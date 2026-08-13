import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCoordinate, type PlanetView, type WorldView } from '@ashes/contracts';
import { assertProtocol, fetchOverview } from './api';
import { BuildingsSection, ShipyardSection } from './construction';
import { GameHeader, HeaderMeta, type WorldMeta } from './header';
import { SectionHelp } from './planet-ui';
import { sessionWorldId } from './session';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEV_AUTO_RECOVER = import.meta.env.DEV;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: string; offline: boolean }
  | { status: 'ready'; view: WorldView };

/**
 * The archive's construction desk: every owned world's building and shipyard
 * production, managed from one surface. A picker chooses the world; below it
 * the full building catalog and (where a Shipyard stands) the ship catalog.
 * The planet ledger keeps the dossier — this page owns the work.
 */
export function ConstructionsApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldId = sessionWorldId(seed);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [worldMeta, setWorldMeta] = useState<WorldMeta | null>(null);
  const [worldVersion, setWorldVersion] = useState(0);
  // Which world the desk is editing; deep-linkable via ?planet=…, defaults to
  // the home world once the overview resolves.
  const [selectedPlanetId, setSelectedPlanetId] = useState<string | null>(params.get('planet'));
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
        title="Constructions"
        current="constructions"
        meta={worldMeta && <HeaderMeta meta={worldMeta} />}
      />

      {state.status === 'loading' && <p className="status-line">Opening the desk…</p>}
      {state.status === 'error' && !state.offline && (
        <p className="retrying-line" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          Engine not responding — retrying…
        </p>
      )}
      {state.status === 'error' && state.offline && (
        <section
          className="offline-card"
          data-testid="constructions-offline"
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
        <ConstructionsPanel
          view={state.view}
          worldId={worldId}
          worldVersion={worldVersion}
          selectedPlanetId={selectedPlanetId}
          onSelect={setSelectedPlanetId}
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
        <span>construction desk · ashfield command archive</span>
      </footer>
    </div>
  );
}

function ConstructionsPanel({
  view,
  worldId,
  worldVersion,
  selectedPlanetId,
  onSelect,
  onStateChange,
}: {
  view: WorldView;
  worldId: string;
  worldVersion: number;
  selectedPlanetId: string | null;
  onSelect: (id: string) => void;
  onStateChange: () => void;
}) {
  // The worlds the commander can build on: owned planets (the home world at
  // the very least). A deep-linked planet that is not owned falls back to home.
  const owned = view.planets.filter((p) => p.ownerId === view.player.id);
  const planets = owned.length > 0 ? owned : [view.player.homePlanet];
  const selected =
    planets.find((p) => p.id === selectedPlanetId) ??
    planets.find((p) => p.id === view.player.homePlanet.id) ??
    planets[0];

  return (
    <main className="constructions-grid">
      <section className="panel constructions-picker" aria-labelledby="pick-heading">
        <h2 id="pick-heading" className="panel-title">
          Worlds
        </h2>
        <ul className="planet-picker" data-testid="constructions-planets">
          {planets.map((p) => {
            const active = activeOrders(p);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`planet-picker-pill${p.id === selected.id ? ' is-selected' : ''}`}
                  data-testid={`pick-planet-${p.id}`}
                  aria-pressed={p.id === selected.id}
                  onClick={() => onSelect(p.id)}
                >
                  <span className="planet-picker-name">{p.name}</span>
                  <span className="planet-picker-meta mono">
                    {formatCoordinate(p.coordinate)} · {active} active
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <SectionHelp id="constructions-worlds">
          <p>
            Choose a world to read its queue and raise buildings or ships there. Each world keeps
            its own store and its own construction and shipyard queues; the cost of every order is
            reserved from that world&apos;s store the moment you commit.
          </p>
        </SectionHelp>
      </section>

      <BuildingsSection
        view={selected}
        worldId={worldId}
        worldVersion={worldVersion}
        onStateChange={onStateChange}
      />
      <ShipyardSection
        view={selected}
        worldId={worldId}
        worldVersion={worldVersion}
        completedTechs={view.research.completed}
        onStateChange={onStateChange}
      />
    </main>
  );
}

/** Building + shipyard orders currently in flight on a world. */
function activeOrders(planet: PlanetView): number {
  const building = planet.construction.filter(
    (o) => o.status === 'building' || o.status === 'queued',
  ).length;
  const ship = planet.shipyard.filter(
    (o) => o.status === 'building' || o.status === 'queued',
  ).length;
  return building + ship;
}
