import { entityExists, query, removeEntity } from 'bitecs';
import { CitizenState, FactionId, FACTION_META, ItemType, TaskFailReason } from '../data/content';
import { seasonHungerFactor } from '../core/seasons';
import { sortedQuery, type SimWorld } from '../ecs/world';
import { failTask } from './taskops';
import { clearCarry } from './inventory';

/**
 * Needs system. Read: TaskId, CarryItem, CarryAmount, Energy, Hunger. Write:
 * Hunger, Energy, Morale, CitizenState. Side effects: eating, starvation,
 * deaths.
 */
export function runNeeds(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  const citizens = sortedQuery(query(world, [c.Citizen]));
  // Winter cold raises food needs: hunger grows at the season-scaled rate.
  const hungerFactor = seasonHungerFactor(config, world.tick);

  for (const eid of citizens) {
    c.Hunger[eid] += config.hungerPerTick * hungerFactor;

    const state = c.CitizenState[eid] ?? CitizenState.Idle;
    if (state === CitizenState.Working) {
      c.Energy[eid] -= config.energyWorkDrainPerTick;
    } else if (state === CitizenState.Idle || state === CitizenState.Resting) {
      c.Energy[eid] += config.energyIdleRegenPerTick;
    }
    if (c.Energy[eid] > 100) c.Energy[eid] = 100;
    if (c.Energy[eid] < 0) c.Energy[eid] = 0;

    if (c.Hunger[eid] < 60) {
      c.Morale[eid] = Math.min(100, c.Morale[eid] + config.moraleGainPerTick);
    } else {
      c.Morale[eid] = Math.max(0, c.Morale[eid] - config.moraleLossPerTick);
    }

    // Eat from carry when hungry (food only — wood cannot be eaten).
    if (c.Hunger[eid] >= config.eatThreshold && c.CarryItem[eid] === ItemType.Food) {
      const carried = c.CarryAmount[eid] ?? 0;
      if (carried > 0) {
        c.CarryAmount[eid] = carried - 1;
        if (c.CarryAmount[eid] === 0) {
          clearCarry(world, eid);
        }
        c.Hunger[eid] -= config.eatHungerRelief;
        c.CitizenState[eid] = CitizenState.Eating;
        world.stats.foodEaten++;
        continue;
      }
      clearCarry(world, eid);
    }

    // Rest when exhausted (only when not committed to a task).
    if (c.TaskId[eid] === -1) {
      if (state !== CitizenState.Resting && c.Energy[eid] < config.restBelow) {
        c.CitizenState[eid] = CitizenState.Resting;
      } else if (state === CitizenState.Resting && c.Energy[eid] >= config.resumeWorkAt) {
        c.CitizenState[eid] = CitizenState.Idle;
      }
    }

    // Starvation.
    if (c.Hunger[eid] >= config.starveAt) {
      c.CitizenState[eid] = CitizenState.Dead;
      world.stats.deaths++;
      // Rate-limit starvation alerts so a dying population doesn't flood the
      // chronicle; the food.shortage alert carries the real signal.
      const faction = c.Faction[eid] ?? FactionId.None;
      const lastStarve = world.lastStarvationAlertTick[faction] ?? 0;
      if (world.tick - lastStarve >= config.foodAlertCooldownTicks) {
        world.lastStarvationAlertTick[faction] = world.tick;
        pushAlert(world, {
          code: 'citizen.starved',
          severity: 1,
          factionId: faction,
          text: `${FACTION_META[faction as FactionId]?.name ?? 'Faction'} citizen starved to death.`,
        });
      }
      const task = c.TaskId[eid];
      if (task !== -1 && entityExists(world, task)) {
        failTask(world, task, TaskFailReason.WorkerDied);
      }
      removeEntity(world, eid);
    }
  }
}

export function pushAlert(
  world: SimWorld,
  alert: { code: string; severity: number; factionId: number; text: string },
): void {
  world.alertLog.push({
    id: world.alertSeq++,
    tick: world.tick,
    code: alert.code,
    severity: alert.severity,
    factionId: alert.factionId,
    text: alert.text,
  });
  if (world.alertLog.length > world.config.alertLogCapacity) {
    world.alertLog.splice(0, world.alertLog.length - world.config.alertLogCapacity);
  }
}
