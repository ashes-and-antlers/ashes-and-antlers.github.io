# AGENTS.md — Ashes and Antlers (Civilizations at War)

Guidance for AI coding agents and human contributors working in this repository.
Read this before editing anything.

**If you only read two documents, read:** this file and
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) (the full design, which is the
source of truth for what the game will become).

---

## 1. Current state (2026-08-11)

**The game has been scrapped. Only the landing page remains.**

The player-facing M1/M2 implementation (worldgen, simulation worker, ECS,
task market, construction, economy, seasons) was deleted in one go on
2026-08-11 so the project could restart from a clean slate. The scrapped code
is recoverable from git history (it was fully committed at `86e838f` and
earlier); do not treat those files as authoritative, but they are a useful
reference for the rebuild.

What remains is the public entry only:

- `index.html` + `src/app/landing.ts` + `src/app/landing.css` + the shared
  base stylesheet `src/app/style.css` — the landing page: brand mark cover,
  premise entries, the two peoples, the rules of the archive, and the single
  "Enter the world" action.
- `public/` — the brand mark (`logo.png`), favicon, `.nojekyll`.
- `tests/e2e/landing.spec.ts` — the one surviving Playwright smoke test.
- Infra: Vite, strict TypeScript, ESLint 9 flat, Prettier, Vitest,
  Playwright, the CI/deploy workflows, and the design docs (`DESIGN.md`,
  `PRODUCT.md`, `DEVELOPMENT_PLAN.md`, `docs/ADR-001`).

There is **no `game.html`** and **no simulation code** right now. The landing
page's "Enter the world" action still links to `game.html?seed=1337`, which
currently 404s until the game is rebuilt. Do not rebuild the game without
explicit direction.

## 2. Landing page facts

- The brand mark (`public/logo.png`) is the cover and carries the wordmark;
  it must never be recolored, tinted, or distorted, and the name is never
  re-typed beside it (see DESIGN.md "The Brand Mark Rule").
- The landing page holds **no simulation state at all**; it links to the game
  page (which owns the worker) with the default seed `1337`.
- `data-testid` hooks for e2e: `landing-title`, `enter-link`.
- `prefers-reduced-motion` is honored; keyboard focus is visible.
- Surfaces are solid and opaque per the "Flat Ledger Rule" — no translucency
  or backdrop blur on new surfaces.

## 3. Commands and quality gates

```bash
npm install                 # install dependencies
npm run dev                 # Vite dev server
npm run build               # typecheck + production build → dist/
npm run preview             # serve dist/ at http://localhost:4173

npm run typecheck           # tsc -p tsconfig.json && tsc -p tsconfig.node.json
npm run lint                # eslint .
npm run format              # prettier --write .
npm run format:check        # prettier --check .
npm run test                # vitest run (currently passes with no test files)
npm run test:e2e            # Playwright (requires a build; webServer auto-starts preview)
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → format:check → test →
build → `npx playwright install --with-deps chromium` → e2e on every push/PR.
Anything that passes locally must pass that pipeline.

## 4. Engineering constraints that carry into the rebuild

These commitments come from `DEVELOPMENT_PLAN.md` §5 and
`docs/ADR-001-worker-ownership-and-determinism.md`. They will be enforced
again when the game is rebuilt:

1. **The Web Worker owns all authoritative simulation state.** The main
   thread (DOM, input, rendering) only reads snapshots and sends validated
   commands; it must never import from `sim/` and mutate simulation objects.
2. **No `Math.random()` anywhere in `sim/`.** All randomness flows through
   seeded PRNG streams (mulberry32 + FNV-1a, named streams per concern).
3. **Fixed ticks only.** `FixedClock` runs 5 ticks/second at 1×; systems
   never read wall-clock time or `deltaTime`. Pause discards time; speed is a
   pure multiplier; catch-up is capped per frame.
4. **Stable iteration order.** Authoritative systems iterate entities in
   ascending entity id and break ties with explicit stable keys.
5. **Content is data-driven.** Balance lives in config/definitions files;
   never hard-code tunable numbers in systems.
6. **Version everything.** `WORLD_VERSION` (worldgen semantics) and
   `PROTOCOL_VERSION` (worker protocol) gate every handshake; mismatch is a
   hard error.
7. **Renderer/UI state is derived.** Never store authoritative sim data on
   the main thread; rebuild render layers from each snapshot.

## 5. Common pitfalls (learned the hard way)

- **Cold-boot e2e flake:** tests that interact with the game right after
  `goto` race worker boot. Use a `workerReady(page)` helper first.
- **Transferable detach:** never `postMessage(transfer: [buffer])` a buffer
  the worker still needs; copy with `.slice()` first.
- **Silent typed-array clamping:** out-of-bounds writes don't throw; guard
  entity creation with `MAX_ENTITIES` and initialize every field on spawn.
- **`import type` is mandatory** for type-only imports (`verbatimModuleSyntax`).
- **Content vs. code:** tuning a number goes in the config, never inline.

## 6. Working agreement for agents

- Work in **small, vertically integrated changes**: inspect existing code →
  state the plan → modify the smallest coherent surface → run targeted tests
  plus full gates → report changed files, behavior, tests, risks.
- Never begin broad work by generating dozens of empty abstractions; prefer a
  thin end-to-end slice with real tests, then generalize on second use.
- Keep commits narrow and conventional: `feat(sim):`, `fix(logistics):`,
  `test(ai):`, `refactor(render):`, `docs:`.

**Definition of done** (all six): accessible in the running browser build;
has a deterministic test or reproducible scenario for its primary success
path; handles at least one failure/edge path visibly; is inspectable through
debug UI/logs if it affects autonomous behavior; does not regress lint,
typecheck, unit, scenario, or browser smoke tests; documentation updated for
public data schemas or architectural changes.

## 7. Next steps

The full design and roadmap (milestones 0–6) live in
`DEVELOPMENT_PLAN.md` §6. The rebuild direction (per the 2026-08-11 plan
update) centers on strategic competition and war: dominance scoring, victory
conditions, and the hierarchical enemy AI. Do not start rebuilding without
explicit direction on the first slice.
