import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCoordinate,
  M3_MISSION_KINDS,
  parseCoordinate,
  planetIdFromCoordinate,
  RESOURCE_KEYS,
  type Coordinate,
  type FleetView,
  type M3MissionKind,
  type ShipKind,
  type WorldView,
} from '@ashes/contracts';
import { SHIP_DEFINITIONS, SHIP_ORDER } from '@ashes/content';
import {
  ApiError,
  assertProtocol,
  fetchFleetRoute,
  fetchOverview,
  submitLoadCargo,
  submitRecallFleet,
  submitSendFleet,
  submitSplitFleet,
  submitTransferFleet,
  submitUnloadCargo,
} from './api';
import { GameHeader, HeaderMeta, type WorldMeta } from './header';
import { RESOURCE_NAMES, SectionHelp } from './planet-ui';
import { sessionWorldId } from './session';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEV_AUTO_RECOVER = import.meta.env.DEV;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: string; offline: boolean }
  | { status: 'ready'; view: WorldView };

function sameLocation(a: FleetView, b: FleetView): boolean {
  return sameCoord(a.location, b.location);
}

function sameCoord(a: Coordinate, b: Coordinate): boolean {
  return (
    a.galaxy === b.galaxy && a.sector === b.sector && a.system === b.system && a.planet === b.planet
  );
}

const MISSION_LABELS: Record<M3MissionKind, string> = {
  transport: 'Transport',
  scout: 'Scout',
  colonize: 'Colonize',
  raid: 'Raid',
};

/** Total cargo units currently held by a fleet. */
function heldCargo(fleet: FleetView): number {
  return RESOURCE_KEYS.reduce((a, r) => a + (fleet.cargo[r] ?? 0), 0);
}

export function FleetsApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldId = sessionWorldId(seed);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [worldMeta, setWorldMeta] = useState<WorldMeta | null>(null);
  const [worldVersion, setWorldVersion] = useState(0);
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    const load = async () => {
      try {
        const view = await fetchOverview(worldId);
        assertProtocol(view);
        if (cancelled) return;
        failuresRef.current = 0;
        stopped = false;
        setWorldMeta({ name: view.player.name, tick: view.tick, nextTickAt: view.nextTickAt });
        setWorldVersion(view.version);
        setState({ status: 'ready', view });
      } catch (err) {
        if (cancelled) return;
        failuresRef.current += 1;
        const message = err instanceof Error ? err.message : 'unknown error';
        const code = err instanceof Error ? (err as { code?: string }).code : undefined;
        const offline = failuresRef.current >= MAX_CONSECUTIVE_FAILURES;
        if (offline) stopped = !DEV_AUTO_RECOVER;
        setState({
          status: 'error',
          message,
          offline,
          ...(code === undefined ? {} : { code }),
        });
      }
    };
    void load();
    const id = setInterval(() => {
      if (!stopped) void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [worldId, attempt, refresh]);

  const retry = useCallback(() => {
    failuresRef.current = 0;
    setState({ status: 'loading' });
    setAttempt((a) => a + 1);
  }, []);

  const offline = state.status === 'error' && state.offline;

  return (
    <div className={`game-shell${offline ? ' is-offline' : ''}`}>
      <GameHeader
        seed={seed}
        title="Fleets"
        current="fleets"
        meta={worldMeta && <HeaderMeta meta={worldMeta} />}
      />

      {state.status === 'loading' && <p className="status-line">Opening the archive…</p>}
      {state.status === 'error' && !state.offline && (
        <p className="retrying-line" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          Engine not responding — retrying…
        </p>
      )}
      {state.status === 'error' && state.offline && (
        <section
          className="offline-card"
          data-testid="fleets-offline"
          aria-labelledby="offline-heading"
        >
          <h2 id="offline-heading">Archive offline</h2>
          <p className="offline-explainer">
            The simulation engine isn&apos;t reachable from here. Start it and reload, or retry
            below.
          </p>
          <p className="offline-tech">
            {state.message}
            {state.code ? ` · ${state.code}` : ''}
          </p>
          <button type="button" className="retry-button" onClick={retry}>
            Try again
          </button>
        </section>
      )}
      {state.status === 'ready' && (
        <FleetsPanel
          view={state.view}
          worldId={worldId}
          worldVersion={worldVersion}
          seed={seed}
          onStateChange={() => setRefresh((r) => r + 1)}
        />
      )}

      <footer className="game-footer">
        <span>deterministic core · versioned protocol</span>
        <span className="footer-links">
          <a className="footer-link" data-testid="map-link" href={`map.html?seed=${seed}`}>
            Galaxy map
          </a>
          <span aria-hidden="true">·</span>
          <a
            className="footer-link"
            data-testid="glossary-link"
            href={`glossary.html?seed=${seed}`}
          >
            Glossary
          </a>
        </span>
        <span>fleet command · ashfield command archive</span>
      </footer>
    </div>
  );
}

