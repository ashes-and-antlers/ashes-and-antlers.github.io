import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROTOCOL_VERSION, formatCoordinate, type GalaxyView } from '@ashes/contracts';
import { fetchGalaxy } from './api';
import { SectionHelp } from './planet-ui';

const MAX_CONSECUTIVE_FAILURES = 3;
/** Narrowest map window (world units) — the maximum zoom-in. */
const MIN_WINDOW_WIDTH = 80;
/** Per wheel notch, the window shrinks/grows by this factor. */
const ZOOM_STEP = 1 / 1.35;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; offline: boolean }
  | { status: 'ready'; view: GalaxyView };

/** A rectangular window of map space, in world units. */
type Window = { minX: number; minY: number; maxX: number; maxY: number };

/** Which viewport the map is showing: the whole chart, one galaxy, one sector. */
type Level =
  | { kind: 'chart' }
  | { kind: 'galaxy'; galaxy: number }
  | { kind: 'sector'; galaxy: number; sector: number };

/**
 * Fit a box to a window with the frame's aspect ratio, so the map never
 * distorts and `viewBox` always fills the frame exactly.
 */
function fitBox(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  aspect: number,
): Window {
  let w = box.maxX - box.minX;
  let h = box.maxY - box.minY;
  if (w / h > aspect) {
    h = w / aspect;
  } else {
    w = h * aspect;
  }
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 };
}

