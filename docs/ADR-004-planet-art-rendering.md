# ADR-004: Deterministic pre-rendered planet art

Status: accepted (2026-08-11)

## Context

The planet detail view needs a portrait of every planet without hand-drawn
assets. A well-known reference is `dgreenheck/threejs-procedural-planets`
(MIT): a real-time WebGL scene built from fbm noise, an elevation → color
ramp, a cloud layer, and an atmosphere rim.

## Decision

- **CPU renderer, not WebGL.** The _math_ of the reference (hash-based fbm
  value noise, elevation ramps, clouds, fresnel rim) is ported to a pure
  TypeScript rasterizer in `packages/domain` (`planet-art.ts`). No `three`,
  no WebGL, no native deps — it runs anywhere Node runs (API, CI, tests).
- **Pre-rendered static PNGs.** The API renders on first request, caches in
  memory keyed by `(planetId, ART_VERSION, size)`, and serves `image/png`
  with `Cache-Control: immutable`. The browser never renders; it just
  displays the cached bytes.
- **Everything derives from sim data.** Planet id → seeded orientation and
  noise streams (`fnv1a`); abundance drives the art: food → cloud coverage,
  metal/mineral → mountain prominence. Determinism rules from ADR-001 apply:
  integer-only lattice hashing (`Math.imul`), no `Math.random`, no wall clock
  — the same planet renders byte-identical pixels on every platform.
- **The DESIGN.md terrain gamut is the palette.** Elevation bands map to
  deep water → water → marsh → grass → forest → hill → mountain, shaded by
  elevation (×0.78–1.10) exactly as the design doc specifies.
- **Art is versioned separately from sim content.** `ART_VERSION` in
  `packages/content` (`planet-art.ts`) keys the image cache; re-tuning a
  color re-renders images without bumping `CONTENT_VERSION` (art affects no
  simulation outcome).
- **The browser caches by URL, so the client versiones the image URL.** The
  API serves PNGs with `Cache-Control: immutable`; the web client appends
  `?v=ART_VERSION` to every image request (and keys its thumbnail blob cache
  on it), so any art change busts the browser cache and stale portraits
  (e.g. a pre-starfield image) are never served after an upgrade.
- **art-2 added a deterministic starfield.** Space behind the disc is a deep-
  forest-tinted field with a hash-lattice of stars (mostly bone, rare ember
  or cool-white), derived from the planet id like everything else. The brand
  mark is stamped at the portrait's bottom-right as a CSS overlay (real
  `logo.png` on a plate) — never baked into the PNG, so The Brand Mark Rule
  (no recolor/tint/distort) holds.
- **art-3 added a per-planet nebula.** Some planets (seeded, `presenceChance`
  0.65) carry 1–3 soft dust-cloud blobs behind the disc — in-palette tints
  from the design gamut, ember rare (The Ember Seal Rule) — blended under the
  star layer so stars stay crisp. Space therefore varies per planet, not just
  star positions. The disc radius also moved into `PLANET_ART` config
  (data-driven, per the content rule) instead of a renderer constant.
- **art-4 matched the site's space retheme.** DESIGN.md moved from the
  deep-forest "Ember Archive" to the near-black "Deep Archive": the portrait
  backdrop is now the same void as the UI (`#0a0e14`), stars are star-white
  with rare ice and cool-white variants (no more ember stars), and the nebula
  tints are space neutrals (deep indigo, slate, cool grey) with ice rare (The
  Ice Seal Rule). `ART_VERSION` bumped so the `?v=` cache-bust re-renders
  every cached portrait. The planet's own clouds and atmosphere rim stay
  warm bone (`#d3c7ac`) by design — the world carries its warmth against the
  cold void, echoing the brand mark's cream accents.

## Consequences

- Planets are visually unique, deterministic, and tied to their data —
  consistent with the "every visible outcome has a causal chain" rule.
- No browser WebGL requirement and a ~150KB dependency avoided; the renderer
  is unit-testable in vitest (determinism, abundance sensitivity, disc alpha).
- Rendering cost is paid once per (planet, size, art version): ~160ms at
  512px (1× sampling) or ~540ms (2× supersampling), then cached.
- The image endpoint is bearer-authenticated like every other route; the web
  client fetches the PNG with the token and displays it via an object URL
  (an `<img src>` cannot attach the Authorization header).
