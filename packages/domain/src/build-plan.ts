import {
  BUILDING_KINDS,
  RESOURCE_KEYS,
  emptyTechnologyEffects,
  type Abundance,
  type BuildingKind,
  type BuildingLevels,
  type ResourceKey,
  type ResourceRates,
  type ResourceStore,
  type TechnologyEffects,
} from '@ashes/contracts';
import {
  BUILDING_DEFINITIONS,
  CONSTRUCTION,
  ECONOMY,
  type BuildingDefinition,
} from '@ashes/content';
import { buildingNetRates, storageCapForLevel } from './economy';

/**
 * Build-order planner: when the player cannot afford a building, work out the
 * smallest producer chain that makes it affordable and estimate how many ticks
 * it takes — "build a Metal Mine, then the Settlement, ~6 ticks".
 *
 * The planner is also cancel-aware: when a deficit resource has no income (the
 * classic soft-lock — everything costs metal, the only metal producer is the
 * Metal Mine, and the store is below its cost), it refunds pending
 * construction orders to fund the keystone producer and then rebuilds what it
 * cancelled, exactly like the engine's cancellation (full refund, clamped at
 * the storage cap). A player can never be told "wait for income" when no
 * income exists.
 *
 * Pure and deterministic (no randomness, no wall clock): the same planet state
 * and target always produce the same plan. The estimate is presentation-only —
 * the engine remains the only authority on what actually resolves — but it
 * simulates the real formulas (content costs/ticks, abundance-scaled output,
 * serialized queue, energy brownout) so the numbers are honest.
 */

export type BuildPlanInput = {
  resources: ResourceStore;
  buildings: BuildingLevels;
  abundance: Abundance;
  /** Active (building/queued) construction orders: queue capacity, pending
   *  levels, and — when the plan needs seed capital — cancellable refunds. */
  activeOrders: Array<{ building: BuildingKind; cost: Partial<ResourceStore> }>;
  /** The owner's research effects (M2): production/storage/upkeep modifiers. */
  effects?: TechnologyEffects;
};

export type PlanStep =
  | { kind: 'build'; building: BuildingKind; toLevel: number; produces?: ResourceKey }
  | { kind: 'cancel'; building: BuildingKind; refunds: Partial<ResourceStore> };

/** Internal build step: the target has no "produces" resource. */
type SimStep = { building: BuildingKind; toLevel: number };

export type BuildPlan =
  | { status: 'affordable'; steps: []; ticks: 0; summary: string }
  | { status: 'blocked-maxed'; steps: []; ticks: 0; summary: string }
  | { status: 'blocked-queue'; steps: []; ticks: 0; summary: string }
  | { status: 'plan'; steps: PlanStep[]; ticks: number; summary: string }
  | { status: 'no-path'; steps: []; ticks: number; summary: string };

/** Recursion depth for making a producer itself affordable (guards cycles). */
const MAX_PRODUCER_DEPTH = 4;
/** Simulated build time is allowed to run this many ticks before giving up. */
const MAX_SIMULATION_TICKS = 10_000;

