import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { symbolById } from '@ashes/content';
import { fetchOverview } from './api';
import { getSession } from './session';

/** mm:ss until the next tick resolves. */
export function formatCountdown(nextTickAt: number, now: number): string {
  const secondsLeft = Math.max(0, Math.ceil((nextTickAt - now) / 1000));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The live archive readout every page header shows: commander, tick, countdown. */
export type WorldMeta = { name: string; tick: number; nextTickAt: number };

/**
 * Polls the overview projection for the header's live readout. Stops polling
 * after repeated failures, matching the overview's offline behavior.
 */
export function useWorldMeta(worldId: string): WorldMeta | null {
  const [meta, setMeta] = useState<WorldMeta | null>(null);
  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    let failures = 0;
    const load = async () => {
      try {
        const view = await fetchOverview(worldId);
        if (cancelled) return;
        failures = 0;
        stopped = false;
        setMeta({ name: view.player.name, tick: view.tick, nextTickAt: view.nextTickAt });
      } catch {
        if (cancelled) return;
        failures += 1;
        if (failures >= 3) stopped = true;
      }
    };
    void load();
    const id = setInterval(() => {
      if (!stopped) void load();
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [worldId]);
  return meta;
}

/**
 * The live archive readout rendered in every page's header: the commander's
 * name, the current tick, and the countdown to the next beat.
 */
export function HeaderMeta({ meta }: { meta: WorldMeta }) {
  const now = useNow();
  return (
    <>
      <div className="meta-item">
        <dt title="Your name in the archive.">Commander</dt>
        <dd className="commander-name" data-testid="commander-name" title={meta.name}>
          {meta.name}
        </dd>
      </div>
      <div className="meta-item meta-divider">
        <dt title="Ticks are fixed beats of the simulation — the world advances one step per tick.">
          Current tick
        </dt>
        <dd className="tick-value" data-testid="overview-tick">
          {meta.tick}
        </dd>
      </div>
      <div className="meta-item">
        <dt title="Countdown to the next beat of the simulation.">Next tick</dt>
        <dd className="tick-value" data-testid="next-tick-countdown">
          {formatCountdown(meta.nextTickAt, now)}
        </dd>
      </div>
    </>
  );
}

/**
 * The archive's shared header bar: brand lockup on the left, page-specific
 * meta readouts and the primary navigation on the right. Every view (command
 * overview, galaxy map, planetary ledger, glossary) renders the same bar with
 * its own title and current-view highlight, so navigation works identically
 * everywhere. Seeds are preserved on every link.
 */
export function GameHeader({
  seed,
  title,
  current,
  meta,
  className,
}: {
  seed: string;
  title: string;
  /** Which view is open; highlighted in the nav (detail pages pass none). */
  current:
    | 'overview'
    | 'constructions'
    | 'map'
    | 'research'
    | 'fleets'
    | 'scans'
    | 'planet'
    | 'glossary'
    | 'account';
  /** Page-specific readouts rendered inside the meta dl (commander, tick, counts). */
  meta?: ReactNode;
  className?: string;
}) {
  const links: Array<{
    view:
      | 'overview'
      | 'constructions'
      | 'map'
      | 'research'
      | 'fleets'
      | 'scans'
      | 'glossary'
      | 'account';
    testid: string;
    label: string;
    href: string;
    title: string;
    /** Game flow vs. reference/meta surface; rendered behind a divider. */
    secondary?: boolean;
  }> = [
    {
      view: 'overview',
      testid: 'nav-overview',
      label: 'Overview',
      href: `game.html?seed=${seed}`,
      title: 'Orders pending, recent completions, and the known planets',
    },
    {
      view: 'constructions',
      testid: 'nav-constructions',
      label: 'Constructions',
      href: `constructions.html?seed=${seed}`,
      title: 'Raise buildings and build ships on every owned world',
    },
    {
      view: 'map',
      testid: 'nav-map',
      label: 'Galaxy map',
      href: `map.html?seed=${seed}`,
      title: 'The chart of every galaxy, sector, system, and world',
    },
    {
      view: 'research',
      testid: 'nav-research',
      label: 'Research',
      href: `research.html?seed=${seed}`,
      title: 'The account-wide technology queue and tree',
    },
    {
      view: 'fleets',
      testid: 'nav-fleets',
      label: 'Fleets',
      href: `fleets.html?seed=${seed}`,
      title: 'Your fleets: split detachments and transfer ships and cargo',
    },
    {
      view: 'scans',
      testid: 'nav-scans',
      label: 'Scans',
      href: `scans.html?seed=${seed}`,
      title: 'Run scan missions and read the intelligence archive',
    },
    {
      view: 'glossary',
      testid: 'nav-glossary',
      label: 'Glossary',
      href: `glossary.html?seed=${seed}`,
      title: "The archive's vocabulary in one place",
      secondary: true,
    },
    {
      // The commander's control panel (account.html): the profile, security,
      // and devices surfaces. Always reachable — without a session it is the
      // register/login door, and with one it opens the panel.
      view: 'account',
      testid: 'nav-account',
      label: 'Account',
      href: 'account.html',
      title: 'The commander control panel — profile, security, sessions',
      secondary: true,
    },
  ];

  // The commander's chosen emblem (from the signed-in account) rides beside
  // the brand mark; without a session the bar keeps the plain pulse dot.
  const session = getSession();
  const emblem = session ? symbolById(session.account.symbolId) : undefined;

  return (
    <header className={`game-header${className ? ` ${className}` : ''}`}>
      <div className="brand-lockup">
        {emblem ? (
          <svg className="brand-emblem" viewBox="0 0 48 48" aria-hidden="true">
            <path d={emblem.path} />
          </svg>
        ) : null}
        <span className="brand-dot" aria-hidden="true" />
        <h1 className="brand-word">{title}</h1>
      </div>
      <div className="header-right">
        {meta ? <dl className="header-meta">{meta}</dl> : null}
        <nav className="header-nav" aria-label="Archive views">
          {links.map((link, index) => (
            <Fragment key={link.view}>
              {link.secondary && index > 0 && !links[index - 1].secondary ? (
                <span className="nav-sep" aria-hidden="true" />
              ) : null}
              <a
                className={`header-nav-link${current === link.view ? ' is-current' : ''}${
                  link.secondary ? ' is-secondary' : ''
                }`}
                data-testid={link.testid}
                href={link.href}
                title={link.title}
                aria-current={current === link.view ? 'page' : undefined}
              >
                {link.label}
              </a>
            </Fragment>
          ))}
        </nav>
      </div>
    </header>
  );
}
