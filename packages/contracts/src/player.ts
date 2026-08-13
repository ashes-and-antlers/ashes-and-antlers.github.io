import type { PlayerId, FactionId, PlanetId, TechnologyId } from './ids';
import type { Coordinate } from './coordinate';
import type { ResearchOrder } from './research';
import type { ScanReport } from './scan';

/**
 * A player is an account with a seeded home planet. `token` is the dev
 * identity (a bearer token); real authentication lives in account sessions.
 * M2 adds the account-wide research state: the immutable research queue and
 * the completed technologies whose effects aggregate into the economy and
 * travel calculations. M3 adds the player's scan archive: immutable,
 * timestamped scan reports that feed the visibility-filtered intel views.
 */
export type Player = {
  id: PlayerId;
  name: string;
  factionId: FactionId;
  homePlanetId: PlanetId;
  token: string;
  /** Account-wide research queue (M2): accepted studies in submission order. */
  researchOrders: ResearchOrder[];
  /** Completed technologies (M2): effects aggregate into researchEffects. */
  technologies: TechnologyId[];
  /** Scan archive (M3): immutable scan reports in submission order. */
  scanReports: ScanReport[];
  version: number;
};

export type PlayerView = {
  id: PlayerId;
  name: string;
  factionId: FactionId;
  homePlanet: Coordinate;
};