export function planBuildOrder(input: BuildPlanInput, target: BuildingKind): BuildPlan {
  const def = BUILDING_DEFINITIONS[target];
  const level = input.buildings[target] ?? 0;
  const pendingTarget = input.activeOrders.filter((o) => o.building === target).length;

  if (level + pendingTarget >= def.maxLevel) {
    return {
      status: 'blocked-maxed',
      steps: [],
      ticks: 0,
      summary: `${def.name} is already at max level ${def.maxLevel}.`,
    };
  }
  if (input.activeOrders.length >= CONSTRUCTION.queueCapacity) {
    return {
      status: 'blocked-queue',
      steps: [],
      ticks: 0,
      summary: `The construction queue is full — complete or cancel an order before raising ${def.name}.`,
    };
  }

  const shortfall = costShortfall(def.cost, input.resources);
  if (shortfall.length === 0) {
    return { status: 'affordable', steps: [], ticks: 0, summary: `${def.name} is affordable now.` };
  }

  // A producer chain that covers the deficits, in build order. Producers of a
  // deficit come first, and a producer's own producers precede it (bounded
  // recursion, cycles excluded). Affordability is deliberately NOT checked
  // here: the simulation below inserts the waits — and the cancellations —
  // so a producer the store cannot pay for today is simply scheduled after
  // the income that funds it.
  const planned = new Set<BuildingKind>([target]);
  const steps: PlanStep[] = [];
  for (const { resource } of shortfall) {
    const producer = bestProducer(input, resource, planned);
    if (!producer) continue;
    planned.add(producer);
    const preSteps = collectProducerChain(input, producer, planned, 1);
    steps.push(...preSteps, {
      kind: 'build',
      building: producer,
      toLevel: (input.buildings[producer] ?? 0) + 1,
      produces: resource,
    });
  }

  // Simulate the plan against the real formulas to get an honest horizon. The
  // target is the final build step; the simulation may interleave cancels.
  const buildChain = steps.filter(
    (s): s is Extract<PlanStep, { kind: 'build' }> => s.kind === 'build',
  );
  const ordered: SimStep[] = [
    ...buildChain.map((s) => ({ building: s.building, toLevel: s.toLevel })),
    { building: target, toLevel: level + 1 },
  ];
  const simulation = simulate(input, ordered);
  if (!simulation.ok) {
    return noPathPlan(input, def, shortfall);
  }

  const planSteps = simulation.steps;
  const targetPlanned = planSteps.find(
    (s): s is Extract<PlanStep, { kind: 'build' }> => s.kind === 'build' && s.building === target,
  );
  // The chain names the steps that lead to the target: cancellations and the
  // producer chain, in the order the simulation executed them (rebuilds are
  // restoration after the goal, so they stay out of the headline).
  const chain = planSteps
    .filter(
      (s) =>
        s.kind === 'cancel' ||
        (s.kind === 'build' && s !== targetPlanned && steps.some((p) => p.building === s.building)),
    )
    .map((s) =>
      s.kind === 'cancel'
        ? `Cancel ${BUILDING_DEFINITIONS[s.building].name}`
        : BUILDING_DEFINITIONS[s.building].name,
    )
    .join(' → ');

  const wait = simulation.ticks - totalBuildTicks(planSteps);
  const summary =
    chain === ''
      ? `${def.name} affordable in ~${simulation.ticks} tick${simulation.ticks === 1 ? '' : 's'}.`
      : `${chain} → ${def.name}, ~${simulation.ticks} ticks total (${
          wait > 0 ? `~${wait} tick${wait === 1 ? '' : 's'} of saving` : 'no waiting needed'
        }).`;
  return { status: 'plan', steps: planSteps, ticks: simulation.ticks, summary };
}

/** Producers the given building needs first, in build order (ordering only —
 *  the simulation decides whether each step waits for income or cancels). */
function collectProducerChain(
  input: BuildPlanInput,
  need: BuildingKind,
  planned: Set<BuildingKind>,
  depth: number,
): PlanStep[] {
  if (depth > MAX_PRODUCER_DEPTH) return [];
  const needDef = BUILDING_DEFINITIONS[need];
  const steps: PlanStep[] = [];
  for (const { resource } of costShortfall(needDef.cost, input.resources)) {
    const producer = bestProducer(input, resource, planned);
    if (!producer) continue;
    planned.add(producer);
    const pre = collectProducerChain(input, producer, planned, depth + 1);
    steps.push(...pre, {
      kind: 'build',
      building: producer,
      toLevel: (input.buildings[producer] ?? 0) + 1,
      produces: resource,
    });
  }
  return steps;
}

/**
 * The cheapest producer of `resource` the planet can still raise, or undefined.
 * Deterministic ordering: total cost, then build time, then next-level output,
 * then content order for ties. Never reuses a planned kind and never picks the
 * target itself (raising the target is the goal, not a step toward it).
 */
function bestProducer(
  input: BuildPlanInput,
  resource: ResourceKey,
  planned: Set<BuildingKind>,
): BuildingKind | undefined {
  const candidates = BUILDING_KINDS.filter((kind) => {
    if (planned.has(kind)) return false;
    const def = BUILDING_DEFINITIONS[kind];
    if (!def.produces.includes(resource)) return false;
    const pending = input.activeOrders.filter((o) => o.building === kind).length;
    return (input.buildings[kind] ?? 0) + pending < def.maxLevel;
  });
  const scored = candidates
    .map((kind) => ({
      kind,
      cost: totalCost(BUILDING_DEFINITIONS[kind].cost),
      ticks: BUILDING_DEFINITIONS[kind].buildTicks,
      output: nextLevelOutput(kind, input.buildings, input.abundance)[resource],
      order: BUILDING_KINDS.indexOf(kind),
    }))
    .sort(
      (a, b) => a.cost - b.cost || a.ticks - b.ticks || b.output - a.output || a.order - b.order,
    );
  return scored[0]?.kind;
}

/** The cheapest producer of `resource` regardless of the plan's target — used
 *  only to name the blocker in dead-end messages. */
