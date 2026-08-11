import { SPEED_OPTIONS } from '../shared/constants';
import { BUILDING_NAMES, CITIZEN_STATE_NAMES, NODE_NAMES } from '../shared/labels';
import type { Calendar, InspectDetail, SimAlert } from '../shared/protocol';
import { toHex8 } from '../shared/utils';
import { BuildingKind, FACTION_META, type FactionId } from '../sim/data/content';
import { TERRAIN_NAMES } from '../sim/world/tiles';

export interface HudCallbacks {
  onSpeedChange: (speed: number) => void;
  onToggleGrid: () => void;
  onToggleOwnership: () => void;
  onBuildClick: (building: BuildingKind) => void;
  onBuildFaction: (faction: FactionId) => void;
  /** Esc pressed while in placement mode. */
  onCancelBuild: () => void;
}

/**
 * Lightweight DOM HUD. Later milestones can swap this for React panels —
 * the worker protocol and read-only snapshot contract stay.
 */
export class Hud {
  private readonly callbacks: HudCallbacks;
  private readonly speedButtons = new Map<number, HTMLButtonElement>();
  private readonly tickEl: HTMLElement;
  private readonly dayEl: HTMLElement;
  private readonly seasonEl: HTMLElement;
  private readonly yearEl: HTMLElement;
  private readonly hashEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly seedEl: HTMLElement;
  private readonly gridToggle: HTMLButtonElement;
  private readonly ownerToggle: HTMLButtonElement;
  private readonly alertBanner: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly inspectorTitle: HTMLElement;
  private readonly inspectorContent: HTMLElement;
  private readonly buildButtons = new Map<BuildingKind, HTMLButtonElement>();
  private readonly buildFaction: HTMLSelectElement;
  private currentSpeed = 1;
  private lastNonZeroSpeed = 1;
  private activeBuild: BuildingKind | null = null;

  constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    root.innerHTML = this.template();

