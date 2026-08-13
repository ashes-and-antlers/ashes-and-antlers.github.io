import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCoordinate,
  parseCoordinate,
  SCAN_KIND_LABELS,
  SCAN_KINDS,
  type PlanetView,
  type ScannedPlanetView,
  type ScanKind,
  type ScanReportView,
  type WorldView,
} from '@ashes/contracts';
import { factionById, PLANET_CLASSES, SCAN } from '@ashes/content';
import { ApiError, assertProtocol, fetchOverview, fetchScanPreview, submitRunScan } from './api';
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

const CLASS_NAMES = new Map(PLANET_CLASSES.map((c) => [c.key, c.name]));
const CLASS_COLORS = new Map(PLANET_CLASSES.map((c) => [c.key, c.mapColor]));

function classNameOf(classId: string): string {
  return CLASS_NAMES.get(classId as (typeof PLANET_CLASSES)[number]['key']) ?? classId;
}

function ownerLabel(planet: { ownerId: string | null; factionId: string | null }): string {
  if (planet.ownerId === null) return 'unclaimed';
  const faction = planet.factionId ? factionById(planet.factionId as never) : undefined;
  return faction ? faction.name : `occupied (${planet.ownerId})`;
}

export function ScansApp() {
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
        title="Scans"
        current="scans"
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
          data-testid="scans-offline"
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
        <ScansPanel
          view={state.view}
          worldId={worldId}
          worldVersion={worldVersion}
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
        <span>watch array · ashfield command archive</span>
      </footer>
    </div>
  );
}

function ScansPanel({
  view,
  worldId,
  worldVersion,
  onStateChange,
}: {
  view: WorldView;
  worldId: string;
  worldVersion: number;
  onStateChange: () => void;
}) {
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const report = (kind: 'ok' | 'error', text: string) => setNotice({ kind, text });

  // The scan form's source defaults to the first owned planet with an array.
  const sources = view.planets;
  const firstScanner = sources.find((p) => (p.buildings.scanner ?? 0) >= 1);
  const [sourceId, setSourceId] = useState<string>(firstScanner?.id ?? sources[0]?.id ?? '');

  const source = sources.find((p) => p.id === sourceId);
  const scannerLevel = source?.buildings.scanner ?? 0;

  return (
    <main className="scans-grid">
      <section className="panel scans-form" aria-labelledby="scans-form-heading">
        <h2 id="scans-form-heading" className="panel-title">
          Scan mission
        </h2>
        {sources.length === 0 ? (
          <p className="empty-state">Claim a planet before running scans.</p>
        ) : (
          <ScanForm
            key={sourceId}
            sources={sources}
            sourceId={sourceId}
            scannerLevel={scannerLevel}
            onSourceChange={setSourceId}
            worldId={worldId}
            worldVersion={worldVersion}
            onStateChange={onStateChange}
            report={report}
          />
        )}
        <SectionHelp id="scans">
          <p>
            A Scanner Array runs scan missions against any world within its reach. Level it up to
            reach farther and unlock deeper scans — basic shows occupancy and class, resource adds
            approximate stores, military adds the fleet picture. Reports are stamped with the tick
            they were gathered on; a report is never a guarantee the target has not moved since.
          </p>
        </SectionHelp>
      </section>

      <KnownWorlds view={view} />

      <ScanArchive reports={view.intel.reports} currentTick={view.tick} />

      {notice && (
        <p
          className={`command-notice notice-${notice.kind}`}
          data-testid="scan-notice"
          role="status"
        >
          {notice.text}
        </p>
      )}
    </main>
  );
}

