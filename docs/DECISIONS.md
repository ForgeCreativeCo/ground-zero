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

## M3: Interiors and fire

- **Units are slab cells:** one unit per structural cell (~11 m) per floor, so a unit id is plain arithmetic from (building, floor, cell) and costs no lookup tables. Type comes from the building seed: downtown towers are offices over shops; mid-rises are offices or apartments (50/50) with shops on the ground floor 70% of the time; parking garages hold cars.
- **Furniture is simple boxes plus a round plant blob,** one instanced mesh each, with the look (wood, fabric, metal, drywall, plant, light panel, screen) picked per instance. Parked cars are a body and cabin until the vehicle models of M5.
- **Breaching a panel furnishes its unit and the neighbouring cells on the same floor (±1).** The unit the hero is standing in is furnished too, so flying in through a hole always lands in a real room. Undamaged furnished units more than 260 m away are removed; damaged ones stay.
- **Interior walls are drywall boxes with door gaps,** placed on the cell edges between furnished units and shared, so neighbouring units don't build two walls.
- **The hero smashes through furniture and interior walls within 1.3 m as he moves;** punches, slams and debris also break props. A broken prop becomes debris chunks like any other piece.
- **Furniture riding a falling section is removed** rather than carried along. Moving thousands of props with the section every frame costs too much; the section's own rubble and dust hide it.
- **Window interiors use one shader for every facade:** the room is ray-cast inside a box behind each window (back wall, floor, ceiling, side walls, a light panel and furniture silhouettes), with a per-room seed for colour, layout and lights on or off (30% by day, 72% at night). The same function runs on stand-ins and on real panels, so a building looks the same before and after its first damage.
- **Power failure:** when 8% of a building's columns are gone, the power fails at the damaged floor and the outage spreads 3 floors a second, with a 2-floor flickering edge. Window rooms, emissive ceiling panels and real lights all read the same floor-power value.
- **Real lights are capped hard:** 0 on Low, where window rooms, emissive panels and flame particles carry it. With real point lights on, fires dropped this laptop to ~20 fps, because each light costs shading on every surface in view. High has 2 room lights and 3 fire lights.
- **Fire is simulated per unit, 4 times a second:** grow (12 s to full), burn fuel (90 s scaled by furniture), spread sideways (4%/s per neighbour) and up (6%/s, only through a broken window or hole), capped at 220 burning units. Burning units break their windows, soot their panels (charred look), heat their columns (for the M4 steel-strength hook) and pour flames and smoke from their openings; smoke rises at 4 m/s and drifts with the wind.
- **Collapses and crushed stories start fires** (35% chance per crushed story, plus open fires in the rubble), so destroyed districts burn and light the night. The spec ties ignition to heat vision; until M4, collapses, slams and the debug "start fire under reticle" are the sources.
- **One shared material per family:** every piece, falling section, debris chunk and rubble instance uses one shader, with the look picked by a per-instance attribute. The same goes for props and stand-ins. Shader programs dropped from 194 to 135.
- **three.js builds shader code per instanced mesh,** because its cache key includes the mesh's uuid. A new InstancedMesh mid-play costs a 100–300 ms stall even when an identical one already exists. So every instanced mesh (piece batches, falling-section pool, debris, rubble, props, particles) is created up front and never mid-play.
- **The startup prewarm became a background warm-up.** The M2 approach (compile everything before play) had grown to 40–70 s. Now boot compiles only what's on screen (playable in ~6 s), and the real meshes are compiled asynchronously on a hidden layer over the next ~7 s while you fly. Something that first appears in those 7 s can still hitch once.
- **Black-surface bug (worth remembering):** three.js emits a shared node, like the world normal, at the spot where it's first used. If that's inside a shader branch (here, the "is this piece cracked?" branch), the lighting later reads an unset normal and every undamaged surface renders black. Fix: evaluate the normal at the top of each shader function, or read the geometry normal for unrotated stand-ins. An earlier theory blamed `select()` between colours; that was this same bug.
- **The perf run now waits for the background warm-up,** so it measures steady play. The warm-up overlapping the run cost ~1 fps.
- **Perf at 1080p on this laptop (Low): 25.5 fps average, p95 67 ms, ~610k triangles at peak; High: 15.4 fps.** The laptop measured slower than at M2 today: the committed M2 build ran 24.0 fps under the same conditions (vs 30.1 when first measured), so M3 adds no measurable steady-state cost. The window rooms cost ~2 fps each on stand-ins and on real pieces.
- **Known issues:** toggling day/night in the debug panel stalls ~0.6 s (sky and lighting re-bake; debug only, since the sun doesn't move in play). Floor slabs near a punch show crack lines that read more like contour lines than cracks; revisit with the M11 look pass.
- **Not in M3 (as scheduled):** occupants and bodies blown out of windows (M5, humans); vehicle fires and fuel explosions (vehicles, M5+); heat-vision ignition (M4).

## M4: Heat vision, freeze breath, sonic fly-through

- **Heat vision is aimed by the camera ray and drawn from the eyes.** Where the reticle ray meets a surface is the target; the twin beams run from his eyes to that point. Building pieces are traced piece by piece (a new `CityStructure.raycast`), because the merged physics colliders don't match individual pieces; the physics ray finds everything else (ground, debris, rubble).
- **While a power fires, the camera moves further over the shoulder (1.25 m) and closer (3.3 m).** From the normal chase position the beams start behind his head and run straight at the reticle, so they were nearly invisible. The aim offset makes them cross the screen.
- **Burn rates are "seconds to burn through", per material** (concrete panel 0.3 s, brick 0.28, reinforced concrete 0.45, steel 0.9, glass instant), not HP per second. Piece HP scales with volume, so a time is the number a designer actually wants to tune. Heat rises 1,400–2,600 °C/s at the spot; pieces glow from 350 °C, are white-hot at 1,400, and cool exponentially (0.06/s, so steel stays weak for ~20 s).
- **The beam goes into the building.** It passes fully through pieces it has burned through (destroyed, or panels with a hole), and 45% of it gets through unbroken ones, up to 40 m past the first surface. That lets a sweep cut through a building's depth rather than just its facade, and it's how a facade scar also scorches, breaks and ignites the room behind it.
- **Cuts are axis-aligned box splits, not CSG.** When a sweeping beam (> 0.6 m/s across surfaces) burns through a piece, the piece splits into two halves along whichever of its long axes best matches the cut plane (beam direction × sweep direction), with an 18 cm kerf, and both halves come loose as debris. Pieces are boxes everywhere in the pipeline (render batches, colliders, debris), so `three-bvh-csg` would have meant a second geometry path. A diagonal sweep therefore cuts in steps at piece scale, while the scar decals trace the true line. A beam held still melts a hole instead (fewer, smaller fragments).
- **Glass shatters the instant the beam touches it** and becomes a glowing frame (the breached state); the beam passes through. Punched windows in concrete and brick blow out on first contact.
- **Interior damage:** a facade panel above 500 °C sets the unit behind it alight. Along the beam inside the building, furniture and drywall take 400 HP/s, and the units it passes through catch fire. Fire then spreads under the M3 rules.
- **Hot steel feeds the structure live.** The beam now drives the M2 capacity hook (full strength at 300 °C, none at 800 °C), and buildings whose steel is being heated are re-checked every 0.35 s. Holding the beam on a downtown tower's columns makes it creak, sag and fail.
- **Damaged columns carry less load (new, for all damage types).** Above 70% HP a column carries its full share; below that, proportionally less. This is needed for "a tower with a tunnel through it" to fail (§7.6). It also makes heavily punched columns weaker, which is more realistic.
- **Scar decals are segments chained along the sweep:** a new one every 0.3 m, with the newest kept white-hot while the beam dwells. They cool white → orange → dark red → black over 10 s. Scars and frost share one instanced mesh and one material. **The decal budget (600) is split 25% craters, 75% scars and frost**, each recycling its oldest. A decal on a building piece disappears with the piece. The piece keeps its soot, so buildings stay charred after their scars are recycled.
- **Screen-space heat shimmer is deferred to the M10 post pass,** alongside the flight shimmer deferred in M1. Sampling the framebuffer (`viewportSharedTexture`) compiled synchronously and stalled the first frames for ~1 s, while one distortion node in M10 can cover beams, fires and the Nova. Meanwhile the beam has a rippling heat glow.
- **Not in M4 (as scheduled):** igniting vehicles and fuel-tank explosions need vehicles (M5). Burning, freezing and obliterating people need humans (M5) and the gore systems (M6).
- **Freeze breath is a cone (24 m, 16° half-angle) from the mouth toward the reticle.** It stops 1.5 m past the first surface it reaches, so it doesn't freeze through walls. 0.5 s of breath freezes a piece, and any frost makes it brittle (double blunt damage, via the existing M2 hook). Frost cools hot pieces before it settles, puts out fires in the cone, leaves frost patches where it lands, and thaws after 30 s (fading over the last 5).
- **Nothing in the city to freeze as water yet:** there are no puddles or fountains, so "puddles and fountains freeze" waits for water features (M10 world dressing).
- **Meters:** heat vision overheats after 8 s of continuous fire, locks out for 1.6 s, then drains at 0.35/s. The breath meter holds 5 s; once empty it has to refill to 25% before he can breathe again. Both sit above the speed bar and fade out when idle.
- **Visual tells and stances:** his eyes glow with the beam (faintly while the meter is hot). He turns to face the aim: braced with his head on the target for heat vision, leaning into it for freeze breath.
- **Fly-through: above the sonic threshold the character controller ignores building colliders** (a filter predicate). Each collision substep (≤ 0.35 m) sweeps a 1.5 m sphere along his path, so he never passes through anything without hitting it. The ground, the highway and rubble piles still stop him.
- **The blast radius (4 m) only hits what's beside and behind him.** Applied ahead, it blew the facade away before he reached it, so buildings never registered him entering.
- **Slabs are only bored through when the path is steep** (|vy| / speed ≥ 0.5, i.e. diving). In level flight they're blasted (cracked) instead, per the spec.
- **Entering a building** (the first piece his tunnel destroys) costs 15% of his speed and brings a 50 ms hitch at 0.2× time, heavy shake, a deep crunch, and muffled audio (420 Hz low-pass) until he leaves. **Leaving** (his centre exits the footprint) blows the exit facade within 4.5 m outward along his velocity, with a burst of dust and the sound coming back all at once. Debris sprays at 38% of his speed plus 9 m/s of scatter.
- **Crashing:** if the speed cost drops him below the threshold, or he slows below it while inside, he stops dead 3 m on into the building in a cleared pocket of wreckage. That building's colliders are rebuilt on the spot, so he isn't left inside a stale collider. The never-stuck lift is suspended while he's penetrating, since going through buildings is meant to put him inside them.
- **Structural shock:** when he leaves (or crashes), every column on the tunnelled stories ±1 takes 95% of its HP in damage at the path, falling to 60% at 30 m and beyond. With the damaged-column capacity above, a tunnelled building usually fails after the §7.6 delay: in the smoke test the 49-floor tower creaks, sags and collapses on every run. Lower `flyThrough.shockDamage*` to make collapses rarer.
- **Rooms ahead are furnished just before he arrives:** looking 0.5 s ahead along his path, up to 10 units on his line through the next building are furnished immediately (normally furnishing is queued at 3 units a frame), so furniture sprays out of the far side.
- **Performance fixes found while testing the fly-through:**
  - `forEachBuildingNear` scanned every building, and it runs for every loose debris fragment every step (the floor-height query from M2). A glass tower's tunnel makes ~6,000 fragments, so it cost ~250 ms per second of play. Buildings now sit in a 32 m grid, and the query is ~6× cheaper.
  - Debris resting on upper floors (parked) stayed in the flying-debris batch and re-uploaded every frame. It now has its own batch that only uploads when something parks or leaves, which halved per-frame buffer uploads after a tunnel.
  - Fixed: fragments returning to the flying batch when their floor fell could overflow it (a WebGPU `writeBuffer` error). With no room left, they now drop straight to rubble.
- **Perf at 1080p on this laptop (Low, the default perf path): 24.0 fps average (41.6 ms), p95 67 ms, max 350 ms; High: 13.0 fps.** The committed M3 build measured 21.9 fps on the same path today, so M4 adds no steady-state cost (the fixes above more than cover the new effects). The perf path still has no powers in it, which keeps it comparable with M2 and M3. In the M4 smoke test (720p) it's ~33 fps while firing heat vision or freeze breath, and ~20 fps while tunnelled buildings collapse with 800 rigid bodies (the budget cap) and ~6,500 loose fragments.
- **Known issues:**
  - Chaining through several buildings at full boost collapses all of them. It's spectacular, but the laptop drops to ~15–20 fps while they come down.
  - Inside a tunnel the camera can pull in tight for a frame or two, because colliders are rebuilt only a few buildings per frame after the pass.
  - The smoke test's fly-through vantage hides the tunnel behind a nearer roof, so the collapse is verified by the failure state rather than a clean screenshot.

## M4 follow-up (user feedback: stronger heat beam, new energy ball)

- **Heat beam made far stronger** (feedback: "lack-luster, should take huge chunks out and slice pillars without issue"):
  - Burn-through times are now concrete panel 0.06 s, brick 0.06, reinforced concrete 0.1, steel 0.14 (were 0.3 / 0.28 / 0.45 / 0.9).
  - The beam bores a 1.6 m-radius channel: every piece within it burns at up to 85% of the full beam, falling off to the edge. It replaces the old heat-only spot.
  - 80% of the beam now gets through unbroken pieces (was 45%), and a sweep counts from 0.3 m/s (was 0.6), so a sweep through a column slices it.
  - Melted pieces break into more chunks (80% of a full shatter, was 50%).
  - In the smoke test the same sweep burns 37 pieces and slices 31 (was 10 and 7).
- **Energy ball: a new power the user asked for; not in DESIGN.md.**
  - Bound to G, the middle mouse button, and the right stick click on gamepad (all free; R stays reserved for the Nova).
  - Hold to charge (1.6 s to full), release to throw at the reticle at 110 m/s (plus his own velocity). A tap throws a 15% ball. 0.35 s cooldown.
  - It bursts on the first thing it hits: buildings are traced piece by piece, the ground by the physics ray, and it ploughs through loose debris.
  - **Blast:** 4 m radius at minimum charge, 15 m at full. Every piece inside 60% of the radius is blown apart outright; further out, damage falls off with distance squared from up to 9,000 HP (scaled by charge^1.5). Debris and furniture are launched outward, windows shatter out to 2.5× the radius, and rooms in the blast catch fire (45% chance each).
  - **No hitch from a full charge:** the blast front expands at 140 m/s and breaks pieces as it reaches them, which spreads a full charge over ~6 steps. Blown-apart pieces make half the usual fragments to stay within the debris budget.
  - In the smoke test a full charge on a mid-rise destroyed 83 pieces outright, and the building lost 190 in all once the unsupported parts fell.
  - **Look:** a white-blue plasma ball (crackling core, soft halo) grows in his hands while he holds it out in front of him; a trail of sparks follows it in flight. The burst is a swelling flash, two shockwave rings, a dust ring and a shower of sparks.
  - **Feedback:** the aim camera is used while charging, a charge bar appears with the other power meters (it glows at full charge), and the audio is a rising whine, a throw whoosh, and a crack-and-boom heard with travel delay.
- **Known issue: one early warm-up stall grew from ~450 ms (M3) to ~570 ms** with the M4 meshes. It lands about a second after the game becomes playable, during the background shader warm-up, and the M1 walk check in the smoke test sometimes measured it, so that test now waits for the warm-up like the M4 and perf tests do. Tracing which pipeline compiles synchronously is part of the M11 optimisation pass that already owns the M2 collapse stall.

## M8: Nova blast (built before M5–M7, at the user's request)

- **M8 was built straight after M4.** M5–M7 (people, ragdolls, response) don't exist yet, so the parts of §6.6 that act on them are hooks for later: people vaporized, flung or fleeing, cars lifting, flipping and setting off alarms, and response heat jumping to maximum. `nova:windup` / `nova:release` / `nova:done` events carry what those systems will need.
- **Charge meter fills from property damage only**, from empty to full at $60 M (tunable). In the smoke tests a few minutes of heavy destruction makes $30–60 M. Casualties add to it once people exist (M5). The Nova's own damage doesn't refill it. The debug panel has "Fill Nova meter", and `nova.requireFullMeter` off lets it fire any time.
- **Wind-up (hold R, 2.5 s):**
  - Letting go early cancels it and keeps the charge. He's locked in a hover, so movement can't cancel it (§6.6).
  - Pose: curled in, fists clenched. His suit seams light up first, then the whole suit glows. A rippling hot aura forms around him.
  - Loose debris within 45 m lifts and swirls around him. Cracks spread on the ground below in five stages.
  - The city's window lights flicker (one new uniform on the window shader), colour drains to 20%, the shake rises, and the audio builds from a low rumble to a high whine.
- **Release:**
  - A white-out flash (in a new colour-grade stage of the post chain, before tone mapping) holds for 0.3 s, then recovers over 1.4 s.
  - The shockwave front expands at 250 m/s to 200 m, drawn as a dome riding the front. A ground shockwave ring and dust rolling out along the streets follow it.
  - The fireball swells to a fifth of the radius and cools away over 4 s.
  - Audio: near-silence under the flash, then the roar, then 6 s of ringing ears with the world muffled.
- **Damage zones applied as the front reaches each piece** (fractions of the radius, as in the spec):
  - **Core (0–25%):** pieces are deleted with no simulation. A building wholly inside the core goes in one call. Every 30 vaporized pieces make an ash-and-dust burst with glowing fragments.
  - **Blast (25–65%):** every piece is torn loose and scorched. 15% fly outward (up to 70 m/s at the core edge) as visual debris; the rest drop straight into rubble on the ground below.
  - **Edge (65–100%):** all glass goes. 80% of facade panels are stripped (falling to 40% at the radius), and the rest crack, scorch and lose their windows. Columns take up to 90% of their HP (none at the radius), so supports fail and sections collapse after the usual delay. Power is cut, and up to 14 rooms per building catch fire.
  - **Fringe (100–150%):** windows blown in.
- **Bulk destruction path:** the Nova removes pieces through new quiet methods (`vaporizeBuilding`, `vaporizePiece`, `tearLoose`, `bulkDamage`, `bulkShatter`). They skip per-piece dust, sound, events and furnishing, and announce the damage bill once per step. Per-piece effects at this scale (~29,000 pieces) would swamp the particle, audio and furnishing systems.
- **Performance rules (§6.6), as built:**
  - The core never simulates pieces.
  - The front's work is time-boxed: 6 ms of each rendered frame, however many physics steps it runs. On a slow machine the destruction lags slightly behind the visible front instead of dragging the frame rate down.
  - The Nova makes no rigid bodies: flung pieces are visual debris that become rubble where they land (§6.6: "short-lived visual debris (simple ballistic motion, no collision)"). The first version used rigid bodies; physics alone then cost 66 ms a frame on this laptop.
- **Supporting fixes found while measuring the Nova:**
  - Rubble capacity now starts at 80,000 (was 20,000). Growing it creates a new instanced mesh mid-play, which three.js compiles: a 100–300 ms stall. One Nova makes 25–30 k rubble chunks.
  - Building piece batches now upload only the slots that changed, instead of the whole live range (~3 MB a frame at 26 k pieces).
  - Flying fragments re-query the floor under them every 6 steps (or when about to land or moved sideways), not every step, and their spin step is precomputed.
  - Falling-section mesh pool raised from 6 to 12: a Nova's edge zone drops 6–9 sections at once, and every one past the pool is created (and compiled) mid-play.
- **Crater:** a deformed crater (the M2 ground crater, 30 m at ground level, shrinking as he goes higher, none above a quarter of the radius), road chunks around the rim, and a glowing disc that cools over 4 minutes.
- **Mushroom cloud:** 320 soft billboards, each placed by a closed-form function of time, so it costs no simulation. The stem flows up into a cap that rolls over as a torus and spreads to 55% of the radius at 160% of the radius up (320 m for the default Nova), with a dust skirt at the base. It glows orange-white at first and cools to grey-brown smoke lit from above, drifts with the wind, hangs for 3 minutes, then thins over 1. From across the city (420 m out) it reads clearly over the skyline.
- **Aftermath:** ash falls around the camera for 90 s. An orange-grey cast with 45% less colour fades back over 2 minutes. The sky and sun are left alone, because re-baking the sky lighting stalls ~0.6 s (an M3 known issue).
- **Perf on this laptop (far below the reference RTX 3060):** steady play on the default perf path is unchanged at 25 fps. During a default 200 m Nova over downtown, frames average 114 ms (~9 fps) for the ~7 s the front takes to work through everything, with spikes of 300–380 ms. The slowest physics step is 31 ms. That is well short of the §13 target (30 fps on the reference hardware), which can't be measured here. What's left is spread across rendering (~32 ms of CPU at 1.6 M triangles), the remaining visual debris and physics. A smaller `nova.radius` is the main dial for this machine. Tracing the spikes is part of the M11 optimisation pass.
- **Known issues:**
  - The wind-up camera doesn't pull back, so the aura and debris crowd the view at the default distance.
  - Buildings in the edge zone often topple into their neighbours for a while after the front passes, adding to the load.

## Mobile controls and landscape-only play (user request after M8)

- **On-screen touch controls appear on phones and tablets**: devices whose main pointer is a finger and can't hover (`controls.touchUi`: auto by default; "on" forces them on, and a mouse can then drive them for testing; "off" never). DESIGN.md §4 only covers keyboard and gamepad, so this is an addition. Laptops with touchscreens keep the desktop controls: the first version also checked for any touch support, which showed the touch UI (and hid the perf readout) on desktop.
- **Layout for a landscape phone:**
  - Left thumb: a floating move stick that appears wherever the thumb lands on the left 45% of the screen. Pushing it to the rim boosts, since thumbs are busy, and a BOOST button on the left toggles boost on and off.
  - Dragging anywhere else turns the camera. It turns the same way as the mouse, at `controls.touchLookSensitivity` × the mouse speed per pixel.
  - Right thumb: a cluster of round buttons. PUNCH is the big one; around it are FLY (tap = hop, hold = charge a leap, double-tap = take off, hold while flying = up), DOWN, GRAB, SLAM, HEAT, ICE, BALL and NOVA (glows when the meter is full).
  - MENU (debug panel) and FPS (perf readout) are small buttons top-left.
- **Buttons hold the same raw inputs the bindings map** (new `Touch:*` ids in `config/controls.ts`), so every hold, tap and double-tap behaves exactly like its key, with no separate code path per power.
- **The perf readout starts hidden on touch devices.** It covers too much of a phone screen; the FPS button shows it.
- **Landscape only:**
  - On touch devices a prompt covers the game in portrait ("Turn your device sideways").
  - A "Tap to play" screen goes fullscreen and locks the orientation to landscape where the browser allows it (Android Chrome). iOS Safari and embedded frames can't lock, so the prompt is what enforces it there.
  - A web app manifest (`display: fullscreen`, `orientation: landscape`) covers "Add to Home Screen" installs.
  - Desktops are left alone: a narrow browser window on a computer still plays.
- **Page zoom and browser gestures are off** (viewport `user-scalable=no`, `touch-action: none`, no overscroll), so pinches and swipes go to the game.
- **Not verified on a real phone yet:** the smoke test emulates a touch phone (844 × 390) in desktop Chrome. Real-device performance is unknown; phones vary hugely, and the Low preset with the pixel ratio capped at 1 is the starting point.
- **Known flake (older than this change):** the M3 smoke test's fly-into-the-hole check fails about 1 run in 3 on this laptop, including on the committed M8 build. The scripted flight sometimes misses the breach, so the room it checks is never furnished. It now waits up to 3 s for furnishing, which fixes the timing part. Making the flight itself aim at the hole is a test-only fix for later.
