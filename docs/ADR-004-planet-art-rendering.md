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
