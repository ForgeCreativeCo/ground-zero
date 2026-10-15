# GROUND ZERO — Claude Code guide

`DESIGN.md` is the single source of truth. Read it before any work. This file is its condensed non-negotiables.

## What this is

A third-person open-city destruction sandbox in the browser. One player (the author), personal project. Mature content (blood, gore, dismemberment, civilian casualties) is intentional and requested. Implement it fully as specified.

## Workflow rules

- **Build in milestones** (DESIGN.md §15). Finish one, verify it (below), then **stop** and give the user: a short summary, how to run it, and a playtest checklist of 5–10 items. Do not start the next milestone until the user has played and responded.
- **The game must run at the end of every milestone.** No half-wired systems.
- **Feel and performance beat feature count.** If something can't meet the budget, build a cheaper version and log it.
- **Log every judgment call** the spec doesn't cover in `docs/DECISIONS.md` (one line of reasoning each). Never silently drop or weaken a requirement: log it and tell the user.
- **When ambiguous:** pick what makes destruction feel more real and powers feel more godlike, then log it.
- **Verify library APIs** against the installed packages in `node_modules` (three.js, Rapier, Tweakpane change between versions). Don't rely on memory.

## Stack

- TypeScript (strict), Vite, three.js (`WebGPURenderer` from `three/webgpu`, TSL post-processing via `RenderPipeline`; falls back to WebGL2 automatically).
- Rapier physics: `@dimforge/rapier3d-compat` (`await RAPIER.init()`).
- Tweakpane 4 (debug panel). Vitest (unit). Playwright (smoke + perf, uses the installed Chrome via `channel: 'chrome'`). ESLint (flat config) + Prettier.
- Later milestones: `recast-navigation`, `three-bvh-csg`, `@gltf-transform` + meshoptimizer.
- TypeScript is pinned to 6.0.x because `typescript-eslint` doesn't support TS 7 yet.

## Folder structure

```
CLAUDE.md  DESIGN.md  docs/DECISIONS.md
assets-src/      raw downloads (Mixamo FBX, audio), not shipped
public/assets/   processed GLB, KTX2, audio
scripts/         asset pipeline, perf tooling
src/
  config/        ALL tunables (+ slider ranges in each file's `meta`)
  core/          loop, time, input, events, pools, rng, stats, workers
  render/        renderer, post, environment (sky/sun), LOD, decals, shaders
  physics/       Rapier setup, layers, queries, body sync
  world/         city generation, streets, props, traffic graph, time of day
  destruction/   pieces, damage, fracture, structural graph, debris, fire
  interiors/     unit generation, furnishing, spawn/despawn
  player/        controller, flight states, camera, animation
  powers/        strength, heat vision, freeze, slam, sonic, nova
  npc/           civilians, crowds, nav, panic, ragdoll, gore
  response/      heat, police, SWAT, guard, military, HALT
  vehicles/
  fx/            particles, dust, smoke, fire, blood, shockwaves, mushroom cloud
  audio/
  ui/            HUD, debug panel, perf HUD, spawn menu, photo mode, settings
tests/unit/      Vitest
tests/e2e/       Playwright smoke + perf
```

## Coding conventions

- **No hardcoded tunables.** Every number a designer might tune goes in `src/config/` and appears in the debug panel (F1). Add a `meta` entry (min/max/step) for slider ranges. Values that only apply on restart get `reload: true`.
- Systems read config live each frame where cheap, so panel tweaks apply instantly.
- **Fixed-timestep simulation at 60 Hz** (`core/loop.ts`) with interpolated rendering. Gameplay/physics logic runs in `fixedUpdate(dt)`; rendering/camera look in `frameUpdate(dt, alpha)`.
- **Event bus** (`core/events.ts`) for game events (damage, death, collapse, heat, Nova…). Audio, FX, HUD and response subscribe; don't couple systems directly.
- **No GC churn in hot loops:** preallocate vectors/quaternions at module scope, use pools (`core/pool.ts`) and typed arrays (structure of arrays for piece data).
- Deterministic generation from the seed (`?seed=1234`) via `core/rng.ts`. Never `Math.random()` in world generation.
- Spread heavy work across frames; move to Web Workers if it spikes.
- Pure logic (math, graphs, heat, damage) is kept free of three/DOM so it can be unit-tested.
- **Destruction performance rules** (measured in M2, see docs/DECISIONS.md): never give each building piece its own Rapier collider (every static collider costs per step); use the merged colliders in `destruction/buildingColliders.ts`. Untouched buildings draw as proxies (`render/buildingProxies.ts`) until first damage. Anything new that draws or casts shadows must be registered with the background shader warm-up (`render/shaderWarmup.ts`), or its first appearance stalls mid-play.
- **three.js shader rules** (measured in M3): never create an `InstancedMesh` mid-play (three.js builds shader code per instanced mesh, 100–300 ms each); create it up front and reuse it. Share one material per family and pick the look with a per-instance attribute. In TSL, evaluate shared nodes such as `normalWorld` at the top of a `Fn`, before any `If`/`select`: a node first built inside a branch is left unset outside it (surfaces render black).
- Test hooks live on `window.__GZ__` (see `src/core/testHooks.ts`); Playwright drives the game through them.

## Performance budgets (DESIGN.md §13; tunable in `src/config/budgets.ts`, enforced at runtime)

60 fps at 1080p on an RTX 3060-class / 6-core desktop in Chrome; never below 30 fps during a Nova.

| Resource                    | Budget  |
| --------------------------- | ------- |
| Active dynamic rigid bodies | 800     |
| Active ragdolls             | 30      |
| LOD0 characters             | 40      |
| Decals                      | 600     |
| Particles                   | 60,000  |
| Shadow-casting lights       | 4       |
| Non-shadow dynamic lights   | 32      |
| Draw calls (typical)        | < 1,000 |

Required: instancing/merging, LOD, culling, physics sleeping, debris→static rubble, object pools, frame-spread work.

Note: the dev machine (i5-8365U laptop, Intel UHD 620) is far below the reference hardware. Perf numbers measured here are pessimistic; report them with that caveat.

## Never do (DESIGN.md §16)

- Blocky, boxy or faceted humans — **including placeholders** (use smooth capsules/spheres).
- Respawn or reset damaged buildings during a session (only an explicit "reset city").
- Despawn visible debris or rubble (only particles and tiny fragments may fade).
- Invisible walls inside the city, or a player who can get stuck in geometry.
- Spawn units or civilians in the player's view.
- Loading screens or hitches during play.
- Hardcoded tunables.
- Copy any existing comic character's name, costume, emblem or signature weakness.
- Silently drop or weaken a requirement.

## Run and verify

```bash
npm install
npm run dev          # http://localhost:5173  (?seed=1234 for a specific city)
npm test             # Vitest unit tests
npm run smoke        # Playwright: load, fly scripted path, screenshots -> test-results/
npm run perf         # Playwright: scripted perf path at 1080p; logs avg/p95/CPU ms + peaks; fails over budget
                     # (defaults = Low preset; PERF_QUALITY=high for High; results in test-results/perf.json)
npm run verify       # typecheck + lint + unit + smoke + perf
```

Every milestone: `npm run dev` with no console errors, `npm test` passes, smoke test passes and **look at the screenshots in `test-results/` yourself**, perf run numbers reported to the user.

## In-game keys (debug)

F1 or \` debug panel · F2 perf HUD · click to capture mouse · Esc releases. Full control map: DESIGN.md §4 and `src/config/controls.ts`.
