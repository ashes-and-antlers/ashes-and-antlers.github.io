/**
 * Coordinate space: `galaxy : sector : system : planet`, all 1-based. This is
 * the finite map hierarchy of the world (DEVELOPMENT_PLAN.md §3).
 */
export type Coordinate = {
  galaxy: number;
  sector: number;
  system: number;
  planet: number;
};

export function formatCoordinate(coord: Coordinate): string {
  return `${coord.galaxy}:${coord.sector}:${coord.system}:${coord.planet}`;
}

export function parseCoordinate(value: string): Coordinate | null {
  const match = /^(\d+):(\d+):(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const [, galaxy, sector, system, planet] = match;
  return {
    galaxy: Number(galaxy),
    sector: Number(sector),
    system: Number(system),
    planet: Number(planet),
  };
}

/**
 * Stable, total order over coordinates (ascending galaxy, sector, system,
 * planet). All authoritative iteration and canonical serialization uses this.
 */
export function compareCoordinates(a: Coordinate, b: Coordinate): number {
  return a.galaxy - b.galaxy || a.sector - b.sector || a.system - b.system || a.planet - b.planet;
}