function FleetsPanel({
  view,
  worldId,
  worldVersion,
  seed,
  onStateChange,
}: {
  view: WorldView;
  worldId: string;
  worldVersion: number;
  seed: string;
  onStateChange: () => void;
}) {
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const report = (kind: 'ok' | 'error', text: string) => setNotice({ kind, text });

  const totalFleets = view.fleets.length;
  const totalShipsCount = view.fleets.reduce((a, f) => a + totalShips(f), 0);
  const totalCargo = RESOURCE_KEYS.reduce(
    (a, r) => a + view.fleets.reduce((b, f) => b + (f.cargo[r] ?? 0), 0),
    0,
  );

  return (
    <main className="fleets-grid">
      <section className="panel fleets-summary" aria-labelledby="fleets-summary-heading">
        <h2 id="fleets-summary-heading" className="panel-title">
          Fleet summary
        </h2>
        <dl className="fleets-summary-stats">
          <div>
            <dt>Fleets</dt>
            <dd className="mono">{totalFleets}</dd>
          </div>
          <div>
            <dt>Ships</dt>
            <dd className="mono">{totalShipsCount}</dd>
          </div>
          <div>
            <dt>Cargo held</dt>
            <dd className="mono">{totalCargo}</dd>
          </div>
        </dl>
      </section>

      <section className="panel fleets-inventory" aria-labelledby="fleets-heading">
        <h2 id="fleets-heading" className="panel-title">
          Fleet inventory
        </h2>
        {view.fleets.length === 0 ? (
          <p className="empty-state">No fleets. Build ships at a planet&apos;s shipyard first.</p>
        ) : (
          <div className="fleet-cards" data-testid="fleet-cards">
            {view.fleets.map((fleet) => (
              <FleetCard
                key={fleet.id}
                fleet={fleet}
                view={view}
                worldId={worldId}
                worldVersion={worldVersion}
                seed={seed}
                onStateChange={onStateChange}
                report={report}
              />
            ))}
          </div>
        )}
        <SectionHelp id="fleets">
          <p>
            Every shipyard delivers its completed hulls to the planet&apos;s local fleet, which
            orbits the world it was built on. A fleet can be sent to any coordinate in the galaxy:
            it departs at the next tick boundary and docks on its calculated arrival tick. A fleet
            in flight can be recalled — it turns around and returns to its origin. Transport
            missions carry cargo loaded from your planets; scout, colonize, and raid missions are in
            flight now and their effects resolve in later milestones. Split detachments off a fleet
            and shuffle ships and cargo between fleets sharing a location.
          </p>
        </SectionHelp>
      </section>

      <TransferPanel
        fleets={view.fleets}
        worldId={worldId}
        worldVersion={worldVersion}
        onStateChange={onStateChange}
        report={report}
      />

      {notice && (
        <p
          className={`command-notice notice-${notice.kind}`}
          data-testid="fleet-notice"
          role="status"
        >
          {notice.text}
        </p>
      )}
    </main>
  );
}

