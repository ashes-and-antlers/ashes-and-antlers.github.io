import { FactionId } from '../data/content';
import type { SimWorld } from '../ecs/world';

/**
 * Ownership system. Tiles within `claimRadius` (Chebyshev) of a command
 * center belong to that faction; ties resolve to the first command center in
 * creation order (deterministic). Recomputed every ownershipEveryTicks.
 *
 * Read: commandCenters, Position, Faction. Write: owner, ownerVersion.
 */
export function runOwnership(world: SimWorld): void {
  if (world.tick % world.config.ownershipEveryTicks !== 0) {
    return;
  }
  const c = world.components;
  const radius = world.config.claimRadius;
  const next = new Uint8Array(world.owner); // start from current, mutate below

  let changed = false;
  for (let tile = 0; tile < world.tiles.tileCount; tile++) {
    const tx = tile % world.tiles.width;
    const ty = Math.floor(tile / world.tiles.width);
    let owner: FactionId = FactionId.None;
    for (const cc of world.commandCenters) {
      const dx = Math.abs((c.Position.x[cc] ?? 0) - tx);
      const dy = Math.abs((c.Position.y[cc] ?? 0) - ty);
      if (Math.max(dx, dy) <= radius) {
        owner = c.Faction[cc] as FactionId;
        break; // first command center in creation order wins ties
      }
    }
    if (next[tile] !== owner) {
      next[tile] = owner;
      changed = true;
    }
  }

  if (changed) {
    world.owner = next;
    world.ownerVersion++;
  }
}