function cheapestProducerFor(
  input: BuildPlanInput,
  resource: ResourceKey,
): BuildingKind | undefined {
  const candidates = BUILDING_KINDS.filter((kind) => {
    const def = BUILDING_DEFINITIONS[kind];
    if (!def.produces.includes(resource)) return false;
    const pending = input.activeOrders.filter((o) => o.building === kind).length;
    return (input.buildings[kind] ?? 0) + pending < def.maxLevel;
  });
  candidates.sort(
    (a, b) =>
      totalCost(BUILDING_DEFINITIONS[a].cost) - totalCost(BUILDING_DEFINITIONS[b].cost) ||
      BUILDING_KINDS.indexOf(a) - BUILDING_KINDS.indexOf(b),
  );
  return candidates[0];
}

/** Output of a producer at its next level, for tie-breaking. */
function nextLevelOutput(
  kind: BuildingKind,
  buildings: BuildingLevels,
  abundance: Abundance,
): ResourceRates {
  const level = (buildings[kind] ?? 0) + 1;
  const rates = emptyRates();
  for (const r of BUILDING_DEFINITIONS[kind].produces) {
    rates[r] = Math.floor((ECONOMY.production.baseOutputPerLevel * level * abundance[r]) / 100);
  }
  return rates;
}

/**
 * Walk the plan against the engine formulas: wait while a step's cost is short
 * (accumulating at the current built set's net rates, clamped at the storage
 * cap), cancel pending orders when a deficit has no income (refunding exactly
 * like the engine, cheapest first), then commit and build. After the goal,
 * restore whatever the plan cancelled that it did not also raise. Returns the
 * ordered steps (cancels + builds) and the estimated ticks, or `ok: false`
 * when a deficit can be neither earned nor refunded.
 */
function simulate(
  input: BuildPlanInput,
  ordered: SimStep[],
): { ok: boolean; ticks: number; steps: PlanStep[] } {
  const effects = input.effects ?? emptyTechnologyEffects();
  const buildings: BuildingLevels = { ...input.buildings };
  const budget: ResourceStore = { ...input.resources };
  const cap = storageCapForLevel(buildings.storehouse ?? 0, effects);
  const steps: PlanStep[] = [];
  let ticks = 0;
  // Orders still refundable; the plan never cancels a kind it is also raising.
  const plannedKinds = new Set(ordered.map((s) => s.building));
  let cancellable = input.activeOrders.map((o, index) => ({ ...o, index }));

  const performBuild = (building: BuildingKind): boolean => {
    const def = BUILDING_DEFINITIONS[building];
    let guard = 0;
    while (costShortfall(def.cost, budget).length > 0) {
      if (guard++ > MAX_SIMULATION_TICKS) return false;
      // The engine's economy: production × abundance, minus upkeep, with the
      // same brownout rule — when stored + produced energy cannot cover energy
      // upkeep, production is halved.
      const rates = buildingNetRates(buildings, input.abundance);
      const brownout = budget.energy + rates.production.energy < rates.upkeep.energy;
      const production = brownout ? halveRates(rates.production) : rates.production;
      const net: ResourceRates = {
        metal: production.metal - rates.upkeep.metal,
        mineral: production.mineral - rates.upkeep.mineral,
        food: production.food - rates.upkeep.food,
        energy: production.energy - rates.upkeep.energy,
      };
      const deficits = costShortfall(def.cost, budget);

      // A deficit resource with no income can be funded by cancelling a
      // pending order (full refund, clamped at the cap, exactly like the
      // engine): cancel the smallest refunds first so the player gives up as
      // little as possible.
      const blocked = deficits.find((d) => net[d.resource] <= 0);
      if (blocked) {
        const candidates = cancellable
          .filter((o) => !plannedKinds.has(o.building) && (o.cost[blocked.resource] ?? 0) > 0)
          .sort(
            (a, b) =>
              (a.cost[blocked.resource] ?? 0) - (b.cost[blocked.resource] ?? 0) ||
              a.index - b.index,
          );
        let cancelledAny = false;
        for (const c of candidates) {
          cancellable = cancellable.filter((x) => x.index !== c.index);
          steps.push({ kind: 'cancel', building: c.building, refunds: c.cost });
          for (const r of RESOURCE_KEYS) {
            const amt = Math.floor((c.cost[r] ?? 0) * CONSTRUCTION.refundFraction);
            budget[r] = Math.min(cap, budget[r] + amt);
          }
          cancelledAny = true;
          if (budget[blocked.resource] >= (def.cost[blocked.resource] ?? 0)) break;
        }
        if (!cancelledAny) return false;
        continue;
      }

      let wait = 0;
      for (const { resource, amount } of deficits) {
        wait = Math.max(wait, Math.ceil(amount / net[resource]));
      }
      ticks += wait;
      for (const r of RESOURCE_KEYS) {
        // Stores floor at zero: upkeep can starve a resource but never send it
        // negative, which would create phantom deficits for zero-cost resources.
        budget[r] = Math.max(0, Math.min(cap, budget[r] + wait * net[r]));
      }
    }
    for (const [r, amount] of Object.entries(def.cost)) {
      budget[r as ResourceKey] -= amount;
    }
    ticks += def.buildTicks;
    buildings[building] = (buildings[building] ?? 0) + 1;
    steps.push({
      kind: 'build',
      building,
      toLevel: buildings[building],
      produces: def.produces[0],
    });
    return true;
  };

  for (const step of ordered) {
    if (!performBuild(step.building)) return { ok: false, ticks, steps };
  }

  // Restoration: rebuild anything the plan cancelled that it did not already
  // raise, so the player is not left worse off than before the plan.
  const cancelled = steps.filter(
    (s): s is Extract<PlanStep, { kind: 'cancel' }> => s.kind === 'cancel',
  );
  for (const c of cancelled) {
    const alreadyPlanned = steps.some((s) => s.kind === 'build' && s.building === c.building);
    if (alreadyPlanned) continue;
    if ((buildings[c.building] ?? 0) >= BUILDING_DEFINITIONS[c.building].maxLevel) continue;
    if (!performBuild(c.building)) return { ok: false, ticks, steps };
  }

  return { ok: true, ticks, steps };
}

