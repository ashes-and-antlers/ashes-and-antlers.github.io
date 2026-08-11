import type { PlayerId, FactionId, PlanetId } from './ids';
import type { Coordinate } from './coordinate';

/**
 * A player is an account with one seeded home planet in M0. `token` is the
 * M0 dev identity (a bearer token); real authentication arrives in M1.
 */
export type Player = {
  id: PlayerId;
  name: string;
  factionId: FactionId;
  homePlanetId: PlanetId;
  token: string;
  version: number;
};

export type PlayerView = {
  id: PlayerId;
  name: string;
  factionId: FactionId;
  homePlanet: Coordinate;
};
