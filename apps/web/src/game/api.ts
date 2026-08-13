import {
  PROTOCOL_VERSION,
  type AccountSessionView,
  type AccountView,
  type BuildingKind,
  type ConstructionOrderView,
  type Coordinate,
  type FleetId,
  type FleetOpReceiptResult,
  type GalaxyView,
  type M3MissionKind,
  type OrderId,
  type PlanetView,
  type ResearchOrderView,
  type ScanKind,
  type ScanReportView,
  type SessionResponse,
  type ShipKind,
  type ShipStacks,
  type ShipyardOrderView,
  type TechnologyId,
  type WorldView,
} from '@ashes/contracts';
import { ART_VERSION, type FactionSymbol } from '@ashes/content';
import { getSession } from './session';

/**
 * API base: baked at build time. In dev the Vite proxy serves /api from the
 * API server; in the e2e build VITE_API_BASE points at the live API.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/**
 * The acting bearer token: the signed-in account's session when present,
 * else the seeded dev player's token (the M0 fallback, matching the API's
 * default) so the dev/e2e overview keeps working without an account.
 */
function authToken(): string {
  return (
    getSession()?.token ??
    (import.meta.env.VITE_PLAYER_TOKEN as string | undefined) ??
    'player-1337-token'
  );
}

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
  return (await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}/overview`)) as WorldView;
}

/** Galaxy map projection: every planet's position in map space. */
export async function fetchGalaxy(worldId: string): Promise<GalaxyView> {
  return (await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}/galaxy`)) as GalaxyView;
}

/** Single-planet projection for the planet detail page. */
export async function fetchPlanet(worldId: string, planetId: string): Promise<PlanetView> {
  return (await fetchJson(
    `/api/v1/worlds/${encodeURIComponent(worldId)}/planets/${encodeURIComponent(planetId)}`,
  )) as PlanetView;
}

// -- construction commands -------------------------------------------------

export type StartBuildingInput = {
  worldId: string;
  planetId: string;
  building: BuildingKind;
  /** Optimistic concurrency gate: the world version from the last overview. */
  expectedVersion: number;
};

/**
 * Accept a StartBuilding command. The envelope's idempotency key is generated
 * client-side (crypto.randomUUID) so retrying the same action after a network
 * blip cannot double-reserve the planet store.
 */
export async function submitStartBuilding(
  input: StartBuildingInput,
): Promise<ConstructionOrderView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind: 'StartBuilding', planetId: input.planetId, building: input.building },
  })) as { receipt: ConstructionOrderView };
  return body.receipt;
}

export type CancelConstructionInput = {
  worldId: string;
  orderId: OrderId;
  expectedVersion: number;
};

export async function cancelConstruction(
  input: CancelConstructionInput,
): Promise<ConstructionOrderView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind: 'CancelConstruction', orderId: input.orderId },
  })) as { receipt: ConstructionOrderView };
  return body.receipt;
}

// -- research commands (M2) -------------------------------------------------

export type StartResearchInput = {
  worldId: string;
  /** The owned lab planet that hosts and funds the study. */
  hostPlanetId: string;
  technologyId: TechnologyId;
  expectedVersion: number;
};

export async function submitStartResearch(input: StartResearchInput): Promise<ResearchOrderView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: {
      kind: 'StartResearch',
      hostPlanetId: input.hostPlanetId,
      technologyId: input.technologyId,
    },
  })) as { receipt: ResearchOrderView };
  return body.receipt;
}

export type CancelResearchInput = {
  worldId: string;
  orderId: OrderId;
  expectedVersion: number;
};

export async function cancelResearch(input: CancelResearchInput): Promise<ResearchOrderView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind: 'CancelResearch', orderId: input.orderId },
  })) as { receipt: ResearchOrderView };
  return body.receipt;
}

// -- shipyard commands (M2) -------------------------------------------------

export type QueueShipInput = {
  worldId: string;
  planetId: string;
  ship: ShipKind;
  quantity: number;
  expectedVersion: number;
};

export async function submitQueueShip(input: QueueShipInput): Promise<ShipyardOrderView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: {
      kind: 'QueueShip',
      planetId: input.planetId,
      ship: input.ship,
      quantity: input.quantity,
    },
  })) as { receipt: ShipyardOrderView };
  return body.receipt;
}

export type CancelShipOrderInput = {
  worldId: string;
  orderId: OrderId;
  expectedVersion: number;
};

export async function cancelShipOrder(input: CancelShipOrderInput): Promise<ShipyardOrderView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind: 'CancelShipOrder', orderId: input.orderId },
  })) as { receipt: ShipyardOrderView };
  return body.receipt;
}

// -- fleet commands (M2) ----------------------------------------------------

