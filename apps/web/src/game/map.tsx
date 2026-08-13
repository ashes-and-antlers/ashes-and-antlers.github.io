import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { PROTOCOL_VERSION, formatCoordinate, type GalaxyView } from '@ashes/contracts';
import { PLANET_CLASSES } from '@ashes/content';
import { fetchGalaxy } from './api';
import { GameHeader, HeaderMeta, useWorldMeta } from './header';
import { sessionWorldId } from './session';
import { SectionHelp, planetClassName } from './planet-ui';
import { buildSky } from './sky';
import {
  boundsForLevel,
  clampWindow,
  fitWindow,
  makeViewBox,
  paintMap,
  scaleWindow,
  screenToPoint,
  type MapLevel,
  type MapWindow,
} from './map-engine';

const MAX_CONSECUTIVE_FAILURES = 3;
const MIN_WINDOW_WIDTH = 120;
const MAX_WINDOW_WIDTH = 80_000;
const ZOOM_SENSITIVITY = 0.0018;

const PLANET_CLASS_META_SWATCHES: Array<{ classId: string; color: string }> = PLANET_CLASSES.map(
  (planet) => ({ classId: planet.key, color: planet.mapColor }),
);

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; offline: boolean }
  | { status: 'ready'; view: GalaxyView };

