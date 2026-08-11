import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCoordinate, type PlanetView, type WorldView } from '@ashes/contracts';
import { assertProtocol, fetchOverview } from './api';
import { PlanetThumb, RESOURCE_NAMES, SectionHelp } from './planet-ui';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;

/** mm:ss until the next tick resolves. */
function formatCountdown(nextTickAt: number, now: number): string {
  const secondsLeft = Math.max(0, Math.ceil((nextTickAt - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

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
  const readyView = state.status === 'ready' ? state.view : null;

  return (
    <div className={`game-shell${offline ? ' is-offline' : ''}`}>
      <header className="game-header">
        <div className="brand-lockup">
          <span className="brand-dot" aria-hidden="true" />
          <h1 className="brand-word">Command Overview</h1>
        </div>
        <div className="header-right">
          <dl className="header-meta">
            {readyView && (
              <>
                <div className="meta-item">
                  <dt title="Your name in the archive.">Commander</dt>
                  <dd data-testid="commander-name">{readyView.player.name}</dd>
                </div>
                <div className="meta-item meta-divider">
                  <dt title="The latest tick the archive has resolved.">Current tick</dt>
                  <dd className="tick-value" data-testid="overview-tick">
                    {readyView.tick}
                  </dd>
                </div>
                <div className="meta-item">
                  <dt title="Countdown to the next beat of the simulation.">Next tick</dt>
                  <dd className="tick-value" data-testid="next-tick-countdown">
                    {formatCountdown(readyView.nextTickAt, now)}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <a className="header-action" data-testid="map-link" href={`map.html?seed=${seed}`}>
            Galaxy map
          </a>
        </div>
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

      {state.status === 'ready' && <Overview view={state.view} seed={seed} />}

      <footer className="game-footer">
        <span>deterministic core · versioned protocol</span>
        <a className="footer-link" data-testid="glossary-link" href={`glossary.html?seed=${seed}`}>
          Glossary
        </a>
        <span>ashfield command archive</span>
      </footer>
    </div>
  );
}

function Overview({ view, seed }: { view: WorldView; seed: string }) {
  const home = view.player.homePlanet;

  return (
    <main className="game-grid">
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
                <code>{o.command.kind}</code>
              </li>
            ))}
          </ul>
        )}{' '}
        <SectionHelp id="orders">
          <p>
            Orders you&apos;ve issued wait here and resolve when the next tick fires. A tick is one
            fixed beat of the simulation — the world advances by exactly one step, and every order
            issued before its cutoff is applied in that same beat. The header countdown is the time
            until that next beat resolves.
          </p>
        </SectionHelp>
      </section>

      <section className="panel planets-panel" aria-labelledby="planets-heading">
        <h2 id="planets-heading" className="panel-title">
          Known planets
        </h2>
        <div className="table-scroll">
          <PlanetTable
            planets={view.planets}
            seed={seed}
            worldId={view.worldId}
            homePlanetId={home.id}
          />
        </div>
        <SectionHelp id="planets">
          <p>
            Every planet the archive has encountered, with its address in the galaxy — coordinates
            read galaxy:sector:system:planet. Abundance is the world&apos;s natural yield,
            population its headcount, and the crown marks your home planet.
          </p>
        </SectionHelp>
      </section>
    </main>
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
  homePlanetId,
}: {
  planets: PlanetView[];
  seed: string;
  worldId: string;
  homePlanetId: string;
}) {
  return (
    <table className="planet-table">
      <thead>
        <tr>
          <th scope="col" title="The planet's address in the galaxy: galaxy:sector:system:planet">
            Coordinate
          </th>
          <th scope="col">Planet</th>
          <th scope="col" title="Natural yield of each resource at this world">
            Abundance
          </th>
          <th scope="col" title="Current headcount of the world">
            Population
          </th>
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
                {p.id === homePlanetId && (
                  <span
                    className="home-marker"
                    data-testid="home-planet-marker"
                    role="img"
                    aria-label="Home planet"
                    title="Home planet"
                  >
                    <svg viewBox="0 0 16 12" aria-hidden="true" focusable="false">
                      <path d="M1.8 8.6 1 3.2 5.2 5.6 8 2.2 10.8 5.6 15 3.2 14.2 8.6Z" />
                      <rect x="1.6" y="8.2" width="12.8" height="2.6" rx="0.8" />
                    </svg>
                  </span>
                )}
              </span>
            </td>
            <td>
              <AbundanceMeter planet={p} />
            </td>
            <td className="mono">{p.population.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