export function MapApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldId = `world:${seed}`;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const view = await fetchGalaxy(worldId);
        if (view.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(
            `protocol mismatch: client ${PROTOCOL_VERSION}, server ${view.protocolVersion}`,
          );
        }
        if (cancelled) return;
        failuresRef.current = 0;
        setState({ status: 'ready', view });
      } catch (err) {
        if (cancelled) return;
        failuresRef.current += 1;
        const message = err instanceof Error ? err.message : 'unknown error';
        setState({
          status: 'error',
          message,
          offline: failuresRef.current >= MAX_CONSECUTIVE_FAILURES,
        });
      }
    };
    void load();
    return () => {
      cancelled = true;
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
          <a className="back-link" data-testid="map-back" href={`game.html?seed=${seed}`}>
            ← Command overview
          </a>
        </div>
        <dl className="header-meta">
          {readyView && (
            <>
              <div className="meta-item">
                <dt>Galaxies</dt>
                <dd className="mono" data-testid="map-galaxy-count">
                  {readyView.config.galaxies}
                </dd>
              </div>
              <div className="meta-item meta-divider">
                <dt>Worlds</dt>
                <dd className="mono" data-testid="map-planet-count">
                  {readyView.planets.length.toLocaleString()}
                </dd>
              </div>
              <div className="meta-item meta-divider">
                <dt>Sectors</dt>
                <dd className="mono" data-testid="map-sector-count">
                  {readyView.sectors.length}
                </dd>
              </div>
            </>
          )}
        </dl>
      </header>

      {state.status === 'loading' && <p className="status-line">Charting the galaxies…</p>}

      {state.status === 'error' && !state.offline && (
        <p className="retrying-line" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          Engine not responding — retrying…
        </p>
      )}

      {state.status === 'error' && state.offline && (
        <section
          className="offline-card"
          data-testid="map-offline"
          aria-labelledby="offline-heading"
        >
          <h2 id="offline-heading">Archive offline</h2>
          <p className="offline-explainer">
            The galaxy chart is served by the simulation engine. Start it and reload, or retry
            below.
          </p>
          <p className="offline-tech">{state.message}</p>
          <button type="button" className="retry-button" onClick={retry}>
            Try again
          </button>
        </section>
      )}

      {state.status === 'ready' && <GalaxyMap view={state.view} seed={seed} />}

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

function GalaxyMap({ view, seed }: { view: GalaxyView; seed: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [win, setWin] = useState<Window | null>(null);
  const [level, setLevel] = useState<Level>({ kind: 'chart' });
  const winRef = useRef<Window | null>(null);
  const dragRef = useRef<{ px: number; py: number; id: number } | null>(null);
  const draggedRef = useRef(false);

  const homeGalaxy = useMemo(() => {
    const home = view.planets.find((p) => p.id === view.homePlanetId);
    return home?.coordinate.galaxy ?? 1;
  }, [view]);

  const homeSector = useMemo(() => {
    const home = view.planets.find((p) => p.id === view.homePlanetId);
    return home?.coordinate.sector ?? 1;
  }, [view]);

  // Keep the current window + level readable inside native event handlers.
  const updateWin = (next: Window) => {
    winRef.current = next;
    setWin(next);
  };
  const updateLevel = setLevel;

  const chartBox = useMemo(() => view.bounds, [view]);

  const galaxyBox = useCallback(
    (galaxy: number): Window => {
      const g = view.galaxies.find((x) => x.galaxy === galaxy);
      const r = g ? g.discRadius : 4_000;
      const o = g ? g.position : { x: 0, y: 0 };
      return { minX: o.x - r, minY: o.y - r, maxX: o.x + r, maxY: o.y + r };
    },
    [view],
  );

  const sectorBox = useCallback(
    (galaxy: number, sector: number): Window => {
      const s = view.sectors.find((x) => x.galaxy === galaxy && x.sector === sector);
      if (!s) return galaxyBox(galaxy);
      return {
        minX: s.bounds.minX,
        minY: s.bounds.minY,
        maxX: s.bounds.maxX,
        maxY: s.bounds.maxY,
      };
    },
    [view, galaxyBox],
  );

  // Measure the frame so dots/labels keep a constant screen size at any zoom
  // and the fitted window matches the frame's aspect ratio.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the chart once the frame is measured and the view is ready.
  useEffect(() => {
    if (frame.w > 0 && frame.h > 0 && !winRef.current) {
      updateWin(fitBox(chartBox, frame.w / frame.h));
    }
  }, [frame, chartBox]);

  const frameRect = () => frameRef.current?.getBoundingClientRect() ?? null;

  /** Screen px → world units (the window fills the frame exactly). */
  const screenToWorld = (clientX: number, clientY: number) => {
    const winNow = winRef.current;
    const rect = frameRect();
    if (!winNow || !rect) return null;
    const w = winNow.maxX - winNow.minX;
    const h = winNow.maxY - winNow.minY;
    return {
      x: winNow.minX + ((clientX - rect.left) / rect.width) * w,
      y: winNow.minY + ((clientY - rect.top) / rect.height) * h,
    };
  };

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const prev = winRef.current;
    if (!prev) return;
    const w = prev.maxX - prev.minX;
    const h = prev.maxY - prev.minY;
    if (w * factor < MIN_WINDOW_WIDTH) return;
    // Never zoom out past the chart bounds: the galaxy should not be lost
    // in empty space, with Fit as the only way back.
    if (w * factor > chartBox.maxX - chartBox.minX) return;
    const nw = w * factor;
    const nh = h * factor;
    const lr = (cx - prev.minX) / w;
    const tr = (cy - prev.minY) / h;
    updateWin({
      minX: cx - nw * lr,
      maxX: cx + nw * (1 - lr),
      minY: cy - nh * tr,
      maxY: cy + nh * (1 - tr),
    });
  };

  // Wheel zoom (non-passive so the page does not scroll while zooming).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const point = screenToWorld(e.clientX, e.clientY);
      if (!point) return;
      zoomAt(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, point.x, point.y);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomCenter = (factor: number) => {
    const prev = winRef.current;
    if (!prev) return;
    const cx = (prev.minX + prev.maxX) / 2;
    const cy = (prev.minY + prev.maxY) / 2;
    zoomAt(factor, cx, cy);
  };

  /** Drill into a galaxy: frame its disc and switch to the galaxy viewport. */
  const focusGalaxy = (galaxy: number) => {
    if (frame.w > 0 && frame.h > 0) {
      updateWin(fitBox(galaxyBox(galaxy), frame.w / frame.h));
    }
    updateLevel({ kind: 'galaxy', galaxy });
  };

  /** Drill into a sector: frame its cell and switch to the sector viewport. */
  const focusSector = (galaxy: number, sector: number) => {
    if (frame.w > 0 && frame.h > 0) {
      updateWin(fitBox(sectorBox(galaxy, sector), frame.w / frame.h));
    }
    updateLevel({ kind: 'sector', galaxy, sector });
  };

  /** Back out to the chart. */
  const reset = () => {
    if (frame.w > 0 && frame.h > 0) updateWin(fitBox(chartBox, frame.w / frame.h));
    updateLevel({ kind: 'chart' });
  };

  const focusHome = () => {
    focusSector(homeGalaxy, homeSector);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Never hijack the control buttons: a press there is a click, not a pan.
    if ((e.target as Element).closest('.map-controls')) return;
    dragRef.current = { px: e.clientX, py: e.clientY, id: e.pointerId };
    draggedRef.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragRef.current;
    const prev = winRef.current;
    const rect = frameRect();
    if (!start || !prev || !rect) return;
    const dx = e.clientX - start.px;
    const dy = e.clientY - start.py;
    // Capture the pointer only once a real drag starts, so plain clicks
    // (buttons, planet dots) keep reaching their targets.
    if (!draggedRef.current && Math.hypot(dx, dy) < 4) return;
    if (!draggedRef.current) {
      draggedRef.current = true;
      e.currentTarget.setPointerCapture(start.id);
    }
    const w = prev.maxX - prev.minX;
    const h = prev.maxY - prev.minY;
    updateWin({
      minX: prev.minX - (dx / rect.width) * w,
      maxX: prev.maxX - (dx / rect.width) * w,
      minY: prev.minY - (dy / rect.height) * h,
      maxY: prev.maxY - (dy / rect.height) * h,
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // draggedRef intentionally stays set after a drag: the click that follows
    // a pan must not navigate. It resets on the next pointerdown.
  };

  const frameWidth = frame.w > 0 ? frame.w : 1;
  const scale = win ? (win.maxX - win.minX) / frameWidth : 1;
  const dotR = 2.4 * scale;
  const knownR = 4.6 * scale;
  const starR = 1.7 * scale;
  const ringR = 7.2 * scale;
  const labelSize = 10 * scale;
  const galaxyLabelSize = 12 * scale;

  const currentLevel = level;

  return (
    <main className="map-page">
      {/* Breadcrumb: where you are in the chart. */}
      <nav className="map-crumbs" aria-label="Map level">
        <button type="button" className="map-crumb" data-testid="map-crumb-chart" onClick={reset}>
          Chart
        </button>
        {currentLevel.kind !== 'chart' && (
          <>
            <span className="map-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="map-crumb map-crumb-current" data-testid="map-crumb-galaxy">
              Galaxy {currentLevel.kind === 'galaxy' ? currentLevel.galaxy : homeGalaxy}
            </span>
          </>
        )}
        {currentLevel.kind === 'sector' && (
          <>
            <span className="map-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="map-crumb map-crumb-current" data-testid="map-crumb-sector">
              Sector {currentLevel.galaxy}:{currentLevel.sector}
            </span>
          </>
        )}
      </nav>

      <div
        className="map-frame"
        ref={frameRef}
        data-testid="map-frame"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {win !== null && (
          <svg
            className="map-svg"
            data-testid="galaxy-map"
            viewBox={`${win.minX} ${win.minY} ${win.maxX - win.minX} ${win.maxY - win.minY}`}
            role="img"
            aria-label="Galaxy map of the archive"
          >
            {/* Chart viewport: every galaxy as a disc, sectors as dots on its arms. */}
            {currentLevel.kind === 'chart' &&
              view.galaxies.map((g) => (
                <g
                  key={g.galaxy}
                  className="map-chart-galaxy"
                  data-testid="map-galaxy"
                  data-home={g.galaxy === homeGalaxy ? 'true' : undefined}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open galaxy ${g.galaxy}`}
                  onClick={() => {
                    if (!draggedRef.current) focusGalaxy(g.galaxy);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      focusGalaxy(g.galaxy);
                    }
                  }}
                >
                  <circle
                    className="map-galaxy-disc"
                    cx={g.position.x}
                    cy={g.position.y}
                    r={g.discRadius}
                  />
                  {view.sectors
                    .filter((s) => s.galaxy === g.galaxy)
                    .map((s) => (
                      <circle
                        key={`${s.galaxy}:${s.sector}`}
                        className="map-sector-dot"
                        cx={s.position.x}
                        cy={s.position.y}
                        r={dotR * 1.6}
                      />
                    ))}
                  {g.galaxy === homeGalaxy && (
                    <circle
                      className="map-home-galaxy-ring"
                      data-testid="map-home-galaxy"
                      cx={g.position.x}
                      cy={g.position.y}
                      r={g.discRadius + ringR}
                    />
                  )}
                  <text
                    className="map-galaxy-label"
                    x={g.position.x}
                    y={g.position.y - g.discRadius - 14 * scale}
                    fontSize={galaxyLabelSize}
                    textAnchor="middle"
                  >
                    G{g.galaxy}
                  </text>
                </g>
              ))}

            {/* Galaxy viewport: sector cells + system stars of one galaxy. */}
            {currentLevel.kind === 'galaxy' && (
              <GalaxyLevelView
                view={view}
                galaxy={currentLevel.galaxy}
                homeGalaxy={homeGalaxy}
                homeSector={homeSector}
                starR={starR}
                labelSize={labelSize}
                scale={scale}
                draggedRef={draggedRef}
                onSectorClick={(sector) => focusSector(currentLevel.galaxy, sector)}
              />
            )}

            {/* Sector viewport: planets of one sector. */}
            {currentLevel.kind === 'sector' && (
              <SectorLevelView
                view={view}
                galaxy={currentLevel.galaxy}
                sector={currentLevel.sector}
                homeGalaxy={homeGalaxy}
                homeSector={homeSector}
                seed={seed}
                dotR={dotR}
                knownR={knownR}
                starR={starR}
                ringR={ringR}
                labelSize={labelSize}
                scale={scale}
              />
            )}
          </svg>
        )}
        <div className="map-controls" role="group" aria-label="Map controls">
          <button type="button" aria-label="Zoom in" onClick={() => zoomCenter(1 / ZOOM_STEP)}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomCenter(ZOOM_STEP)}>
            −
          </button>
          <button type="button" data-testid="map-focus-home" onClick={focusHome}>
            Home
          </button>
          <button type="button" onClick={reset}>
            Fit
          </button>
        </div>
      </div>

      <p className="map-legend" role="list" aria-label="Map legend">
        <span className="map-legend-item" role="listitem">
          <span className="map-legend-dot home" aria-hidden="true" /> Home
        </span>
        <span className="map-legend-item" role="listitem">
          <span className="map-legend-dot known" aria-hidden="true" /> Yours
        </span>
        <span className="map-legend-item" role="listitem">
          <span className="map-legend-dot" aria-hidden="true" /> Unclaimed
        </span>
      </p>

      <SectionHelp id="map">
        <p>
          Every world of the archive, in map space. The chart shows the eight galaxies; each galaxy
          is a spiral of sector cells winding out of its core. Open a galaxy to see its sectors,
          then a sector to see its systems and worlds — coordinates read
          galaxy:sector:system:planet, and the map is drawn to scale: planets in the same system sit
          close together, systems cluster inside their sector, sectors trace the spiral arms, and
          the galaxies are far apart — the same distances fleet drives will later measure. Drag to
          pan, scroll or use the controls to zoom, and click any galaxy, sector, or world to open
          it. Filled worlds are yours; the crowned one is your home.
        </p>
      </SectionHelp>
    </main>
  );
}

/** Galaxy viewport: the sector cells and system stars of one galaxy. */
function GalaxyLevelView({
  view,
  galaxy,
  homeGalaxy,
  homeSector,
  starR,
  labelSize,
  scale,
  draggedRef,
  onSectorClick,
}: {
  view: GalaxyView;
  galaxy: number;
  homeGalaxy: number;
  homeSector: number;
  starR: number;
  labelSize: number;
  scale: number;
  draggedRef: React.MutableRefObject<boolean>;
  onSectorClick: (sector: number) => void;
}) {
  const sectors = view.sectors.filter((s) => s.galaxy === galaxy);
  const systems = view.systems.filter((s) => s.galaxy === galaxy);
  return (
    <g className="map-galaxy-view">
      {sectors.map((s) => (
        <g
          key={`${s.galaxy}:${s.sector}`}
          className="map-sector-cell"
          data-testid="map-sector"
          data-home={galaxy === homeGalaxy && s.sector === homeSector ? 'true' : undefined}
          role="button"
          tabIndex={0}
          aria-label={`Open sector ${s.galaxy}:${s.sector}`}
          onClick={() => {
            if (!draggedRef.current) onSectorClick(s.sector);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSectorClick(s.sector);
            }
          }}
        >
          <rect
            className="map-sector-cell-bg"
            x={s.bounds.minX}
            y={s.bounds.minY}
            width={s.bounds.maxX - s.bounds.minX}
            height={s.bounds.maxY - s.bounds.minY}
            rx={120 * scale}
          />
          {galaxy === homeGalaxy && s.sector === homeSector && (
            <circle
              className="map-home-sector-ring"
              data-testid="map-home-sector"
              cx={s.position.x}
              cy={s.position.y}
              r={300 * scale}
            />
          )}
          <text
            className="map-sector-label"
            x={s.position.x}
            y={s.position.y + labelSize * 0.35}
            fontSize={labelSize}
            textAnchor="middle"
          >
            {s.sector}
          </text>
        </g>
      ))}
      {systems.map((sy) => (
        <circle
          key={`${sy.galaxy}:${sy.sector}:${sy.system}`}
          className="map-star"
          cx={sy.position.x}
          cy={sy.position.y}
          r={starR}
        />
      ))}
    </g>
  );
}

/** Sector viewport: one sector's systems and worlds, click-through to ledgers. */
function SectorLevelView({
  view,
  galaxy,
  sector,
  homeGalaxy,
  homeSector,
  seed,
  dotR,
  knownR,
  starR,
  ringR,
  labelSize,
  scale,
}: {
  view: GalaxyView;
  galaxy: number;
  sector: number;
  homeGalaxy: number;
  homeSector: number;
  seed: string;
  dotR: number;
  knownR: number;
  starR: number;
  ringR: number;
  labelSize: number;
  scale: number;
}) {
  const s = view.sectors.find((x) => x.galaxy === galaxy && x.sector === sector);
  const systems = view.systems.filter((x) => x.galaxy === galaxy && x.sector === sector);
  const planets = view.planets.filter(
    (p) => p.coordinate.galaxy === galaxy && p.coordinate.sector === sector,
  );
  const isHome = galaxy === homeGalaxy && sector === homeSector;
  if (!s) return null;
  return (
    <g className="map-sector-view">
      <rect
        className="map-sector-view-bg"
        x={s.bounds.minX}
        y={s.bounds.minY}
        width={s.bounds.maxX - s.bounds.minX}
        height={s.bounds.maxY - s.bounds.minY}
        rx={120 * scale}
      />
      {systems.map((sy) => (
        <circle
          key={`${sy.galaxy}:${sy.sector}:${sy.system}`}
          className="map-star"
          cx={sy.position.x}
          cy={sy.position.y}
          r={starR}
        />
      ))}
      {planets.map((p) => (
        <a
          key={p.id}
          className="map-planet-link"
          data-testid={p.known ? 'map-known' : 'map-planet'}
          href={`planet.html?seed=${seed}&planet=${encodeURIComponent(p.id)}`}
        >
          {p.known && (
            <circle
              className="map-home-ring"
              data-testid="map-home"
              cx={p.position.x}
              cy={p.position.y}
              r={ringR}
            />
          )}
          <circle
            className={`map-planet${p.known ? ' known' : ''}`}
            cx={p.position.x}
            cy={p.position.y}
            r={p.known ? knownR : dotR}
          />
          {p.known && (
            <text
              className="map-label"
              x={p.position.x + knownR + 6 * scale}
              y={p.position.y + labelSize * 0.35}
              fontSize={labelSize}
            >
              {p.name}
            </text>
          )}
          <title>{`${p.name} — ${formatCoordinate(p.coordinate)}`}</title>
        </a>
      ))}
      {isHome && (
        <text
          className="map-sector-name"
          x={s.position.x}
          y={s.bounds.minY - 10 * scale}
          fontSize={labelSize * 1.2}
          textAnchor="middle"
        >
          Home sector — {galaxy}:{sector}
        </text>
      )}
    </g>
  );
}
