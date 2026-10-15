# Decisions log

Judgment calls the spec doesn't cover, one line of reasoning each. Newest at the bottom of each milestone.

## M0: Foundation

- **Renderer: three.js `WebGPURenderer` (r186) with TSL `RenderPipeline` post-processing.** It's the maintained path in current three.js, falls back to WebGL2 automatically, and ships bloom/GTAO/DoF/motion blur nodes we need later (§12).
- **TypeScript pinned to 6.0.x**, not 7.0: `typescript-eslint` 8.71 only supports TS < 6.1.
- **Rapier `@dimforge/rapier3d-compat` 0.21** (wasm embedded, no Vite plugin needed); initialised with `await RAPIER.init()` (current signature, verified in `init.d.ts`).
- **Tweakpane 4** over lil-gui: better typed, folders, monitors and buttons.
- **Playwright uses the installed Chrome (`channel: 'chrome'`) with GPU flags** instead of downloading Playwright's Chromium, so the perf run uses the real GPU rather than SwiftShader.
- **Descend is bound to Ctrl _and_ C.** Ctrl+W closes the browser tab and can't be blocked outside fullscreen; C is a safe alternate. Fullscreen (debug panel button) requests Keyboard Lock so Ctrl+W/Esc get captured there.
- **Debug panel opens with F1 or backtick.** F1 is Chrome's help key; we `preventDefault` it, but backtick is a fallback in case a browser won't release it.
- **Perf HUD toggles with F2 and is visible by default** ("always available", §13).
- **Debug panel tweaks persist in `localStorage`** (with "reset to defaults" and "copy changed values" buttons) so tuning survives reloads and can be pasted back into `src/config/`.
- **Config slider ranges live beside the values** as a `meta` map keyed by dotted path; values stay plain objects so game code reads `config.sun.elevationDeg` directly.
- **Restart-only settings** (MSAA samples, shadow map size, cascade count) are marked `reload` in meta and take effect after a reload.
- **M0 camera is a free-fly debug camera** using the real input pipeline (WASD/Space/Ctrl/Shift, mouse, gamepad). The player character arrives in M1.
- **Scale-reference pillars (10/50/100/200 m) on the ground plane.** An empty plane gives no sense of speed or shadow quality; these are trivially removable and help tune M1 flight.
- **"Spawn test bodies" debug button** drops Rapier rigid bodies in front of the camera so physics, interpolation, sleeping and the active-body counter can be checked before destruction exists.
- **Smoke test can't "punch a wall" in M0** (no player or buildings yet). It flies a scripted camera path, spawns physics bodies and screenshots instead; the punch step gets added in M2.
- **Test hooks on `window.__GZ__`** are always present (not stripped in production): it's a single-player personal project and the perf runner needs them.
- **Environment lighting = PMREM of the sky**, regenerated when the sun moves (throttled). Cheap, keeps PBR consistent with the sky, and sets up the day/night cycle.
- **Shadow camera far plane set explicitly** (sun distance + light margin + max far). three's default 500 m silently produced no shadows at all with CSM.
- **Sun and its shadow follow the camera**, snapped to whole metres to avoid shimmer, so shadows work anywhere in the city (not just near the origin).
- **`render.shadows.cascaded` toggle** (default on, per §12): off uses one camera-following shadow map, a cheaper option for weak GPUs.
- **Sky IBL at 0.15, bloom threshold 8 (HDR luminance).** At IBL 0.6 and threshold 0.9 the bright HDR sky lit and bloomed everything into a white haze. Bloom now only catches hot emissives (beams, fire, the Nova) and gets tuned again when those exist.
- **Stopgap Quality High/Low buttons in the debug panel.** The dev laptop (Intel UHD 620) is far below the RTX 3060 reference. Full quality presets stay in M11; these two buttons just toggle MSAA, bloom, shadow resolution/cascades and pixel ratio.
- **The perf HUD and perf run report CPU ms per frame** next to frame time, so we can tell GPU-bound from simulation-bound. On WebGPU, CPU time includes waiting on a saturated GPU.
- **Perf budgets stay at the reference-hardware values** (16.7 ms avg, 25 ms p95). `npm run perf` therefore fails on the dev laptop; that's a true statement about this machine, not a bug. `PERF_QUALITY=low npm run perf` measures the low preset.
- **HUD frame stats skip the first 10 frames** (shader compilation) so the average reflects play rather than startup.

