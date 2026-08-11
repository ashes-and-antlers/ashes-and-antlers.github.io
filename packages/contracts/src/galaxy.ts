import type { Coordinate } from './coordinate';
import type { FactionId, PlanetId, WorldId } from './ids';

/** A point in galaxy map space, derived deterministically from the seed. */
export type MapPosition = {
  x: number;
  y: number;
};

/** Axis-aligned bounds of every generated position, so the client can fit
 *  the map without knowing the layout geometry. */
export type GalaxyBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Galaxy map projection (DEVELOPMENT_PLAN.md §3/§5). A read-only snapshot of
 * where every galaxy, system, and planet sits in 2D map space. Positions are
 * a deterministic function of (seed, coordinate) — the client never derives
 * them, so fleet travel distance later has one authoritative source.
 *
 * `known` is the player's intelligence: the planets they own/control are
 * labeled on the map; everything else is an anonymous dot until scanned.
 */
export type GalaxyView = {
  worldId: WorldId;
  seed: number;
  protocolVersion: string;
  config: {
    galaxies: number;
    sectorsPerGalaxy: number;
    systemsPerSector: number;
    planetsPerSystem: number;
  };
  homePlanetId: PlanetId;
  bounds: GalaxyBounds;
  galaxies: Array<{
    galaxy: number;
    position: MapPosition;
    /** Disc radius that holds every sector of this galaxy, for the chart. */
    discRadius: number;
  }>;
  /** Every sector's cell — its center and axis-aligned bounds. */
  sectors: Array<{
    galaxy: number;
    sector: number;
    position: MapPosition;
    bounds: GalaxyBounds;
    planetCount: number;
  }>;
  systems: Array<{
    galaxy: number;
    sector: number;
    system: number;
    position: MapPosition;
  }>;
  planets: Array<{
    id: PlanetId;
    coordinate: Coordinate;
    position: MapPosition;
    name: string;
    factionId: FactionId | null;
    known: boolean;
  }>;
};
