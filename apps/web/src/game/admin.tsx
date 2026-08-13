import { useEffect, useState } from 'react';
import {
  formatCoordinate,
  RESOURCE_KEYS,
  type AdminAccountDetail,
  type AdminAccountSummary,
  type AdminPlayerDetail,
  type AdminPlayerSummary,
  type AdminWorldDetail,
  type AdminWorldSummary,
  type ResourceKey,
  type ShipStacks,
} from '@ashes/contracts';
import { EMBLEMS, factionById } from '@ashes/content';
import {
  clearAdminToken,
  createAdminWorld,
  deleteAdminAccount,
  deleteAdminWorld,
  fetchAdminAccount,
  fetchAdminAccounts,
  fetchAdminPlayer,
  fetchAdminPlayers,
  fetchAdminResolutions,
  fetchAdminStatus,
  fetchAdminWorld,
  fetchAdminWorlds,
  getAdminToken,
  grantAdminPlayer,
  renameAdminPlayer,
  resetAdminPassword,
  resolveAdminTick,
  revokeAdminSession,
  revokeAllAdminSessions,
  setAdminToken,
  updateAdminAccount,
  type AdminApiError,
} from './admin-api';
import { RESOURCE_NAMES } from './planet-ui';

type TabId = 'overview' | 'worlds' | 'players' | 'accounts' | 'database';

// -- shared helpers ----------------------------------------------------------

const RESOURCE_LABELS = new Map<ResourceKey, string>(RESOURCE_NAMES);

function factionName(id: string | null): string {
  if (id === null) return '—';
  return factionById(id as never)?.name ?? id;
}

