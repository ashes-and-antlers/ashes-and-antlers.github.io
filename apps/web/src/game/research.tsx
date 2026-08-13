import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RESOURCE_KEYS,
  type ResearchBranch,
  type ResearchOrderView,
  type TechnologyEffects,
  type TechnologyId,
  type WorldView,
} from '@ashes/contracts';
import { RESEARCH, RESEARCH_BRANCH_LABELS, RESEARCH_BY_ID, RESEARCH_TREE } from '@ashes/content';
import {
  ApiError,
  assertProtocol,
  cancelResearch,
  fetchOverview,
  submitStartResearch,
} from './api';
import { GameHeader, HeaderMeta, type WorldMeta } from './header';
import { RESOURCE_NAMES, SectionHelp } from './planet-ui';
import { sessionWorldId } from './session';

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEV_AUTO_RECOVER = import.meta.env.DEV;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: string; offline: boolean }
  | { status: 'ready'; view: WorldView };

const BRANCH_ORDER: ResearchBranch[] = [
  'infrastructure',
  'navigation',
  'military',
  'colonization',
  'intelligence',
];

export function ResearchApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldId = sessionWorldId(seed);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [worldMeta, setWorldMeta] = useState<WorldMeta | null>(null);
  const [worldVersion, setWorldVersion] = useState(0);
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
        title="Research"
        current="research"
        meta={worldMeta && <HeaderMeta meta={worldMeta} />}
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
          data-testid="research-offline"
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
        <ResearchPanel
          view={state.view}
          worldId={worldId}
          worldVersion={worldVersion}
          seed={seed}
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
        <span>archive research · ashfield command archive</span>
      </footer>
    </div>
  );
}

