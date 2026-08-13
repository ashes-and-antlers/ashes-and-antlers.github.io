import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlanetWarning, ResourceKey } from '@ashes/contracts';
import { ART_VERSION, PLANET_CLASSES, type PlanetClassKey } from '@ashes/content';
import { fetchPlanetImage } from './api';

/** Thumbnail render size; the API caches per (world, planet, art, size). */
export const PLANET_THUMB_SIZE = 64;

/**
 * Full-size portrait render — shared by the planet detail page and the
 * overview home card, so both show the same asset (cache keys include size).
 */
export const PLANET_PORTRAIT_SIZE = 512;

/**
 * In-flight and settled thumbnail blobs, keyed by world+planet+size, so the
 * overview's 2s poll never re-fetches a thumbnail it already has. The blob is
 * immutable for a given (planet, ART_VERSION), so caching across polls is safe.
 * Failed fetches are evicted (never cached), so a later mount retries.
 */
const thumbCache = new Map<string, Promise<Blob>>();
const THUMB_CACHE_LIMIT = 128;

function cacheThumb(key: string, pending: Promise<Blob>): Promise<Blob> {
  thumbCache.set(key, pending);
  // Simple cap: evict the oldest entry (Map preserves insertion order).
  if (thumbCache.size > THUMB_CACHE_LIMIT) {
    const oldest = thumbCache.keys().next().value as string;
    thumbCache.delete(oldest);
  }
  // Never cache a rejection: a transient failure (API restart, offline
  // window) must not permanently blank a thumbnail.
  pending.catch(() => {
    thumbCache.delete(key);
  });
  return pending;
}

/**
 * Small planet portrait for table rows. Fetches with the bearer token (an
 * <img src> cannot attach it) and exposes the result as a revocable object
 * URL; the caller owns the URL and must revoke it.
 */
export function PlanetThumb({
  worldId,
  planetId,
  name,
  size = PLANET_THUMB_SIZE,
  className,
  priority = false,
}: {
  worldId: string;
  planetId: string;
  name: string;
  size?: number;
  className?: string;
  /** Eager-load (hero portraits above the fold); default lazy. */
  priority?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let stale = false;
    // The art version is part of the key so a starfield/palette change never
    // returns a stale cached blob.
    const key = `${worldId}:${planetId}:${size}:${ART_VERSION}`;
    let pending = thumbCache.get(key);
    if (!pending) {
      pending = cacheThumb(key, fetchPlanetImage(worldId, planetId, size));
    }
    void pending
      .then((blob) => {
        if (stale) return;
        const next = URL.createObjectURL(blob);
        if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
      })
      .catch(() => {
        // Portrait failure is non-fatal: the row still renders.
      });
    return () => {
      stale = true;
      if (urlRef.current !== null) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [worldId, planetId, size]);

  const cls = ['planet-thumb', className].filter(Boolean).join(' ');
  if (url === null) {
    return <span className={`${cls} planet-thumb-empty`} aria-hidden="true" />;
  }
  return (
    <img
      className={cls}
      data-testid={`planet-thumb-${planetId}`}
      src={url}
      alt={`Portrait of ${name}`}
      width={size}
      height={size}
      loading={priority ? 'eager' : 'lazy'}
    />
  );
}

export const RESOURCE_NAMES: Array<[ResourceKey, string]> = [
  ['metal', 'Metal'],
  ['mineral', 'Mineral'],
  ['food', 'Food'],
  ['energy', 'Energy'],
];

/**
 * Planet class → dot/legend color on the map, and its display name. The
 * single source of truth is PLANET_CLASSES in @ashes/content (which also
 * drives the art renderer), so adding a class can never drift the UI.
 * Presentation only: these tint the map, never the simulation.
 */
const CLASS_BY_KEY: Record<PlanetClassKey, { name: string; color: string }> = Object.fromEntries(
  PLANET_CLASSES.map((c) => [c.key, { name: c.name, color: c.mapColor }]),
) as Record<PlanetClassKey, { name: string; color: string }>;

export function planetClassName(classId: PlanetClassKey): string {
  return CLASS_BY_KEY[classId]?.name ?? classId;
}

export function planetClassColor(classId: PlanetClassKey): string {
  return CLASS_BY_KEY[classId]?.color ?? '#93a2b8';
}

/**
 * One-click explainer for a ledger section: a compact 'What is this?'
 * disclosure that expands inline. Native <details>/<summary> keeps it
 * keyboard-accessible and works without JS state, so the fold survives
 * the 2s overview poll re-renders.
 */
export function SectionHelp({ id, children }: { id: string; children: ReactNode }) {
  return (
    <details className="section-help" data-testid={`section-help-${id}`}>
      <summary>
        <span className="section-help-label">What is this?</span>
        <span className="fold-chevron" aria-hidden="true" />
      </summary>
      <div className="section-help-body">{children}</div>
    </details>
  );
}

const WARNING_LABELS: Record<PlanetWarning, string> = {
  storage_full: 'Storage full',
  food_deficit: 'Food deficit',
  energy_deficit: 'Energy deficit',
};

export function WarningsChips({ warnings }: { warnings: PlanetWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="warning-chips" aria-label="planet warnings">
      {warnings.map((w) => (
        <li key={w} className={`warning-chip warning-${w}`}>
          {WARNING_LABELS[w]}
        </li>
      ))}
    </ul>
  );
}
