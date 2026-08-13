import { useState } from 'react';
import {
  BUILDING_KINDS,
  RESOURCE_KEYS,
  type BuildingKind,
  type ConstructionOrderView,
  type PlanetView,
  type ResourceRates,
  type ShipKind,
  type ShipyardOrderView,
} from '@ashes/contracts';
import {
  BUILDING_DEFINITIONS,
  CONSTRUCTION,
  ECONOMY,
  RESEARCH_BY_ID,
  SHIP_DEFINITIONS,
  SHIP_ORDER,
  SHIPYARD,
  type BuildingCategory,
} from '@ashes/content';
import { planBuildOrder } from '@ashes/domain';
import {
  ApiError,
  cancelConstruction,
  cancelShipOrder,
  submitQueueShip,
  submitStartBuilding,
} from './api';
import { RESOURCE_NAMES, SectionHelp } from './planet-ui';

/** Catalog groups in display order. Buildings declare their category in
 *  content, so new kinds slot into the right group with no UI changes; a
 *  category without a known group falls back to the end of the list. */
const CATALOG_GROUPS: Array<{ category: BuildingCategory; label: string }> = [
  { category: 'extraction', label: 'Extraction' },
  { category: 'infrastructure', label: 'Infrastructure' },
  { category: 'advanced', label: 'Advanced' },
];