function shipStacksLabel(ships: ShipStacks): string {
  const parts = Object.entries(ships).filter(([, n]) => (n ?? 0) > 0);
  if (parts.length === 0) return 'empty';
  return parts.map(([kind, n]) => `${kind}×${n}`).join(' · ');
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function formatAge(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatCountdown(ms: number, now: number): string {
  const secondsLeft = Math.max(0, Math.ceil((ms - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** A small inline status/notice line for operator feedback. */
function Notice({ text, tone }: { text: string | null; tone?: 'ok' | 'err' | undefined }) {
  if (text === null) return null;
  return (
    <p className={`admin-notice${tone === 'ok' ? ' is-ok' : tone === 'err' ? ' is-err' : ''}`}>
      {text}
    </p>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="admin-section-title">{children}</h2>;
}

// -- entry: gate + dashboard shell -------------------------------------------

export function AdminApp() {
  const [token, setToken] = useState<string | null>(() => getAdminToken());
  const [gateError, setGateError] = useState<string | null>(null);

  if (token === null) {
    return (
      <AdminGate
        onUnlock={(t) => {
          setAdminToken(t);
          setToken(t);
        }}
        error={gateError}
        onError={setGateError}
      />
    );
  }
  return (
    <Dashboard
      token={token}
      onLock={() => {
        clearAdminToken();
        setToken(null);
      }}
    />
  );
}

/** The operator token door: the token is never baked into the client. */
function AdminGate({
  onUnlock,
  error,
  onError,
}: {
  onUnlock: (token: string) => void;
  error: string | null;
  onError: (message: string | null) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const unlock = async () => {
    const token = value.trim();
    if (token === '') return;
    setBusy(true);
    onError(null);
    try {
      await fetchAdminStatus(token);
      onUnlock(token);
    } catch (err) {
      const apiError = err as AdminApiError;
      onError(
        apiError.status === 401
          ? 'That token was rejected — check the operator bearer token.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-shell admin-gate" data-testid="admin-gate">
      <div className="admin-gate-card">
        <div className="brand-lockup">
          <span className="brand-dot" aria-hidden="true" />
          <h1 className="brand-word">Archive · Administration</h1>
        </div>
        <p className="admin-gate-copy">
          The operator console for the shared world. Enter the administrator bearer token to manage
          the game, the database, and the commanders.
        </p>
        <label className="admin-field">
          <span>Administrator token</span>
          <input
            type="password"
            data-testid="admin-token-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void unlock();
            }}
            autoComplete="off"
            autoFocus
          />
        </label>
        <Notice text={error} tone="err" />
        <button
          className="admin-button is-primary"
          data-testid="admin-unlock"
          disabled={busy || value.trim() === ''}
          onClick={() => void unlock()}
        >
          {busy ? 'Checking…' : 'Enter console'}
        </button>
      </div>
    </div>
  );
}

function Dashboard({ token, onLock }: { token: string; onLock: () => void }) {
  const [tab, setTab] = useState<TabId>('overview');
  const tabs: Array<{ id: TabId; label: string; testid: string }> = [
    { id: 'overview', label: 'Overview', testid: 'tab-overview' },
    { id: 'worlds', label: 'Worlds', testid: 'tab-worlds' },
    { id: 'players', label: 'Players', testid: 'tab-players' },
    { id: 'accounts', label: 'Accounts', testid: 'tab-accounts' },
    { id: 'database', label: 'Database', testid: 'tab-database' },
  ];

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="brand-lockup">
          <span className="brand-dot" aria-hidden="true" />
          <h1 className="brand-word">Archive · Administration</h1>
          <span className="admin-badge" data-testid="admin-badge">
            OPERATOR
          </span>
        </div>
        <div className="admin-header-right">
          <nav className="admin-tabs" aria-label="Administration views" data-testid="admin-tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`admin-tab${tab === t.id ? ' is-current' : ''}`}
                data-testid={t.testid}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <button className="admin-signout" data-testid="admin-signout" onClick={onLock}>
            Sign out
          </button>
        </div>
      </header>
      <main className="admin-main">
        {tab === 'overview' ? <OverviewTab token={token} /> : null}
        {tab === 'worlds' ? <WorldsTab token={token} /> : null}
        {tab === 'players' ? <PlayersTab token={token} /> : null}
        {tab === 'accounts' ? <AccountsTab token={token} /> : null}
        {tab === 'database' ? <DatabaseTab token={token} /> : null}
      </main>
    </div>
  );
}

// -- overview ----------------------------------------------------------------

function OverviewTab({ token }: { token: string }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchAdminStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchAdminStatus(token);
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <section className="admin-panel">
        <SectionTitle>Overview</SectionTitle>
        <Notice text={error} tone="err" />
      </section>
    );
  }
  if (!status) {
    return (
      <section className="admin-panel">
        <SectionTitle>Overview</SectionTitle>
        <p className="admin-muted">Loading the archive…</p>
      </section>
    );
  }

  const { db } = status;
  return (
    <section className="admin-panel" data-testid="admin-overview">
      <SectionTitle>Overview</SectionTitle>
      <div className="admin-card-grid">
        <StatCard label="Worlds" value={String(status.worldCount)} />
        <StatCard label="Players" value={String(status.playerCount)} />
        <StatCard label="Accounts" value={String(status.accountCount)} />
        <StatCard label="Ticks resolved" value={String(status.tickCount)} />
        <StatCard label="Database" value={db.databaseName} />
        <StatCard label="Server" value={db.serverVersion} />
        <StatCard label="Migrations" value={String(db.appliedMigrations)} />
        <StatCard label="Total rows" value={String(db.totalRows)} />
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table" data-testid="admin-db-tables">
          <thead>
            <tr>
              <th>Table</th>
              <th>Rows</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {db.tables.map((t) => (
              <tr key={t.name} data-testid={`db-table-${t.name}`}>
                <td className="mono">{t.name}</td>
                <td>{t.rows.toLocaleString()}</td>
                <td>{t.size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-stat-card">
      <span className="admin-stat-label">{label}</span>
      <span className="admin-stat-value" title={value}>
        {value}
      </span>
    </div>
  );
}

// -- worlds ------------------------------------------------------------------

function WorldsTab({ token }: { token: string }) {
  const [worlds, setWorlds] = useState<AdminWorldSummary[] | null>(null);
  const [selected, setSelected] = useState<AdminWorldDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone?: 'ok' | 'err' } | null>(null);
  const [seedInput, setSeedInput] = useState('1337');
  const now = useNow();

  const load = async () => {
    try {
      const next = await fetchAdminWorlds(token);
      setWorlds(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5_000);
    return () => clearInterval(id);
  }, [token]);

  const openWorld = async (worldId: string) => {
    try {
      setSelected(await fetchAdminWorld(token, worldId));
      setNotice(null);
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const resolveTick = async (world: AdminWorldSummary) => {
    try {
      const result = await resolveAdminTick(token, world.id);
      setNotice({ text: `world ${world.id} → tick ${result.tick} resolved`, tone: 'ok' });
      await load();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const deleteWorld = async (world: AdminWorldSummary) => {
    if (!window.confirm(`Delete world ${world.id} (${world.resolutionCount} resolutions)?`)) return;
    try {
      await deleteAdminWorld(token, world.id);
      setNotice({ text: `world ${world.id} deleted`, tone: 'ok' });
      await load();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const createWorld = async () => {
    const seed = Number(seedInput);
    if (!Number.isInteger(seed) || seed < 0) {
      setNotice({ text: 'seed must be a non-negative integer', tone: 'err' });
      return;
    }
    try {
      const detail = await createAdminWorld(token, seed);
      setNotice({ text: `world ${detail.summary.id} created from seed ${seed}`, tone: 'ok' });
      await load();
      setSelected(detail);
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  if (selected) {
    return (
      <WorldDetail
        token={token}
        detail={selected}
        onBack={() => setSelected(null)}
        onChanged={load}
      />
    );
  }

  return (
    <section className="admin-panel" data-testid="admin-worlds">
      <SectionTitle>Worlds</SectionTitle>
      <Notice text={notice?.text ?? null} tone={notice?.tone} />
      <Notice text={error} tone="err" />
      {worlds === null ? (
        <p className="admin-muted">Loading worlds…</p>
      ) : (
        <>
          <div className="admin-toolbar">
            <label className="admin-field is-inline">
              <span>Create / reload world from seed</span>
              <input
                type="number"
                data-testid="create-world-seed"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
              />
            </label>
            <button
              className="admin-button is-primary"
              data-testid="create-world"
              onClick={() => void createWorld()}
            >
              Create world
            </button>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>World</th>
                  <th>Seed</th>
                  <th>Tick</th>
                  <th>Next tick</th>
                  <th>Players</th>
                  <th>Planets</th>
                  <th>Fleets</th>
                  <th>Resolutions</th>
                  <th>Content</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {worlds.map((w) => (
                  <tr key={w.id} data-testid={`world-row-${w.id}`}>
                    <td className="mono">{w.id}</td>
                    <td className="mono">{w.seed}</td>
                    <td className="mono">{w.tick}</td>
                    <td className="mono">{formatCountdown(w.nextTickAt, now)}</td>
                    <td>{w.playerCount}</td>
                    <td>{w.planetCount}</td>
                    <td>{w.fleetCount}</td>
                    <td>{w.resolutionCount}</td>
                    <td className="mono" title={w.contentVersion}>
                      {w.contentVersion}
                    </td>
                    <td className="admin-actions">
                      <button
                        className="admin-button"
                        data-testid={`world-detail-${w.id}`}
                        onClick={() => void openWorld(w.id)}
                      >
                        Inspect
                      </button>
                      <button
                        className="admin-button"
                        data-testid={`tick-world-${w.id}`}
                        onClick={() => void resolveTick(w)}
                      >
                        Resolve tick
                      </button>
                      <button
                        className="admin-button is-danger"
                        data-testid={`delete-world-${w.id}`}
                        onClick={() => void deleteWorld(w)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function WorldDetail({
  token,
  detail,
  onBack,
  onChanged,
}: {
  token: string;
  detail: AdminWorldDetail;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [resolutions, setResolutions] = useState<Awaited<
    ReturnType<typeof fetchAdminResolutions>
  > | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone?: 'ok' | 'err' } | null>(null);
  const { summary } = detail;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await fetchAdminResolutions(token, summary.id, 20);
        if (!cancelled) setResolutions(rows);
      } catch (err) {
        if (!cancelled) setNotice({ text: errorMessage(err), tone: 'err' });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [token, summary.id]);

  const resolveTick = async () => {
    try {
      const result = await resolveAdminTick(token, summary.id);
      setNotice({ text: `tick ${result.tick} resolved (${result.status})`, tone: 'ok' });
      onChanged();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  return (
    <section className="admin-panel" data-testid={`world-detail-${summary.id}`}>
      <div className="admin-detail-head">
        <button className="admin-button" data-testid="world-detail-back" onClick={onBack}>
          ← Worlds
        </button>
        <SectionTitle>{summary.id}</SectionTitle>
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone} />
      <div className="admin-card-grid">
        <StatCard label="Seed" value={String(summary.seed)} />
        <StatCard label="Tick" value={String(summary.tick)} />
        <StatCard label="World hash" value={summary.worldHash} />
        <StatCard label="Content" value={summary.contentVersion} />
        <StatCard label="World version" value={summary.worldVersion} />
        <StatCard label="Resolutions" value={String(summary.resolutionCount)} />
      </div>
      <div className="admin-toolbar">
        <button
          className="admin-button is-primary"
          data-testid="world-detail-tick"
          onClick={() => void resolveTick()}
        >
          Resolve next tick
        </button>
      </div>

      <SectionTitle>Players</SectionTitle>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Name</th>
              <th>Faction</th>
              <th>Home planet</th>
              <th>Techs</th>
              <th>Fleets</th>
            </tr>
          </thead>
          <tbody>
            {detail.players.map((p) => (
              <tr key={p.playerId}>
                <td className="mono">{p.playerId}</td>
                <td>{p.name}</td>
                <td>{factionName(p.factionId)}</td>
                <td className="mono">{p.homePlanetId}</td>
                <td>{p.technologyCount}</td>
                <td>{p.fleetCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Fleets</SectionTitle>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Fleet</th>
              <th>Owner</th>
              <th>Location</th>
              <th>Ships</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {detail.fleets.map((f) => (
              <tr key={f.id}>
                <td className="mono">{f.id}</td>
                <td className="mono">{f.ownerId}</td>
                <td className="mono">{formatCoordinate(f.location)}</td>
                <td>{shipStacksLabel(f.ships)}</td>
                <td>{f.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Resolution history (newest first)</SectionTitle>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Tick</th>
              <th>Resolved</th>
              <th>Status</th>
              <th>Planet state hash</th>
            </tr>
          </thead>
          <tbody>
            {resolutions === null ? (
              <tr>
                <td colSpan={4} className="admin-muted">
                  Loading…
                </td>
              </tr>
            ) : resolutions.length === 0 ? (
              <tr>
                <td colSpan={4} className="admin-muted">
                  No resolutions yet.
                </td>
              </tr>
            ) : (
              resolutions.map((r) => (
                <tr key={r.tick}>
                  <td className="mono">{r.tick}</td>
                  <td>{formatTime(r.resolvedAt)}</td>
                  <td>{r.status}</td>
                  <td className="mono">{r.planetStateHash}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// -- players ----------------------------------------------------------------

function PlayersTab({ token }: { token: string }) {
  const [players, setPlayers] = useState<AdminPlayerSummary[] | null>(null);
  const [selected, setSelected] = useState<AdminPlayerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchAdminPlayers(token);
        if (!cancelled) setPlayers(next);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const openPlayer = async (playerId: string) => {
    try {
      setSelected(await fetchAdminPlayer(token, playerId));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (selected) {
    return (
      <PlayerDetail
        token={token}
        detail={selected}
        onBack={() => setSelected(null)}
        onChanged={async () => setSelected(await fetchAdminPlayer(token, selected.player.playerId))}
      />
    );
  }

  return (
    <section className="admin-panel" data-testid="admin-players">
      <SectionTitle>Players</SectionTitle>
      <Notice text={error} tone="err" />
      {players === null ? (
        <p className="admin-muted">Loading players…</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Name</th>
                <th>Faction</th>
                <th>World</th>
                <th>Account</th>
                <th>Techs</th>
                <th>Fleets</th>
                <th>Scans</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.playerId} data-testid={`player-row-${p.playerId}`}>
                  <td className="mono">{p.playerId}</td>
                  <td>{p.name}</td>
                  <td>{factionName(p.factionId)}</td>
                  <td className="mono">{p.worldId}</td>
                  <td>{p.username ?? <span className="admin-muted">dev</span>}</td>
                  <td>{p.technologyCount}</td>
                  <td>{p.fleetCount}</td>
                  <td>{p.scanReportCount}</td>
                  <td className="admin-actions">
                    <button
                      className="admin-button"
                      data-testid={`player-detail-${p.playerId}`}
                      onClick={() => void openPlayer(p.playerId)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PlayerDetail({
  token,
  detail,
  onBack,
  onChanged,
}: {
  token: string;
  detail: AdminPlayerDetail;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [notice, setNotice] = useState<{ text: string; tone?: 'ok' | 'err' } | null>(null);
  const [grant, setGrant] = useState<Record<ResourceKey, string>>({
    metal: '',
    mineral: '',
    food: '',
    energy: '',
  });
  const [rename, setRename] = useState(detail.player.name);
  const { player, homePlanet } = detail;

  const submitGrant = async () => {
    const resources: Record<string, number> = {};
    for (const key of RESOURCE_KEYS) {
      const raw = grant[key].trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        setNotice({
          text: `${RESOURCE_LABELS.get(key)} must be a non-negative integer`,
          tone: 'err',
        });
        return;
      }
      resources[key] = value;
    }
    if (Object.keys(resources).length === 0) {
      setNotice({ text: 'grant at least one resource', tone: 'err' });
      return;
    }
    try {
      const result = await grantAdminPlayer(token, player.playerId, resources);
      setNotice({
        text: `granted — store ${RESOURCE_KEYS.map((k) => `${k} ${result.resources[k]}`).join(' · ')} (cap ${result.storageCap})`,
        tone: 'ok',
      });
      setGrant({ metal: '', mineral: '', food: '', energy: '' });
      await onChanged();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const submitRename = async () => {
    const name = rename.trim();
    if (name === '') {
      setNotice({ text: 'name cannot be empty', tone: 'err' });
      return;
    }
    try {
      await renameAdminPlayer(token, player.playerId, name);
      setNotice({ text: `renamed to “${name}”`, tone: 'ok' });
      await onChanged();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  return (
    <section className="admin-panel" data-testid={`player-detail-${player.playerId}`}>
      <div className="admin-detail-head">
        <button className="admin-button" data-testid="player-detail-back" onClick={onBack}>
          ← Players
        </button>
        <SectionTitle>{player.name}</SectionTitle>
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone} />
      <div className="admin-card-grid">
        <StatCard label="Player" value={player.playerId} />
        <StatCard label="Faction" value={factionName(player.factionId)} />
        <StatCard label="World" value={player.worldId} />
        <StatCard label="Home planet" value={homePlanet.name} />
        <StatCard label="Storage cap" value={String(homePlanet.storageCap)} />
        <StatCard label="Population" value={homePlanet.population.toLocaleString()} />
      </div>

      <SectionTitle>Home planet store</SectionTitle>
      <div className="admin-resource-grid">
        {RESOURCE_KEYS.map((key) => (
          <div className="admin-resource-tile" key={key}>
            <span className="admin-resource-name">{RESOURCE_LABELS.get(key)}</span>
            <span className="admin-resource-value mono">{homePlanet.resources[key]}</span>
          </div>
        ))}
      </div>

      <div className="admin-toolbar">
        <div className="admin-field is-inline">
          <span>Grant resources</span>
          {RESOURCE_KEYS.map((key) => (
            <input
              key={key}
              className="admin-grant-input"
              type="number"
              min={0}
              placeholder={RESOURCE_LABELS.get(key)}
              data-testid={`grant-${key}`}
              value={grant[key]}
              onChange={(e) => setGrant({ ...grant, [key]: e.target.value })}
            />
          ))}
        </div>
        <button
          className="admin-button is-primary"
          data-testid={`grant-submit-${player.playerId}`}
          onClick={() => void submitGrant()}
        >
          Grant
        </button>
      </div>

      <div className="admin-toolbar">
        <label className="admin-field is-inline">
          <span>Commander name</span>
          <input
            data-testid={`rename-${player.playerId}`}
            value={rename}
            onChange={(e) => setRename(e.target.value)}
          />
        </label>
        <button
          className="admin-button"
          data-testid={`rename-submit-${player.playerId}`}
          onClick={() => void submitRename()}
        >
          Rename
        </button>
      </div>

      <SectionTitle>Fleets</SectionTitle>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Fleet</th>
              <th>Location</th>
              <th>Ships</th>
              <th>Cargo</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {detail.fleets.map((f) => (
              <tr key={f.id}>
                <td className="mono">{f.id}</td>
                <td className="mono">{formatCoordinate(f.location)}</td>
                <td>{shipStacksLabel(f.ships)}</td>
                <td>
                  {RESOURCE_KEYS.filter((k) => f.cargo[k] > 0)
                    .map((k) => `${k} ${f.cargo[k]}`)
                    .join(' · ') || '—'}
                </td>
                <td>{f.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Owned planets</SectionTitle>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Planet</th>
              <th>Coordinate</th>
              <th>Population</th>
              <th>Resources</th>
              <th>Buildings</th>
            </tr>
          </thead>
          <tbody>
            {detail.ownedPlanets.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.name}</td>
                <td className="mono">{formatCoordinate(p.coordinate)}</td>
                <td>{p.population.toLocaleString()}</td>
                <td>
                  {RESOURCE_KEYS.filter((k) => p.resources[k] > 0)
                    .map((k) => `${k} ${p.resources[k]}`)
                    .join(' · ') || '—'}
                </td>
                <td>
                  {Object.entries(p.buildings)
                    .map(([k, lv]) => `${k} L${lv}`)
                    .join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Research</SectionTitle>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Completed technologies</th>
              <th>Active studies</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                {detail.research.completed.length === 0 ? (
                  <span className="admin-muted">none</span>
                ) : (
                  detail.research.completed.join(', ')
                )}
              </td>
              <td>{detail.research.activeOrderCount}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// -- accounts ---------------------------------------------------------------

function AccountsTab({ token }: { token: string }) {
  const [accounts, setAccounts] = useState<AdminAccountSummary[] | null>(null);
  const [selected, setSelected] = useState<AdminAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchAdminAccounts(token);
        if (!cancelled) setAccounts(next);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const openAccount = async (accountId: string) => {
    try {
      setSelected(await fetchAdminAccount(token, accountId));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (selected) {
    return (
      <AccountDetail
        token={token}
        detail={selected}
        onBack={() => setSelected(null)}
        onChanged={async () => setSelected(await fetchAdminAccount(token, selected.account.id))}
        onDeleted={() => setSelected(null)}
      />
    );
  }

  return (
    <section className="admin-panel" data-testid="admin-accounts">
      <SectionTitle>Accounts</SectionTitle>
      <Notice text={error} tone="err" />
      {accounts === null ? (
        <p className="admin-muted">Loading accounts…</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Faction</th>
                <th>World</th>
                <th>Sessions</th>
                <th>Last seen</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} data-testid={`account-row-${a.id}`}>
                  <td className="mono">{a.username}</td>
                  <td>{a.name}</td>
                  <td>{factionName(a.factionId)}</td>
                  <td className="mono">{a.worldId}</td>
                  <td>{a.activeSessionCount}</td>
                  <td>{a.lastSeenAt === null ? 'never' : formatAge(a.lastSeenAt, now)}</td>
                  <td>{formatTime(a.createdAt)}</td>
                  <td className="admin-actions">
                    <button
                      className="admin-button"
                      data-testid={`account-detail-${a.id}`}
                      onClick={() => void openAccount(a.id)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AccountDetail({
  token,
  detail,
  onBack,
  onChanged,
  onDeleted,
}: {
  token: string;
  detail: AdminAccountDetail;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { account } = detail;
  const [notice, setNotice] = useState<{ text: string; tone?: 'ok' | 'err' } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [revokeOnReset, setRevokeOnReset] = useState(true);
  const [editName, setEditName] = useState(account.name);
  const [editSymbol, setEditSymbol] = useState<string>(account.symbolId);
  const [removePlayer, setRemovePlayer] = useState(true);

  const resetPassword = async () => {
    if (newPassword.length < 8) {
      setNotice({ text: 'password must be at least 8 characters', tone: 'err' });
      return;
    }
    try {
      await resetAdminPassword(token, account.id, newPassword, revokeOnReset);
      setNotice({
        text: revokeOnReset
          ? 'password reset — every session was signed out'
          : 'password reset — sessions kept',
        tone: 'ok',
      });
      setNewPassword('');
      await onChanged();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const saveProfile = async () => {
    const name = editName.trim();
    if (name === '') {
      setNotice({ text: 'name cannot be empty', tone: 'err' });
      return;
    }
    try {
      const next = await updateAdminAccount(token, account.id, {
        name,
        ...(editSymbol === account.symbolId ? {} : { symbolId: editSymbol }),
      });
      setNotice({ text: 'profile updated', tone: 'ok' });
      await onChanged();
      setEditName(next.account.name);
      setEditSymbol(next.account.symbolId);
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const revokeAll = async () => {
    if (!window.confirm(`Sign every session on “${account.username}” out?`)) return;
    try {
      const revoked = await revokeAllAdminSessions(token, account.id);
      setNotice({ text: `${revoked} session(s) revoked`, tone: 'ok' });
      await onChanged();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const revokeOne = async (sessionId: string) => {
    try {
      await revokeAdminSession(token, account.id, sessionId);
      setNotice({ text: 'session revoked', tone: 'ok' });
      await onChanged();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  const deleteAccount = async () => {
    if (
      !window.confirm(
        `Delete account “${account.username}”${removePlayer ? ' and remove its commander from the world' : ' (keep the commander in the world)'}? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteAdminAccount(token, account.id, removePlayer);
      onDeleted();
    } catch (err) {
      setNotice({ text: errorMessage(err), tone: 'err' });
    }
  };

  return (
    <section className="admin-panel" data-testid={`account-detail-${account.id}`}>
      <div className="admin-detail-head">
        <button className="admin-button" data-testid="account-detail-back" onClick={onBack}>
          ← Accounts
        </button>
        <SectionTitle>{account.username}</SectionTitle>
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone} />
      <div className="admin-card-grid">
        <StatCard label="Account" value={account.id} />
        <StatCard label="Player" value={account.playerId} />
        <StatCard label="Faction" value={factionName(account.factionId)} />
        <StatCard label="World" value={account.worldId} />
        <StatCard label="Active sessions" value={String(account.activeSessionCount)} />
        <StatCard label="Joined" value={formatTime(account.createdAt)} />
      </div>

      <SectionTitle>Profile</SectionTitle>
      <div className="admin-toolbar">
        <label className="admin-field is-inline">
          <span>Name</span>
          <input
            data-testid={`account-name-${account.id}`}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
        </label>
        <label className="admin-field is-inline">
          <span>Emblem</span>
          <select
            data-testid={`account-symbol-${account.id}`}
            value={editSymbol}
            onChange={(e) => setEditSymbol(e.target.value)}
          >
            {EMBLEMS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="admin-button"
          data-testid={`profile-save-${account.id}`}
          onClick={() => void saveProfile()}
        >
          Save profile
        </button>
      </div>

      <SectionTitle>Sessions</SectionTitle>
      <div className="admin-toolbar">
        <button
          className="admin-button"
          data-testid={`revoke-all-${account.id}`}
          onClick={() => void revokeAll()}
        >
          Revoke all sessions
        </button>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last seen</th>
              <th>User agent</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {detail.sessions.map((s) => (
              <tr key={s.id} data-testid={`account-session-${s.id}`}>
                <td className="mono">{s.id}</td>
                <td>{formatTime(s.createdAt)}</td>
                <td>{formatTime(s.expiresAt)}</td>
                <td>{formatAge(s.lastSeenAt, Date.now())}</td>
                <td title={s.userAgent ?? undefined}>{s.userAgent ?? '—'}</td>
                <td>
                  {s.revokedAt !== null
                    ? 'revoked'
                    : s.expiresAt <= Date.now()
                      ? 'expired'
                      : 'active'}
                </td>
                <td className="admin-actions">
                  {s.revokedAt === null ? (
                    <button
                      className="admin-button is-danger"
                      data-testid={`revoke-session-${s.id}`}
                      onClick={() => void revokeOne(s.id)}
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="admin-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Security</SectionTitle>
      <div className="admin-toolbar">
        <label className="admin-field is-inline">
          <span>New password</span>
          <input
            type="password"
            data-testid={`reset-password-${account.id}`}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={revokeOnReset}
            onChange={(e) => setRevokeOnReset(e.target.checked)}
          />
          <span>Sign every session out</span>
        </label>
        <button
          className="admin-button"
          data-testid={`password-submit-${account.id}`}
          onClick={() => void resetPassword()}
        >
          Reset password
        </button>
      </div>

      <SectionTitle>Danger zone</SectionTitle>
      <div className="admin-toolbar">
        <label className="admin-check">
          <input
            type="checkbox"
            checked={removePlayer}
            onChange={(e) => setRemovePlayer(e.target.checked)}
          />
          <span>Also remove the commander from the world</span>
        </label>
        <button
          className="admin-button is-danger"
          data-testid={`delete-account-${account.id}`}
          onClick={() => void deleteAccount()}
        >
          Delete account
        </button>
      </div>
    </section>
  );
}

// -- database ---------------------------------------------------------------

function DatabaseTab({ token }: { token: string }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchAdminStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchAdminStatus(token);
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <section className="admin-panel">
        <SectionTitle>Database</SectionTitle>
        <Notice text={error} tone="err" />
      </section>
    );
  }
  if (!status) {
    return (
      <section className="admin-panel">
        <SectionTitle>Database</SectionTitle>
        <p className="admin-muted">Loading database status…</p>
      </section>
    );
  }

  const { db } = status;
  return (
    <section className="admin-panel" data-testid="admin-database">
      <SectionTitle>Database</SectionTitle>
      <div className="admin-card-grid">
        <StatCard label="Driver" value={db.driver} />
        <StatCard label="Server" value={db.serverVersion} />
        <StatCard label="Database" value={db.databaseName} />
        <StatCard label="Migrations applied" value={String(db.appliedMigrations)} />
        <StatCard label="Total rows" value={db.totalRows.toLocaleString()} />
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table" data-testid="db-tables">
          <thead>
            <tr>
              <th>Table</th>
              <th>Rows</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {db.tables.map((t) => (
              <tr key={t.name} data-testid={`db-table-${t.name}`}>
                <td className="mono">{t.name}</td>
                <td>{t.rows.toLocaleString()}</td>
                <td>{t.size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="admin-muted">
        Row counts are exact (COUNT(*)). Resolutions are immutable rows keyed by (world, tick) —
        browse them from a world's detail panel.
      </p>
    </section>
  );
}