export function MapApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldId = sessionWorldId(seed);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const failuresRef = useRef(0);
  // The header's live tick readout, polled from the overview projection.
  const worldMeta = useWorldMeta(worldId);

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
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'unknown error',
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
    setAttempt((value) => value + 1);
  }, []);

  const offline = state.status === 'error' && state.offline;

  return (
    <div className={`game-shell map-shell${offline ? ' is-offline' : ''}`}>
      <GameHeader
        seed={seed}
        title="Galaxy Map"
        current="map"
        className="map-header"
        meta={worldMeta && <HeaderMeta meta={worldMeta} />}
      />

      {state.status === 'loading' && <p className="status-line">Assembling the deep chart…</p>}
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [win, setWin] = useState<MapWindow | null>(null);
  const [level, setLevel] = useState<MapLevel>({ kind: 'chart' });
  const winRef = useRef<MapWindow | null>(null);
  const levelRef = useRef<MapLevel>({ kind: 'chart' });
  const dragRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const draggedRef = useRef(false);
  const paintFrameRef = useRef<number | null>(null);
  const sky = useMemo(() => buildSky(view), [view]);

  const homePlanet = useMemo(
    () => view.planets.find((planet) => planet.id === view.homePlanetId),
    [view],
  );
  const homeGalaxy = homePlanet?.coordinate.galaxy ?? 1;
  const homeSector = homePlanet?.coordinate.sector ?? 1;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const frameElement = frameRef.current;
    const currentWindow = winRef.current;
    if (!canvas || !frameElement || !currentWindow) return;
    const width = frameElement.clientWidth;
    const height = frameElement.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.ceil(width * dpr);
    const pixelHeight = Math.ceil(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintMap(context, view, sky, levelRef.current, currentWindow, width, height);
    const svg = svgRef.current;
    if (svg) {
      const viewBox = makeViewBox(currentWindow);
      if (svg.getAttribute('viewBox') !== viewBox) svg.setAttribute('viewBox', viewBox);
    }
  }, [sky, view]);

  const schedulePaint = useCallback(() => {
    if (paintFrameRef.current !== null) return;
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = null;
      paint();
    });
  }, [paint]);

  // The first fit is established in an effect after the initial frame
  // measurement. Paint synchronously once that window exists so a cold boot
  // cannot leave the canvas at its browser default 300×150 backing store.
  useEffect(() => {
    if (win) paint();
  }, [paint, win]);

  useEffect(() => {
    schedulePaint();
    return () => {
      if (paintFrameRef.current !== null) {
        cancelAnimationFrame(paintFrameRef.current);
        // StrictMode (dev) double-invokes effects: mount → cleanup → mount.
        // Leaving the cancelled id in the ref would make every later
        // schedulePaint() early-return, so the map would paint once and all
        // wheel/drag/button interactions would silently do nothing.
        paintFrameRef.current = null;
      }
    };
  }, [schedulePaint]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () => {
      setFrame({ width: element.clientWidth, height: element.clientHeight });
      schedulePaint();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [schedulePaint]);

  useEffect(() => {
    if (frame.width === 0 || frame.height === 0 || winRef.current) return;
    const firstWindow = fitWindow(view.bounds, frame.width / frame.height, 0.06);
    winRef.current = firstWindow;
    setWin(firstWindow);
    schedulePaint();
  }, [frame, schedulePaint, view.bounds]);

  const updateWindow = useCallback(
    (next: MapWindow) => {
      winRef.current = next;
      setWin(next);
      schedulePaint();
    },
    [schedulePaint],
  );

  const updateLevel = useCallback(
    (next: MapLevel) => {
      levelRef.current = next;
      setLevel(next);
      schedulePaint();
    },
    [schedulePaint],
  );

  const focusLevel = useCallback(
    (next: MapLevel) => {
      if (frame.width === 0 || frame.height === 0) return;
      const nextWindow = fitWindow(boundsForLevel(view, next), frame.width / frame.height, 0.07);
      updateLevel(next);
      updateWindow(nextWindow);
    },
    [frame.height, frame.width, updateLevel, updateWindow, view],
  );

  const reset = useCallback(() => focusLevel({ kind: 'chart' }), [focusLevel]);
  const focusHome = useCallback(
    () => focusLevel({ kind: 'sector', galaxy: homeGalaxy, sector: homeSector }),
    [focusLevel, homeGalaxy, homeSector],
  );

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const currentWindow = winRef.current;
      if (!currentWindow) return;
      const rect = element.getBoundingClientRect();
      const anchor = screenToPoint(event.clientX, event.clientY, currentWindow, rect);
      const factor = Math.exp(event.deltaY * ZOOM_SENSITIVITY);
      const width = currentWindow.maxX - currentWindow.minX;
      const boundedFactor = Math.min(
        MAX_WINDOW_WIDTH / width,
        Math.max(MIN_WINDOW_WIDTH / width, factor),
      );
      if (boundedFactor === 1) return;
      event.preventDefault();
      const bounded = clampWindow(
        scaleWindow(currentWindow, boundedFactor, anchor),
        boundsForLevel(view, levelRef.current),
      );
      winRef.current = bounded;
      schedulePaint();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [schedulePaint, view]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest('.map-controls')) return;
      draggedRef.current = false;
      dragRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const currentWindow = winRef.current;
      if (!drag || !currentWindow) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!draggedRef.current && Math.hypot(dx, dy) < 4) return;
      if (!draggedRef.current) {
        draggedRef.current = true;
        element.setPointerCapture(drag.pointerId);
      }
      const rect = element.getBoundingClientRect();
      const worldWidth = currentWindow.maxX - currentWindow.minX;
      const worldHeight = currentWindow.maxY - currentWindow.minY;
      const next = {
        minX: currentWindow.minX - (dx / rect.width) * worldWidth,
        maxX: currentWindow.maxX - (dx / rect.width) * worldWidth,
        minY: currentWindow.minY - (dy / rect.height) * worldHeight,
        maxY: currentWindow.maxY - (dy / rect.height) * worldHeight,
      };
      winRef.current = clampWindow(next, boundsForLevel(view, levelRef.current));
      drag.x = event.clientX;
      drag.y = event.clientY;
      schedulePaint();
    };
    const onPointerUp = (event: PointerEvent) => {
      dragRef.current = null;
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
    };
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
    };
  }, [schedulePaint, view]);

  const currentLevel = level;
  const currentWindow = win;

  return (
    <main className="map-page">
      <nav className="map-crumbs" aria-label="Map level">
        <button type="button" className="map-crumb" data-testid="map-crumb-chart" onClick={reset}>
          Chart
        </button>
        {currentLevel.kind !== 'chart' && (
          <>
            <span className="map-crumb-sep" aria-hidden="true">
              /
            </span>
            {currentLevel.kind === 'galaxy' ? (
              <span
                className="map-crumb map-crumb-current"
                data-testid="map-crumb-galaxy"
                aria-current="page"
              >
                Galaxy {currentLevel.galaxy}
              </span>
            ) : (
              <button
                type="button"
                className="map-crumb"
                data-testid="map-crumb-galaxy"
                onClick={() => focusLevel({ kind: 'galaxy', galaxy: currentLevel.galaxy })}
              >
                Galaxy {currentLevel.galaxy}
              </button>
            )}
          </>
        )}
        {currentLevel.kind === 'sector' && (
          <>
            <span className="map-crumb-sep" aria-hidden="true">
              /
            </span>
            <span
              className="map-crumb map-crumb-current"
              data-testid="map-crumb-sector"
              aria-current="page"
            >
              Sector {currentLevel.galaxy}:{currentLevel.sector}
            </span>
          </>
        )}
      </nav>

      <div className="map-frame" ref={frameRef} data-testid="map-frame">
        <canvas
          ref={canvasRef}
          className="map-canvas"
          data-testid="map-sky"
          aria-label="Procedurally drawn galaxy chart"
        />
        {currentWindow && (
          <svg
            className="map-hit-layer"
            data-testid="galaxy-map"
            ref={svgRef}
            viewBox={makeViewBox(currentWindow)}
            aria-label="Interactive galaxy map"
          >
            <MapHitLayer
              view={view}
              level={currentLevel}
              homeGalaxy={homeGalaxy}
              homeSector={homeSector}
              seed={seed}
              draggedRef={draggedRef}
              onGalaxy={(galaxy) => focusLevel({ kind: 'galaxy', galaxy })}
              onSector={(galaxy, sector) => focusLevel({ kind: 'sector', galaxy, sector })}
            />
          </svg>
        )}
        <div className="map-readout" aria-live="polite">
          <span className="map-readout-title">
            {currentLevel.kind === 'chart'
              ? 'Galactic chart'
              : currentLevel.kind === 'galaxy'
                ? `Galaxy ${currentLevel.galaxy}`
                : `Sector ${currentLevel.galaxy}:${currentLevel.sector}`}
          </span>
          <span className="map-readout-subtitle">
            {currentLevel.kind === 'chart'
              ? 'Eight spiral systems · strategic distances'
              : currentLevel.kind === 'galaxy'
                ? 'Sector lanes · system beacons'
                : 'System orbits · world ledgers'}
          </span>
        </div>
        <div className="map-controls" role="group" aria-label="Map controls">
          <button type="button" aria-label="Zoom in" onClick={() => zoomCenter(1 / 1.22)}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomCenter(1.22)}>
            −
          </button>
          <button
            type="button"
            data-testid="map-focus-home"
            title="Jump to your home sector"
            onClick={focusHome}
          >
            Home
          </button>
          <button type="button" onClick={reset}>
            Fit
          </button>
        </div>
      </div>

      <p className="map-world-stats" aria-label="World composition">
        <span>
          Galaxies <strong data-testid="map-galaxy-count">{view.config.galaxies}</strong>
        </span>
        <span>
          Worlds{' '}
          <strong data-testid="map-planet-count">{view.planets.length.toLocaleString()}</strong>
        </span>
        <span>
          Sectors <strong data-testid="map-sector-count">{view.sectors.length}</strong>
        </span>
      </p>

      {/* The legend tracks the current level: what the chart actually shows
          at this depth, never a static list of every symbol at once. */}
      <p className="map-legend" role="list" aria-label="Map legend">
        {currentLevel.kind === 'chart' ? (
          <>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot home" aria-hidden="true" /> Home galaxy
            </span>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot" aria-hidden="true" /> Galaxy
            </span>
          </>
        ) : currentLevel.kind === 'galaxy' ? (
          <>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot home" aria-hidden="true" /> Home sector
            </span>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot" aria-hidden="true" /> Sector
            </span>
          </>
        ) : (
          <>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot home" aria-hidden="true" /> Home world
            </span>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot known" aria-hidden="true" /> Known world
            </span>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dot system" aria-hidden="true" /> System
            </span>
            <span className="map-legend-item" role="listitem">
              <span className="map-legend-dots" aria-hidden="true">
                {PLANET_CLASS_META_SWATCHES.map((planet) => (
                  <span key={planet.classId} style={{ background: planet.color }} />
                ))}
              </span>
              World class
            </span>
          </>
        )}
      </p>

      <SectionHelp id="map">
        <p>
          This is a scale-aware chart, not a list of worlds. The first level shows each galaxy as a
          seeded spiral with arms, cores, dust, and sector beacons. Open a galaxy to inspect its
          sector lanes, then open a sector to read system orbits and world ledgers. The canvas
          paints the star field and map marks; only visible targets remain in the interactive layer,
          so dragging and zooming do not rebuild thousands of DOM nodes. Drag to pan, scroll to
          zoom, and use Home to return to your starting world. Coordinates read{' '}
          <span className="mono">galaxy:sector:system:planet</span>.
        </p>
      </SectionHelp>
    </main>
  );

  function zoomCenter(factor: number) {
    const current = winRef.current;
    if (!current) return;
    const anchor = {
      x: (current.minX + current.maxX) / 2,
      y: (current.minY + current.maxY) / 2,
    };
    const width = current.maxX - current.minX;
    const boundedFactor = Math.min(
      MAX_WINDOW_WIDTH / width,
      Math.max(MIN_WINDOW_WIDTH / width, factor),
    );
    if (boundedFactor === 1) return;
    winRef.current = clampWindow(
      scaleWindow(current, boundedFactor, anchor),
      boundsForLevel(view, levelRef.current),
    );
    schedulePaint();
  }
}

