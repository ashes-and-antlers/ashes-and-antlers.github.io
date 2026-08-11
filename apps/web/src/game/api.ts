import {
  PROTOCOL_VERSION,
  type GalaxyView,
  type PlanetView,
  type WorldView,
} from '@ashes/contracts';
import { ART_VERSION } from '@ashes/content';

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
    { headers: { authorization: `Bearer ${PLAYER_TOKEN}` } },
  );
  if (!res.ok) {
    throw new ApiError(res.status, `planet image failed (${res.status})`);
  }
  return res.blob();
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${PLAYER_TOKEN}` },
  });
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
