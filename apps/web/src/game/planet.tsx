import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCoordinate, type PlanetView } from '@ashes/contracts';
import { factionById } from '@ashes/content';
import { ApiError, assertProtocol, fetchOverview, fetchPlanet, fetchPlanetImage } from './api';
import { GameHeader, HeaderMeta, type WorldMeta } from './header';
import { sessionWorldId } from './session';
import {
  PLANET_PORTRAIT_SIZE,
  RESOURCE_NAMES,
  SectionHelp,
  planetClassName,
  WarningsChips,
} from './planet-ui';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// Dev keeps polling through an offline stretch so a `tsx watch` API restart
// never strands the ledger on the offline card; the static build stops.
const DEV_AUTO_RECOVER = import.meta.env.DEV;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: string; offline: boolean }
  | { status: 'notFound' }
  | { status: 'ready'; view: PlanetView };

export function PlanetApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const planetId = params.get('planet');
  const worldId = sessionWorldId(seed);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const failuresRef = useRef(0);
  // The header's live readout, fed by the overview poll this page already
  // runs as its world-level handshake (no extra request).
  const [worldMeta, setWorldMeta] = useState<WorldMeta | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  // Poll the single-planet projection. Unknown planets get a distinct
  // not-found state (the planet route 404s) rather than the offline card.
  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    const load = async () => {
      try {
        // The overview is the world-level handshake (existence + protocol).
        // A failure here is an engine/offline problem, not an unknown planet.
        const overview = await fetchOverview(worldId);
        assertProtocol(overview);
        setWorldMeta({
          name: overview.player.name,
          tick: overview.tick,
          nextTickAt: overview.nextTickAt,
        });
        let view;
        try {
          view = await fetchPlanet(worldId, planetId ?? '');
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            // The world is reachable but the planet does not exist in it.
            stopped = true;
            setState({ status: 'notFound' });
            return;
          }
          throw err;
        }
        if (cancelled) return;
        failuresRef.current = 0;
        stopped = false;
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
  }, [worldId, planetId, attempt]);

  // Fetch the pre-rendered PNG once per planet id. The blob URL is tracked in
  // a ref so a replacement (and unmount) always revokes the previous one —
  // never leak an object URL across retries.
  const readyView = state.status === 'ready' ? state.view : null;
  useEffect(() => {
    let cancelled = false;
    if (readyView) {
      fetchPlanetImage(worldId, readyView.id, PLANET_PORTRAIT_SIZE)
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          if (imageUrlRef.current !== null) URL.revokeObjectURL(imageUrlRef.current);
          imageUrlRef.current = url;
          setImageUrl(url);
        })
        .catch(() => {
          // Image failure is non-fatal: the ledger still renders.
        });
    }
    return () => {
      cancelled = true;
      if (imageUrlRef.current !== null) {
        URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
        setImageUrl(null);
      }
    };
  }, [readyView?.id, worldId]);

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
        title="Planetary Ledger"
        current="planet"
        meta={worldMeta && <HeaderMeta meta={worldMeta} />}
      />
      {state.status === 'loading' && <p className="status-line">Opening the ledger…</p>}
      {state.status === 'error' && !state.offline && (
        <p className="retrying-line" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          Engine not responding — retrying…
        </p>
      )}
      {state.status === 'notFound' && (
        <section
          className="offline-card"
          data-testid="planet-not-found"
          aria-labelledby="nf-heading"
        >
          <h2 id="nf-heading">Unknown planet</h2>
          <p className="offline-explainer">
            This archive has no record of <code>{planetId}</code> in {worldId}. It may belong to
            another world, or the world has not reached it yet.
          </p>
          <a className="retry-button" href={`game.html?seed=${seed}`}>
            Back to command overview
          </a>
        </section>
      )}
      {state.status === 'error' && state.offline && (
        <section
          className="offline-card"
          data-testid="planet-offline"
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
        <PlanetLedger view={state.view} imageUrl={imageUrl} seed={seed} />
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
        <span>planetary ledger · ashfield command archive</span>
      </footer>
    </div>
  );
}

/** Trend color for a signed per-tick rate: surplus green, deficit red, flat muted. */
function netClass(net: number): string {
  return net > 0 ? 'net-pos' : net < 0 ? 'net-neg' : 'net-zero';
}

