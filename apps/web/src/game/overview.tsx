import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCoordinate,
  type PlanetView,
  type TickResolutionStatus,
  type WorldView,
} from '@ashes/contracts';
import { assertProtocol, fetchOverview } from './api';
import {
  AbundanceBar,
  formatNet,
  formatResources,
  PlanetThumb,
  RESOURCE_NAMES,
  WarningsChips,
} from './planet-ui';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;

function worldIdFromSeed(seed: string): string {
  return `world:${seed}`;
}

function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: string; offline: boolean }
  | { status: 'ready'; view: WorldView };

function describeError(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : 'unknown error';
  const code = err instanceof Error ? (err as { code?: string }).code : undefined;
  return code === undefined ? { message } : { message, code };
}

export function OverviewApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldId = worldIdFromSeed(seed);
  const now = useNow();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
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
        // A success also re-arms polling: if the engine came back while a
        // failure window was closing, we keep updating rather than freezing.
        stopped = false;
        setState({ status: 'ready', view });
      } catch (err) {
        if (cancelled) return;
        failuresRef.current += 1;
        const { message, code } = describeError(err);
        const offline = failuresRef.current >= MAX_CONSECUTIVE_FAILURES;
        if (offline) stopped = true;
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
  }, [worldId, attempt]);

  const retry = useCallback(() => {
    failuresRef.current = 0;
    setState({ status: 'loading' });
    setAttempt((a) => a + 1);
  }, []);

  const offline = state.status === 'error' && state.offline;

  return (
    <div className={`game-shell${offline ? ' is-offline' : ''}`}>
      <header className="game-header">
        <div className="brand-lockup">
          <span className="brand-dot" aria-hidden="true" />
          <h1 className="brand-word">Command Overview</h1>
        </div>
        <dl className="header-meta">
          <div className="meta-item">
            <dt>World</dt>
            <dd data-testid="world-id">{worldId}</dd>
          </div>
          <div className="meta-item">
            <dt>Seed</dt>
            <dd data-testid="game-seed">{seed}</dd>
          </div>
        </dl>
      </header>

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
          data-testid="overview-offline"
          aria-labelledby="offline-heading"
        >
          <h2 id="offline-heading">Archive offline</h2>
          <p className="offline-explainer">
            The simulation engine isn&apos;t reachable from here. M0&apos;s engine runs in the local
            API process (<code>pnpm dev</code>) — start it and reload, or retry below.
          </p>
          <p className="offline-tech">
            {state.message}
            {state.code ? ` · ${state.code}` : ''}
          </p>
          <button type="button" className="retry-button" data-testid="retry-button" onClick={retry}>
            Try again
          </button>
        </section>
      )}

      {state.status === 'ready' && <Overview view={state.view} now={now} seed={seed} />}

      <footer className="game-footer">
        <span>deterministic core · versioned protocol</span>
        <span>ashfield command archive</span>
      </footer>
    </div>
  );
}

/** Signed integer for rate cells, e.g. "+3" / "0" / "-2". */
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Engine/resolution state chip: starting, running, completed, failed. */
function StatusChip({ status }: { status: TickResolutionStatus | null }) {
  if (status === null) return <span className="status-chip is-starting">starting</span>;
  return <span className={`status-chip is-${status}`}>{status}</span>;
}

