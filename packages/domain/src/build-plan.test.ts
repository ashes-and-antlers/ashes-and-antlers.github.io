import { describe, expect, it } from 'vitest';
import type { BuildingKind, BuildingLevels, ResourceStore } from '@ashes/contracts';
import type { Abundance } from '@ashes/contracts';
import { BUILDING_DEFINITIONS } from '@ashes/content';
import { planBuildOrder, type BuildPlan, type BuildPlanInput } from './build-plan';

/** Even abundance of 100 makes mine/extractor/farm/reactor output exactly
 *  baseOutputPerLevel × level per tick — clean numbers for assertions. */
const ABUNDANT: Abundance = { metal: 100, mineral: 100, food: 100, energy: 100 };

function state(overrides: {
  resources?: Partial<ResourceStore>;
  buildings?: BuildingLevels;
  activeOrders?: Array<{ building: BuildingKind; cost?: Partial<ResourceStore> }>;
}): BuildPlanInput {
  return {
    resources: { metal: 100, mineral: 50, food: 200, energy: 50, ...overrides.resources },
    buildings: { settlement: 1, ...overrides.buildings },
    abundance: ABUNDANT,
    activeOrders: (overrides.activeOrders ?? []).map((o) => ({
      building: o.building,
      cost: o.cost ?? BUILDING_DEFINITIONS[o.building].cost,
    })),
  };
}

const isPlan = (p: BuildPlan): p is Extract<BuildPlan, { status: 'plan' }> => p.status === 'plan';
const buildSteps = (p: Extract<BuildPlan, { status: 'plan' }>) =>
  p.steps.filter((s) => s.kind === 'build');
const cancelSteps = (p: Extract<BuildPlan, { status: 'plan' }>) =>
  p.steps.filter(
    (s): s is Extract<BuildPlan, { status: 'plan' }>['steps'][number] & { kind: 'cancel' } =>
      s.kind === 'cancel',
  );

