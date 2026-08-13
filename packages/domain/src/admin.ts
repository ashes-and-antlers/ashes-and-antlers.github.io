import {
  RESOURCE_KEYS,
  type PlayerId,
  type ResourceRates,
  type ResourceStore,
  type WorldState,
} from '@ashes/contracts';
import { storageCapFor } from './economy';
import { playerResearchEffects } from './research';

/**
 * Admin/operator state transitions (M4). These are the only player-level
 * mutations the tick engine exposes outside the command surface: granting
 * resources to a commander's home planet (a debug/QA tool) and removing a
 * player from a world (account deletion with the world kept consistent).
 *
 * Both are pure, deterministic transitions on the aggregate — no wall clock,
 * no randomness — and bump the same aggregate/planet versions every other
 * mutation does, so optimistic-concurrency envelopes and the world lock treat
 * them exactly like player commands.
 */

export type AdminError =
  | { code: 'PLAYER_NOT_FOUND'; playerId: PlayerId }
  | { code: 'HOME_PLANET_NOT_FOUND'; playerId: PlayerId; planetId: string }
  | { code: 'INVALID_GRANT'; message: string };

/** Typed admin-domain failure, mapped to an ApiError by the engine. */
export class AdminDomainError extends Error {
  constructor(public readonly adminError: AdminError) {
    super(
      adminError.code === 'PLAYER_NOT_FOUND'
        ? `player ${adminError.playerId} not found`
        : adminError.code === 'HOME_PLANET_NOT_FOUND'
          ? `home planet ${adminError.planetId} of player ${adminError.playerId} not found`
          : adminError.message,
    );
    this.name = 'AdminDomainError';
  }
}

/**
 * Add resources to a player's home planet store, clamped at the storage cap
 * (the same policy as refunds and unloads). Returns the updated aggregate.
 */
export function grantResourcesToPlanet(
  world: WorldState,
  playerId: PlayerId,
  resources: Partial<ResourceRates>,
): WorldState {
  const player = world.players.find((p) => p.id === playerId);
  if (!player) throw new AdminDomainError({ code: 'PLAYER_NOT_FOUND', playerId });
  const planet = world.planets.find((p) => p.id === player.homePlanetId);
  if (!planet) {
    throw new AdminDomainError({
      code: 'HOME_PLANET_NOT_FOUND',
      playerId,
      planetId: player.homePlanetId,
    });
  }
  const cap = storageCapFor(planet, playerResearchEffects(player));
  const next: ResourceStore = { ...planet.resources };
  for (const key of RESOURCE_KEYS) {
    const amount = resources[key];
    if (amount === undefined || amount <= 0) continue;
    if (!Number.isFinite(amount)) {
      throw new AdminDomainError({
        code: 'INVALID_GRANT',
        message: `grant for ${key} is not finite`,
      });
    }
    next[key] = Math.min(cap, Math.floor(planet.resources[key] + amount));
  }
  if (RESOURCE_KEYS.every((k) => next[k] === planet.resources[k])) {
    // Nothing changed (all grants were 0 or negative) — still a valid no-op.
    return world;
  }
  return {
    ...world,
    planets: world.planets.map((p) =>
      p.id === planet.id ? { ...p, resources: next, version: p.version + 1 } : p,
    ),
    version: world.version + 1,
  };
}

/**
 * Remove a player from a world and keep the aggregate consistent: the player
 * row and every fleet they own are dropped, and every planet they owned
 * becomes unowned (its faction flavor stays — planets are born with a
 * faction, ownership is a separate concern). Historical receipts and orders
 * remain as immutable records; nothing else references the removed player.
 */
export function removePlayerFromWorld(world: WorldState, playerId: PlayerId): WorldState {
  const player = world.players.find((p) => p.id === playerId);
  if (!player) throw new AdminDomainError({ code: 'PLAYER_NOT_FOUND', playerId });

  const removedFleetIds = new Set(
    world.fleets.filter((f) => f.ownerId === playerId).map((f) => f.id),
  );

  return {
    ...world,
    players: world.players.filter((p) => p.id !== playerId),
    fleets: world.fleets.filter((f) => f.ownerId !== playerId),
    planets: world.planets.map((p) =>
      p.ownerId === playerId
        ? { ...p, ownerId: null, localFleets: [], version: p.version + 1 }
        : {
            ...p,
            // Orbits at unowned planets are emptied too (their fleets were the
            // removed player's); other owners' fleets stay untouched.
            localFleets: p.localFleets.filter((fid) => !removedFleetIds.has(fid)),
          },
    ),
    version: world.version + 1,
  };
}