function PlanetLedger({
  view,
  imageUrl,
  seed,
}: {
  view: PlanetView;
  imageUrl: string | null;
  seed: string;
}) {
  return (
    <main className="planet-grid">
      {/* Identity: the portrait and the planet's fixed facts. */}
      <section className="panel planet-identity" aria-labelledby="identity-heading">
        <h2 id="identity-heading" className="panel-title">
          World
        </h2>
        <div className="planet-identity-main">
          <div className="portrait-frame">
            {imageUrl === null ? (
              <div className="portrait-placeholder" data-testid="planet-image-loading">
                Engraving the sphere…
              </div>
            ) : (
              <>
                <img
                  className="planet-portrait"
                  data-testid="planet-image"
                  src={imageUrl}
                  alt={`Procedurally generated portrait of ${view.name}`}
                  width={PLANET_PORTRAIT_SIZE}
                  height={PLANET_PORTRAIT_SIZE}
                />
                {/* The brand mark, stamped small at the portrait's corner. It is
                    never recolored, tinted, or distorted (The Brand Mark Rule). */}
                <img
                  className="portrait-brand"
                  src="logo.png"
                  alt="Ashes and Antlers"
                  width={56}
                  height={38}
                  loading="lazy"
                />
              </>
            )}
          </div>
          <div className="planet-identity-facts">
            <p className="planet-name">{view.name}</p>
            <p className="planet-fact">
              <span className="micro-label">World class</span>
              <strong data-testid="planet-class">{planetClassName(view.classId)}</strong>
            </p>
            <p className="planet-fact">
              <span className="micro-label">Coordinate</span>
              <strong className="mono" data-testid="planet-coordinate">
                {formatCoordinate(view.coordinate)}
              </strong>
            </p>
            <p className="planet-fact">
              <span className="micro-label">Faction</span>
              <strong data-testid="planet-faction">
                {view.factionId
                  ? (factionById(view.factionId)?.name ?? view.factionId)
                  : 'Unclaimed'}
              </strong>
            </p>
          </div>
        </div>
        <a
          className="construction-desk-link"
          data-testid="planet-construction-link"
          href={`constructions.html?seed=${seed}&planet=${encodeURIComponent(view.id)}`}
        >
          Manage construction →
        </a>
      </section>

      {/* Economy: what the store holds, how it trends, and why — at a glance. */}
      <section className="panel planet-economy" aria-labelledby="economy-heading">
        <h2 id="economy-heading" className="panel-title">
          Economy
        </h2>
        {/* One tile per resource: stored amount is the hero figure, the bar
            shows how full the stock is against the cap, the net chip shows
            the trend, and abundance explains the ceiling in a micro-label. */}
        <div className="resource-tiles" data-testid="planet-resource-tiles">
          {RESOURCE_NAMES.map(([key, label]) => {
            const stored = view.resources[key];
            const net = view.rates.net[key];
            const fillPct =
              view.storageCap > 0 ? Math.min(100, Math.round((stored / view.storageCap) * 100)) : 0;
            return (
              <div className="resource-tile" key={key}>
                <span className="resource-tile-name">{label}</span>
                <span className="resource-tile-stored mono" data-testid={`resource-stored-${key}`}>
                  {stored.toLocaleString()}
                </span>
                <span
                  className="resource-tile-track"
                  role="img"
                  aria-label={`${label} storage ${fillPct}% full`}
                  title={`${stored.toLocaleString()} / ${view.storageCap.toLocaleString()}`}
                >
                  <span className="resource-tile-fill" style={{ width: `${fillPct}%` }} />
                </span>
                <span className="resource-tile-meta mono">
                  <span
                    className={`resource-tile-net ${netClass(net)}`}
                    data-testid={`resource-net-${key}`}
                  >
                    {net > 0 ? '+' : ''}
                    {net} / tick
                  </span>
                  <span
                    className="resource-tile-abundance"
                    title="How rich the world is by nature — caps extraction yield"
                  >
                    abundance {view.abundance[key]}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <dl className="planet-stats">
          <div>
            <dt>Population</dt>
            <dd className="mono" data-testid="planet-population">
              {view.population.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Storage cap</dt>
            <dd className="mono">{view.storageCap.toLocaleString()} / resource</dd>
          </div>
          <div>
            <dt>Resolved at tick</dt>
            <dd className="mono">{view.lastResolvedTick}</dd>
          </div>
        </dl>
        <SectionHelp id="resources">
          <p>
            Stored is what the planet holds right now, and the bar shows how full the stock is
            against the storage cap. Net per tick is the trend: production minus upkeep, so a green
            surplus grows the stock and a red deficit drains it. Abundance is how rich the world is
            by nature and caps what extraction can pull; population is the world&apos;s headcount,
            the hands that work your buildings; anything produced beyond the cap is wasted. Open
            Production &amp; upkeep to see exactly where the net comes from.
          </p>
        </SectionHelp>
        {/* The drivers behind the trend, one fold away. */}
        <details className="rates-fold">
          <summary>
            <span className="rates-fold-title">Production &amp; upkeep</span>
            <span className="fold-chevron" aria-hidden="true" />
          </summary>
          <table className="rates-table">
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Production</th>
                <th scope="col">Upkeep</th>
                <th scope="col">Net</th>
              </tr>
            </thead>
            <tbody>
              {RESOURCE_NAMES.map(([key, label]) => {
                const production = view.rates.production[key];
                const upkeep = view.rates.upkeep[key];
                const net = view.rates.net[key];
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td className="mono">{production > 0 ? `+${production}` : production}</td>
                    <td className="mono">{upkeep > 0 ? `−${upkeep}` : upkeep}</td>
                    <td className={`mono ${netClass(net)}`}>{net > 0 ? `+${net}` : net}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      </section>

      {/* Warnings: the flags that need attention. */}
      <section className="panel planet-warnings" aria-labelledby="warnings-heading">
        <h2 id="warnings-heading" className="panel-title">
          Warnings
        </h2>
        {view.warnings.length === 0 ? (
          <p className="warnings-clear">No warnings — all systems nominal.</p>
        ) : (
          <WarningsChips warnings={view.warnings} />
        )}
        <SectionHelp id="warnings">
          <p>
            Flags the archive raises when a world needs attention — a full stock that is wasting
            production, or a food or energy deficit that will bite at resolution.
          </p>
        </SectionHelp>
      </section>
    </main>
  );
}
