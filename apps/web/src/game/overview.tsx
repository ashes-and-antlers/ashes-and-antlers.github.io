import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCoordinate, type PlanetView, type WorldView } from '@ashes/contracts';
import { assertProtocol, fetchOverview } from './api';

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

      {state.status === 'ready' && <Overview view={state.view} now={now} />}

      <footer className="game-footer">
        <span>deterministic core · versioned protocol</span>
        <span>ashfield command archive</span>
      </footer>
    </div>
  );
}

function Overview({ view, now }: { view: WorldView; now: number }) {
  const secondsLeft = Math.max(0, Math.ceil((view.nextTickAt - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const home = view.player.homePlanet;

  return (
    <main className="game-grid">
      <section className="panel tick-panel" aria-labelledby="tick-heading">
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
        </div>
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
        </dl>
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
        <p className="home-coord">
          <span className="micro-label">Coordinate</span>
          <strong data-testid="home-coordinate">{formatCoordinate(home.coordinate)}</strong>
        </p>
        <AbundanceBar planet={home} />
        <p className="home-note">The local fleet anchor. Development begins here.</p>
      </section>

      <section className="panel planets-panel" aria-labelledby="planets-heading">
        <h2 id="planets-heading" className="panel-title">
          Known planets
        </h2>
        <PlanetTable planets={view.planets} />
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

function AbundanceBar({ planet }: { planet: PlanetView }) {
  const rows: Array<[keyof PlanetView['abundance'], string]> = [
    ['metal', 'Metal'],
    ['mineral', 'Mineral'],
    ['food', 'Food'],
    ['energy', 'Energy'],
  ];
  return (
    <div className="abundance" aria-label="planet abundance">
      {rows.map(([key, label]) => (
        <div className="abundance-row" key={key}>
          <span className="abundance-label">{label}</span>
          <div className="abundance-track" role="meter" aria-valuenow={planet.abundance[key]}>
            <div className="abundance-fill" style={{ width: `${planet.abundance[key]}%` }} />
          </div>
          <span className="abundance-value">{planet.abundance[key]}</span>
        </div>
      ))}
    </div>
  );
}

function PlanetTable({ planets }: { planets: PlanetView[] }) {
  return (
    <table className="planet-table">
      <thead>
        <tr>
          <th scope="col">Coordinate</th>
          <th scope="col">Name</th>
          <th scope="col">Owner</th>
          <th scope="col">Faction</th>
          <th scope="col">Resolved</th>
        </tr>
      </thead>
      <tbody>
        {planets.map((p) => (
          <tr key={p.id}>
            <td className="mono">{formatCoordinate(p.coordinate)}</td>
            <td>{p.name}</td>
            <td>{p.ownerId ?? '—'}</td>
            <td>{p.factionId ?? '—'}</td>
            <td className="mono">{p.lastResolvedTick}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