/** The scan form: pick a source array, target, and kind; preview reach; run. */
function ScanForm({
  sources,
  sourceId,
  scannerLevel,
  onSourceChange,
  worldId,
  worldVersion,
  onStateChange,
  report,
}: {
  sources: PlanetView[];
  sourceId: string;
  scannerLevel: number;
  onSourceChange: (id: string) => void;
  worldId: string;
  worldVersion: number;
  onStateChange: () => void;
  report: (kind: 'ok' | 'error', text: string) => void;
}) {
  const [target, setTarget] = useState('');
  const [scan, setScan] = useState<ScanKind>('basic');
  const [preview, setPreview] = useState<{
    range: number;
    distance: number;
    inRange: boolean;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = parseCoordinate(target.trim());
  const required = SCAN.kinds[scan].requiredScannerLevel;
  const locked = scannerLevel < required;

  useEffect(() => {
    let cancelled = false;
    if (!parsed) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreview(null);
    setPreviewError(null);
    fetchScanPreview(worldId, sourceId, parsed)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'preview unavailable';
        const code = err instanceof ApiError ? err.code : undefined;
        setPreviewError(code === undefined ? message : `${message} (${code})`);
      });
    return () => {
      cancelled = true;
    };
  }, [target, sourceId, worldId]);

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const reportResult = await submitRunScan({
        worldId,
        sourcePlanetId: sourceId,
        target: parsed,
        scan,
        expectedVersion: worldVersion,
      });
      report(
        'ok',
        `${SCAN_KIND_LABELS[scan]} scan of ${formatCoordinate(
          reportResult.target,
        )} — ${reportResult.revealed.ownerId === null ? 'unclaimed' : 'occupied'} world recorded at tick ${reportResult.submittedTick}.`,
      );
      setTarget('');
      onStateChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'command failed';
      const code = err instanceof ApiError ? err.code : undefined;
      report('error', code === undefined ? message : `${message} (${code})`);
      if (code === 'STALE_VERSION') onStateChange();
    } finally {
      setBusy(false);
    }
  };

  const validTarget = parsed !== null;

  return (
    <div className="scan-form-fields">
      <label className="field-row">
        <span className="field-label">Source array</span>
        <select
          className="field-select"
          data-testid="scan-source"
          value={sourceId}
          onChange={(e) => onSourceChange(e.target.value)}
        >
          {sources.map((planet) => {
            const level = planet.buildings.scanner ?? 0;
            return (
              <option key={planet.id} value={planet.id}>
                {planet.name} — Scanner Array L{level}
                {level === 0 ? ' (none)' : ''}
              </option>
            );
          })}
        </select>
      </label>
      <label className="field-row compact">
        <span className="field-label">Target</span>
        <input
          type="text"
          className="field-input mono"
          placeholder="1:1:1:2"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Target coordinate"
        />
        <span className="field-hint mono">galaxy:sector:system:planet</span>
      </label>
      <label className="field-row compact">
        <span className="field-label">Scan kind</span>
        <select
          className="field-select"
          data-testid="scan-kind"
          value={scan}
          onChange={(e) => setScan(e.target.value as ScanKind)}
        >
          {SCAN_KINDS.map((kind) => {
            const need = SCAN.kinds[kind].requiredScannerLevel;
            return (
              <option key={kind} value={kind} disabled={scannerLevel < need}>
                {SCAN_KIND_LABELS[kind]} — array L{need}
              </option>
            );
          })}
        </select>
        {locked ? (
          <span className="field-hint mono">
            needs Scanner Array level {required} (this array is L{scannerLevel})
          </span>
        ) : null}
      </label>
      <p className="route-preview mono" data-testid="scan-preview" role="status">
        {previewError ? (
          <span className="notice-error-text">{previewError}</span>
        ) : preview ? (
          preview.inRange ? (
            `reach ${Math.round(preview.range)} · target ${Math.round(preview.distance)} — in range`
          ) : (
            <span className="notice-error-text">
              out of range — reach {Math.round(preview.range)}, target{' '}
              {Math.round(preview.distance)}
            </span>
          )
        ) : (
          <span className="route-preview-idle">Enter a target to check reach.</span>
        )}
      </p>
      <button
        type="button"
        className="build-button"
        data-testid="scan-run"
        onClick={() => void run()}
        disabled={busy || !validTarget || locked || preview === null || !preview.inRange}
      >
        Run {SCAN_KIND_LABELS[scan].toLowerCase()} scan
      </button>
    </div>
  );
}

