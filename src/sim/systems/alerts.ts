import { query } from 'bitecs';
import { FACTIONS, FACTION_META, NodeKind, type FactionId } from '../data/content';
import { sortedQuery, type SimWorld } from '../ecs/world';
import { pushAlert } from './needs';
import { factionStock } from './tasks';

/**
 * Alert system. Alerts are consequences of simulation state, never arbitrary
 * events (DEVELOPMENT_PLAN §3.9).
 *
 * food.shortage fires when a faction has no food anywhere, no berry nodes
 * with stock, and hungry citizens — i.e. gathering has genuinely failed.
 */
export function runAlerts(world: SimWorld): void {
  const c = world.components;
  const config = world.config;

  const citizens = sortedQuery(query(world, [c.Citizen]));
  const hungryByFaction = new Map<FactionId, number>();
  const carryByFaction = new Map<FactionId, number>();
  for (const eid of citizens) {
    const faction = c.Faction[eid] as FactionId;
    hungryByFaction.set(
      faction,
      (hungryByFaction.get(faction) ?? 0) + (c.Hunger[eid] >= config.foodAlertHungerLevel ? 1 : 0),
    );
    carryByFaction.set(faction, (carryByFaction.get(faction) ?? 0) + (c.CarryFood[eid] ?? 0));
  }

  const berryStock = world.nodes.some(
    (node) => c.NodeKind[node] === NodeKind.Berries && (c.NodeAmount[node] ?? 0) > 0,
  );

  for (const faction of FACTIONS) {
    const stock = factionStock(world, faction);
    const hungry = hungryByFaction.get(faction) ?? 0;
    if (stock > 0 || (carryByFaction.get(faction) ?? 0) > 0 || berryStock || hungry === 0) {
      continue;
    }
    // Cooldown only applies *after* the first alert; otherwise a faction could
    // starve silently before its first warning (cooldown counts from tick 0).
    const last = world.lastFoodAlertTick[faction] ?? 0;
    if (last > 0 && world.tick - last < world.config.foodAlertCooldownTicks) {
      continue;
    }
    world.lastFoodAlertTick[faction] = world.tick;
    pushAlert(world, {
      code: 'food.shortage',
      severity: 2,
      factionId: faction,
      text: `${FACTION_META[faction].name} has no food and no reachable berry patches.`,
    });
  }
}