function ResearchPanel({
  view,
  worldId,
  worldVersion,
  seed,
  onStateChange,
}: {
  view: WorldView;
  worldId: string;
  worldVersion: number;
  seed: string;
  onStateChange: () => void;
}) {
  const constructionsUrl = `constructions.html?seed=${seed}&planet=${encodeURIComponent(view.player.homePlanet.id)}`;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Research runs on a lab planet: pick the host from the owned labs.
  const labPlanets = view.planets.filter((p) => (p.buildings.lab ?? 0) > 0);
  const [hostPlanetId, setHostPlanetId] = useState<string>(labPlanets[0]?.id ?? '');
  const hostPlanet = labPlanets.find((p) => p.id === hostPlanetId) ?? labPlanets[0];

  const orders = view.research.orders;
  const active = orders.filter(
    (o): o is ResearchOrderView & { position: number } =>
      o.status === 'researching' || o.status === 'queued',
  );
  const history = orders.filter((o) => o.status === 'completed' || o.status === 'cancelled');
  const queueFull = active.length >= RESEARCH.queueCapacity;

  const start = async (technologyId: TechnologyId) => {
    if (!hostPlanet) return;
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await submitStartResearch({
        worldId,
        hostPlanetId: hostPlanet.id,
        technologyId,
        expectedVersion: worldVersion,
      });
      const def = RESEARCH_BY_ID[technologyId];
      setNotice({
        kind: 'ok',
        text:
          receipt.status === 'researching'
            ? `${def.name} is under study — completes in ${receipt.ticksRemaining} tick${receipt.ticksRemaining === 1 ? '' : 's'}.`
            : `${def.name} queued behind ${receipt.position} order${receipt.position === 1 ? '' : 's'}.`,
      });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      setNotice({ kind: 'error', text: code === undefined ? message : `${message} (${code})` });
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (order: ResearchOrderView) => {
    setBusy(true);
    setNotice(null);
    try {
      await cancelResearch({ worldId, orderId: order.id, expectedVersion: worldVersion });
      setNotice({ kind: 'ok', text: 'Research cancelled — the reserved cost is refunded.' });
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      setNotice({ kind: 'error', text: code === undefined ? message : `${message} (${code})` });
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="research-grid">
      {/* Queue + completed effects: the account-wide state at a glance. */}
      <section className="panel research-queue-panel" aria-labelledby="research-queue-heading">
        <h2 id="research-queue-heading" className="panel-title">
          Research queue
        </h2>
        {labPlanets.length === 0 ? (
          <div className="research-gate" data-testid="research-no-lab">
            <p className="empty-state">No Research Lab yet — every study below is gated on one.</p>
            <a className="construction-desk-link" href={constructionsUrl}>
              Raise a Research Lab →
            </a>
          </div>
        ) : (
          <>
            <label className="field-row">
              <span className="field-label">Hosting lab planet</span>
              <select
                className="field-select"
                data-testid="host-planet-select"
                value={hostPlanet?.id ?? ''}
                onChange={(e) => setHostPlanetId(e.target.value)}
              >
                {labPlanets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {hostPlanet ? (
                <span className="field-hint mono">
                  {RESOURCE_NAMES.map(
                    ([key, label]) => `${label} ${hostPlanet.resources[key]}`,
                  ).join(' · ')}
                </span>
              ) : null}
            </label>
            {active.length === 0 && history.length === 0 ? (
              <p className="empty-state">No research in progress or completed.</p>
            ) : (
              <ul className="research-queue" data-testid="research-queue">
                {active.map((o) => {
                  const def = RESEARCH_BY_ID[o.technologyId];
                  return (
                    <li
                      key={o.id}
                      className={`research-order order-${o.status}`}
                      data-testid={`research-order-${o.id}`}
                    >
                      <span className="research-order-main">
                        <span className="building-kind">{def?.name ?? o.technologyId}</span>
                        {o.status === 'researching' ? (
                          <span
                            className="construction-order-eta mono"
                            data-testid={`research-eta-${o.id}`}
                          >
                            {o.ticksRemaining} tick{o.ticksRemaining === 1 ? '' : 's'} left
                          </span>
                        ) : (
                          <span className="construction-order-eta mono">
                            position {o.position + 1} of {active.length}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="cancel-button"
                        data-testid={`cancel-research-${o.id}`}
                        onClick={() => void cancel(o)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </li>
                  );
                })}
                {history.map((o) => {
                  const def = RESEARCH_BY_ID[o.technologyId];
                  return (
                    <li key={o.id} className={`research-order order-${o.status}`}>
                      <span className="research-order-main">
                        <span className="building-kind">{def?.name ?? o.technologyId}</span>
                        <span className="construction-order-eta mono">
                          {o.status === 'completed'
                            ? `completed at tick ${o.completedAtTick}`
                            : 'cancelled'}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        <SectionHelp id="research-queue">
          <p>
            Research is account-wide: one study at a time, with a small queue behind it. The study
            runs on — and is paid from — whichever owned planet has a Research Lab; pick the host
            above. The full cost is reserved the moment you commit, and cancelling refunds it. A
            completed technology applies its effects from the next tick onward.
          </p>
        </SectionHelp>
      </section>

      <section className="panel research-effects-panel" aria-labelledby="effects-heading">
        <h2 id="effects-heading" className="panel-title">
          Completed research
        </h2>
        <p className="research-completed-count mono" data-testid="research-completed-count">
          <strong>{view.research.completed.length}</strong> of {RESEARCH_TREE.length} technologies
        </p>
        {view.research.completed.length === 0 ? (
          <p className="empty-state">Nothing completed yet.</p>
        ) : (
          <div className="research-completed-list" data-testid="research-completed">
            {view.research.completed.map((id) => (
              <span key={id} className="research-completed-chip">
                {RESEARCH_BY_ID[id]?.name ?? id}
              </span>
            ))}
          </div>
        )}
        <EffectsSummary effects={view.research.effects} />
        <SectionHelp id="research-effects">
          <p>
            Every completed technology adds its effects to the account. Extraction and storage
            bonuses multiply production and the storage cap on every owned world, navigation
            shortens fleet travel, and some technologies unlock new ship kinds for your shipyards.
          </p>
        </SectionHelp>
      </section>

      {/* The tree: the whole catalog, grouped by branch. */}
      <section className="panel research-tree-panel" aria-labelledby="tree-heading">
        <h2 id="tree-heading" className="panel-title">
          Technology tree
        </h2>
        {labPlanets.length === 0 ? (
          <p className="research-tree-gate" data-testid="research-tree-no-lab">
            Raise a Research Lab and the full tree unlocks — every study below is shown locked until
            then, so you can plan ahead.
          </p>
        ) : null}
        <TechnologyTree
          view={view}
          host={hostPlanet}
          noLab={labPlanets.length === 0}
          queueFull={queueFull}
          busy={busy}
          onStart={(id) => void start(id)}
        />
        <SectionHelp id="research-tree">
          <p>
            Technologies are researched in order: a study&apos;s prerequisites must be completed
            first. Cost is paid from the hosting lab planet&apos;s store at submission, so a rich
            lab host can fund a longer run of studies than a poor one.
          </p>
        </SectionHelp>
      </section>

      {notice && (
        <p
          className={`command-notice notice-${notice.kind}`}
          data-testid="research-notice"
          role="status"
        >
          {notice.text}
        </p>
      )}
    </main>
  );
}

function TechnologyTree({
  view,
  host,
  noLab,
  queueFull,
  busy,
  onStart,
}: {
  view: WorldView;
  host: { id: string; resources: Record<string, number> } | undefined;
  noLab: boolean;
  queueFull: boolean;
  busy: boolean;
  onStart: (id: TechnologyId) => void;
}) {
  const activeTechIds = new Set(
    view.research.orders
      .filter((o) => o.status === 'researching' || o.status === 'queued')
      .map((o) => o.technologyId),
  );
  const completed = new Set(view.research.completed);

  return (
    <div className="tech-tree">
      {BRANCH_ORDER.map((branch) => {
        const techs = RESEARCH_TREE.filter((t) => t.branch === branch);
        if (techs.length === 0) return null;
        return (
          <div key={branch} className="tech-branch" data-testid={`tech-branch-${branch}`}>
            <h3 className="tech-branch-title">{RESEARCH_BRANCH_LABELS[branch]}</h3>
            <ul className="tech-branch-list">
              {techs.map((tech) => {
                const done = completed.has(tech.id);
                const queued = activeTechIds.has(tech.id);
                const missing = tech.prerequisites.filter((p) => !completed.has(p));
                const affordable =
                  !noLab &&
                  host !== undefined &&
                  RESOURCE_KEYS.every((r) => host.resources[r] >= (tech.cost[r] ?? 0));
                const disabled =
                  busy || noLab || done || queued || missing.length > 0 || queueFull || !affordable;
                const reason = noLab
                  ? 'Requires a Research Lab first'
                  : done
                    ? 'Research complete'
                    : queued
                      ? 'Already in the queue'
                      : missing.length > 0
                        ? `Requires ${missing.map((p) => RESEARCH_BY_ID[p]?.name ?? p).join(', ')}`
                        : queueFull
                          ? 'Research queue full'
                          : !affordable
                            ? 'Host lab cannot afford this study'
                            : '';
                return (
                  <li
                    key={tech.id}
                    className={`tech-row${done ? ' tech-done' : ''}${queued ? ' tech-queued' : ''}`}
                    data-testid={`tech-row-${tech.id}`}
                  >
                    <div className="tech-row-head">
                      <span className="tech-row-title">
                        <span className="tech-name">{tech.name}</span>
                        <span className="tech-tier-chip">Tier {tech.tier}</span>
                      </span>
                      <span className="tech-meta mono">
                        {formatCost(tech.cost)} · {tech.researchTicks} tick
                        {tech.researchTicks === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="tech-summary">{tech.summary}</p>
                    <div className="tech-row-foot">
                      <span className="tech-effects">
                        {tech.prerequisites.length > 0 ? (
                          <span className="tech-prereqs">
                            {tech.prerequisites.map((p) => (
                              <span
                                key={p}
                                className={`tech-prereq-chip${completed.has(p) ? ' tech-prereq-done' : ''}`}
                                data-testid={`tech-prereq-${p}`}
                              >
                                {RESEARCH_BY_ID[p]?.name ?? p}
                              </span>
                            ))}
                          </span>
                        ) : null}
                        <span className="tech-effects-list">{formatEffects(tech.effects)}</span>
                      </span>
                      <button
                        type="button"
                        className="build-button"
                        data-testid={`research-${tech.id}`}
                        onClick={() => onStart(tech.id)}
                        disabled={disabled}
                        title={reason === '' ? undefined : reason}
                      >
                        {noLab
                          ? 'Locked'
                          : done
                            ? 'Researched'
                            : queued
                              ? 'In queue'
                              : affordable
                                ? 'Research'
                                : 'Locked'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function EffectsSummary({ effects }: { effects: TechnologyEffects }) {
  const parts = effectParts(effects);
  if (parts.length === 0) {
    return <p className="empty-state">No effects yet.</p>;
  }
  return (
    <ul className="effects-summary" data-testid="research-effects">
      {parts.map((part) => (
        <li key={part}>{part}</li>
      ))}
    </ul>
  );
}

function effectParts(effects: TechnologyEffects): string[] {
  const parts: string[] = [];
  if (effects.extractionBonus > 0)
    parts.push(`+${Math.round(effects.extractionBonus * 100)}% extraction`);
  if (effects.storageBonus > 0)
    parts.push(`+${Math.round(effects.storageBonus * 100)}% storage cap`);
  if (effects.upkeepReduction > 0)
    parts.push(`−${Math.round(effects.upkeepReduction * 100)}% upkeep`);
  if (effects.navigationSpeedBonus > 0)
    parts.push(`+${Math.round(effects.navigationSpeedBonus * 100)}% fleet speed`);
  if (effects.scanRangeBonus > 0) parts.push(`+${effects.scanRangeBonus} scan range`);
  for (const ship of effects.shipUnlocks) parts.push(`unlocks ${ship} ship`);
  return parts;
}

function formatEffects(effects: TechnologyEffects): string {
  const parts = effectParts(effects);
  return parts.length === 0 ? 'no direct effect' : parts.join(' · ');
}

function formatCost(cost: Partial<Record<(typeof RESOURCE_KEYS)[number], number>>): string {
  const parts = RESOURCE_KEYS.filter((r) => (cost[r] ?? 0) > 0).map(
    (r) => `${RESOURCE_NAMES.find(([k]) => k === r)?.[1]} ${cost[r]}`,
  );
  return parts.length === 0 ? 'free' : parts.join(', ');
}
