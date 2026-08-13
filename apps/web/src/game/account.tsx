import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { AccountSessionView, AccountView } from '@ashes/contracts';
import { type FactionSymbol } from '@ashes/content';
import {
  ApiError,
  changePassword,
  fetchEmblems,
  fetchFactions,
  fetchMe,
  fetchSessions,
  loginAccount,
  logoutAccount,
  registerAccount,
  revokeOtherSessions,
  revokeSession,
  updateProfile,
  type FactionCatalogEntry,
} from './api';
import { GameHeader, HeaderMeta, useWorldMeta } from './header';
import { clearSession, getSession, saveSession, sessionWorldId } from './session';

/**
 * The archive's front door. A commander either registers — picking one of the
 * archive's emblems — or returns with an existing session. The power
 * (faction) is not a choice: the archive assigns the least-populated one so
 * the galaxy stays balanced however many commanders join. Registering also
 * spawns the commander into the least-populated reachable area of the shared
 * galaxy (server-side, see domain spawn.ts); the session token then
 * authenticates every game page.
 */
export function AccountApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldMeta = useWorldMeta(sessionWorldId(seed));
  const [boot, setBoot] = useState<'checking' | 'panel' | 'form'>('checking');
  const [account, setAccount] = useState<AccountView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Validate the persisted session before choosing a surface, exactly like
  // the overview boot: a session that no longer exists server-side (revoked,
  // expired, or the account was wiped) must clear itself and land on the
  // door with an explanation — never silently on register/login, and never
  // on a panel for an identity the archive no longer knows.
  useEffect(() => {
    let cancelled = false;
    const session = getSession();
    if (!session) {
      setBoot('form');
      setNotice(
        'You are not signed in. This door registers commanders — sign in below to open your command panel.',
      );
      return;
    }
    void (async () => {
      try {
        const fresh = await fetchMe();
        if (cancelled) return;
        // The account view may have changed elsewhere (e.g. profile edits on
        // another device); refresh the persisted copy so the panel is current.
        saveSession({ token: session.token, account: fresh });
        setAccount(fresh);
        setBoot('panel');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
          clearSession();
          setNotice(
            'Your previous session was signed out or expired. Sign in to return to your command panel.',
          );
          setBoot('form');
        } else {
          // The archive is unreachable (dev restart, offline) — keep the
          // persisted session and render the panel; its own fetches will show
          // the outage instead of pretending the identity is gone.
          setAccount(session.account);
          setBoot('panel');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The live commander/tick readout rides the header only once signed in; the
  // register/login door keeps the nav but not a fabricated world context.
  const headerMeta = account && worldMeta ? <HeaderMeta meta={worldMeta} /> : undefined;

  if (boot === 'checking') {
    return (
      <div className="game-shell account-shell">
        <GameHeader seed={seed} title="Account" current="account" />
        <main className="account-panel">
          <p className="empty-state" data-testid="account-checking">
            Checking your session…
          </p>
        </main>
      </div>
    );
  }
  if (boot === 'panel' && account) {
    return <ControlPanel account={account} seed={seed} meta={headerMeta} />;
  }
  return <AccountForm sessionNotice={notice} seed={seed} />;
}

/**
 * The commander's control panel: profile (name + emblem), security (password),
 * and the devices signed into this account. Every change is written through
 * the account API; the local session is refreshed so the header and every
 * game page wear the updated identity.
 */
function ControlPanel({
  account: initial,
  seed,
  meta,
}: {
  account: AccountView;
  seed: string;
  meta?: ReactNode;
}) {
  const [account, setAccount] = useState<AccountView>(initial);
  const [emblems, setEmblems] = useState<FactionSymbol[] | null>(null);
  const [factions, setFactions] = useState<FactionCatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState(initial.name);
  const [symbolId, setSymbolId] = useState(initial.symbolId);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<Notice | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<Notice | null>(null);

  const [sessions, setSessions] = useState<AccountSessionView[] | null>(null);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [devicesNotice, setDevicesNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchEmblems(), fetchFactions(), fetchSessions()])
      .then(([emblemList, factionList, sessionList]) => {
        if (cancelled) return;
        setEmblems(emblemList);
        setFactions(factionList);
        setSessions(sessionList);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'could not reach the archive');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const factionName = factions?.find((f) => f.id === account.factionId)?.name ?? account.factionId;

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (profileBusy) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setProfileNotice({ kind: 'error', text: 'name cannot be empty' });
      return;
    }
    setProfileBusy(true);
    setProfileNotice(null);
    try {
      const updated = await updateProfile({
        ...(trimmed === account.name ? {} : { name: trimmed }),
        ...(symbolId === account.symbolId ? {} : { symbolId }),
      });
      const session = getSession();
      if (session) saveSession({ token: session.token, account: updated });
      setAccount(updated);
      setName(updated.name);
      setSymbolId(updated.symbolId);
      setProfileNotice({ kind: 'ok', text: 'Profile saved.' });
    } catch (err) {
      setProfileNotice({ kind: 'error', text: messageOf(err) });
    } finally {
      setProfileBusy(false);
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    if (newPassword !== confirmPassword) {
      setPasswordNotice({ kind: 'error', text: 'new passwords do not match' });
      return;
    }
    setPasswordBusy(true);
    setPasswordNotice(null);
    try {
      await changePassword({ currentPassword, newPassword, revokeOthers });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordNotice({
        kind: 'ok',
        text: revokeOthers
          ? 'Password changed. Every other device has been signed out.'
          : 'Password changed.',
      });
    } catch (err) {
      setPasswordNotice({ kind: 'error', text: messageOf(err) });
    } finally {
      setPasswordBusy(false);
    }
  };

  const refreshSessions = async () => {
    const list = await fetchSessions();
    setSessions(list);
    return list;
  };

  const revokeOne = async (sessionId: string) => {
    if (devicesBusy) return;
    setDevicesBusy(true);
    setDevicesNotice(null);
    try {
      await revokeSession(sessionId);
      const list = await refreshSessions();
      const row = list.find((s) => s.id === sessionId);
      setDevicesNotice({
        kind: 'ok',
        text: row?.isCurrent ? 'This device has been signed out.' : 'Session revoked.',
      });
      if (row?.isCurrent) {
        clearSession();
        window.location.reload();
      }
    } catch (err) {
      setDevicesNotice({ kind: 'error', text: messageOf(err) });
    } finally {
      setDevicesBusy(false);
    }
  };

  const revokeAllOthers = async () => {
    if (devicesBusy) return;
    setDevicesBusy(true);
    setDevicesNotice(null);
    try {
      const revoked = await revokeOtherSessions();
      await refreshSessions();
      setDevicesNotice({
        kind: 'ok',
        text:
          revoked === 0
            ? 'No other devices were signed in.'
            : `${revoked} other device${revoked === 1 ? '' : 's'} signed out.`,
      });
    } catch (err) {
      setDevicesNotice({ kind: 'error', text: messageOf(err) });
    } finally {
      setDevicesBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await logoutAccount();
    } finally {
      clearSession();
      window.location.reload();
    }
  };

  return (
    <div className="game-shell account-shell">
      <GameHeader seed={seed} title="Account" current="account" meta={meta} />

      <main className="account-panel">
        <h2 className="panel-title">The archive remembers you</h2>
        <p className="account-signed-in">
          Signed in as <strong data-testid="account-session-name">{account.name}</strong>. Your
          commander, emblem, and devices are below — the home world is already seeded, so return to
          the overview to read its state.
        </p>
        <div className="account-actions">
          <button
            type="button"
            className="account-text-button"
            data-testid="account-sign-out"
            onClick={signOut}
          >
            Sign out
          </button>
        </div>

        {loadError ? (
          <p className="account-error" role="alert">
            {loadError}
          </p>
        ) : null}

        {/* -- profile ---------------------------------------------------- */}
        <section className="cp-card" aria-labelledby="cp-profile-title">
          <h3 id="cp-profile-title" className="panel-title">
            Profile
          </h3>
          <form onSubmit={saveProfile}>
            <div className="cp-facts">
              <div className="cp-fact">
                <span className="micro-label">Username</span>
                <span data-testid="cp-account-username">{account.username}</span>
              </div>
              <div className="cp-fact">
                <span className="micro-label">Power</span>
                <span data-testid="cp-faction">{factionName}</span>
              </div>
              <div className="cp-fact">
                <span className="micro-label">Home planet</span>
                <span data-testid="cp-home-planet">{account.homePlanetId}</span>
              </div>
              <div className="cp-fact">
                <span className="micro-label">Established</span>
                <span data-testid="cp-joined">
                  {new Date(account.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>

            <label className="account-field">
              <span className="micro-label">Commander name</span>
              <input
                type="text"
                data-testid="cp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="nickname"
                maxLength={40}
              />
            </label>

            <div className="cp-emblem-title">
              <span className="micro-label">Emblem</span>
            </div>
            {emblems === null ? (
              <p className="empty-state">Loading the emblems…</p>
            ) : (
              <div className="account-symbols">
                {emblems.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    className={`account-symbol${symbolId === candidate.id ? ' is-selected' : ''}`}
                    data-testid={`cp-emblem-${candidate.id}`}
                    aria-pressed={symbolId === candidate.id}
                    aria-label={candidate.name}
                    title={candidate.name}
                    onClick={() => setSymbolId(candidate.id)}
                  >
                    <svg viewBox="0 0 48 48" aria-hidden="true">
                      <path d={candidate.path} />
                    </svg>
                    <span>{candidate.name}</span>
                  </button>
                ))}
              </div>
            )}

            {profileNotice ? (
              <NoticeView notice={profileNotice} testid="cp-profile-notice" />
            ) : null}
            <button
              type="submit"
              className="retry-button cp-save"
              data-testid="cp-profile-save"
              disabled={profileBusy || emblems === null}
            >
              {profileBusy ? 'Saving…' : 'Save profile'}
            </button>
          </form>
        </section>

        {/* -- security --------------------------------------------------- */}
        <section className="cp-card" aria-labelledby="cp-security-title">
          <h3 id="cp-security-title" className="panel-title">
            Security
          </h3>
          <form onSubmit={savePassword}>
            <label className="account-field">
              <span className="micro-label">Current password</span>
              <input
                type="password"
                data-testid="cp-current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="account-field">
              <span className="micro-label">New password</span>
              <input
                type="password"
                data-testid="cp-new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="at least 8 characters"
                required
              />
            </label>
            <label className="account-field">
              <span className="micro-label">Confirm new password</span>
              <input
                type="password"
                data-testid="cp-confirm-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="cp-check">
              <input
                type="checkbox"
                data-testid="cp-revoke-others"
                checked={revokeOthers}
                onChange={(e) => setRevokeOthers(e.target.checked)}
              />
              Sign every other device out after this change
            </label>
            {passwordNotice ? (
              <NoticeView notice={passwordNotice} testid="cp-password-notice" />
            ) : null}
            <button
              type="submit"
              className="retry-button cp-save"
              data-testid="cp-password-submit"
              disabled={passwordBusy}
            >
              {passwordBusy ? 'Changing…' : 'Change password'}
            </button>
          </form>
        </section>

        {/* -- devices ---------------------------------------------------- */}
        <section className="cp-card" aria-labelledby="cp-devices-title">
          <div className="cp-card-head">
            <h3 id="cp-devices-title" className="panel-title">
              Devices
            </h3>
            <button
              type="button"
              className="account-text-button"
              data-testid="cp-revoke-others-btn"
              disabled={devicesBusy || sessions === null}
              onClick={revokeAllOthers}
            >
              Sign out all other devices
            </button>
          </div>
          {devicesNotice ? <NoticeView notice={devicesNotice} testid="cp-devices-notice" /> : null}
          {sessions === null ? (
            <p className="empty-state">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="empty-state" data-testid="cp-sessions">
              No active sessions.
            </p>
          ) : (
            <ul className="cp-sessions" data-testid="cp-sessions">
              {sessions.map((session) => {
                const active = session.revokedAt === null && session.expiresAt > Date.now();
                return (
                  <li
                    key={session.id}
                    className={`cp-session${active ? '' : ' is-inactive'}`}
                    data-testid={`cp-session-${session.id}`}
                  >
                    <div className="cp-session-main">
                      <span className="cp-session-device">
                        {describeDevice(session.userAgent)}
                        {session.isCurrent ? (
                          <span className="cp-current-tag">this device</span>
                        ) : null}
                      </span>
                      <span className="cp-session-meta">
                        {session.ipAddress ?? 'unknown ip'} · last seen{' '}
                        {relativeTime(session.lastSeenAt)} · {describeStatus(session)}
                      </span>
                    </div>
                    {active && !session.isCurrent ? (
                      <button
                        type="button"
                        className="account-text-button"
                        data-testid={`cp-session-revoke-${session.id}`}
                        disabled={devicesBusy}
                        onClick={() => void revokeOne(session.id)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

type Notice = { kind: 'ok' | 'error'; text: string };

function NoticeView({ notice, testid }: { notice: Notice; testid: string }) {
  return (
    <p
      className={`cp-notice${notice.kind === 'error' ? ' is-error' : ''}`}
      data-testid={testid}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'request failed';
}

/** Best-effort device label from the user agent the session was created with. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Unknown browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} · ${os}`;
}

function describeStatus(session: AccountSessionView): string {
  if (session.revokedAt !== null) return 'revoked';
  if (session.expiresAt <= Date.now()) return 'expired';
  return 'active';
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

type Mode = 'register' | 'login';

function AccountForm({ sessionNotice, seed }: { sessionNotice?: string | null; seed: string }) {
  const [mode, setMode] = useState<Mode>('register');
  const [emblems, setEmblems] = useState<FactionSymbol[] | null>(null);
  const [factionsLoaded, setFactionsLoaded] = useState(false);
  const [symbolId, setSymbolId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Both catalogs are fetched so the page is ready even if one is slow;
    // the faction list also verifies the archive is reachable.
    Promise.all([fetchEmblems(), fetchFactions()])
      .then(([emblemList]) => {
        if (cancelled) return;
        setEmblems(emblemList);
        setSymbolId(emblemList[0]?.id ?? null);
        setFactionsLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'could not reach the archive');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (mode === 'register' && password !== confirm) {
      setError('passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      const response =
        mode === 'register'
          ? await registerAccount({
              username: username.trim(),
              password,
              ...(name.trim() === '' ? {} : { name: name.trim() }),
              symbolId: symbolId ?? '',
            })
          : await loginAccount({ username: username.trim(), password });
      saveSession(response);
      window.location.href = 'game.html';
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'request failed',
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="game-shell account-shell">
      <GameHeader seed={seed} title="Account" current="account" />

      <main className="account-panel">
        {sessionNotice ? (
          <p className="account-session-notice" data-testid="account-session-notice" role="status">
            {sessionNotice}
          </p>
        ) : null}
        <div className="account-tabs" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={`account-tab${mode === 'register' ? ' is-active' : ''}`}
            data-testid="account-tab-register"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
          >
            Register
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`account-tab${mode === 'login' ? ' is-active' : ''}`}
            data-testid="account-tab-login"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
          >
            Log in
          </button>
        </div>

        <form onSubmit={submit} className="account-form">
          {mode === 'register' ? (
            <>
              <section className="account-section" aria-labelledby="account-symbol-title">
                <h3 id="account-symbol-title" className="panel-title">
                  1 · Choose your emblem
                </h3>
                {emblems === null ? (
                  <p className="empty-state">Loading the emblems…</p>
                ) : (
                  <div className="account-symbols">
                    {emblems.map((emblem) => (
                      <button
                        type="button"
                        key={emblem.id}
                        className={`account-symbol${symbolId === emblem.id ? ' is-selected' : ''}`}
                        data-testid={`account-symbol-${emblem.id}`}
                        aria-pressed={symbolId === emblem.id}
                        aria-label={emblem.name}
                        title={emblem.name}
                        onClick={() => setSymbolId(emblem.id)}
                      >
                        <svg viewBox="0 0 48 48" aria-hidden="true">
                          <path d={emblem.path} />
                        </svg>
                        <span>{emblem.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="account-balance-note">
                  Your power is not a choice: the archive assigns you the least-populated faction,
                  so the galaxy stays balanced no matter how many commanders join.
                </p>
              </section>
            </>
          ) : null}

          <section className="account-section" aria-labelledby="account-credentials-title">
            <h3 id="account-credentials-title" className="panel-title">
              {mode === 'register' ? '2 · Establish identity' : 'Return to the archive'}
            </h3>
            {mode === 'register' ? (
              <label className="account-field">
                <span className="micro-label">Commander name (optional)</span>
                <input
                  type="text"
                  data-testid="account-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="What should the archive call you?"
                  autoComplete="nickname"
                  maxLength={40}
                />
              </label>
            ) : null}
            <label className="account-field">
              <span className="micro-label">Username</span>
              <input
                type="text"
                data-testid="account-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="letters, numbers, underscores"
                autoComplete="username"
                required
              />
            </label>
            <label className="account-field">
              <span className="micro-label">Password</span>
              <input
                type="password"
                data-testid="account-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'at least 8 characters' : 'your password'}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
              />
            </label>
            {mode === 'register' ? (
              <label className="account-field">
                <span className="micro-label">Confirm password</span>
                <input
                  type="password"
                  data-testid="account-confirm"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
            ) : null}
          </section>

          {error ? (
            <p className="account-error" data-testid="account-error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="retry-button account-submit"
            data-testid="account-submit"
            disabled={
              submitting ||
              (mode === 'register' && (!factionsLoaded || emblems === null || symbolId === null))
            }
          >
            {submitting
              ? 'Contacting the archive…'
              : mode === 'register'
                ? 'Establish the archive'
                : 'Return to the archive'}
          </button>
        </form>
      </main>
    </div>
  );
}