/** The honest dead-end answer when a deficit can be neither earned nor refunded. */
function noPathPlan(
  input: BuildPlanInput,
  def: BuildingDefinition,
  shortfall: Array<{ resource: ResourceKey; amount: number }>,
): BuildPlan {
  const rates = buildingNetRates(input.buildings, input.abundance).net;
  let ticks = 0;
  let stuck: ResourceKey | undefined;
  for (const { resource, amount } of shortfall) {
    if (rates[resource] <= 0) {
      stuck ??= resource;
      continue;
    }
    ticks = Math.max(ticks, Math.ceil(amount / rates[resource]));
  }
  if (stuck) {
    const r = stuck;
    const producer = cheapestProducerFor(input, r);
    const refundable = input.activeOrders.reduce(
      (sum, o) => sum + Math.floor((o.cost[r] ?? 0) * CONSTRUCTION.refundFraction),
      0,
    );
    const producerPart = producer
      ? `the only producer (${BUILDING_DEFINITIONS[producer].name}, ${formatCost(
          BUILDING_DEFINITIONS[producer].cost,
        )}) is out of reach`
      : `no building here produces ${resourceLabel(r)}`;
    return {
      status: 'no-path',
      steps: [],
      ticks: 0,
      summary: `No path to ${def.name}: ${producerPart} — ${resourceLabel(r)} has no income here (${
        rates[r]
      }/tick), you hold ${input.resources[r]}, and ${refundable} is refundable.`,
    };
  }
  return {
    status: 'no-path',
    steps: [],
    ticks,
    summary: `No affordable producer helps here — ${resourceLabel(shortfall[0].resource)} accumulates in ~${ticks} tick${
      ticks === 1 ? '' : 's'
    } at the current rate.`,
  };
}

// -- helpers ----------------------------------------------------------------

function costShortfall(
  cost: Partial<ResourceStore>,
  resources: ResourceStore,
): Array<{ resource: ResourceKey; amount: number }> {
  const out: Array<{ resource: ResourceKey; amount: number }> = [];
  for (const r of RESOURCE_KEYS) {
    const need = cost[r] ?? 0;
    const have = resources[r];
    if (need > have) out.push({ resource: r, amount: need - have });
  }
  return out;
}

function totalCost(cost: Partial<ResourceStore>): number {
  return RESOURCE_KEYS.reduce((sum, r) => sum + (cost[r] ?? 0), 0);
}

function totalBuildTicks(steps: PlanStep[]): number {
  return steps.reduce(
    (sum, s) => sum + (s.kind === 'build' ? BUILDING_DEFINITIONS[s.building].buildTicks : 0),
    0,
  );
}

function emptyRates(): ResourceRates {
  return { metal: 0, mineral: 0, food: 0, energy: 0 };
}

function halveRates(rates: ResourceRates): ResourceRates {
  const factor = ECONOMY.brownoutProductionFactor;
  return {
    metal: Math.floor(rates.metal * factor),
    mineral: Math.floor(rates.mineral * factor),
    food: Math.floor(rates.food * factor),
    energy: Math.floor(rates.energy * factor),
  };
}

function formatCost(cost: Partial<ResourceStore>): string {
  return RESOURCE_KEYS.filter((r) => (cost[r] ?? 0) > 0)
    .map((r) => `${cost[r]} ${r}`)
    .join(', ');
}

function resourceLabel(r: ResourceKey): string {
  return r.charAt(0).toUpperCase() + r.slice(1);
}