describe('planBuildOrder', () => {
  it('reports affordable when the store covers the cost', () => {
    const plan = planBuildOrder(state({}), 'mine');
    expect(plan.status).toBe('affordable');
  });

  it('plans a single producer step when one resource falls short', () => {
    // Extractor costs metal 120 + mineral 40; we hold 80 metal, so the mine
    // (60 metal) is the missing income and is itself affordable.
    const plan = planBuildOrder(
      state({ resources: { metal: 80, mineral: 50, food: 200, energy: 50 } }),
      'extractor',
    );
    expect(plan.status).toBe('plan');
    if (!isPlan(plan)) return;
    expect(buildSteps(plan)).toEqual([
      { kind: 'build', building: 'mine', toLevel: 1, produces: 'metal' },
      { kind: 'build', building: 'extractor', toLevel: 1, produces: 'mineral' },
    ]);
    // 2 ticks build the mine, then saving 100 metal at +10/tick, then 3 ticks
    // for the extractor itself.
    expect(plan.ticks).toBe(2 + 10 + 3);
    expect(plan.summary).toContain('Metal Mine');
    expect(plan.summary).toContain('Mineral Extractor');
  });

  it('plans a chained producer set when several resources fall short', () => {
    // Shipyard costs metal 300 + mineral 150. Hold 220 metal / 100 mineral:
    // need a mine (metal) AND an extractor (mineral), both affordable.
    const plan = planBuildOrder(
      state({ resources: { metal: 220, mineral: 100, food: 200, energy: 50 } }),
      'shipyard',
    );
    expect(plan.status).toBe('plan');
    if (!isPlan(plan)) return;
    expect(buildSteps(plan)).toEqual([
      { kind: 'build', building: 'mine', toLevel: 1, produces: 'metal' },
      { kind: 'build', building: 'extractor', toLevel: 1, produces: 'mineral' },
      { kind: 'build', building: 'shipyard', toLevel: 1, produces: undefined },
    ]);
    expect(plan.ticks).toBeGreaterThan(0);
  });

  it('cancels a pending order to fund the keystone producer when income is zero', () => {
    // The soft-lock: hold 50 metal (the farm order reserved the other 50) and
    // no metal income, so the only metal producer (mine, 60) is out of reach.
    // The plan must recycle the farm's full refund to fund the mine, then
    // restore the farm after the goal.
    const plan = planBuildOrder(
      state({
        resources: { metal: 50, mineral: 50, food: 200, energy: 50 },
        activeOrders: [{ building: 'farm', cost: { metal: 50 } }],
      }),
      'storehouse',
    );
    expect(plan.status).toBe('plan');
    if (!isPlan(plan)) return;
    expect(cancelSteps(plan)).toEqual([
      { kind: 'cancel', building: 'farm', refunds: { metal: 50 } },
    ]);
    // The plan raises the mine, reaches the storehouse, then rebuilds the farm.
    expect(buildSteps(plan).map((s) => s.building)).toEqual(['mine', 'storehouse', 'farm']);
    expect(plan.summary).toContain('Cancel Farm');
    expect(plan.summary).toContain('Metal Mine');
  });

  it('cancels the cheapest refund first when several orders could fund the gap', () => {
    // Two pending orders, both refundable metal; the smallest (the mine's own
    // 60 is not cancellable — it is the producer being planned, so the farm's
    // 50 and the reactor's spare metal remain). Only the farm is refunded.
    const plan = planBuildOrder(
      state({
        resources: { metal: 30, mineral: 50, food: 200, energy: 50 },
        activeOrders: [
          { building: 'farm', cost: { metal: 50 } },
          { building: 'reactor', cost: { metal: 200, mineral: 60 } },
        ],
      }),
      'storehouse',
    );
    expect(plan.status).toBe('plan');
    if (!isPlan(plan)) return;
    expect(cancelSteps(plan).map((s) => s.building)).toEqual(['farm']);
  });

  it('waits out the deficit when the producer is the target itself', () => {
    // A mine at L1 earns metal; raising it to L2 costs 60 metal while we hold
    // only 10. The only metal producer is the mine (the target), so the honest
    // plan is to save at the current +10/tick income.
    const plan = planBuildOrder(
      state({
        resources: { metal: 10, mineral: 50, food: 200, energy: 50 },
        buildings: { settlement: 1, mine: 1 },
      }),
      'mine',
    );
    expect(plan.status).toBe('plan');
    if (!isPlan(plan)) return;
    // 5 ticks saving 50 metal at +10/tick, then 2 ticks for the build itself.
    expect(plan.ticks).toBe(5 + 2);
    expect(buildSteps(plan)).toEqual([
      { kind: 'build', building: 'mine', toLevel: 2, produces: 'metal' },
    ]);
  });

  it('blocks when the queue is full, before suggesting steps', () => {
    const activeOrders = [
      { building: 'mine' as const },
      { building: 'farm' as const },
      { building: 'reactor' as const },
    ];
    const plan = planBuildOrder(state({ activeOrders }), 'extractor');
    expect(plan.status).toBe('blocked-queue');
    expect(plan.summary).toContain('queue is full');
  });

  it('blocks when the building is already at its max level', () => {
    const plan = planBuildOrder(
      state({ buildings: { settlement: BUILDING_DEFINITIONS.settlement.maxLevel } }),
      'settlement',
    );
    expect(plan.status).toBe('blocked-maxed');
  });

  it('reports a dead end with honest numbers when nothing can fund the producer', () => {
    // 10 metal, no income, no pending order to refund: the mine (60 metal) is
    // the only producer and is out of reach — a true dead end.
    const plan = planBuildOrder(
      state({ resources: { metal: 10, mineral: 50, food: 200, energy: 50 } }),
      'mine',
    );
    expect(plan.status).toBe('no-path');
    if (plan.status !== 'no-path') return;
    expect(plan.ticks).toBe(0);
    expect(plan.summary).toContain('Metal Mine');
    expect(plan.summary).toContain('you hold 10');
    expect(plan.summary).toContain('0 is refundable');
  });

  it('is deterministic: identical input yields an identical plan', () => {
    const input = state({ resources: { metal: 80, mineral: 50, food: 200, energy: 50 } });
    expect(planBuildOrder(input, 'extractor')).toEqual(planBuildOrder(input, 'extractor'));
  });
});
