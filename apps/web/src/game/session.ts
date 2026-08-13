import type { AccountView } from '@ashes/contracts';

/**
 * The browser's session: the bearer token issued at register/login plus the
 * public account view. Stored in localStorage so every game page (overview,
 * map, planet, glossary) authenticates as the same commander.
 */
export type Session = {
  token: string;
  account: AccountView;
};

const KEY = 'ashes.session.v1';

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (
      typeof parsed?.token !== 'string' ||
      typeof parsed?.account?.worldId !== 'string' ||
      typeof parsed?.account?.playerId !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}

/**
 * The world the browser plays: the session's world when signed in, else the
 * seed-derived dev world (the seeded M0 overview keeps working without an
 * account).
 */
export function sessionWorldId(seed: string): string {
  return getSession()?.account.worldId ?? `world:${seed}`;
}
