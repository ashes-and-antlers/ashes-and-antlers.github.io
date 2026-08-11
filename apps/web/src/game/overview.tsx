import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCoordinate, type PlanetView, type WorldView } from '@ashes/contracts';
import { assertProtocol, fetchOverview } from './api';
import { PlanetThumb, RESOURCE_NAMES } from './planet-ui';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Portrait render size for the home-planet card (displayed at 200px). */
const HOME_PORTRAIT_SIZE = 220;

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
        <dl className="header-meta">
          <div className="meta-item">
            <dt>World</dt>
            <dd data-testid="world-id">{worldId}</dd>
          </div>
          <div className="meta-item">
            <dt>Seed</dt>
            <dd data-testid="game-seed">{seed}</dd>
          </div>
          {readyView && (
            <>
              <div className="meta-item">
                <dt>Commander</dt>
                <dd>{readyView.player.name}</dd>
              </div>
              <div className="meta-item meta-divider">
                <dt>Current tick</dt>
                <dd className="tick-value" data-testid="overview-tick">
                  {readyView.tick}
                </dd>
              </div>
              <div className="meta-item">
                <dt>Next tick</dt>
                <dd className="tick-value" data-testid="next-tick-countdown">
                  {formatCountdown(readyView.nextTickAt, now)}
                </dd>
              </div>
            </>
          )}
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

      {state.status === 'ready' && <Overview view={state.view} seed={seed} />}

      <footer className="game-footer">
        <span>deterministic core · versioned protocol</span>
        <span>ashfield command archive</span>
      </footer>
    </div>
  );
}

function Overview({ view, seed }: { view: WorldView; seed: string }) {
  const home = view.player.homePlanet;

  return (
    <main className="game-grid">
      <section className="panel home-panel" aria-labelledby="home-heading">
        <h2 id="home-heading" className="panel-title">
          Home planet
        </h2>
        <a
          className="home-card"
          data-testid="home-planet-link"
          href={`planet.html?seed=${seed}&planet=${encodeURIComponent(home.id)}`}
        >
          <PlanetThumb
            worldId={view.worldId}
            planetId={home.id}
            name={home.name}
            size={HOME_PORTRAIT_SIZE}
            className="planet-thumb-large"
            priority
          />
          <p className="home-card-name">
            <strong>{home.name}</strong>
            {home.factionId && <span className="faction-tag">{home.factionId}</span>}
          </p>
          <p className="home-coord">
            <span className="micro-label">Coordinate</span>
            <strong data-testid="home-coordinate">{formatCoordinate(home.coordinate)}</strong>
          </p>
          <span className="home-card-cta">Open the ledger →</span>
        </a>
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
                <code>{o.command.kind}</code>
              </li>
            ))}
          </ul>
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