export type SplitFleetInput = {
  worldId: string;
  fleetId: FleetId;
  ships: ShipStacks;
  expectedVersion: number;
};

export async function submitSplitFleet(input: SplitFleetInput): Promise<FleetOpReceiptResult> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind: 'SplitFleet', fleetId: input.fleetId, ships: input.ships },
  })) as { result: FleetOpReceiptResult };
  return body.result;
}

export type TransferFleetInput = {
  worldId: string;
  fromFleetId: FleetId;
  toFleetId: FleetId;
  ships: ShipStacks;
  cargo?: Partial<Record<'metal' | 'mineral' | 'food' | 'energy', number>>;
  expectedVersion: number;
};

export async function submitTransferFleet(
  input: TransferFleetInput,
): Promise<FleetOpReceiptResult> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: {
      kind: 'TransferFleet',
      fromFleetId: input.fromFleetId,
      toFleetId: input.toFleetId,
      ships: input.ships,
      ...(input.cargo === undefined ? {} : { cargo: input.cargo }),
    },
  })) as { result: FleetOpReceiptResult };
  return body.result;
}

// -- fleet movement commands (M3) -------------------------------------------

export type SendFleetInput = {
  worldId: string;
  fleetId: FleetId;
  destination: Coordinate;
  mission: M3MissionKind;
  expectedVersion: number;
};

export async function submitSendFleet(input: SendFleetInput): Promise<FleetOpReceiptResult> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: {
      kind: 'SendFleet',
      fleetId: input.fleetId,
      destination: input.destination,
      mission: input.mission,
    },
  })) as { result: FleetOpReceiptResult };
  return body.result;
}

export type RecallFleetInput = {
  worldId: string;
  fleetId: FleetId;
  expectedVersion: number;
};

export async function submitRecallFleet(input: RecallFleetInput): Promise<FleetOpReceiptResult> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind: 'RecallFleet', fleetId: input.fleetId },
  })) as { result: FleetOpReceiptResult };
  return body.result;
}

export type CargoOpInput = {
  worldId: string;
  fleetId: FleetId;
  /** Resource amounts to move, e.g. { metal: 50 }. */
  resources: Record<string, number>;
  expectedVersion: number;
};

export async function submitLoadCargo(input: CargoOpInput): Promise<FleetOpReceiptResult> {
  return submitCargoOp('LoadCargo', input);
}

export async function submitUnloadCargo(input: CargoOpInput): Promise<FleetOpReceiptResult> {
  return submitCargoOp('UnloadCargo', input);
}

async function submitCargoOp(
  kind: 'LoadCargo' | 'UnloadCargo',
  input: CargoOpInput,
): Promise<FleetOpReceiptResult> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: { kind, fleetId: input.fleetId, resources: input.resources },
  })) as { result: FleetOpReceiptResult };
  return body.result;
}

// -- scan commands (M3) -----------------------------------------------------

export type RunScanInput = {
  worldId: string;
  sourcePlanetId: string;
  target: Coordinate;
  scan: ScanKind;
  expectedVersion: number;
};

/** Accept a RunScan command; returns the immutable, timestamped report. */
export async function submitRunScan(input: RunScanInput): Promise<ScanReportView> {
  const body = (await postAuthed(`/api/v1/worlds/${encodeURIComponent(input.worldId)}/commands`, {
    idempotencyKey: crypto.randomUUID(),
    expectedVersion: input.expectedVersion,
    submittedAt: new Date().toISOString(),
    command: {
      kind: 'RunScan',
      sourcePlanetId: input.sourcePlanetId,
      target: input.target,
      scan: input.scan,
    },
  })) as { report: ScanReportView };
  return body.report;
}

/** Scan reach preview (M3): the source array's range vs. distance to target. */
export async function fetchScanPreview(
  worldId: string,
  sourcePlanetId: string,
  target: Coordinate,
): Promise<{ range: number; distance: number; inRange: boolean }> {
  const to = `${target.galaxy}:${target.sector}:${target.system}:${target.planet}`;
  return (await fetchJson(
    `/api/v1/worlds/${encodeURIComponent(worldId)}/scans/preview?source=${encodeURIComponent(
      sourcePlanetId,
    )}&to=${encodeURIComponent(to)}`,
  )) as { range: number; distance: number; inRange: boolean };
}

/**
 * Deterministic route preview (M3): distance, travel ticks, and arrival tick
 * for sending `fleetId` to `destination`. Read-only — the engine answers.
 */