## M1: Flight and camera

- **Low quality is now the default** (no MSAA, no bloom, 2 × 1024 shadow cascades, pixel ratio 1), at the user's request: they play on this laptop and High runs warm. High stays one click away in the debug panel.
- **Shift is "run" on the ground and "boost" in the air.** The spec gives walk 6 / run 14 but no run key; reusing boost keeps the controls to the spec's table.
- **Leap and take-off share Space.** Tap = hop, hold = charge a leap (full charge ≈ 86 m apex, clears the mid-rises), and pressing Space again while airborne takes off. A ground double-tap is therefore "hop + take off", which feels the same as the spec's double-tap and needs no extra timing window.
- **Hover → cruise is automatic.** The spec has hover (20) and cruise (50) bands but one fly input; holding a direction for 0.5 s ramps from hover to cruise over 2 s, and Shift boosts. Letting go stops dead in hover and brakes with momentum above it.
- **Flight follows the camera.** Forward is where the camera looks (pitch included), so diving is "look down and push forward". This is the standard superhero-game scheme and keeps the mouse as the one steering input.
- **Rapier kinematic character controller** with collision substeps capped at 0.35 m per substep (up to 16), so at 160 m/s he can't tunnel. It requires the hero's capsule to sit on a kinematic body; a parentless collider sank through the ground.
- **Ground and highway colliders are tiled** (500 m ground slabs, 40 m deck spans). The controller loses precision against a single 4 km cuboid and the hero sank through it; verified in a standalone Node repro.
- **Never-stuck rule:** if his centre ends up inside geometry, or he's been blocked in the air for 20 steps and can't rise, he is lifted to the surface above. Walking into walls doesn't count.
- **Sonic speed collides like any other speed for now.** Going straight through buildings at sonic speed is §7.7, scheduled for M4; until then a sonic hit is a slam with bounce. Facade cracks and holes from slams arrive with destructible buildings in M2.
- **Debug test bodies don't block the hero.** Knocking debris aside properly is M2's job; until then they're excluded from his sweep so a pile can never wedge him.
- **Chase camera rises in fast flight** (pivot 1.6 m → 2.7 m) and sits closer (5.6 m cruise, 7 m boost). From a level camera a horizontal flyer is seen end-on, soles first, and shrinks to a speck.
- **Sonic boom = shock collar + air ring + dust.** A ring that forms around him and rides along for 0.3 s (so the chase camera sees it), a 90 m ring left in the air, a vapor-cone flash, FOV kick, heavy shake and a synthesized double crack. Window shattering and knocking people down are emitted as `player:sonicBoom` events for M2/M5 to consume.
- **Hard landings: crater decal + dust ring + ground shockwave + shake + thud.** Craters are decals capped at `budgets.decals` and never fade (damage is permanent). Deforming the ground mesh needs the destructible street of M2.
- **Placeholder audio is synthesized now** (wind rising with speed, boom, thuds, slams), not left for M10: flight speed and the boom don't feel like anything in silence.
- **Speed indicator with a sonic-threshold marker** (part of the §10.1 HUD) added now, because tuning flight without a speed readout is guesswork.
- **Hero placeholder is capsules and spheres on a joint hierarchy with procedural poses** (idle, walk/run cycle, leap crouch, airborne, hover, flight with one arm forward, both arms in boost/dive, hard-landing crouch, banking). The Mixamo pipeline (M5) replaces it without touching the controller.
- **Optional motion blur and heat-shimmer air distortion (§5.3) are deferred to the M10 visual pass.** Speed lines, FOV widening, vapor cone and shake carry the speed for now, and they're cheap on the laptop.
- **Gray-box city:** 6 × 6 blocks of 100 m with 24 m streets (≈ 744 m across), downtown towers 20–50 floors in the core, mid-rises around it, low-rises at the edge, one park with trees, one plaza, one parking structure, and the elevated highway along the north edge. All buildings are one instanced draw call with a procedural window grid (3.5 m floors and bays) so scale reads at a glance.
- **Scale pillars are off by default** now that buildings give scale (the toggle stays in the debug panel). Hidden pillars also disable their colliders, so they never become invisible walls.
- **Cosmetic effect shaping constants** (dust puff counts and spreads) stay in the effect code; anything a player would tune (sizes, timings, strengths, thresholds) is in `src/config/fx.ts`.
- **Contact normals are oriented against the attempted move.** Rapier's controller reports blocking normals with an unreliable sign (and sometimes blocks without reporting at all, so a ray probe fills the gap). Without this, wall slams and hard landings silently didn't register.
- **Pressed against a wall, only motion toward your steering builds speed**, and a low-speed reversal brakes through zero instead of looping around. Otherwise holding forward into a facade made him grind sideways or slide down it at 17 m/s.
- **Startup shader prewarm renders real frames with every effect visible.** `compileAsync` alone compiles for the canvas, but the game draws through the post-processing target, so speed lines and the vapor cone still hitched 100–250 ms the first time they appeared.
- **Dust within 1.5 m of the camera isn't drawn.** A puff on the lens is a full-screen blended quad: it greyed out the screen after a wall slam and cost 100+ ms per frame at 1080p on the laptop.
- **The perf route loops the city at 190 m**, above the tallest tower, so it measures flight, city rendering and the boom rather than repeated crashes into towers.
- **Perf at 1080p on this laptop (Low, the default): 44.7 fps average, p95 33.5 ms, max 33.7 ms (no hitches).** High: 27.8 fps. Rendering at 1080p is GPU-bound here; at 720p it holds ~57 fps. The ~300 debug bodies cost ~10 ms of CPU physics, which matters for M2's debris budget.