function FleetCard({
  fleet,
  view,
  worldId,
  worldVersion,
  seed,
  onStateChange,
  report,
}: {
  fleet: FleetView;
  view: WorldView;
  worldId: string;
  worldVersion: number;
  seed: string;
  onStateChange: () => void;
  report: (kind: 'ok' | 'error', text: string) => void;
}) {
  const [showSplit, setShowSplit] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showCargo, setShowCargo] = useState(false);
  const shipyardHref = `constructions.html?seed=${seed}&planet=${encodeURIComponent(
    planetIdFromCoordinate(fleet.location),
  )}`;
  const [counts, setCounts] = useState<Record<ShipKind, number>>(() => emptyCounts());
  const [busy, setBusy] = useState(false);

  const inFlight = fleet.state === 'moving' || fleet.state === 'returning';
  const planet = view.planets.find((p) => sameCoord(p.coordinate, fleet.location));
  const atOwnedPlanet = fleet.state === 'orbiting' && planet !== undefined;

  const split = async () => {
    const ships: Partial<Record<ShipKind, number>> = {};
    for (const kind of SHIP_ORDER) {
      const count = counts[kind] ?? 0;
      if (count > 0) ships[kind] = count;
    }
    setBusy(true);
    try {
      const result = await submitSplitFleet({
        worldId,
        fleetId: fleet.id,
        ships,
        expectedVersion: worldVersion,
      });
      if (result.op !== 'split') return;
      report('ok', `Detachment created with ${formatShips(result.fleet.ships)}.`);
      setCounts(emptyCounts());
      setShowSplit(false);
      onStateChange();
    } catch (err) {
      reportError(err, report, onStateChange);
    } finally {
      setBusy(false);
    }
  };

  const recall = async () => {
    setBusy(true);
    try {
      await submitRecallFleet({
        worldId,
        fleetId: fleet.id,
        expectedVersion: worldVersion,
      });
      report('ok', `${fleet.name} recalled — returning home.`);
      onStateChange();
    } catch (err) {
      reportError(err, report, onStateChange);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="fleet-card" data-testid={`fleet-${fleet.id}`}>
      <div className="fleet-card-head">
        <span className="fleet-name">{fleet.name}</span>
        <span className="fleet-location mono">
          {inFlight && fleet.mission
            ? `→ ${formatCoordinate(fleet.mission.destination)}`
            : formatCoordinate(fleet.location)}
        </span>
      </div>
      {inFlight && fleet.mission ? (
        <div className="fleet-travel" data-testid={`travel-${fleet.id}`}>
          <span>
            {fleet.state === 'moving' ? 'En route to' : 'Returning to'}{' '}
            <strong className="mono">{formatCoordinate(fleet.mission.destination)}</strong>
          </span>
          <span className="mono">arrives tick {fleet.arrivalTick ?? '—'}</span>
          {fleet.state === 'moving' ? (
            <button
              type="button"
              className="plan-toggle"
              data-testid={`recall-${fleet.id}`}
              onClick={() => void recall()}
              disabled={busy}
            >
              Recall
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="fleet-card-stats">
        <span className="fleet-stat">
          <span className="micro-label">State</span>
          <strong className="mono">{fleet.state}</strong>
        </span>
        <span className="fleet-stat">
          <span className="micro-label">Drive tier</span>
          <strong
            className="mono"
            title="The slowest drive aboard — it sets this fleet's travel speed"
          >
            {fleet.driveTier}
          </strong>
        </span>
        <span className="fleet-stat">
          <span className="micro-label">Ships</span>
          <strong className="mono">{totalShips(fleet)}</strong>
        </span>
      </div>
      <div className="fleet-card-cargo">
        {fleetShips(fleet).length === 0 ? (
          <div className="fleet-empty">
            <p className="empty-state">No ships aboard.</p>
            <a className="construction-desk-link" href={shipyardHref}>
              Build ships →
            </a>
          </div>
        ) : (
          <ul className="fleet-ships">
            {fleetShips(fleet).map(([kind, count]) => (
              <li key={kind} className="fleet-ship-row">
                <span className="building-kind">{SHIP_DEFINITIONS[kind].name}</span>
                <span className="mono">× {count}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="fleet-cargo">
          <span className="micro-label">Cargo</span>
          <span className="fleet-cargo-value mono">
            {formatCargo(fleet.cargo)}
            <span className="fleet-cargo-cap mono"> / {fleet.cargoCapacity} held</span>
          </span>
        </div>
      </div>
      <div className="fleet-card-actions">
        {fleet.state === 'orbiting' && totalShips(fleet) > 0 ? (
          <button
            type="button"
            className="plan-toggle"
            data-testid={`send-toggle-${fleet.id}`}
            aria-expanded={showSend}
            onClick={() => setShowSend((v) => !v)}
          >
            {showSend ? 'Hide send' : 'Send fleet'}
          </button>
        ) : null}
        {atOwnedPlanet ? (
          <button
            type="button"
            className="plan-toggle"
            data-testid={`cargo-toggle-${fleet.id}`}
            aria-expanded={showCargo}
            onClick={() => setShowCargo((v) => !v)}
          >
            {showCargo ? 'Hide cargo ops' : 'Cargo ops'}
          </button>
        ) : null}
        {totalShips(fleet) > 1 ? (
          <button
            type="button"
            className="plan-toggle"
            data-testid={`split-toggle-${fleet.id}`}
            aria-expanded={showSplit}
            onClick={() => setShowSplit((v) => !v)}
          >
            {showSplit ? 'Hide split' : 'Split detachment'}
          </button>
        ) : null}
      </div>
      {showSend && fleet.state === 'orbiting' && totalShips(fleet) > 0 ? (
        <SendPanel
          fleet={fleet}
          worldId={worldId}
          worldVersion={worldVersion}
          onStateChange={onStateChange}
          report={report}
        />
      ) : null}
      {showCargo && atOwnedPlanet && planet ? (
        <CargoPanel
          fleet={fleet}
          planet={planet}
          worldId={worldId}
          worldVersion={worldVersion}
          onStateChange={onStateChange}
          report={report}
        />
      ) : null}
      {showSplit && (
        <div className="fleet-split" data-testid={`split-panel-${fleet.id}`}>
          <p className="ledger-subtitle">Move ships into a new detachment</p>
          <div className="fleet-split-counts">
            {SHIP_ORDER.map((kind) => (
              <label key={kind} className="field-row compact">
                <span className="field-label">{SHIP_DEFINITIONS[kind].name}</span>
                <input
                  type="number"
                  min={0}
                  max={fleet.ships[kind] ?? 0}
                  className="field-input mono"
                  value={counts[kind]}
                  onChange={(e) => {
                    const value = Math.max(
                      0,
                      Math.min(fleet.ships[kind] ?? 0, Number(e.target.value) || 0),
                    );
                    setCounts((prev) => ({ ...prev, [kind]: value }));
                  }}
                  aria-label={`Split ${SHIP_DEFINITIONS[kind].name}`}
                />
                <span className="field-hint mono">have {fleet.ships[kind] ?? 0}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="build-button"
            data-testid={`split-${fleet.id}`}
            onClick={() => void split()}
            disabled={busy || SHIP_ORDER.every((k) => (counts[k] ?? 0) === 0)}
          >
            Split detachment
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * The send panel (M3): pick a destination coordinate and a mission, preview
 * the deterministic route (distance, travel ticks, arrival tick) from the
 * engine, then submit. The mission's effects resolve in later milestones;
 * M3 carries the flight itself.
 */
function SendPanel({
  fleet,
  worldId,
  worldVersion,
  onStateChange,
  report,
}: {
  fleet: FleetView;
  worldId: string;
  worldVersion: number;
  onStateChange: () => void;
  report: (kind: 'ok' | 'error', text: string) => void;
}) {
  const [destination, setDestination] = useState('');
  const [mission, setMission] = useState<M3MissionKind>('transport');
  const [preview, setPreview] = useState<{
    distance: number;
    travelTicks: number;
    arrivalTick: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = parseCoordinate(destination.trim());

  useEffect(() => {
    let cancelled = false;
    if (!parsed) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (sameCoord(parsed, fleet.location)) {
      setPreview(null);
      setPreviewError('The fleet is already at this coordinate.');
      return;
    }
    setPreview(null);
    setPreviewError(null);
    fetchFleetRoute(worldId, fleet.id, parsed)
      .then((route) => {
        if (!cancelled) setPreview(route);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'route unavailable';
        const code = err instanceof ApiError ? err.code : undefined;
        setPreviewError(code === undefined ? message : `${message} (${code})`);
      });
    return () => {
      cancelled = true;
    };
  }, [destination, fleet.id, fleet.location, worldId]);

  const send = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const result = await submitSendFleet({
        worldId,
        fleetId: fleet.id,
        destination: parsed,
        mission,
        expectedVersion: worldVersion,
      });
      if (result.op !== 'send') return;
      report(
        'ok',
        `${fleet.name} departed — ${MISSION_LABELS[mission]} to ${formatCoordinate(
          result.fleet.mission?.destination ?? parsed,
        )}, arrives tick ${result.fleet.arrivalTick}.`,
      );
      setDestination('');
      onStateChange();
    } catch (err) {
      reportError(err, report, onStateChange);
    } finally {
      setBusy(false);
    }
  };

  const validTarget = parsed !== null && !sameCoord(parsed, fleet.location);

  return (
    <div className="fleet-send" data-testid={`send-panel-${fleet.id}`}>
      <p className="ledger-subtitle">Send to a coordinate — mission resolves on arrival</p>
      <label className="field-row compact">
        <span className="field-label">Destination</span>
        <input
          type="text"
          className="field-input mono"
          placeholder="1:1:1:2"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          aria-label="Destination coordinate"
        />
        <span className="field-hint mono">galaxy:sector:system:planet</span>
      </label>
      <label className="field-row compact">
        <span className="field-label">Mission</span>
        <select
          className="field-select"
          data-testid={`send-mission-${fleet.id}`}
          value={mission}
          onChange={(e) => setMission(e.target.value as M3MissionKind)}
        >
          {M3_MISSION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {MISSION_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <p className="route-preview mono" data-testid={`send-preview-${fleet.id}`} role="status">
        {previewError ? (
          <span className="notice-error-text">{previewError}</span>
        ) : preview ? (
          `${Math.round(preview.distance)} map units · ${preview.travelTicks} tick${
            preview.travelTicks === 1 ? '' : 's'
          } · arrives tick ${preview.arrivalTick}`
        ) : (
          <span className="route-preview-idle">Enter a destination to preview the route.</span>
        )}
      </p>
      <button
        type="button"
        className="build-button"
        data-testid={`send-${fleet.id}`}
        onClick={() => void send()}
        disabled={busy || !validTarget}
      >
        Send fleet
      </button>
    </div>
  );
}

/**
 * Cargo ops (M3): load planet-store resources into the fleet's hold or
 * unload cargo back into the planet store. Loads are bounded by the fleet's
 * free cargo capacity; unloads clamp at the planet's storage cap (the same
 * policy as refunds), exactly as the engine resolves them.
 */
function CargoPanel({
  fleet,
  planet,
  worldId,
  worldVersion,
  onStateChange,
  report,
}: {
  fleet: FleetView;
  planet: NonNullable<WorldView['planets'][number]>;
  worldId: string;
  worldVersion: number;
  onStateChange: () => void;
  report: (kind: 'ok' | 'error', text: string) => void;
}) {
  const [loads, setLoads] = useState<Record<string, number>>(() => zeroResources());
  const [unloads, setUnloads] = useState<Record<string, number>>(() => zeroResources());
  const [busy, setBusy] = useState(false);

  const free = Math.max(0, fleet.cargoCapacity - heldCargo(fleet));

  const run = async (kind: 'load' | 'unload') => {
    const amounts = kind === 'load' ? loads : unloads;
    const resources: Record<string, number> = {};
    for (const r of RESOURCE_KEYS) {
      const n = amounts[r] ?? 0;
      if (n > 0) resources[r] = n;
    }
    if (Object.keys(resources).length === 0) return;
    setBusy(true);
    try {
      const result =
        kind === 'load'
          ? await submitLoadCargo({
              worldId,
              fleetId: fleet.id,
              resources,
              expectedVersion: worldVersion,
            })
          : await submitUnloadCargo({
              worldId,
              fleetId: fleet.id,
              resources,
              expectedVersion: worldVersion,
            });
      if (result.op !== (kind === 'load' ? 'load' : 'unload')) return;
      report(
        'ok',
        kind === 'load'
          ? `${formatResources(resources)} loaded into ${fleet.name}.`
          : `${formatResources(resources)} unloaded to ${planet.name}.`,
      );
      setLoads(zeroResources());
      setUnloads(zeroResources());
      onStateChange();
    } catch (err) {
      reportError(err, report, onStateChange);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fleet-cargo-ops" data-testid={`cargo-panel-${fleet.id}`}>
      <div className="transfer-group">
        <p className="ledger-subtitle">Load from {planet.name}</p>
        {RESOURCE_NAMES.map(([key, label]) => (
          <label key={key} className="field-row compact">
            <span className="field-label">{label}</span>
            <input
              type="number"
              min={0}
              max={Math.min(planet.resources[key] ?? 0, free)}
              className="field-input mono"
              value={loads[key]}
              onChange={(e) => {
                const value = Math.max(
                  0,
                  Math.min(Math.min(planet.resources[key] ?? 0, free), Number(e.target.value) || 0),
                );
                setLoads((prev) => ({ ...prev, [key]: value }));
              }}
              aria-label={`Load ${label}`}
            />
            <span className="field-hint mono">stored {planet.resources[key] ?? 0}</span>
          </label>
        ))}
        <p className="field-hint mono">{free} capacity free</p>
        <button
          type="button"
          className="build-button"
          data-testid={`load-${fleet.id}`}
          onClick={() => void run('load')}
          disabled={busy || RESOURCE_KEYS.every((r) => (loads[r] ?? 0) === 0)}
        >
          Load cargo
        </button>
      </div>
      <div className="transfer-group">
        <p className="ledger-subtitle">Unload to {planet.name}</p>
        {RESOURCE_NAMES.map(([key, label]) => (
          <label key={key} className="field-row compact">
            <span className="field-label">{label}</span>
            <input
              type="number"
              min={0}
              max={fleet.cargo[key] ?? 0}
              className="field-input mono"
              value={unloads[key]}
              onChange={(e) => {
                const value = Math.max(
                  0,
                  Math.min(fleet.cargo[key] ?? 0, Number(e.target.value) || 0),
                );
                setUnloads((prev) => ({ ...prev, [key]: value }));
              }}
              aria-label={`Unload ${label}`}
            />
            <span className="field-hint mono">hold {fleet.cargo[key] ?? 0}</span>
          </label>
        ))}
        <p className="field-hint mono">unload clamps at the planet&apos;s storage cap</p>
        <button
          type="button"
          className="build-button"
          data-testid={`unload-${fleet.id}`}
          onClick={() => void run('unload')}
          disabled={busy || RESOURCE_KEYS.every((r) => (unloads[r] ?? 0) === 0)}
        >
          Unload cargo
        </button>
      </div>
    </div>
  );
}

function reportError(
  err: unknown,
  report: (kind: 'ok' | 'error', text: string) => void,
  onStateChange: () => void,
): void {
  const message = err instanceof Error ? err.message : 'command failed';
  const code = err instanceof ApiError ? err.code : undefined;
  report('error', code === undefined ? message : `${message} (${code})`);
  if (code === 'STALE_VERSION') onStateChange();
}

function zeroResources(): Record<string, number> {
  return { metal: 0, mineral: 0, food: 0, energy: 0 };
}

function formatResources(resources: Record<string, number>): string {
  return RESOURCE_KEYS.filter((r) => (resources[r] ?? 0) > 0)
    .map((r) => `${RESOURCE_NAMES.find(([k]) => k === r)?.[1]} ${resources[r]}`)
    .join(', ');
}

function TransferPanel({
  fleets,
  worldId,
  worldVersion,
  onStateChange,
  report,
}: {
  fleets: FleetView[];
  worldId: string;
  worldVersion: number;
  onStateChange: () => void;
  report: (kind: 'ok' | 'error', text: string) => void;
}) {
  const [fromId, setFromId] = useState<string>(fleets[0]?.id ?? '');
  const [toId, setToId] = useState('');
  const [ships, setShips] = useState<Record<ShipKind, number>>(() => emptyCounts());
  const [cargo, setCargo] = useState<Record<string, number>>(() => ({
    metal: 0,
    mineral: 0,
    food: 0,
    energy: 0,
  }));
  const [busy, setBusy] = useState(false);

  const from = fleets.find((f) => f.id === fromId);
  const coLocated = fleets.filter((f) => f.id !== fromId && from && sameLocation(f, from));
  const to = fleets.find((f) => f.id === toId);

  const transfer = async () => {
    if (!from || !to) return;
    const shipTransfer: Partial<Record<ShipKind, number>> = {};
    for (const kind of SHIP_ORDER) {
      const count = ships[kind] ?? 0;
      if (count > 0) shipTransfer[kind] = count;
    }
    const cargoTransfer: Record<string, number> = {};
    for (const r of RESOURCE_KEYS) {
      const count = cargo[r] ?? 0;
      if (count > 0) cargoTransfer[r] = count;
    }
    setBusy(true);
    try {
      await submitTransferFleet({
        worldId,
        fromFleetId: from.id,
        toFleetId: to.id,
        ships: shipTransfer,
        ...(Object.keys(cargoTransfer).length > 0 ? { cargo: cargoTransfer } : {}),
        expectedVersion: worldVersion,
      });
      report('ok', 'Transfer complete.');
      setShips(emptyCounts());
      setCargo({ metal: 0, mineral: 0, food: 0, energy: 0 });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      report('error', code === undefined ? message : `${message} (${code})`);
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  if (fleets.length === 0) {
    return (
      <section className="panel fleets-transfer" aria-labelledby="transfer-heading">
        <h2 id="transfer-heading" className="panel-title">
          Transfer
        </h2>
        <p className="empty-state">Build a fleet before transferring anything between fleets.</p>
      </section>
    );
  }

  return (
    <section className="panel fleets-transfer" aria-labelledby="transfer-heading">
      <h2 id="transfer-heading" className="panel-title">
        Transfer between fleets
      </h2>
      <div className="transfer-pick">
        <label className="field-row">
          <span className="field-label">From</span>
          <select
            className="field-select"
            data-testid="transfer-from"
            value={fromId}
            onChange={(e) => {
              // A different source may not share a location with the old
              // target — reset the target so the picker always re-chooses.
              setFromId(e.target.value);
              setToId('');
            }}
          >
            {fleets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span className="field-label">To</span>
          <select
            className="field-select"
            data-testid="transfer-to"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
          >
            <option value="">— co-located fleet —</option>
            {coLocated.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {from && coLocated.length === 0 ? (
        <p className="empty-state">
          No other fleet shares this location. Split a detachment off this fleet to create a
          co-located one, then transfer between them.
        </p>
      ) : null}
      {from && coLocated.length > 0 ? (
        <div className="transfer-inputs">
          <div className="transfer-group">
            <p className="ledger-subtitle">Ships</p>
            {SHIP_ORDER.map((kind) => (
              <label key={kind} className="field-row compact">
                <span className="field-label">{SHIP_DEFINITIONS[kind].name}</span>
                <input
                  type="number"
                  min={0}
                  max={from?.ships[kind] ?? 0}
                  className="field-input mono"
                  value={ships[kind]}
                  onChange={(e) => {
                    const value = Math.max(
                      0,
                      Math.min(from?.ships[kind] ?? 0, Number(e.target.value) || 0),
                    );
                    setShips((prev) => ({ ...prev, [kind]: value }));
                  }}
                  aria-label={`Transfer ${SHIP_DEFINITIONS[kind].name}`}
                />
                <span className="field-hint mono">have {from?.ships[kind] ?? 0}</span>
              </label>
            ))}
          </div>
          <div className="transfer-group">
            <p className="ledger-subtitle">Cargo</p>
            {RESOURCE_NAMES.map(([key, label]) => (
              <label key={key} className="field-row compact">
                <span className="field-label">{label}</span>
                <input
                  type="number"
                  min={0}
                  max={from?.cargo[key] ?? 0}
                  className="field-input mono"
                  value={cargo[key]}
                  onChange={(e) => {
                    const value = Math.max(
                      0,
                      Math.min(from?.cargo[key] ?? 0, Number(e.target.value) || 0),
                    );
                    setCargo((prev) => ({ ...prev, [key]: value }));
                  }}
                  aria-label={`Transfer ${label}`}
                />
                <span className="field-hint mono">hold {from?.cargo[key] ?? 0}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {from && coLocated.length > 0 ? (
        <button
          type="button"
          className="build-button"
          data-testid="transfer-execute"
          onClick={() => void transfer()}
          disabled={
            busy ||
            to === undefined ||
            (SHIP_ORDER.every((k) => (ships[k] ?? 0) === 0) &&
              RESOURCE_KEYS.every((r) => (cargo[r] ?? 0) === 0))
          }
        >
          Transfer
        </button>
      ) : null}
    </section>
  );
}

function emptyCounts(): Record<ShipKind, number> {
  return { scout: 0, freighter: 0, outpost: 0, fighter: 0 };
}

function totalShips(fleet: FleetView): number {
  return Object.values(fleet.ships).reduce((a, b) => a + (b ?? 0), 0);
}

function fleetShips(fleet: FleetView): Array<[ShipKind, number]> {
  return SHIP_ORDER.filter((k) => (fleet.ships[k] ?? 0) > 0).map((k) => [k, fleet.ships[k] ?? 0]);
}

function formatShips(ships: Record<string, number | undefined>): string {
  return Object.entries(ships)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${SHIP_DEFINITIONS[k as ShipKind]?.name ?? k} × ${n}`)
    .join(', ');
}

function formatCargo(cargo: Record<string, number>): string {
  const parts = RESOURCE_KEYS.filter((r) => (cargo[r] ?? 0) > 0).map(
    (r) => `${RESOURCE_NAMES.find(([k]) => k === r)?.[1]} ${cargo[r]}`,
  );
  return parts.length === 0 ? 'empty' : parts.join(', ');
}