export function BuildingsSection({
  view,
  worldId,
  worldVersion,
  onStateChange,
}: {
  view: PlanetView;
  worldId: string;
  worldVersion: number;
  onStateChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const active = view.construction.filter(
    (o): o is ConstructionOrderView & { position: number } =>
      o.status === 'building' || o.status === 'queued',
  );
  const history = view.construction.filter(
    (o) => o.status === 'completed' || o.status === 'cancelled',
  );

  const startBuilding = async (building: BuildingKind) => {
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await submitStartBuilding({
        worldId,
        planetId: view.id,
        building,
        expectedVersion: worldVersion,
      });
      const name = BUILDING_DEFINITIONS[building].name;
      setNotice({
        kind: 'ok',
        text:
          receipt.status === 'building'
            ? `${name} is under construction — completes in ${receipt.ticksRemaining} tick${receipt.ticksRemaining === 1 ? '' : 's'}.`
            : `${name} queued behind ${receipt.position} order${receipt.position === 1 ? '' : 's'}.`,
      });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      setNotice({ kind: 'error', text: code === undefined ? message : `${message} (${code})` });
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (order: ConstructionOrderView) => {
    setBusy(true);
    setNotice(null);
    try {
      await cancelConstruction({ worldId, orderId: order.id, expectedVersion: worldVersion });
      setNotice({ kind: 'ok', text: 'Construction cancelled — the reserved cost is refunded.' });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      setNotice({ kind: 'error', text: code === undefined ? message : `${message} (${code})` });
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  const queueFull = active.length >= CONSTRUCTION.queueCapacity;
  const buildCount = Object.values(view.buildings).reduce((a, b) => a + b, 0);
  const groups = catalogGroups();

  return (
    <section className="panel planet-buildings" aria-labelledby="buildings-heading">
      <h2 id="buildings-heading" className="panel-title">
        Buildings
      </h2>

      <div className="buildings-top">
        {/* Raised: what stands on the world, grouped by the same categories
            the catalog uses, with each level's per-tick effect. */}
        <div className="buildings-raised">
          <h3 className="ledger-subtitle">Raised</h3>
          {buildCount === 0 ? (
            <p className="empty-state">Nothing raised yet — pick a building below.</p>
          ) : (
            <div className="building-groups" data-testid="planet-buildings">
              {groups.map((group) => {
                const kinds = BUILDING_KINDS.filter(
                  (kind) =>
                    BUILDING_DEFINITIONS[kind].category === group.category &&
                    (view.buildings[kind] ?? 0) > 0,
                );
                if (kinds.length === 0) return null;
                return (
                  <div key={group.category}>
                    <p className="building-group-title">{group.label}</p>
                    <ul className="building-list">
                      {kinds.map((kind) => {
                        const level = view.buildings[kind] ?? 0;
                        return (
                          <li key={kind}>
                            <span className="building-list-main">
                              <span className="building-kind">
                                {BUILDING_DEFINITIONS[kind].name}
                              </span>
                              <span className="building-list-effect mono">
                                {buildingEffect(kind, level, view)}
                              </span>
                            </span>
                            <span
                              className="building-level mono"
                              data-testid={`building-level-${kind}`}
                            >
                              L{level}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Queue: what is being raised and in what order. */}
        <div className="buildings-queue">
          <h3 className="ledger-subtitle">Construction queue</h3>
          {active.length === 0 && history.length === 0 ? (
            <p className="empty-state">No construction orders on this world.</p>
          ) : (
            <ul className="construction-queue" data-testid="construction-queue">
              {active.map((o) => (
                <li
                  key={o.id}
                  className={`construction-order order-${o.status}`}
                  data-testid={`order-${o.id}`}
                >
                  <span className="construction-order-main">
                    <span className="building-kind">{BUILDING_DEFINITIONS[o.building].name}</span>
                    {o.status === 'building' ? (
                      <span
                        className="construction-order-eta mono"
                        data-testid={`order-eta-${o.id}`}
                      >
                        {o.ticksRemaining} tick{o.ticksRemaining === 1 ? '' : 's'} left
                      </span>
                    ) : (
                      <span className="construction-order-eta mono">
                        position {o.position + 1} of {active.length}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="cancel-button"
                    data-testid={`cancel-${o.id}`}
                    onClick={() => void cancel(o)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </li>
              ))}
              {history.map((o) => (
                <li key={o.id} className={`construction-order order-${o.status}`}>
                  <span className="construction-order-main">
                    <span className="building-kind">{BUILDING_DEFINITIONS[o.building].name}</span>
                    <span className="construction-order-eta mono">
                      {o.status === 'completed'
                        ? `completed at tick ${o.completedAtTick}`
                        : 'cancelled'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h4 className="construction-subheading">Raise a building</h4>
      <BuildingCatalog
        view={view}
        queueFull={queueFull}
        busy={busy}
        onStart={(kind) => void startBuilding(kind)}
      />

      {notice && (
        <p
          className={`command-notice notice-${notice.kind}`}
          data-testid="construction-notice"
          role="status"
        >
          {notice.text}
        </p>
      )}
      <SectionHelp id="construction">
        <p>
          One building is raised at a time and its full cost is reserved from the local store the
          moment you commit — a second order can never spend resources that are already committed.
          Each level takes a fixed number of ticks; a building that completes on a tick starts
          producing on the next one. Cancelling returns the reserved cost, clamped to the storage
          cap, and progress is lost.
        </p>
      </SectionHelp>
    </section>
  );
}

/** Ordered catalog groups (known first, then content categories with no UI slot). */
function catalogGroups(): Array<{ category: BuildingCategory; label: string }> {
  const groups = [...CATALOG_GROUPS];
  for (const kind of BUILDING_KINDS) {
    const category = BUILDING_DEFINITIONS[kind].category;
    if (!groups.some((g) => g.category === category)) groups.push({ category, label: category });
  }
  return groups;
}

/**
 * The "Raise a building" catalog, grouped by the category each building
 * declares in content. Groups are collapsible and show how many of their
 * buildings the store can afford right now, so the list stays scannable as
 * more kinds ship — new buildings only need a category in content.
 */
function BuildingCatalog({
  view,
  queueFull,
  busy,
  onStart,
}: {
  view: PlanetView;
  queueFull: boolean;
  busy: boolean;
  onStart: (kind: BuildingKind) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<BuildingCategory>>(
    () => new Set(CATALOG_GROUPS.map((g) => g.category)),
  );

  const toggle = (category: BuildingCategory) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  const groups = catalogGroups();

  return (
    <ul className="building-catalog" data-testid="building-catalog">
      {groups.map((group) => {
        const kinds = BUILDING_KINDS.filter(
          (kind) => BUILDING_DEFINITIONS[kind].category === group.category,
        );
        if (kinds.length === 0) return null;
        const affordable = kinds.filter((kind) => {
          const def = BUILDING_DEFINITIONS[kind];
          const level = view.buildings[kind] ?? 0;
          const pending = view.construction.filter(
            (o) => o.building === kind && (o.status === 'building' || o.status === 'queued'),
          ).length;
          if (level + pending >= def.maxLevel) return false;
          return RESOURCE_KEYS.every((r) => view.resources[r] >= (def.cost[r] ?? 0));
        }).length;
        return (
          <li
            key={group.category}
            className="building-catalog-group"
            data-testid={`catalog-group-${group.category}`}
          >
            <button
              type="button"
              className="building-catalog-group-head"
              data-testid={`catalog-group-toggle-${group.category}`}
              aria-expanded={open.has(group.category)}
              onClick={() => toggle(group.category)}
            >
              <span className="building-catalog-group-title">{group.label}</span>
              <span className="building-catalog-group-meta mono">
                {kinds.length} building{kinds.length === 1 ? '' : 's'} · {affordable} affordable
              </span>
            </button>
            {open.has(group.category) ? (
              <ul className="building-catalog-group-list">
                {kinds.map((kind) => (
                  <BuildingCatalogRow
                    key={kind}
                    kind={kind}
                    view={view}
                    queueFull={queueFull}
                    busy={busy}
                    onStart={() => onStart(kind)}
                  />
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function BuildingCatalogRow({
  kind,
  view,
  queueFull,
  busy,
  onStart,
}: {
  kind: BuildingKind;
  view: PlanetView;
  queueFull: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const def = BUILDING_DEFINITIONS[kind];
  const level = view.buildings[kind] ?? 0;
  const pendingSameKind = view.construction.filter(
    (o) => o.building === kind && (o.status === 'building' || o.status === 'queued'),
  ).length;
  const atMax = level + pendingSameKind >= def.maxLevel;
  const missing = RESOURCE_KEYS.filter((r) => view.resources[r] < (def.cost[r] ?? 0));
  const affordable = missing.length === 0;
  const disabled = busy || atMax || queueFull || !affordable;
  const [showPlan, setShowPlan] = useState(false);

  const reason = atMax
    ? `already at max level ${def.maxLevel}`
    : queueFull
      ? 'the construction queue is full'
      : !affordable
        ? missing
            .map((r) => `${resourceLabel(r)} ${view.resources[r]}/${def.cost[r] ?? 0}`)
            .join(', ')
        : '';

  // Only a resource shortfall gets a plan; queue-full and maxed are their own
  // clear blockers. The planner is pure and deterministic — it recomputes on
  // every poll and always reflects the current store.
  const canPlan = !affordable && !atMax && !queueFull;
  const plan = canPlan
    ? planBuildOrder(
        {
          resources: view.resources,
          buildings: view.buildings,
          abundance: view.abundance,
          activeOrders: view.construction
            .filter((o) => o.status === 'building' || o.status === 'queued')
            .map((o) => ({ building: o.building, cost: o.cost })),
        },
        kind,
      )
    : null;

  return (
    <li className="building-catalog-row" title={def.summary}>
      <div className="building-catalog-tile-head">
        <span className="building-kind">{def.name}</span>
        <span className="building-catalog-level mono">
          L{level} → L{level + 1}
        </span>
        <span className="building-catalog-effect mono">
          {buildingEffect(kind, level + 1, view)}
        </span>
      </div>
      <div className="building-catalog-tile-foot">
        <span className="building-catalog-meta mono">
          {formatCost(def.cost)} · {def.buildTicks} tick{def.buildTicks === 1 ? '' : 's'}
        </span>
        <span className="building-catalog-actions">
          {canPlan ? (
            <button
              type="button"
              className="plan-toggle"
              data-testid={`plan-toggle-${kind}`}
              aria-expanded={showPlan}
              onClick={() => setShowPlan((v) => !v)}
            >
              {showPlan ? 'Hide plan' : 'How to afford'}
            </button>
          ) : null}
          <button
            type="button"
            className="build-button"
            data-testid={`build-${kind}`}
            onClick={onStart}
            disabled={disabled}
            title={reason === '' ? undefined : reason}
          >
            {atMax ? `Max level ${def.maxLevel}` : `Raise to L${level + 1}`}
          </button>
        </span>
      </div>
      {!affordable && !atMax && !queueFull ? (
        <p className="building-catalog-shortfall mono">
          needs{' '}
          {missing
            .map((r) => `${resourceLabel(r)} ${(def.cost[r] ?? 0) - view.resources[r]} more`)
            .join(', ')}
        </p>
      ) : null}
      {canPlan && showPlan && plan ? (
        <div className="build-plan" data-testid={`plan-${kind}`}>
          <p className="build-plan-summary">{plan.summary}</p>
          {plan.status === 'plan' ? (
            <ol className="build-plan-steps">
              {plan.steps.map((step, i) => (
                <li
                  key={i}
                  className={step.kind === 'cancel' ? 'build-plan-step-cancel' : undefined}
                >
                  {step.kind === 'cancel' ? (
                    <>
                      Cancel {BUILDING_DEFINITIONS[step.building].name}
                      <span className="build-plan-step-for">
                        {' '}
                        refunds {formatCost(step.refunds)}
                      </span>
                    </>
                  ) : (
                    <>
                      {BUILDING_DEFINITIONS[step.building].name} → L{step.toLevel}
                      {step.produces ? (
                        <span className="build-plan-step-for">
                          {' '}
                          produces {resourceLabel(step.produces)}
                        </span>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
          <p className="build-plan-note">
            Estimate assumes one building at a time and no other spending; the real tick count
            follows your store each tick.
          </p>
        </div>
      ) : null}
    </li>
  );
}

function resourceLabel(key: (typeof RESOURCE_KEYS)[number]): string {
  return RESOURCE_NAMES.find(([k]) => k === key)?.[1] ?? key;
}

/**
 * A building's per-tick output at a given level on a given planet, using the
 * same formula the engine resolves (content ECONOMY + the planet's abundance):
 * output = floor(baseOutputPerLevel × level × abundance / 100). Kept here so
 * the catalog can show true next-level numbers; the engine is still the only
 * authority — this is presentation of the documented formula.
 */
function buildingOutput(kind: BuildingKind, level: number, view: PlanetView): ResourceRates {
  const def = BUILDING_DEFINITIONS[kind];
  const rates = emptyRates();
  for (const r of def.produces) {
    rates[r] = Math.floor(
      (ECONOMY.production.baseOutputPerLevel * level * view.abundance[r]) / 100,
    );
  }
  return rates;
}

function emptyRates(): ResourceRates {
  return { metal: 0, mineral: 0, food: 0, energy: 0 };
}

function buildingUpkeep(kind: BuildingKind, level: number): ResourceRates {
  const def = BUILDING_DEFINITIONS[kind];
  const rates = emptyRates();
  for (const [r, amount] of Object.entries(def.upkeep)) {
    rates[r as (typeof RESOURCE_KEYS)[number]] = amount * level;
  }
  return rates;
}

/**
 * A compact, content-derived description of a building's per-tick effect at
 * a level, e.g. "+12 metal · −2 energy" for a level 2 mine on a metal-rich
 * world. Empty output/upkeep (settlement, storehouse, lab, shipyard) yields
 * their structural line instead, so a player always knows what they are for.
 */
function buildingEffect(kind: BuildingKind, level: number, view: PlanetView): string {
  const def = BUILDING_DEFINITIONS[kind];
  const output = buildingOutput(kind, level, view);
  const upkeep = buildingUpkeep(kind, level);
  const parts: string[] = [];
  for (const [r, label] of RESOURCE_NAMES) {
    const out = output[r];
    if (out > 0) parts.push(`+${out} ${label.toLowerCase()}`);
  }
  for (const [r, label] of RESOURCE_NAMES) {
    const up = upkeep[r];
    if (up > 0) parts.push(`−${up} ${label.toLowerCase()}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  // Structural buildings have no per-tick rates; show what the level does.
  switch (kind) {
    case 'settlement':
      return `+${ECONOMY.population.perSettlementLevel * level} population capacity`;
    case 'storehouse':
      return `+${ECONOMY.storage.perStorehouseLevel * level} storage per resource`;
    default:
      return def.summary;
  }
}

function formatCost(cost: Partial<ResourceRates>): string {
  const parts = RESOURCE_KEYS.filter((r) => (cost[r] ?? 0) > 0).map(
    (r) => `${resourceLabel(r)} ${cost[r]}`,
  );
  return parts.length === 0 ? 'free' : parts.join(', ');
}

/**
 * The shipyard: the per-planet production queue fed by the Shipyard building.
 * Ships complete at tick boundaries and land in the planet's local fleet
 * exactly once. Costs are reserved at submission like construction; research
 * unlocks the advanced hulls.
 */
export function ShipyardSection({
  view,
  worldId,
  worldVersion,
  completedTechs,
  onStateChange,
}: {
  view: PlanetView;
  worldId: string;
  worldVersion: number;
  completedTechs: string[];
  onStateChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [quantity, setQuantity] = useState<Record<ShipKind, number>>(() => ({
    scout: 1,
    freighter: 1,
    outpost: 1,
    fighter: 1,
  }));

  const hasYard = (view.buildings.shipyard ?? 0) > 0;
  const active = view.shipyard.filter(
    (o): o is ShipyardOrderView & { position: number } =>
      o.status === 'building' || o.status === 'queued',
  );
  const history = view.shipyard.filter((o) => o.status === 'completed' || o.status === 'cancelled');
  const queueFull = active.length >= SHIPYARD.queueCapacity;

  const queueShip = async (ship: ShipKind) => {
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await submitQueueShip({
        worldId,
        planetId: view.id,
        ship,
        quantity: quantity[ship],
        expectedVersion: worldVersion,
      });
      const def = SHIP_DEFINITIONS[ship];
      setNotice({
        kind: 'ok',
        text:
          receipt.status === 'building'
            ? `${def.name} × ${receipt.quantity} under construction — ${receipt.ticksRemaining} tick${receipt.ticksRemaining === 1 ? '' : 's'} to launch.`
            : `${def.name} × ${receipt.quantity} queued behind ${receipt.position} order${receipt.position === 1 ? '' : 's'}.`,
      });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      setNotice({ kind: 'error', text: code === undefined ? message : `${message} (${code})` });
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (order: ShipyardOrderView) => {
    setBusy(true);
    setNotice(null);
    try {
      await cancelShipOrder({ worldId, orderId: order.id, expectedVersion: worldVersion });
      setNotice({ kind: 'ok', text: 'Ship order cancelled — the reserved cost is refunded.' });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      setNotice({ kind: 'error', text: code === undefined ? message : `${message} (${code})` });
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel planet-shipyard" aria-labelledby="shipyard-heading">
      <h2 id="shipyard-heading" className="panel-title">
        Shipyard
      </h2>

      {!hasYard ? (
        <p className="shipyard-absent-note" data-testid="shipyard-absent">
          No Shipyard on this world yet — raise one in the Buildings panel above and these hulls
          become buildable.
        </p>
      ) : null}
      {hasYard ? (
        <>
          <h3 className="ledger-subtitle">Yard queue</h3>
          {active.length === 0 && history.length === 0 ? (
            <p className="empty-state">The yard is idle.</p>
          ) : (
            <ul className="construction-queue" data-testid="shipyard-queue">
              {active.map((o) => (
                <li
                  key={o.id}
                  className={`construction-order order-${o.status}`}
                  data-testid={`ship-order-${o.id}`}
                >
                  <span className="construction-order-main">
                    <span className="building-kind">
                      {SHIP_DEFINITIONS[o.ship].name} × {o.quantity}
                    </span>
                    {o.status === 'building' ? (
                      <span className="construction-order-eta mono">
                        {o.ticksRemaining} tick{o.ticksRemaining === 1 ? '' : 's'} left
                      </span>
                    ) : (
                      <span className="construction-order-eta mono">
                        position {o.position + 1} of {active.length}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="cancel-button"
                    data-testid={`cancel-ship-${o.id}`}
                    onClick={() => void cancel(o)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </li>
              ))}
              {history.map((o) => (
                <li key={o.id} className={`construction-order order-${o.status}`}>
                  <span className="construction-order-main">
                    <span className="building-kind">
                      {SHIP_DEFINITIONS[o.ship].name} × {o.quantity}
                    </span>
                    <span className="construction-order-eta mono">
                      {o.status === 'completed'
                        ? `delivered to local fleet at tick ${o.completedAtTick}`
                        : 'cancelled'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <h4 className="construction-subheading">Build ships</h4>
      <ul className="ship-catalog" data-testid="ship-catalog">
        {SHIP_ORDER.map((kind) => {
          const def = SHIP_DEFINITIONS[kind];
          const researchLocked =
            def.requiredTechnology !== null && !completedTechs.includes(def.requiredTechnology);
          const noYard = !hasYard;
          const locked = noYard || researchLocked;
          const canAfford = RESOURCE_KEYS.every(
            (r) => view.resources[r] >= (def.cost[r] ?? 0) * quantity[kind],
          );
          const disabled = busy || locked || queueFull || !canAfford;
          const reason = noYard
            ? 'requires a Shipyard on this world'
            : researchLocked
              ? `Requires research: ${RESEARCH_BY_ID[def.requiredTechnology!]?.name ?? def.requiredTechnology}`
              : queueFull
                ? 'the shipyard queue is full'
                : !canAfford
                  ? 'this world cannot afford the order'
                  : '';
          return (
            <li
              key={kind}
              className={`ship-catalog-row${locked ? ' ship-locked' : ''}`}
              data-testid={`ship-row-${kind}`}
            >
              <div className="ship-catalog-head">
                <span className="building-kind">{def.name}</span>
                <span className="ship-catalog-role mono">{def.role}</span>
              </div>
              <p className="ship-catalog-summary">{def.summary}</p>
              <div className="ship-catalog-foot">
                <span className="ship-catalog-meta mono">
                  {formatCost(def.cost)} / hull · {def.buildTicks} tick
                  {def.buildTicks === 1 ? '' : 's'} · cargo {def.cargoCapacity} · hull {def.hull} ·
                  atk {def.attack}
                </span>
                <span className="ship-catalog-actions">
                  <label className="quantity-field">
                    <span className="quantity-label">×</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      className="quantity-input mono"
                      value={quantity[kind]}
                      disabled={locked}
                      onChange={(e) =>
                        setQuantity((prev) => ({
                          ...prev,
                          [kind]: Math.max(1, Math.min(1000, Number(e.target.value) || 1)),
                        }))
                      }
                      aria-label={`Quantity of ${def.name}`}
                    />
                  </label>
                  <button
                    type="button"
                    className="build-button"
                    data-testid={`build-ship-${kind}`}
                    onClick={() => void queueShip(kind)}
                    disabled={disabled}
                    title={reason === '' ? undefined : reason}
                  >
                    {locked
                      ? 'Locked'
                      : queueFull
                        ? 'Queue full'
                        : canAfford
                          ? 'Build'
                          : 'Cannot afford'}
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {notice && (
        <p
          className={`command-notice notice-${notice.kind}`}
          data-testid="shipyard-notice"
          role="status"
        >
          {notice.text}
        </p>
      )}
      <SectionHelp id="shipyard">
        <p>
          A planet with a Shipyard builds hulls into its local fleet. One order builds at a time;
          the rest wait in line. The full order cost is reserved from the local store when you
          commit, and completed ships enter the planet&apos;s local fleet at the next tick boundary
          — exactly once. Advanced hulls are unlocked by research.
        </p>
      </SectionHelp>
    </section>
  );
}
