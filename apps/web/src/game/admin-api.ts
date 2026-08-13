import {
  type AdminAccountDetail,
  type AdminAccountSummary,
  type AdminPlayerDetail,
  type AdminPlayerSummary,
  type AdminResolutionRow,
  type AdminWorldDetail,
  type AdminWorldSummary,
  type DatabaseStatus,
} from '@ashes/contracts';

/**
 * Admin dashboard API surface. The operator's bearer token is never baked
 * into the client — it is entered on the dashboard's gate and kept in
 * sessionStorage for the tab's lifetime (cleared on sign-out).
 */

const TOKEN_KEY = 'ashes.admin.token.v1';

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

type AdminStatus = {
  db: DatabaseStatus;
  worldCount: number;
  accountCount: number;
  playerCount: number;
  tickCount: number;
};

export async function fetchAdminStatus(token: string): Promise<AdminStatus> {
  return (await adminFetch(token, '/api/v1/admin/status')) as AdminStatus;
}

export async function fetchAdminWorlds(token: string): Promise<AdminWorldSummary[]> {
  const body = (await adminFetch(token, '/api/v1/admin/worlds')) as { worlds: AdminWorldSummary[] };
  return body.worlds;
}

export async function fetchAdminWorld(token: string, worldId: string): Promise<AdminWorldDetail> {
  return (await adminFetch(
    token,
    `/api/v1/admin/worlds/${encodeURIComponent(worldId)}`,
  )) as AdminWorldDetail;
}

export async function fetchAdminResolutions(
  token: string,
  worldId: string,
  limit = 20,
): Promise<AdminResolutionRow[]> {
  const body = (await adminFetch(
    token,
    `/api/v1/admin/worlds/${encodeURIComponent(worldId)}/resolutions?limit=${limit}`,
  )) as { resolutions: AdminResolutionRow[] };
  return body.resolutions;
}

export async function createAdminWorld(token: string, seed: number): Promise<AdminWorldDetail> {
  return (await adminPost(token, '/api/v1/admin/worlds', { seed })) as AdminWorldDetail;
}

export async function resolveAdminTick(
  token: string,
  worldId: string,
): Promise<{ tick: number; status: string; planetStateHash: string }> {
  return (await adminPost(
    token,
    `/api/v1/admin/worlds/${encodeURIComponent(worldId)}/tick`,
    {},
  )) as { tick: number; status: string; planetStateHash: string };
}

export async function deleteAdminWorld(token: string, worldId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/admin/worlds/${encodeURIComponent(worldId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) await unwrapAdmin(res);
}

export async function fetchAdminPlayers(token: string): Promise<AdminPlayerSummary[]> {
  const body = (await adminFetch(token, '/api/v1/admin/players')) as {
    players: AdminPlayerSummary[];
  };
  return body.players;
}

export async function fetchAdminPlayer(
  token: string,
  playerId: string,
): Promise<AdminPlayerDetail> {
  return (await adminFetch(
    token,
    `/api/v1/admin/players/${encodeURIComponent(playerId)}`,
  )) as AdminPlayerDetail;
}

export async function grantAdminPlayer(
  token: string,
  playerId: string,
  resources: Record<string, number>,
): Promise<{ resources: Record<string, number>; storageCap: number; version: number }> {
  return (await adminPost(
    token,
    `/api/v1/admin/players/${encodeURIComponent(playerId)}/grant`,
    resources,
  )) as { resources: Record<string, number>; storageCap: number; version: number };
}

export async function renameAdminPlayer(
  token: string,
  playerId: string,
  name: string,
): Promise<void> {
  await adminPost(token, `/api/v1/admin/players/${encodeURIComponent(playerId)}/rename`, { name });
}

export async function fetchAdminAccounts(token: string): Promise<AdminAccountSummary[]> {
  const body = (await adminFetch(token, '/api/v1/admin/accounts')) as {
    accounts: AdminAccountSummary[];
  };
  return body.accounts;
}

export async function fetchAdminAccount(
  token: string,
  accountId: string,
): Promise<AdminAccountDetail> {
  return (await adminFetch(
    token,
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
  )) as AdminAccountDetail;
}

export async function updateAdminAccount(
  token: string,
  accountId: string,
  changes: { name?: string; symbolId?: string },
): Promise<AdminAccountDetail> {
  return (await adminPatch(
    token,
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
    changes,
  )) as AdminAccountDetail;
}

export async function resetAdminPassword(
  token: string,
  accountId: string,
  newPassword: string,
  revokeSessions: boolean,
): Promise<void> {
  await adminPost(token, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/password`, {
    newPassword,
    revokeSessions,
  });
}

export async function revokeAllAdminSessions(token: string, accountId: string): Promise<number> {
  const body = (await adminPost(
    token,
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/sessions/revoke-all`,
    {},
  )) as { revoked: number };
  return body.revoked;
}

export async function revokeAdminSession(
  token: string,
  accountId: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/admin/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) await unwrapAdmin(res);
}

export async function deleteAdminAccount(
  token: string,
  accountId: string,
  removePlayer: boolean,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ removePlayer }),
  });
  if (!res.ok) await unwrapAdmin(res);
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function adminFetch(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return unwrapAdmin(res);
}

async function adminPost(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return unwrapAdmin(res);
}

async function adminPatch(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return unwrapAdmin(res);
}

async function unwrapAdmin(res: Response): Promise<unknown> {
  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      throw new AdminApiError(
        res.status,
        body.error?.message ?? `request failed (${res.status})`,
        code,
      );
    } catch (err) {
      if (err instanceof AdminApiError) throw err;
      throw new AdminApiError(res.status, `request failed (${res.status})`);
    }
  }
  return res.status === 204 ? undefined : res.json();
}