## M1 playtest tuning

- **Sharper turns at speed** (user feedback: turning could be sharper). Turn rate at cruise 3.5 → 5 rad/s and at sonic 1.1 → 2.2 rad/s, so the turning circle at 160 m/s shrinks from ~145 m to ~73 m (about half a city block). Hover turning is unchanged.

## M2: Destructible buildings

- **Piece layout:** one facade panel per bay (~3.75 m) per floor (3.5 m); columns every 3 bays (a structural span ~11 m) per story; one floor slab per structural cell per story; roof parapets and 3 equipment boxes. That's ~89k pieces for the city, in structure-of-arrays typed arrays.
- **The support graph is implicit.** Neighbours come from grid indices instead of stored links (columns ↔ columns above/below and their slabs, slabs ↔ neighbouring slabs, panels ↔ neighbouring panels and the slabs above/below). It's symmetric (unit-tested), costs no memory, and connectivity is a BFS from the ground.
- **Materials:** reinforced concrete 420 HP, steel (tower columns) 300, concrete panel 100, brick 70, glass 6. Panel and roof HP scale with piece volume. Density gives mass, and a $/m³ value feeds the damage bill.
- **Damage states:** cracked at 70% HP, heavily cracked at 40%, breached at 15% (panels only), destroyed at 0. Damage over 3× max HP in one hit blows a piece straight out. A breached panel swaps to a frame mesh with a real hole and a gap in its collider.
- **Cracks are thin isolines of Perlin noise.** Worley noise looked similar but made shader compiles far slower on this GPU's driver.
- **Physics shapes are merged, not per piece.** Measured: Rapier's step costs ~0.24 µs per static collider, so 100k piece colliders would cost ~23 ms per step. A pristine building is one box. Once damaged it's rebuilt from merged runs (facade strips stacked floor to floor, slab rectangles per floor) plus individual exposed columns and roof gear. The whole city stays around 200–1,700 colliders.
- **Pristine buildings render as one proxy box each.** Its shader reproduces that building's exact bay/floor/window layout, and the building swaps to real pieces on its first damage. Drawing 51k pieces up front ran at 5 fps; proxies run at ~50 fps.
- **Interior columns and slabs are hidden until exposed.** Breaking anything on a floor reveals that floor's structure (render + collider).
- **Individual pieces don't cast shadows.** Damaged buildings cast shadows through their merged collider boxes, drawn into the shadow maps only (render layer 1). `colorWrite: false` isn't honoured by the WebGPU renderer and drew the boxes black.
- **Stress failure:** a story fails when fewer than 40% of its columns remain with structure above it. Sequence: creak audio → dust trickle and falling bits → visible sag (the section above becomes a kinematic body tilting up to 1.8° toward the missing support and dropping 0.35 m) → collapse after a random 2–8 s.
- **Falling sections are one rigid body with one box collider per story** (from the spec: start as one body, break on impact). Whatever the section lands on is crushed one story at a time (every 0.08 s while in contact), and the section keeps 75% of its speed, so collapses pancake. Lopsided failures get an initial topple spin proportional to the support imbalance.
- **Crushed pieces become rubble chunks at 60% size** that fall to the ground or pile; they never fade.
- **Debris lifecycle:** rigid bodies up to the 800 budget, at most 40 new per physics step (extras fly as visual fragments); a body asleep for 2.5 s becomes static rubble; small fragments (glass shards) fade; everything else stays forever.
- **Rubble piles are a 6 m height grid.** Each cell with enough rubble gets one merged box collider, so collapse sites are solid ground without a collider per chunk. Simplification: visual fragments don't collide with buildings on the way down, so rubble can pile up inside the footprint of a partly standing building.
- **Thrown and falling debris deal damage = kinetic energy × 0.001 HP/J** to the pieces where they hit (Rapier contact-force events). A 4 t panel thrown at 70 m/s is ~9,800 HP: it punches through most things.
- **Grab rips out any facade panel or roof gear, even intact ones** (godlike, §0.6); columns and slabs only once cracked. Max carry mass is 80 t (configurable).
- **Punch combo:** jab 34 HP, cross 34, finisher 55. Three hits crack, heavily crack, then breach or destroy a concrete panel. Hold the punch button 0.35 s to wind up an uppercut (140 HP and a big upward launch).
- **Ground slam (Q):** a radial blast (14 m base, bigger with dive speed), windows shattered out to 2.5× the radius, a crater and lifted road slabs. In the air, Q rockets him straight down and slams on impact; hard landings above 45 m/s are dive slams too.
- **Craters cut a hole in the ground shader (a mask texture) and fill it with a bowl mesh.** Visual only: the physics ground stays flat, so he stands at street level over a crater's centre. Real terrain deformation would need a heightfield ground; revisit if it bothers.
- **Sonic boom and low sonic passes now break windows:** glass curtain-wall panels shatter (breach), and concrete and brick panels get a "windows blown out" state.
- **The hero damages facades he slams into** (2.2 HP per m/s of impact speed), and hard roof landings crack the roof.
- **HUD:** reticle (turns orange when something is in reach) and a running damage bill in dollars (§10.1).
- **Startup prewarm compiles every destruction material, shadow variant and pooled mesh**, and draws every batch once with frustum culling off. That moves all shader/pipeline creation to boot (~12 s on this laptop, of which ~4 s is destruction) so punches, breaches and collapses don't stall mid-play. Falling sections draw from a pool of pre-created meshes for the same reason.
- **The perf run now includes destruction:** the tallest tower and a mid-rise collapse and two slams go off during a 20 s loop over the city. The M0 artificial test bodies are off by default (`perf.spawnBodies` = 0); real debris is the physics load now.
- **Perf at 1080p on this laptop (Low): 30.1 fps average, p95 50 ms, ~500k triangles at peak** with the collapses in view. At 720p, ~45 fps. Rendering dominates (GPU-bound); physics averages ~7 ms per frame.
- **Known issue:** one 280–430 ms stall late in a full tower collapse on this laptop. It's outside the game's own frame work (most likely a garbage-collection pause or a GPU stall), so it needs proper browser tracing; scheduled for the M11 optimisation pass. Teleporting a long distance also costs one ~110–180 ms physics step (debug/respawn only).
- **Not in M2 (as scheduled):** interior walls, units and furniture (M3); heat-vision cuts feeding the structure (the `cutStory` debug tool and the steel-temperature capacity hook are already in place for M4); the highway isn't destructible yet.
