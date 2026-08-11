# Ashes and Antlers

A single-player, browser-native 2D grand colony/RTS in which **two autonomous
civilizations** inhabit the same procedurally generated world, compete for
finite resources, adapt to pressure, wage logistics-driven war, and ultimately
achieve dominance. Working title only — the full design lives in
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md).

> **Current state: landing page only.** The M1/M2 game implementation was
> scrapped on 2026-08-11 for a fresh start (recoverable from git history at
> commit `86e838f` and earlier). Only the landing page ships right now; the
> game will be rebuilt per the plan. The landing page's "Enter the world"
> action currently points at `game.html`, which does not exist yet.

## Quickstart

```bash
npm install
npm run dev            # dev server (Vite)
npm run build          # typecheck + production build to dist/
npm run preview        # serve the production build
```

Open the dev server URL to see the landing page: the brand mark centered as
the cover, the premise, the two peoples, and the single Enter the world
action.

## Quality gates

```bash
npm run lint          # ESLint (typescript-eslint, flat config)
npm run typecheck     # tsc strict for src/tests and config files
npm run format:check  # Prettier
npm run test          # Vitest (passes with no test files for now)
npm run build         # typecheck + production build
npm run test:e2e      # Playwright smoke test for the landing page
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR,
including `npx playwright install --with-deps chromium`.

## Layout (current)

```
index.html             landing page (public entry)
src/app/
  landing.ts           scroll reveals + the burning field (ash/sparks)
  landing.css          landing styles incl. inlined Cinzel
  style.css            shared base tokens + component styles
public/
  logo.png             the brand mark (palette source of truth)
  favicon.png
tests/e2e/
  landing.spec.ts      the surviving browser smoke test
docs/
  ADR-001-worker-ownership-and-determinism.md   design contract for the rebuild
```

## Roadmap

Milestones 0–6 are defined in [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) §6.
Per the 2026-08-11 direction change, the rebuild centers on strategic
competition and war: dominance scoring, victory conditions, and the
hierarchical enemy AI.
