import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCoordinate,
  type PendingOrderView,
  type PlanetView,
  type WorldView,
} from '@ashes/contracts';
import { BUILDING_DEFINITIONS, RESEARCH_BY_ID, SHIP_DEFINITIONS } from '@ashes/content';
import { ApiError, assertProtocol, fetchMe, fetchOverview } from './api';
import { GameHeader, HeaderMeta } from './header';
import { PlanetThumb, RESOURCE_NAMES, SectionHelp } from './planet-ui';
import { clearSession, getSession, saveSession, sessionWorldId } from './session';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;
// In dev the API restarts constantly (`tsx watch`), so freezing the page after
// three failures strands it on the offline card while the backend is already
// back. Dev keeps polling and recovers on its own; the production/static build
// keeps the stop-on-offline behavior (no request spam on a dead backend).
const DEV_AUTO_RECOVER = import.meta.env.DEV;

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
  const worldId = sessionWorldId(seed);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    const load = async () => {
      try {
        const session = getSession();
        if (session) {
          // The token is authoritative. Refresh the cached account view so a
          // browser session from an older local database cannot pair the right
          // token with the wrong world id.
          const account = await fetchMe();
          if (
            account.worldId !== session.account.worldId ||
            account.playerId !== session.account.playerId
          ) {
            saveSession({ token: session.token, account });
            window.location.replace(`game.html?seed=${encodeURIComponent(seed)}`);
            return;
          }
        }
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
        // A persisted account can outlive a local world/test database. If its
        // token is gone, return to the seeded dev identity instead of trapping
        // the overview offline.
        if (err instanceof ApiError && (err.status === 401 || err.status === 404) && getSession()) {
          clearSession();
          window.location.replace(`game.html?seed=${encodeURIComponent(seed)}`);
          return;
        }
        failuresRef.current += 1;
        const { message, code } = describeError(err);
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
      <GameHeader
        seed={seed}
        title="Command Overview"
        current="overview"
        meta={
          readyView && (
            <HeaderMeta
              meta={{
                name: readyView.player.name,
                tick: readyView.tick,
                nextTickAt: readyView.nextTickAt,
              }}
            />
          )
        }
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
          <div className="orders-empty">
            <p className="empty-state">No orders pending resolution.</p>
            <a className="construction-desk-link" href={`constructions.html?seed=${seed}`}>
              Raise a building →
            </a>
          </div>
        ) : (
          <ul className="orders-list" data-testid="pending-orders">
            {view.pendingOrders.map((o) => (
              <li key={o.id} className="pending-order">
                <span className="pending-order-kind">{pendingLabel(o)}</span>
                <span className="pending-order-planet">{pendingPlace(o)}</span>
                <span className="pending-order-eta mono">
                  {o.status === 'building'
                    ? `${o.ticksRemaining} tick${o.ticksRemaining === 1 ? '' : 's'} left`
                    : `queued — position ${o.position + 1}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <SectionHelp id="orders">
          <p>
            Orders you&apos;ve issued wait here and resolve when the next tick fires — buildings
            being raised, studies running at the archive, and hulls in your shipyards. A tick is one
            fixed beat of the simulation: the world advances by exactly one step, and every order
            issued before its cutoff is applied in that same beat. The header countdown is the time
            until that next beat resolves.
          </p>
        </SectionHelp>
      </section>

      <section className="panel reports-panel" aria-labelledby="reports-heading">
        <h2 id="reports-heading" className="panel-title">
          Recent completions
        </h2>
        {view.reports.length === 0 ? (
          <p className="empty-state">Nothing has completed yet.</p>
        ) : (
          <ul className="reports-list" data-testid="reports-list">
            {view.reports.map((r) => (
              <li key={r.id} className="report-row">
                <span className="report-tick mono">tick {r.tick}</span>
                <span className="report-label">{r.label}</span>
                <span className="report-planet">{r.planetName ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
        <SectionHelp id="reports">
          <p>
            The archive&apos;s feed of recent completions — research that finished, ships that
            launched, and buildings that were raised. Derived from the immutable order records, so a
            refresh can never change history.
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

/** The human label of a pending order, across the three kinds. */
function pendingLabel(o: PendingOrderView): string {
  if (o.kind === 'building') return BUILDING_DEFINITIONS[o.building].name;
  if (o.kind === 'ship') return `${SHIP_DEFINITIONS[o.ship].name} × ${o.quantity}`;
  return RESEARCH_BY_ID[o.technologyId]?.name ?? o.technologyId;
}

/** The place a pending order runs: planet name (research uses the lab host). */
function pendingPlace(o: PendingOrderView): string {
  if (o.kind === 'research') return o.hostPlanetName;
  return o.planetName;
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
