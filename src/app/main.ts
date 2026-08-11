import './style.css';
import { DEFAULT_WORLD_SIZE, PROTOCOL_VERSION } from '../shared/constants';
import type { PlayerCommand, WorkerEvent, WorkerRequest } from '../shared/protocol';
import { createRenderer } from '../render/pixi';
import { CameraController, MapView } from '../render/mapview';
import { Hud } from '../ui/hud';
import { BuildingKind, FactionId } from '../sim/data/content';

/** Seed from ?seed= URL param, else a fixed default (keeps e2e deterministic). */
const seedParam = new URLSearchParams(window.location.search).get('seed');
const seed = seedParam !== null && Number.isFinite(Number(seedParam)) ? Number(seedParam) : 1337;

async function boot(): Promise<void> {
  const appRoot = document.getElementById('app');
  if (!appRoot) {
    throw new Error('App: #app element missing');
  }
  appRoot.innerHTML = `
    <div id="map-host" data-testid="map-host"></div>
    <div id="hud-root"></div>
  `;
  const mapHost = document.getElementById('map-host')!;
  const hudRoot = document.getElementById('hud-root')!;

  const worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' });

  const app = await createRenderer(mapHost);
  const map = new MapView();
  map.setOwnerVisible(true);
  app.stage.addChild(map.container);

  let worldWidth = 0;
  let buildMode: BuildingKind | null = null;
  let buildFaction: FactionId = FactionId.Hearth;

  const camera = new CameraController(
    app,
    map.container,
    (zoom) => map.updateGrid(zoom),
    (tile) => {
      if (buildMode !== null && worldWidth > 0) {
        // Clicked tile becomes the footprint center (anchor = center - 1 for a
        // 3x3 footprint); the worker validates the placement.
        const tx = tile % worldWidth;
        const ty = Math.floor(tile / worldWidth);
        const request: WorkerRequest = {
          kind: 'command',
          command: {
            kind: 'PlaceBlueprint',
            tick: 0,
            faction: buildFaction,
            building: buildMode,
            x: tx - 1,
            y: ty - 1,
          } satisfies PlayerCommand,
        };
        worker.postMessage(request);
      } else {
        const request: WorkerRequest = { kind: 'inspect', tile };
        worker.postMessage(request);
      }
    },
  );

  const BUILD_NAMES: Record<number, string> = {
    [BuildingKind.Stockpile]: 'stockpile',
    [BuildingKind.Hut]: 'hut',
    [BuildingKind.Sawpit]: 'sawpit',
  };
  const exitBuildMode = (): void => {
    buildMode = null;
    hud.setBuildActive(null);
    hud.setStatus(`worker ready · ${worldWidth}×${worldWidth}`);
  };

  let ownerVisible = true;
  const hud = new Hud(hudRoot, {
    onSpeedChange: (speed) => {
      const request: WorkerRequest = {
        kind: 'command',
        command: { kind: 'SetSpeed', tick: 0, speed } satisfies PlayerCommand,
      };
      worker.postMessage(request);
    },
    onToggleGrid: () => {
      hud.setGridEnabled(map.toggleGrid(camera.currentZoom));
    },
    onToggleOwnership: () => {
      ownerVisible = !ownerVisible;
      map.setOwnerVisible(ownerVisible);
      hud.setOwnershipEnabled(ownerVisible);
    },
    onBuildClick: (building) => {
      buildMode = buildMode === building ? null : building;
      hud.setBuildActive(buildMode);
      hud.setStatus(
        buildMode !== null
          ? `placing ${BUILD_NAMES[building] ?? 'building'} — click the map · Esc to cancel`
          : `worker ready · ${worldWidth}×${worldWidth}`,
      );
    },
    onBuildFaction: (faction) => {
      buildFaction = faction;
    },
    onCancelBuild: () => {
      exitBuildMode();
    },
  });
  hud.setSeed(seed);
  hud.setBuildFaction(FactionId.Hearth);

  worker.onmessage = (ev: MessageEvent<WorkerEvent>) => {
    const msg = ev.data;
    switch (msg.kind) {
      case 'ready':
        worldWidth = msg.width;
        hud.setStatus(`worker ready · ${msg.width}×${msg.height}`);
        break;
      case 'snapshot': {
        hud.setTick(msg.tick);
        hud.setCalendar(msg.calendar);
        hud.setHash(msg.terrainHash);
        hud.setAlerts(msg.alerts);
        hud.setStocks(msg.stocks);
        if (msg.tilesChanged && msg.tiles !== undefined) {
          map.setTiles(new Uint8Array(msg.tiles), msg.width, msg.height);
          camera.fitView(map.naturalWidth, map.naturalHeight);
          map.updateGrid(camera.currentZoom);
        }
        if (msg.ownerTiles !== undefined) {
          map.setOwnerTiles(new Uint8Array(msg.ownerTiles), msg.width, msg.height);
        }
        if (msg.entities !== undefined) {
          map.setEntities(new Int32Array(msg.entities), msg.entityCount);
        }
        break;
      }
      case 'inspectResult': {
        if (msg.detail) {
          hud.showInspect(msg.detail);
        } else {
          hud.hideInspect();
        }
        break;
      }
      case 'commandRejected':
        hud.setStatus(`cannot build: ${msg.reason} — click the map or press Esc to cancel`);
        break;
      case 'error':
        hud.setStatus(`error: ${msg.message}`);
        break;
    }
  };

  const request: WorkerRequest = {
    kind: 'init',
    protocolVersion: PROTOCOL_VERSION,
    seed,
    worldSize: DEFAULT_WORLD_SIZE,
  };
  worker.postMessage(request);
}

boot().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = `<div class="fatal" data-testid="fatal">Failed to start: ${message}</div>`;
  }
  console.error('boot failed:', err);
});
