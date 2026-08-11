import { query } from 'bitecs';
import { NodeKind } from '../data/content';
import { seasonRegenFactor } from '../core/seasons';
import { sortedQuery, type SimWorld } from '../ecs/world';

/**
 * Renewable resources. Read: NodeAmount, NodeMax, NodeRegenTick. Write:
 * NodeAmount, NodeRegenTick.
 *
 * A depleted node waits berryRegenDelayTicks, then regrows back to max at the
 * season-scaled rate (0 in winter: plants lie dormant until spring).
 */
export function runResources(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  const nodes = sortedQuery(query(world, [c.ResourceNode]));
  const regenPerTick = config.berryRegenPerTick * seasonRegenFactor(config, world.tick);
  for (const node of nodes) {
    if (c.NodeKind[node] !== NodeKind.Berries) {
      continue;
    }
    const regenTick = c.NodeRegenTick[node] ?? -1;
    if (regenTick === -1) {
      continue;
    }
    if (world.tick < regenTick) {
      continue;
    }
    const amount = (c.NodeAmount[node] ?? 0) + regenPerTick;
    const max = c.NodeMax[node] ?? 0;
    if (amount >= max) {
      c.NodeAmount[node] = max;
      c.NodeRegenTick[node] = -1;
    } else {
      c.NodeAmount[node] = amount;
    }
  }
}
