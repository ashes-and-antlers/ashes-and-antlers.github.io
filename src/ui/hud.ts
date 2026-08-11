import { SPEED_OPTIONS } from '../shared/constants';
import {
  BUILDING_NAMES,
  CITIZEN_STATE_NAMES,
  ITEM_NAMES,
  NODE_NAMES,
  PRIORITY_NAMES,
  SEASON_NAMES,
  WEATHER_NAMES,
} from '../shared/labels';
import type { Calendar, InspectDetail, SimAlert } from '../shared/protocol';
import { toHex8 } from '../shared/utils';
import { SIM_CONFIG } from '../sim/data/config';
import {
  BuildingKind,
  FACTION_META,
  defaultStockpilePolicy,
  ItemType,
  type FactionId,
} from '../sim/data/content';
import { TERRAIN_NAMES } from '../sim/world/tiles';

export interface HudCallbacks {
  onSpeedChange: (speed: number) => void;
  onToggleGrid: () => void;
  onToggleOwnership: () => void;
  onBuildClick: (building: BuildingKind) => void;
  onBuildFaction: (faction: FactionId) => void;
  /** The construction priority selector changed (1 low / 2 normal / 3 high). */
  onBuildPriorityChange: (priority: number) => void;
  /** The stockpile reserve panel set a new desired reserve for an item. */
  onReserveChange: (faction: FactionId, item: ItemType, amount: number) => void;
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
  private readonly weatherEl: HTMLElement;
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
  private readonly buildPriority: HTMLSelectElement;
  private readonly stockEls = new Map<ItemType, HTMLElement>();
  private readonly reserveEls = new Map<ItemType, HTMLElement>();
  private currentSpeed = 1;
  private lastNonZeroSpeed = 1;
  private activeBuild: BuildingKind | null = null;
  private lastStocks: Record<number, Record<number, number>> = {};
  private lastPolicy: Record<number, Record<number, number>> = defaultStockpilePolicy();

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
    this.weatherEl = q('[data-testid="weather"]');
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
    this.buildPriority = q('[data-testid="build-priority"]');
    for (const item of [ItemType.Wood, ItemType.Stone, ItemType.Planks, ItemType.Food]) {
      this.stockEls.set(item, q(`[data-testid="stock-${ITEM_NAMES[item]}"]`));
      this.reserveEls.set(item, q(`[data-testid="reserve-${ITEM_NAMES[item]}"]`));
    }

