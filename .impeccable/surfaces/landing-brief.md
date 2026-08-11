# Surface Brief — Landing page (index.html)

## Scope and mode

Whole-page landing surface, **Persuade** mode, inside the committed Deep
Archive world (DESIGN.md). Structure: The Sequence (concept seed `dc472b5a`,
candidate 5) — the premise unfolds as a series of ledger entries, scroll by
scroll.

## Audience, job, action

A prospective player arriving at the game's public entry. Job: understand the
premise — two autonomous civilizations, one deterministic world — and decide
whether to enter. Action: Enter the world (default seed `1337`) from the
action beneath the mark.

## Proof and content

- **The brand mark is the cover**: the logo carries the wordmark, is centered
  on the near-black space field — no frame, no tag, no re-typed title — and
  the primary Enter the world action sits directly beneath it.
- No nav, no seed controls, no map previews on this page (removed by
  direction); the game page owns worlds and seeds.
- Copy grounded in PRODUCT.md / DEVELOPMENT_PLAN.md: premise, the two
  factions, the four rules of the archive.
- No fabricated claims: no reviews, pricing, dates, or monetization.

## Constraints

- The game boots unchanged on its own page (`game.html`); the landing page
  holds no simulation state at all — the enter action links to the game page
  with the default seed, and the game page owns the worker (worker ownership
  - determinism contract).
- Flattened surfaces (Flat Ledger Rule): solid plates, no translucency or
  blur; ember ≤10% of any surface; faction hues only for faction meaning;
  mono only for data (numerals).
- `data-testid` hooks for e2e: `landing-title`, `enter-link`.
- `prefers-reduced-motion` honored; keyboard focus visible.

## Chosen direction and memorable moment

The archive's cover — near-black space field with a cold nebula and a
scatter of twinkling stars behind it. The logo is the cover: displayed at
clamp(300px, 38vw, 520px) dead-center in a full-viewport hero — no frame,
no tag — carrying the wordmark, with the ice Enter the world action
directly beneath it and the scroll cue anchored to the hero's bottom edge.
No nav. Every entry shares the page's central axis: centered headings and
prose, cards and rules in centered columns, tightened so the whole page
reads in a few scrolls. Memorable moment: the centered mark floating in
the void with one action — enter and the world begins.

## Unresolved decisions

- Final game title (working title "Ashes and Antlers" is a placeholder).
- Whether the landing page later grows marketing sections (release notes,
  media) — planned, not built.
- Whether Inter (declared in the font stack but never loaded) is ever
  shipped or removed from the stack.
