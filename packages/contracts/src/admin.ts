import { z } from 'zod';
import type {
  FactionId,
  FleetId,
  PlanetId,
  PlayerId,
  SymbolId,
  TechnologyId,
  WorldId,
} from './ids';
import type { BuildingLevels, ResourceStore } from './planet';
import type { AccountSessionView } from './account';
import type { FleetMission, FleetState, ShipStacks } from './fleet';
import type { Coordinate } from './coordinate';

/**
 * Admin surface (M4): server-authoritative views for the operator dashboard.
 * Everything here is derived from authoritative state (the world aggregate,
 * the accounts/sessions tables, or the database itself) — admin routes are
 * read-mostly, with mutations (tick, grant, reset, delete) going through the
 * same engine and repository locks every player command uses.
 *
 * Admin is a separate surface from the player protocol: PROTOCOL_VERSION does
 * not gate these views (no player projection changes).
 */

/** One world as the operator's world list shows it. */
export type AdminWorldSummary = {
  id: WorldId;
  seed: number;
  tick: number;
  createdAt: number;
  nextTickAt: number;
  lastResolvedAt: number | null;
  worldVersion: string;
  contentVersion: string;
  tickDurationMs: number;
  worldHash: string;
  version: number;
  playerCount: number;
  planetCount: number;
  fleetCount: number;
  resolutionCount: number;
};

/** One player as the operator's player list shows it (account-enriched). */
export type AdminPlayerSummary = {
  playerId: PlayerId;
  name: string;
  factionId: FactionId;
  worldId: WorldId;
  homePlanetId: PlanetId;
  technologyCount: number;
  fleetCount: number;
  scanReportCount: number;
  /** Linked account, when the player belongs to a registered account. */
  accountId?: string;
  username?: string;
};

/** One fleet as the operator sees it (world + player detail panels). */
export type AdminFleetRow = {
  id: FleetId;
  ownerId: PlayerId;
  location: Coordinate;
  ships: ShipStacks;
  cargo: ResourceStore;
  state: FleetState;
  mission: FleetMission | null;
  departureTick: number | null;
  arrivalTick: number | null;
};

/** The aggregate peek for a world's detail panel. */
export type AdminWorldDetail = {
  summary: AdminWorldSummary;
  players: Array<{
    playerId: PlayerId;
    name: string;
    factionId: FactionId;
    homePlanetId: PlanetId;
    technologyCount: number;
    fleetCount: number;
  }>;
  /** Every planet in the world, in stable coordinate order. */
  planets: Array<{
    id: PlanetId;
    coordinate: Coordinate;
    name: string;
    ownerId: PlayerId | null;
    factionId: FactionId | null;
    population: number;
    buildings: BuildingLevels;
    resources: ResourceStore;
  }>;
  /** Every fleet in the world. */
  fleets: AdminFleetRow[];
};

/** The operator's player dossier. */
export type AdminPlayerDetail = {
  player: AdminPlayerSummary;
  account?: {
    id: string;
    username: string;
    name: string;
    symbolId: SymbolId;
    createdAt: number;
  };
  homePlanet: {
    id: PlanetId;
    coordinate: Coordinate;
    name: string;
    population: number;
    resources: ResourceStore;
    buildings: BuildingLevels;
    storageCap: number;
    localFleets: Array<{ id: FleetId; ships: ShipStacks; cargo: ResourceStore }>;
  };
  ownedPlanets: Array<{
    id: PlanetId;
    coordinate: Coordinate;
    name: string;
    population: number;
    resources: ResourceStore;
    buildings: BuildingLevels;
  }>;
  fleets: AdminFleetRow[];
  research: {
    completed: TechnologyId[];
    activeOrderCount: number;
  };
};

/** One account as the operator's account list shows it. */
export type AdminAccountSummary = {
  id: string;
  username: string;
  name: string;
  factionId: FactionId;
  symbolId: SymbolId;
  worldId: WorldId;
  playerId: PlayerId;
  homePlanetId: PlanetId;
  createdAt: number;
  activeSessionCount: number;
  lastSeenAt: number | null;
};

export type AdminAccountDetail = {
  account: AdminAccountSummary;
  sessions: AccountSessionView[];
};

/** One immutable tick resolution as the operator's history shows it. */
export type AdminResolutionRow = {
  tick: number;
  resolvedAt: number;
  status: string;
  planetStateHash: string;
  phaseHashes: Record<string, string>;
};

/** Per-table statistics for the database panel. */
export type TableStat = {
  name: string;
  rows: number;
  size: string;
};

/** The database status card for the overview and database panels. */
export type DatabaseStatus = {
  driver: 'postgres' | 'memory';
  serverVersion: string;
  databaseName: string;
  appliedMigrations: number;
  tables: TableStat[];
  totalRows: number;
};

// -- admin wire schemas ------------------------------------------------------

/** Grant resources to a player's home planet (debug/operator tool). */
export const GrantResourcesSchema = z
  .object({
    metal: z.number().int().nonnegative().optional(),
    mineral: z.number().int().nonnegative().optional(),
    food: z.number().int().nonnegative().optional(),
    energy: z.number().int().nonnegative().optional(),
  })
  .refine(
    (r) =>
      r.metal !== undefined ||
      r.mineral !== undefined ||
      r.food !== undefined ||
      r.energy !== undefined,
    {
      message: 'grant at least one resource',
    },
  );

export type GrantResourcesInput = z.infer<typeof GrantResourcesSchema>;

/** Admin password reset; optionally signs every session out. */
export const AdminSetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(200, 'password is too long'),
  revokeSessions: z.boolean().optional(),
});

export type AdminSetPasswordInput = z.infer<typeof AdminSetPasswordSchema>;

/** Admin account edit: display name and/or emblem. */
export const AdminUpdateAccountSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(40, 'name is too long').optional(),
  symbolId: z.string().min(1, 'an emblem is required').optional(),
});

export type AdminUpdateAccountInput = z.infer<typeof AdminUpdateAccountSchema>;

/** Account deletion: whether the player is also removed from the world. */
export const AdminDeleteAccountSchema = z.object({
  removePlayer: z.boolean().optional(),
});

export type AdminDeleteAccountInput = z.infer<typeof AdminDeleteAccountSchema>;

/** Create (or reload) a world from a seed. */
export const AdminCreateWorldSchema = z.object({
  seed: z.number().int().nonnegative(),
});

export type AdminCreateWorldInput = z.infer<typeof AdminCreateWorldSchema>;
