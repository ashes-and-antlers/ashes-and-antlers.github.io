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

/**
 * Fit the galaxy bounds to a window with the frame's aspect ratio, so the
 * map never distorts and `viewBox` always fills the frame exactly.
 */
function fitWindow(view: GalaxyView, aspect: number): Window {
  const b = view.bounds;
  let w = b.maxX - b.minX;
  let h = b.maxY - b.minY;
  if (w / h > aspect) {
    h = w / aspect;
  } else {
    w = h * aspect;
  }
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
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
  const winRef = useRef<Window | null>(null);
  const dragRef = useRef<{ px: number; py: number; id: number } | null>(null);
  const draggedRef = useRef(false);

  // Keep the current window readable inside native event handlers.
  const updateWin = (next: Window) => {
    winRef.current = next;
    setWin(next);
  };

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

  // Fit once the frame is measured and the view is ready.
  useEffect(() => {
    if (frame.w > 0 && frame.h > 0) updateWin(fitWindow(view, frame.w / frame.h));
  }, [view, frame]);

  const winRefValue = win ?? winRef.current;
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
    // Never zoom out past the fitted view: the galaxy should not be lost
    // in empty space, with Fit as the only way back.
    const dims = frameDimRef.current;
    if (dims.w > 0 && dims.h > 0) {
      const fit = fitWindow(view, dims.w / dims.h);
      if (w * factor > fit.maxX - fit.minX) return;
    }
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

  const focusHome = () => {
    const home = view.planets.find((p) => p.id === view.homePlanetId);
    if (!home || frame.h <= 0) return;
    const w = 1_400;
    const h = w * (frame.h / frame.w);
    updateWin({
      minX: home.position.x - w / 2,
      maxX: home.position.x + w / 2,
      minY: home.position.y - h / 2,
      maxY: home.position.y + h / 2,
    });
  };

  const reset = () => {
    if (frame.w > 0 && frame.h > 0) updateWin(fitWindow(view, frame.w / frame.h));
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

  // The wheel handler closes over the first render, so it reads the frame
  // dimensions through a ref (updated every render) rather than stale state.
  const frameDimRef = useRef(frame);
  frameDimRef.current = frame;

  const frameWidth = frame.w > 0 ? frame.w : 1;
  const scale = winRefValue ? (winRefValue.maxX - winRefValue.minX) / frameWidth : 1;
  const dotR = 2.4 * scale;
  const knownR = 4.6 * scale;
  const starR = 1.7 * scale;
  const ringR = 7.2 * scale;
  const labelSize = 10 * scale;
  const galaxyLabelSize = 12 * scale;

  return (
    <main className="map-page">
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
            {view.galaxies.map((g) => (
              <text
                key={g.galaxy}
                className="map-galaxy-label"
                x={g.position.x}
                y={g.position.y}
                fontSize={galaxyLabelSize}
                textAnchor="middle"
              >
                G{g.galaxy}
              </text>
            ))}
            {view.systems.map((s) => (
              <circle
                key={`${s.galaxy}:${s.sector}:${s.system}`}
                className="map-star"
                cx={s.position.x}
                cy={s.position.y}
                r={starR}
              />
            ))}
            {view.planets.map((p) => (
              <a
                key={p.id}
                className="map-planet-link"
                data-testid={p.known ? 'map-known' : 'map-planet'}
                href={`planet.html?seed=${seed}&planet=${encodeURIComponent(p.id)}`}
                onClick={(e) => {
                  if (draggedRef.current) e.preventDefault();
                }}
              >
                {p.known && p.id === view.homePlanetId && (
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
          Every world of the archive, in map space. Coordinates read galaxy:sector:system:planet,
          and the map is drawn to scale: planets in the same system sit close together, systems
          cluster inside their sector, and the eight galaxies are far apart — the same distances
          fleet drives will later measure. Drag to pan, scroll or use the controls to zoom, and
          click any dot to open its ledger. Filled worlds are yours; the crowned one is your home.
        </p>
      </SectionHelp>
    </main>
  );
}