function Overview({ view, now, seed }: { view: WorldView; now: number; seed: string }) {
  const secondsLeft = Math.max(0, Math.ceil((view.nextTickAt - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const home = view.player.homePlanet;
  const buildCount = Object.values(home.buildings).reduce((a, b) => a + b, 0);

  return (
    <main className="game-grid">
      <section className="panel tick-hero" aria-labelledby="tick-heading">
        <h2 id="tick-heading" className="panel-title">
          The tick
        </h2>
        <div className="tick-row">
          <div className="tick-current">
            <span className="micro-label">Current tick</span>
            <strong data-testid="overview-tick">{view.tick}</strong>
          </div>
          <div className="tick-next">
            <span className="micro-label">Next tick</span>
            <strong data-testid="next-tick-countdown">
              {mm}:{ss}
            </strong>
          </div>
          <div className="tick-next">
            <span className="micro-label">Next at</span>
            <strong className="mono" data-testid="next-tick-at">
              {new Date(view.nextTickAt).toLocaleTimeString()}
            </strong>
          </div>
          <div className="tick-hero-status">
            <span className="micro-label">Engine</span>
            <StatusChip status={view.lastResolution?.status ?? null} />
          </div>
        </div>
        <div className="tick-hero-identity">
          <dl className="hash-list">
            <div>
              <dt>World hash</dt>
              <dd data-testid="world-hash" title={view.worldHash}>
                {view.worldHash}
              </dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>{view.protocolVersion}</dd>
            </div>
            <div>
              <dt>Worldgen</dt>
              <dd>{view.worldVersion}</dd>
            </div>
            <div>
              <dt>Content</dt>
              <dd>{view.contentVersion}</dd>
            </div>
            <div>
              <dt>Tick length</dt>
              <dd>{view.tickDurationMs} ms</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(view.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Last resolved</dt>
              <dd>
                {view.lastResolvedAt ? new Date(view.lastResolvedAt).toLocaleTimeString() : '—'}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="panel home-panel" aria-labelledby="home-heading">
        <h2 id="home-heading" className="panel-title">
          Home planet
        </h2>
        <p className="home-player">
          <span className="micro-label">Player</span>
          <strong>{view.player.name}</strong>
          <span className="faction-tag">{view.player.factionId}</span>
        </p>
        <p className="home-player-id">
          <span className="micro-label">Archive id</span>
          <code className="mono">{view.player.id}</code>
        </p>
        <p className="home-coord">
          <span className="micro-label">Coordinate</span>
          <strong data-testid="home-coordinate">{formatCoordinate(home.coordinate)}</strong>
        </p>
        <AbundanceBar planet={home} />
        <div className="economy-grid">
          <div className="economy-cell">
            <span className="micro-label">Population</span>
            <strong className="mono">{home.population.toLocaleString()}</strong>
          </div>
          <div className="economy-cell">
            <span className="micro-label">Storage cap</span>
            <strong className="mono">{home.storageCap.toLocaleString()} / resource</strong>
          </div>
          <div className="economy-cell">
            <span className="micro-label">Buildings</span>
            <strong className="mono">{buildCount}</strong>
          </div>
        </div>
        <ResourceTable planet={home} />
        <WarningsChips warnings={home.warnings} />
        <p className="home-note">The local fleet anchor. Development begins here.</p>
      </section>

      <section className="panel resolution-panel" aria-labelledby="resolution-heading">
        <h2 id="resolution-heading" className="panel-title">
          Last tick resolved
        </h2>
        {view.lastResolution === null ? (
          <p className="empty-state">No ticks resolved yet.</p>
        ) : (
          <>
            <div className="resolution-head">
              <span className="micro-label">Tick</span>
              <strong className="resolution-tick mono" data-testid="last-resolved-tick">
                {view.lastResolution.tick}
              </strong>
              <StatusChip status={view.lastResolution.status} />
            </div>
            <dl className="resolution-list">
              <div>
                <dt>Resolved at</dt>
                <dd>{new Date(view.lastResolution.resolvedAt).toLocaleTimeString()}</dd>
              </div>
              <div>
                <dt>Command cutoff</dt>
                <dd>{new Date(view.lastResolution.commandCutoffAt).toLocaleTimeString()}</dd>
              </div>
              <div>
                <dt>Resolution seed</dt>
                <dd title={view.lastResolution.seed}>{view.lastResolution.seed}</dd>
              </div>
              <div>
                <dt>Planet state hash</dt>
                <dd title={view.lastResolution.planetStateHash}>
                  {view.lastResolution.planetStateHash}
                </dd>
              </div>
            </dl>
            <h3 className="ledger-subtitle">Phase hashes</h3>
            <table className="phase-hashes">
              <tbody>
                {Object.entries(view.lastResolution.phaseHashes)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([phase, hash]) => (
                    <tr key={phase}>
                      <th scope="row">{phase}</th>
                      <td title={hash}>{hash}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="panel planets-panel" aria-labelledby="planets-heading">
        <h2 id="planets-heading" className="panel-title">
          Known planets
        </h2>
        <div className="table-scroll">
          <PlanetTable planets={view.planets} seed={seed} worldId={view.worldId} />
        </div>
      </section>

      <section className="panel orders-panel" aria-labelledby="orders-heading">
        <h2 id="orders-heading" className="panel-title">
          Pending next tick
        </h2>
        {view.pendingOrders.length === 0 ? (
          <p className="empty-state">No orders pending resolution.</p>
        ) : (
          <ul className="orders-list">
            {view.pendingOrders.map((o) => (
              <li key={o.idempotencyKey}>
                <code>{o.command.kind}</code> — {o.idempotencyKey}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Per-resource stored / production / upkeep / net breakdown for a planet. */
function ResourceTable({ planet }: { planet: PlanetView }) {
  return (
    <table className="resource-table">
      <thead>
        <tr>
          <th scope="col">Resource</th>
          <th scope="col">Stored</th>
          <th scope="col">Prod</th>
          <th scope="col">Upkeep</th>
          <th scope="col">Net</th>
        </tr>
      </thead>
      <tbody>
        {RESOURCE_NAMES.map(([key, label]) => {
          const net = planet.rates.net[key];
          return (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td className="mono">{planet.resources[key].toLocaleString()}</td>
              <td className="mono">{signed(planet.rates.production[key])}</td>
              <td className="mono">{signed(planet.rates.upkeep[key])}</td>
              <td className={`mono ${net > 0 ? 'is-pos' : net < 0 ? 'is-neg' : ''}`}>
                {signed(net)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Four stacked abundance bars (metal/mineral/food/energy) for table rows. */
function AbundanceMeter({ planet }: { planet: PlanetView }) {
  const parts = RESOURCE_NAMES.map(([key, label]) => `${label} ${planet.abundance[key]}`);
  return (
    <span
      className="abundance-meter"
      role="img"
      aria-label={`Abundance — ${parts.join(', ')}`}
      title={parts.join(', ')}
    >
      {RESOURCE_NAMES.map(([key]) => (
        <span className="abundance-meter-col" key={key}>
          <span className="abundance-meter-track">
            <span
              className="abundance-meter-fill"
              style={{ height: `${planet.abundance[key]}%` }}
            />
          </span>
        </span>
      ))}
    </span>
  );
}

function PlanetTable({
  planets,
  seed,
  worldId,
}: {
  planets: PlanetView[];
  seed: string;
  worldId: string;
}) {
  return (
    <table className="planet-table">
      <thead>
        <tr>
          <th scope="col">Coordinate</th>
          <th scope="col">Planet</th>
          <th scope="col">Abundance</th>
          <th scope="col">Population</th>
          <th scope="col">Resources</th>
          <th scope="col">Net / tick</th>
          <th scope="col">Warnings</th>
          <th scope="col">Resolved</th>
        </tr>
      </thead>
      <tbody>
        {planets.map((p) => (
          <tr key={p.id}>
            <td className="mono">{formatCoordinate(p.coordinate)}</td>
            <td>
              <span className="planet-name-cell">
                <PlanetThumb worldId={worldId} planetId={p.id} name={p.name} />
                <a
                  className="planet-link"
                  data-testid={`planet-link-${p.id}`}
                  href={`planet.html?seed=${seed}&planet=${encodeURIComponent(p.id)}`}
                >
                  {p.name}
                </a>
              </span>
            </td>
            <td>
              <AbundanceMeter planet={p} />
            </td>
            <td className="mono">{p.population.toLocaleString()}</td>
            <td className="mono resource-cells">{formatResources(p.resources)}</td>
            <td className="mono resource-cells">{formatNet(p.rates.net)}</td>
            <td>
              <WarningsChips warnings={p.warnings} />
            </td>
            <td className="mono">{p.lastResolvedTick}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
