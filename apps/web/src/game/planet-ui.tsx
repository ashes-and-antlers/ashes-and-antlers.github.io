import { useEffect, useRef, useState } from 'react';
import type { PlanetView, PlanetWarning, ResourceKey } from '@ashes/contracts';
import { ART_VERSION } from '@ashes/content';
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

export function AbundanceBar({ planet }: { planet: PlanetView }) {
  return (
    <div className="abundance" aria-label="planet abundance">
      {RESOURCE_NAMES.map(([key, label]) => (
        <div className="abundance-row" key={key}>
          <span className="abundance-label">{label}</span>
          <div className="abundance-track" role="meter" aria-valuenow={planet.abundance[key]}>
            <div className="abundance-fill" style={{ width: `${planet.abundance[key]}%` }} />
          </div>
          <span className="abundance-value">{planet.abundance[key]}</span>
        </div>
      ))}
    </div>
  );
}