    const q = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector<T>(sel);
      if (!el) {
        throw new Error(`Hud: missing element ${sel}`);
      }
      return el;
    };

    this.tickEl = q('[data-testid="tick"]');
    this.dayEl = q('[data-testid="day"]');
    this.seasonEl = q('[data-testid="season"]');
    this.yearEl = q('[data-testid="year"]');
    this.hashEl = q('[data-testid="hash"]');
    this.statusEl = q('[data-testid="status"]');
    this.seedEl = q('[data-testid="seed"]');
    this.gridToggle = q('[data-testid="grid-toggle"]');
    this.ownerToggle = q('[data-testid="ownership-toggle"]');
    this.alertBanner = q('[data-testid="alert-banner"]');
    this.inspector = q('[data-testid="inspector"]');
    this.inspectorTitle = q('[data-testid="inspector-title"]');
    this.inspectorContent = q('[data-testid="inspector-content"]');
    this.buildFaction = q('[data-testid="build-faction"]');

    const wireBuild = (building: BuildingKind, testid: string): void => {
      const btn = q<HTMLButtonElement>(`[data-testid="${testid}"]`);
      btn.addEventListener('click', () => this.callbacks.onBuildClick(building));
      this.buildButtons.set(building, btn);
    };
    wireBuild(BuildingKind.Stockpile, 'build-stockpile');
    wireBuild(BuildingKind.Hut, 'build-hut');
    this.buildFaction.addEventListener('change', () => {
      this.callbacks.onBuildFaction(Number(this.buildFaction.value) as FactionId);
    });

    const speedGroup = q<HTMLElement>('[data-testid="speed-group"]');
    const speeds = [0, ...SPEED_OPTIONS];
    for (const speed of speeds) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset['speed'] = String(speed);
      btn.dataset['testid'] = `speed-${speed}`;
      btn.textContent = speed === 0 ? '⏸' : `${speed}×`;
      btn.title = speed === 0 ? 'Pause (Space)' : `Run at ${speed}× speed (key ${speed})`;
      btn.addEventListener('click', () => this.setSpeed(speed));
      this.speedButtons.set(speed, btn);
      speedGroup.appendChild(btn);
    }

    this.gridToggle.addEventListener('click', () => this.callbacks.onToggleGrid());
    this.ownerToggle.addEventListener('click', () => this.callbacks.onToggleOwnership());

    this.syncSpeedUI();

    window.addEventListener('keydown', (e) => {
      const key = e.key;
      if (key === ' ') {
        e.preventDefault();
        this.togglePause();
      } else if (key === '1' || key === '2' || key === '4' || key === '8') {
        this.setSpeed(Number(key));
      } else if (key === 'g' || key === 'G') {
        this.callbacks.onToggleGrid();
      } else if (key === 'o' || key === 'O') {
        this.callbacks.onToggleOwnership();
      } else if (key === 'Escape' && this.activeBuild !== null) {
        this.callbacks.onCancelBuild();
      }
    });
  }

  setSeed(seed: number): void {
    this.seedEl.textContent = `seed ${seed}`;
  }

  setStatus(text: string): void {
    this.statusEl.querySelector('.status-text')!.textContent = text;
  }

  setTick(tick: number): void {
    this.tickEl.textContent = String(tick);
  }

  setCalendar(calendar: Calendar): void {
    this.dayEl.textContent = String(calendar.day);
    this.seasonEl.textContent = String(calendar.season);
    this.yearEl.textContent = String(calendar.year);
  }

  setHash(hash: number): void {
    this.hashEl.textContent = toHex8(hash);
  }

  setGridEnabled(enabled: boolean): void {
    this.gridToggle.setAttribute('aria-pressed', String(enabled));
    this.gridToggle.classList.toggle('is-active', enabled);
  }

  setOwnershipEnabled(enabled: boolean): void {
    this.ownerToggle.setAttribute('aria-pressed', String(enabled));
    this.ownerToggle.classList.toggle('is-active', enabled);
  }

  /** Highlight the active build palette button (or clear placement mode). */
  setBuildActive(building: BuildingKind | null): void {
    this.activeBuild = building;
    for (const [kind, btn] of this.buildButtons) {
      const active = building === kind;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  setBuildFaction(faction: FactionId): void {
    this.buildFaction.value = String(faction);
  }

  /** Show the latest alerts as a stacked banner (auto-removed oldest). */
  setAlerts(alerts: readonly SimAlert[]): void {
    const latest = alerts.slice(-3).reverse();
    this.alertBanner.innerHTML = '';
    for (const alert of latest) {
      const el = document.createElement('div');
      el.className = `alert severity-${alert.severity}`;
      el.dataset['testid'] = 'alert';
      el.innerHTML = `<span class="alert-code">${alert.code}</span><span class="alert-text"></span>`;
      el.querySelector('.alert-text')!.textContent = alert.text;
      this.alertBanner.appendChild(el);
    }
  }

  showInspect(detail: InspectDetail): void {
    this.inspector.hidden = false;
    this.inspectorContent.innerHTML = '';
    const addRow = (label: string, value: string): void => {
      const row = document.createElement('div');
      row.className = 'inspect-row';
      row.innerHTML = `<span class="inspect-label"></span><span class="inspect-value"></span>`;
      row.querySelector('.inspect-label')!.textContent = label;
      row.querySelector('.inspect-value')!.textContent = value;
      this.inspectorContent.appendChild(row);
    };

    const factionName = (id: number): string => FACTION_META[id as FactionId]?.name ?? 'Neutral';

    switch (detail.kind) {
      case 'citizen': {
        this.inspectorTitle.textContent = `Citizen #${detail.eid} · ${factionName(detail.factionId)}`;
        addRow('state', CITIZEN_STATE_NAMES[detail.state] ?? String(detail.state));
        addRow('hunger', `${detail.hunger}/100`);
        addRow('energy', `${detail.energy}/100`);
        addRow('morale', `${detail.morale}/100`);
        addRow('carrying', `${detail.carry} food`);
        addRow('task', detail.taskText);
        addRow('pos', `(${detail.x}, ${detail.y})`);
        break;
      }
      case 'building': {
        this.inspectorTitle.textContent = `${BUILDING_NAMES[detail.buildingKind] ?? 'Building'} · ${factionName(detail.factionId)}`;
        addRow('food', `${detail.food}/${detail.capacity}`);
        addRow('pos', `(${detail.x}, ${detail.y})`);
        break;
      }
      case 'blueprint': {
        this.inspectorTitle.textContent = `${BUILDING_NAMES[detail.buildingKind] ?? 'Building'} blueprint · ${factionName(detail.factionId)}`;
        addRow('progress', `${detail.progress}%`);
        addRow('builder', detail.reserved ? 'reserved' : 'awaiting builder');
        addRow('pos', `(${detail.x}, ${detail.y})`);
        break;
      }
      case 'node': {
        this.inspectorTitle.textContent = `${NODE_NAMES[detail.nodeKind] ?? 'Resource'}`;
        addRow('amount', `${detail.amount}/${detail.maxAmount}`);
        addRow('pos', `(${detail.x}, ${detail.y})`);
        break;
      }
      case 'tile': {
        const terrainName =
          TERRAIN_NAMES[detail.terrain as keyof typeof TERRAIN_NAMES] ?? 'unknown';
        this.inspectorTitle.textContent = 'Tile';
        addRow('terrain', terrainName);
        addRow('owner', factionName(detail.ownerFactionId));
        addRow('elevation', String(detail.elevation));
        addRow('moisture', String(detail.moisture));
        break;
      }
    }
  }

  hideInspect(): void {
    this.inspector.hidden = true;
  }

  private togglePause(): void {
    this.setSpeed(this.currentSpeed === 0 ? this.lastNonZeroSpeed : 0);
  }

  private setSpeed(speed: number): void {
    this.currentSpeed = speed;
    if (speed !== 0) {
      this.lastNonZeroSpeed = speed;
    }
    this.syncSpeedUI();
    this.callbacks.onSpeedChange(speed);
  }

  private syncSpeedUI(): void {
    for (const [speed, btn] of this.speedButtons) {
      btn.classList.toggle('is-active', speed === this.currentSpeed);
      btn.setAttribute('aria-pressed', String(speed === this.currentSpeed));
    }
  }

  private template(): string {
    return `
      <div class="hud" data-testid="hud">
        <header class="hud-top">
          <div class="brand">
            <span class="brand-title">Ashes &amp; Antlers</span>
            <span class="brand-tag">MILESTONE 1</span>
          </div>
          <div class="hud-top-right">
            <div class="chip" data-testid="seed">seed …</div>
            <div class="chip status" data-testid="status">
              <span class="dot" aria-hidden="true"></span>
              <span class="status-text">connecting…</span>
            </div>
          </div>
        </header>

        <div class="alert-banner" data-testid="alert-banner"></div>

        <aside class="inspector" data-testid="inspector" hidden>
          <div class="inspector-title" data-testid="inspector-title"></div>
          <div class="inspector-content" data-testid="inspector-content"></div>
        </aside>

        <footer class="hud-bottom">
          <div class="speed-group" role="group" aria-label="Simulation speed" data-testid="speed-group">
            <span class="group-label">speed</span>
          </div>
          <div class="readouts" aria-label="Simulation state">
            <div class="readout"><span class="readout-label">tick</span><b data-testid="tick">0</b></div>
            <div class="readout"><span class="readout-label">day</span><b data-testid="day">1</b></div>
            <div class="readout"><span class="readout-label">season</span><b data-testid="season">1</b></div>
            <div class="readout"><span class="readout-label">year</span><b data-testid="year">1</b></div>
            <div class="readout"><span class="readout-label">terrain hash</span><b class="mono" data-testid="hash">—</b></div>
          </div>
          <div class="build-group" role="group" aria-label="Build">
            <span class="group-label">build</span>
            <select class="build-faction" data-testid="build-faction" aria-label="Faction to build for" title="Faction to build for">
              <option value="1">Hearth</option>
              <option value="2">Iron Swarm</option>
            </select>
            <button type="button" class="build-btn" data-testid="build-stockpile" aria-pressed="false" title="Place a stockpile blueprint">stockpile</button>
            <button type="button" class="build-btn" data-testid="build-hut" aria-pressed="false" title="Place a hut blueprint">hut</button>
          </div>
          <div class="toggles">
            <button type="button" class="toggle" data-testid="grid-toggle" aria-pressed="false" title="Toggle debug grid (G)">grid</button>
            <button type="button" class="toggle" data-testid="ownership-toggle" aria-pressed="true" title="Toggle ownership overlay (O)">ownership</button>
          </div>
        </footer>
      </div>
    `;
  }
}