    const wireBuild = (building: BuildingKind, testid: string): void => {
      const btn = q<HTMLButtonElement>(`[data-testid="${testid}"]`);
      btn.addEventListener('click', () => this.callbacks.onBuildClick(building));
      this.buildButtons.set(building, btn);
    };
    wireBuild(BuildingKind.Stockpile, 'build-stockpile');
    wireBuild(BuildingKind.Hut, 'build-hut');
    wireBuild(BuildingKind.Sawpit, 'build-sawpit');
    this.buildButtons.get(BuildingKind.Stockpile)!.title =
      `stockpile — ${costLabel(BuildingKind.Stockpile)}`;
    this.buildButtons.get(BuildingKind.Hut)!.title = `hut — ${costLabel(BuildingKind.Hut)}`;
    this.buildButtons.get(BuildingKind.Sawpit)!.title =
      `sawpit — ${costLabel(BuildingKind.Sawpit)}`;
    this.buildFaction.addEventListener('change', () => {
      const faction = Number(this.buildFaction.value) as FactionId;
      this.callbacks.onBuildFaction(faction);
      // Re-render both readout panels immediately; while paused there is no
      // next snapshot to do it.
      this.renderStocks(faction);
      this.renderPolicy(faction);
    });
    this.buildPriority.addEventListener('change', () => {
      this.callbacks.onBuildPriorityChange(Number(this.buildPriority.value) as number);
    });
    for (const item of [ItemType.Wood, ItemType.Stone, ItemType.Planks, ItemType.Food]) {
      const key = ITEM_NAMES[item] ?? String(item);
      const step = SIM_CONFIG.stockpileReserveStep;
      q<HTMLButtonElement>(`[data-testid="reserve-${key}-dec"]`).addEventListener('click', () =>
        this.stepReserve(item, -step),
      );
      q<HTMLButtonElement>(`[data-testid="reserve-${key}-inc"]`).addEventListener('click', () =>
        this.stepReserve(item, step),
      );
    }

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
    this.seasonEl.textContent = `${calendar.season} · ${SEASON_NAMES[calendar.season] ?? calendar.season}`;
    this.weatherEl.textContent = WEATHER_NAMES[calendar.season] ?? '—';
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
    this.renderStocks(faction);
    this.renderPolicy(faction);
  }

  /** Remember the latest snapshot stocks and show the active faction's. */
  setStocks(stocks: Record<number, Record<number, number>>): void {
    this.lastStocks = stocks;
    this.renderStocks(Number(this.buildFaction.value) as FactionId);
  }

  private renderStocks(faction: FactionId): void {
    const row = this.lastStocks[faction] ?? {};
    for (const [item, el] of this.stockEls) {
      el.textContent = String(row[item] ?? 0);
    }
  }

  /** Remember the latest snapshot policy and show the active faction's. */
  setPolicy(policy: Record<number, Record<number, number>>): void {
    this.lastPolicy = policy;
    this.renderPolicy(Number(this.buildFaction.value) as FactionId);
  }

  private renderPolicy(faction: FactionId): void {
    const row = this.lastPolicy[faction] ?? {};
    for (const [item, el] of this.reserveEls) {
      el.textContent = String(row[item] ?? 0);
    }
  }

  /** Step the active faction's reserve for an item (worker re-validates). */
  private stepReserve(item: ItemType, delta: number): void {
    const faction = Number(this.buildFaction.value) as FactionId;
    const current = this.lastPolicy[faction]?.[item] ?? 0;
    const next = Math.min(SIM_CONFIG.maxStockpileReserve, Math.max(0, current + delta));
    if (next === current) return;
    this.callbacks.onReserveChange(faction, item, next);
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
        addRow(
          'carrying',
          detail.carry > 0
            ? `${detail.carry} ${ITEM_NAMES[detail.carryItem] ?? 'item'}`
            : 'nothing',
        );
        addRow('task', detail.taskText);
        addRow('pos', `(${detail.x}, ${detail.y})`);
        break;
      }
      case 'building': {
        this.inspectorTitle.textContent = `${BUILDING_NAMES[detail.buildingKind] ?? 'Building'} · ${factionName(detail.factionId)}`;
        const used = Object.values(detail.stock).reduce((a, b) => a + b, 0);
        addRow('stored', `${used}/${detail.capacity}`);
        for (const item of [ItemType.Food, ItemType.Wood, ItemType.Stone, ItemType.Planks]) {
          const amount = detail.stock[item] ?? 0;
          if (amount > 0) {
            addRow(ITEM_NAMES[item] ?? String(item), String(amount));
          }
        }
        addRow('pos', `(${detail.x}, ${detail.y})`);
        break;
      }
      case 'blueprint': {
        this.inspectorTitle.textContent = `${BUILDING_NAMES[detail.buildingKind] ?? 'Building'} blueprint · ${factionName(detail.factionId)}`;
        addRow('priority', PRIORITY_NAMES[detail.priority] ?? String(detail.priority));
        addRow('progress', `${detail.progress}%`);
        const costText = costLabelFrom(detail.cost);
        addRow('materials', detail.funded ? 'ready' : costText === '' ? '—' : costText);
        if (!detail.funded && detail.missing) {
          const missingText = costLabelFrom(detail.missing);
          if (missingText !== '') {
            addRow('awaiting', missingText);
          }
        }
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
            <span class="brand-tag">MILESTONE 2</span>
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
            <div class="readout"><span class="readout-label">season</span><b data-testid="season">1 · Spring</b></div>
            <div class="readout"><span class="readout-label">weather</span><b data-testid="weather">mild</b></div>
            <div class="readout"><span class="readout-label">year</span><b data-testid="year">1</b></div>
            <div class="readout"><span class="readout-label">terrain hash</span><b class="mono" data-testid="hash">—</b></div>
          </div>
          <div class="readouts stock-readouts" aria-label="Stored goods">
            <div class="readout"><span class="readout-label">wood</span><b data-testid="stock-wood">0</b></div>
            <div class="readout"><span class="readout-label">stone</span><b data-testid="stock-stone">0</b></div>
            <div class="readout"><span class="readout-label">planks</span><b data-testid="stock-planks">0</b></div>
            <div class="readout"><span class="readout-label">food</span><b data-testid="stock-food">0</b></div>
          </div>
          <div class="policy-group" role="group" aria-label="Stockpile reserve targets" data-testid="policy-group">
            <span class="group-label">reserve</span>
            <div class="reserve-row">
              <span class="reserve-item">wood</span>
              <button type="button" class="reserve-step" data-testid="reserve-wood-dec" aria-label="Lower the wood reserve" title="Lower the wood reserve by ${SIM_CONFIG.stockpileReserveStep}">−</button>
              <b class="reserve-value" data-testid="reserve-wood">0</b>
              <button type="button" class="reserve-step" data-testid="reserve-wood-inc" aria-label="Raise the wood reserve" title="Raise the wood reserve by ${SIM_CONFIG.stockpileReserveStep}">+</button>
            </div>
            <div class="reserve-row">
              <span class="reserve-item">stone</span>
              <button type="button" class="reserve-step" data-testid="reserve-stone-dec" aria-label="Lower the stone reserve" title="Lower the stone reserve by ${SIM_CONFIG.stockpileReserveStep}">−</button>
              <b class="reserve-value" data-testid="reserve-stone">0</b>
              <button type="button" class="reserve-step" data-testid="reserve-stone-inc" aria-label="Raise the stone reserve" title="Raise the stone reserve by ${SIM_CONFIG.stockpileReserveStep}">+</button>
            </div>
            <div class="reserve-row">
              <span class="reserve-item">planks</span>
              <button type="button" class="reserve-step" data-testid="reserve-planks-dec" aria-label="Lower the planks reserve" title="Lower the planks reserve by ${SIM_CONFIG.stockpileReserveStep}">−</button>
              <b class="reserve-value" data-testid="reserve-planks">0</b>
              <button type="button" class="reserve-step" data-testid="reserve-planks-inc" aria-label="Raise the planks reserve" title="Raise the planks reserve by ${SIM_CONFIG.stockpileReserveStep}">+</button>
            </div>
            <div class="reserve-row">
              <span class="reserve-item">food</span>
              <button type="button" class="reserve-step" data-testid="reserve-food-dec" aria-label="Lower the food reserve" title="Lower the food reserve by ${SIM_CONFIG.stockpileReserveStep}">−</button>
              <b class="reserve-value" data-testid="reserve-food">0</b>
              <button type="button" class="reserve-step" data-testid="reserve-food-inc" aria-label="Raise the food reserve" title="Raise the food reserve by ${SIM_CONFIG.stockpileReserveStep}">+</button>
            </div>
          </div>
          <div class="build-group" role="group" aria-label="Build">
            <span class="group-label">build</span>
            <select class="build-faction" data-testid="build-faction" aria-label="Faction to build for" title="Faction to build for">
              <option value="1">Hearth</option>
              <option value="2">Iron Swarm</option>
            </select>
            <select class="build-priority" data-testid="build-priority" aria-label="Construction priority" title="Construction priority — high-priority sites are funded and built first">
              <option value="1">1 · low</option>
              <option value="2" selected>2 · normal</option>
              <option value="3">3 · high</option>
            </select>
            <button type="button" class="build-btn" data-testid="build-stockpile" aria-pressed="false" title="Place a stockpile blueprint">stockpile</button>
            <button type="button" class="build-btn" data-testid="build-hut" aria-pressed="false" title="Place a hut blueprint">hut</button>
            <button type="button" class="build-btn" data-testid="build-sawpit" aria-pressed="false" title="Place a sawpit blueprint">sawpit</button>
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

function costLabel(kind: BuildingKind): string {
  const cost = SIM_CONFIG.constructionCosts[kind] ?? [];
  return costLabelFrom(Object.fromEntries(cost.map((line) => [line.item, line.amount])));
}

function costLabelFrom(cost: Record<number, number>): string {
  return Object.entries(cost)
    .map(([item, amount]) => `${amount} ${ITEM_NAMES[Number(item)] ?? item}`)
    .join(', ');
}