function MapHitLayer({
  view,
  level,
  homeGalaxy,
  homeSector,
  seed,
  draggedRef,
  onGalaxy,
  onSector,
}: {
  view: GalaxyView;
  level: MapLevel;
  homeGalaxy: number;
  homeSector: number;
  seed: string;
  draggedRef: MutableRefObject<boolean>;
  onGalaxy: (galaxy: number) => void;
  onSector: (galaxy: number, sector: number) => void;
}) {
  if (level.kind === 'chart') {
    return (
      <g className="map-chart-hits">
        {view.galaxies.map((galaxy) => (
          <g
            key={galaxy.galaxy}
            className="map-chart-galaxy"
            data-testid="map-galaxy"
            data-home={galaxy.galaxy === homeGalaxy ? 'true' : undefined}
            role="button"
            tabIndex={0}
            aria-label={`Open galaxy ${galaxy.galaxy}`}
            onClick={() => {
              if (!draggedRef.current) onGalaxy(galaxy.galaxy);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onGalaxy(galaxy.galaxy);
              }
            }}
          >
            <circle
              className="map-galaxy-disc"
              cx={galaxy.position.x}
              cy={galaxy.position.y}
              r={galaxy.discRadius}
            />
            {galaxy.galaxy === homeGalaxy && (
              <circle
                className="map-home-galaxy-ring"
                data-testid="map-home-galaxy"
                cx={galaxy.position.x}
                cy={galaxy.position.y}
                r={galaxy.discRadius + 24}
              />
            )}
          </g>
        ))}
      </g>
    );
  }

  if (level.kind === 'galaxy') {
    return (
      <g className="map-galaxy-hits">
        {view.sectors
          .filter((sector) => sector.galaxy === level.galaxy)
          .sort((a, b) => Number(a.sector === homeSector) - Number(b.sector === homeSector))
          .map((sector) => (
            <g
              key={`${sector.galaxy}:${sector.sector}`}
              className="map-sector-cell"
              data-testid="map-sector"
              data-home={
                sector.sector === homeSector && level.galaxy === homeGalaxy ? 'true' : undefined
              }
              role="button"
              tabIndex={0}
              aria-label={`Open sector ${sector.galaxy}:${sector.sector}`}
              onClick={() => {
                if (!draggedRef.current) onSector(sector.galaxy, sector.sector);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSector(sector.galaxy, sector.sector);
                }
              }}
            >
              <rect
                className="map-sector-cell-bg"
                x={sector.bounds.minX + (sector.bounds.maxX - sector.bounds.minX) * 0.12}
                y={sector.bounds.minY + (sector.bounds.maxY - sector.bounds.minY) * 0.12}
                width={(sector.bounds.maxX - sector.bounds.minX) * 0.76}
                height={(sector.bounds.maxY - sector.bounds.minY) * 0.76}
                rx={70}
              />
              {sector.sector === homeSector && level.galaxy === homeGalaxy && (
                <circle
                  className="map-home-sector-ring"
                  data-testid="map-home-sector"
                  cx={sector.position.x}
                  cy={sector.position.y}
                  r={300}
                />
              )}
            </g>
          ))}
      </g>
    );
  }

  return (
    <g className="map-sector-hits">
      {view.planets
        .filter(
          (planet) =>
            planet.coordinate.galaxy === level.galaxy && planet.coordinate.sector === level.sector,
        )
        .map((planet) => (
          <a
            key={planet.id}
            className="map-planet-link"
            data-testid={planet.known ? 'map-known' : 'map-planet'}
            href={`planet.html?seed=${seed}&planet=${encodeURIComponent(planet.id)}`}
            onClick={(event) => {
              if (draggedRef.current) event.preventDefault();
            }}
          >
            {planet.known && (
              <circle
                className="map-home-ring"
                data-testid="map-home"
                cx={planet.position.x}
                cy={planet.position.y}
                r={12}
              />
            )}
            <circle
              className={`map-planet${planet.known ? ' known' : ''}`}
              cx={planet.position.x}
              cy={planet.position.y}
              r={planet.known ? 9 : 7}
              aria-label={`${planet.name} — ${planetClassName(planet.classId)} — ${formatCoordinate(planet.coordinate)}`}
            />
            <title>{`${planet.name} — ${planetClassName(planet.classId)} — ${formatCoordinate(planet.coordinate)}`}</title>
          </a>
        ))}
    </g>
  );
}