export async function fetchFleetRoute(
  worldId: string,
  fleetId: FleetId,
  destination: Coordinate,
): Promise<{ distance: number; travelTicks: number; arrivalTick: number }> {
  const to = `${destination.galaxy}:${destination.sector}:${destination.system}:${destination.planet}`;
  return (await fetchJson(
    `/api/v1/worlds/${encodeURIComponent(worldId)}/fleets/${encodeURIComponent(fleetId)}/route?to=${encodeURIComponent(to)}`,
  )) as { distance: number; travelTicks: number; arrivalTick: number };
}

/**
 * Fetch the pre-rendered planet PNG as a Blob (the endpoint requires the
 * bearer token, so an <img src> cannot use it directly).
 *
 * The URL is versioned with ART_VERSION: the API serves the PNG with
 * `Cache-Control: immutable`, so the browser must see a *new URL* whenever
 * the art changes — otherwise a stale portrait (e.g. pre-starfield) keeps
 * being served from cache forever.
 */
export async function fetchPlanetImage(
  worldId: string,
  planetId: string,
  size?: number,
): Promise<Blob> {
  const sizeQuery = size === undefined ? '' : `size=${size}`;
  const versionQuery = `v=${ART_VERSION}`;
  const query = sizeQuery === '' ? `?${versionQuery}` : `?${sizeQuery}&${versionQuery}`;
  const res = await fetch(
    `${API_BASE}/api/v1/worlds/${encodeURIComponent(worldId)}/planets/${encodeURIComponent(planetId)}/image.png${query}`,
    { headers: { authorization: `Bearer ${authToken()}` } },
  );
  if (!res.ok) {
    throw new ApiError(res.status, `planet image failed (${res.status})`);
  }
  return res.blob();
}

// -- accounts --------------------------------------------------------------

export type FactionCatalogEntry = {
  id: string;
  name: string;
  profile: string;
};

/** The two powers (public catalog). */
export async function fetchFactions(): Promise<FactionCatalogEntry[]> {
  return (await fetchJson('/api/v1/factions')) as FactionCatalogEntry[];
}

/** The emblem bank every commander picks from (public catalog). */
export async function fetchEmblems(): Promise<FactionSymbol[]> {
  return (await fetchJson('/api/v1/emblems')) as FactionSymbol[];
}

export async function registerAccount(input: {
  username: string;
  password: string;
  name?: string;
  symbolId: string;
}): Promise<SessionResponse> {
  return (await postJson('/api/v1/accounts/register', input)) as SessionResponse;
}

export async function loginAccount(input: {
  username: string;
  password: string;
}): Promise<SessionResponse> {
  return (await postJson('/api/v1/accounts/login', input)) as SessionResponse;
}

export async function fetchMe(): Promise<AccountView> {
  const body = (await fetchJson('/api/v1/accounts/me')) as { account: AccountView };
  return body.account;
}

export async function logoutAccount(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/accounts/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken()}` },
  });
  if (!res.ok) await unwrap(res);
}

/** Update the commander's profile (display name and/or emblem). */
export async function updateProfile(input: {
  name?: string;
  symbolId?: string;
}): Promise<AccountView> {
  const body = (await patchJson('/api/v1/accounts/me', input)) as { account: AccountView };
  return body.account;
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOthers?: boolean;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/accounts/me/password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken()}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) await unwrap(res);
}

/** Every session on the account, newest first; the current one is marked. */
export async function fetchSessions(): Promise<AccountSessionView[]> {
  const body = (await fetchJson('/api/v1/accounts/me/sessions')) as {
    sessions: AccountSessionView[];
  };
  return body.sessions;
}

/** Revoke one session (including this one — logs this device out). */
export async function revokeSession(sessionId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/accounts/me/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${authToken()}` },
    },
  );
  if (!res.ok) await unwrap(res);
}

/** Sign every other device out; this session stays. */
export async function revokeOtherSessions(): Promise<number> {
  const res = await fetch(`${API_BASE}/api/v1/accounts/me/sessions/revoke-others`, {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken()}` },
  });
  const body = (await unwrap(res)) as { revoked: number };
  return body.revoked;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${authToken()}` },
  });
  return unwrap(res);
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap(res);
}

async function patchJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken()}`,
    },
    body: JSON.stringify(body),
  });
  return unwrap(res);
}

/** Authenticated POST (commands, dev triggers). */
async function postAuthed(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken()}`,
    },
    body: JSON.stringify(body),
  });
  return unwrap(res);
}

async function unwrap(res: Response): Promise<unknown> {
  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      throw new ApiError(res.status, body.error?.message ?? `request failed (${res.status})`, code);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(res.status, `request failed (${res.status})`);
    }
  }
  return res.json();
}

export function assertProtocol(view: WorldView): void {
  if (view.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `protocol mismatch: client ${PROTOCOL_VERSION}, server ${view.protocolVersion}`,
    );
  }
}