/** The visibility-filtered known-worlds table (latest report per target). */
function KnownWorlds({ view }: { view: WorldView }) {
  const intel = view.intel.planets;
  return (
    <section className="panel scans-known" aria-labelledby="scans-known-heading">
      <h2 id="scans-known-heading" className="panel-title">
        Known worlds
      </h2>
      {intel.length === 0 ? (
        <p className="empty-state">
          Nothing charted yet. Run a basic scan to mark a world on the map.
        </p>
      ) : (
        <div className="intel-table-wrap">
          <table className="intel-table">
            <thead>
              <tr>
                <th scope="col">World</th>
                <th scope="col">Class</th>
                <th scope="col">Occupancy</th>
                <th scope="col">Population</th>
                <th scope="col">Intel</th>
              </tr>
            </thead>
            <tbody>
              {intel.map((planet) => {
                const age = view.tick - planet.scanTick;
                const classColor = CLASS_COLORS.get(
                  planet.classId as (typeof PLANET_CLASSES)[number]['key'],
                );
                return (
                  <tr
                    key={`${planet.coordinate.galaxy}:${planet.coordinate.sector}:${planet.coordinate.system}:${planet.coordinate.planet}`}
                  >
                    <td className="intel-world">
                      <span
                        className="planet-class-dot"
                        style={
                          classColor === undefined ? undefined : { backgroundColor: classColor }
                        }
                        aria-hidden="true"
                      />
                      <span className="intel-name">{planet.name}</span>
                      <span className="intel-coord mono">
                        {formatCoordinate(planet.coordinate)}
                      </span>
                    </td>
                    <td>{classNameOf(planet.classId)}</td>
                    <td>{ownerLabel(planet)}</td>
                    <td className="mono">{planet.population.toLocaleString()}</td>
                    <td className="intel-detail">
                      <span className="mono">{SCAN_KIND_LABELS[planet.scanKind]}</span>
                      <span className="intel-age mono">
                        {age === 0 ? 'this tick' : `${age} tick${age === 1 ? '' : 's'} ago`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {intel.length > 0 ? (
        <div className="intel-detail-block">
          {intel.map((planet) => (
            <IntelDetail
              key={`${planet.coordinate.galaxy}:${planet.coordinate.sector}:${planet.coordinate.system}:${planet.coordinate.planet}`}
              planet={planet}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The deeper revealed data for a scanned world (resources, fleet picture). */
function IntelDetail({ planet }: { planet: ScannedPlanetView }) {
  if (planet.resources === undefined && planet.fleets === undefined) return null;
  return (
    <details className="intel-entry" data-testid={`intel-${formatCoordinate(planet.coordinate)}`}>
      <summary>
        <span className="intel-entry-name">{planet.name}</span>
        <span className="mono">{formatCoordinate(planet.coordinate)}</span>
      </summary>
      <dl className="intel-entry-grid">
        {planet.resources ? (
          <>
            {RESOURCE_NAMES.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd className="mono">~{planet.resources![key].toLocaleString()}</dd>
              </div>
            ))}
            <div>
              <dt>Storage cap</dt>
              <dd className="mono">{planet.storageCap?.toLocaleString() ?? '—'}</dd>
            </div>
          </>
        ) : null}
        {planet.fleets ? (
          <>
            <div>
              <dt>Fleets in orbit</dt>
              <dd className="mono">{planet.fleets.count}</dd>
            </div>
            <div>
              <dt>Ship strength</dt>
              <dd className="mono">
                {planet.fleets.ships} ships · {planet.fleets.hull} hull
              </dd>
            </div>
            <div>
              <dt>Drive tier</dt>
              <dd className="mono">{planet.fleets.driveTier}</dd>
            </div>
          </>
        ) : null}
      </dl>
    </details>
  );
}

/** The timestamped scan archive, newest first. */
function ScanArchive({ reports, currentTick }: { reports: ScanReportView[]; currentTick: number }) {
  return (
    <section className="panel scans-archive" aria-labelledby="scans-archive-heading">
      <h2 id="scans-archive-heading" className="panel-title">
        Scan archive
      </h2>
      {reports.length === 0 ? (
        <p className="empty-state">No scans recorded.</p>
      ) : (
        <ul className="scan-report-list" data-testid="scan-reports">
          {reports.map((report) => {
            const age = currentTick - report.submittedTick;
            return (
              <li key={report.id} className="scan-report">
                <div className="scan-report-head">
                  <span className="mono">{SCAN_KIND_LABELS[report.kind]} scan</span>
                  <span className="scan-report-coord mono">{formatCoordinate(report.target)}</span>
                  <span className="scan-report-age mono">
                    tick {report.submittedTick}
                    {age > 0 ? ` · ${age} tick${age === 1 ? '' : 's'} ago` : ''}
                  </span>
                </div>
                <p className="scan-report-summary">
                  {report.revealed.name} · {classNameOf(report.revealed.classId)} ·{' '}
                  {report.revealed.ownerId === null ? 'unclaimed' : ownerLabel(report.revealed)}
                  {report.revealed.population > 0
                    ? ` · ~${report.revealed.population.toLocaleString()} population`
                    : ''}
                  {report.revealed.fleets && report.revealed.fleets.ships > 0
                    ? ` · ${report.revealed.fleets.ships} ships in orbit`
                    : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <SectionHelp id="scans-archive">
        <p>
          Reports are immutable and time-stamped. Deeper scans overwrite the known-worlds entry for
          a target; an older basic scan never unlocks what a military scan has not revealed.
        </p>
      </SectionHelp>
    </section>
  );
}
