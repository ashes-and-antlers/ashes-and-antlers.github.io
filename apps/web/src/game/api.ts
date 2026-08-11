import { PROTOCOL_VERSION, type WorldView } from '@ashes/contracts';

/**
 * API base: baked at build time. In dev the Vite proxy serves /api from the
 * API server; in the e2e build VITE_API_BASE points at the live API.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** M0 dev identity: the seeded player token, matching the API's default. */
const PLAYER_TOKEN =
  (import.meta.env.VITE_PLAYER_TOKEN as string | undefined) ?? 'player-1337-token';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchOverview(worldId: string): Promise<WorldView> {
  const res = await fetch(`${API_BASE}/api/v1/worlds/${encodeURIComponent(worldId)}/overview`, {
    headers: { authorization: `Bearer ${PLAYER_TOKEN}` },
  });
  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      throw new ApiError(
        res.status,
        body.error?.message ?? `overview failed (${res.status})`,
        code,
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(res.status, `overview failed (${res.status})`);
    }
  }
  return (await res.json()) as WorldView;
}

export function assertProtocol(view: WorldView): void {
  if (view.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `protocol mismatch: client ${PROTOCOL_VERSION}, server ${view.protocolVersion}`,
    );
  }
}
