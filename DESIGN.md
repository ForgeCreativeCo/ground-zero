# GROUND ZERO — Design & Build Spec

**Repo folder:** `ground-zero`
**Genre:** Third-person open-city destruction sandbox
**Platform:** Desktop browser (Three.js + TypeScript)
**Audience:** One player: the author. Personal project, built for fun.
**Content rating intent:** Mature. Extreme violence, blood, gore and dismemberment are core, intentional requirements.

---

## 0. Instructions for Claude Code (read first)

This document is the single source of truth for the project. Read it in full before writing any code.

1. **First task:** create `CLAUDE.md` at the repo root. Condense this document's non-negotiables into it: stack, folder structure, performance budgets, coding conventions, the "never do" list (Section 16), and how to run and verify the game. Also create `docs/DECISIONS.md`. Every time you make a judgment call the spec doesn't cover, log it there with one line of reasoning.
2. **Build in milestones** (Section 15). Finish one milestone completely, verify it (Section 14), then stop. Give the user:
   - a short summary of what was built;
   - how to run it;
   - a playtest checklist of 5–10 things to try.

   Do not start the next milestone until the user has played it and responded.
3. **The game must run at the end of every milestone.** No half-wired systems left in a broken state.
4. **Feel and performance beat feature count.** If a feature can't hit the performance budgets, build a cheaper version and log the trade-off. Never silently drop a requirement.
5. **Everything tunable lives in config** (`src/config/`) and is exposed in the in-game debug panel. The user will tune by playing, not by reading code.
6. **When the spec is ambiguous,** pick whatever makes destruction feel more real and powers feel more godlike, and log the choice.
7. **Verify current library APIs** before using them (three.js, Rapier and the other packages here change between versions). Don't rely on memory for exact APIs.
8. **Mature content is intentional.** Blood, gore, dismemberment and civilian casualties are requested features of this personal project. Implement them fully, as specified.

---

## 1. Vision

You are the most powerful being on Earth: invulnerable, flying, impossibly strong. You have stopped pretending to be a hero. There's no story, no missions and no goal except whatever you feel like doing to the city. The fun comes from three things:

- **Destruction that feels real.** Everything breaks the way it should and stays broken. Buildings have insides.
- **Power that feels godlike.** Flight, strength and speed are effortless, instant and overwhelming.
- **A world that reacts.** Civilians panic and flee, and the police, then the army, then a special task force throw everything they have at you.

### Design pillars

1. **Damage is real and permanent.** Nothing resets or respawns during a session. Every hole shows what's behind it. Debris has mass. Buildings fall when their supports fail.
2. **Godlike control.** The player character never feels sluggish, stuck or limited by clumsy controls.
3. **Living, realistic people.** Smooth, realistic human models. **Never blocky or low-poly humans.** They react believably and die messily.
4. **Escalation.** The world's response keeps ramping until it can actually threaten you.
5. **Smooth performance.** 60 fps on a mid-range gaming desktop. Spectacle must come with a budget.

### Out of scope

Story, dialogue, missions, a skill tree or upgrade grind (all powers are available from the start), multiplayer, mobile and touch support, save games (a session is one continuous rampage).

---

## 2. Setting

- **City:** fictional, modern North American city. Working name **Port Halcyon**. Generated procedurally from a seed (`?seed=1234` URL param; same seed gives the same city).
- **Layout:** a street grid with varied blocks:
  - downtown glass-and-steel towers (20–50 floors);
  - mid-rise office and apartment buildings (6–15 floors);
  - low-rise brick shops and walk-ups (2–4 floors);
  - parking structures;
  - a plaza;
  - a park with trees;
  - an elevated highway segment along one edge.
- **Street furniture:** sidewalks, crosswalks, traffic lights, street lamps, bus stops, benches, trees, hydrants, newspaper boxes, parked cars and live traffic.
- **Size:** Milestone 2 uses roughly 6×6 blocks (about 750 m × 750 m). Later milestones scale toward 2 km × 2 km with streaming and LOD (Milestone 11).
- **Buildings are blocky by design**, which is fine, but materials must look realistic: PBR concrete, brick, reflective glass, steel and weathering.
- **Time of day:** full day/night cycle. Night matters: lit windows, glowing fires, sirens' lights and searchlights.

---

## 3. The player character

- **Working name:** ZERO (placeholder; the user may rename).
- **Look:** original design. Tall, imposing, dark matte suit. Do not copy any existing comic hero's costume, colors or emblem. Optional cape driven by a cheap cloth simulation (Verlet strip), only if it fits the performance budget.
- **Model:** realistic human model through the same pipeline as NPCs (Section 9.2). Until assets arrive, use a **smooth** placeholder humanoid (rounded capsules and spheres), never boxes.
- **Invulnerability:** conventional weapons don't hurt him.
  - Bullets spark and flatten on contact, with a ricochet sound.
  - Explosions and rockets push or stagger him but deal no damage.
  - Only the Task Force's dampener technology (Section 8.3) can actually hurt him.
- **Visual tells:**
  - Eyes glow when heat vision charges.
  - Frost on the breath when freeze breath charges.
  - An inner glow builds during the Nova wind-up.
  - Blood, dust and soot accumulate on his suit over the session and clear on reset.
- **Animation set:**
  - idle, walk, run, superhuman leap, takeoff, hover idle, flight pose (arms forward), banking, dive;
  - hard landing (crouched impact);
  - punch combo (3 hits), uppercut, grab, carry, throw;
  - heat vision stance, freeze breath stance;
  - Nova wind-up and release.

---

## 4. Controls

All bindings are rebindable via config. Gamepad support is required (Xbox layout).

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move / fly direction (camera-relative) | WASD | Left stick |
| Camera | Mouse | Right stick |
| Jump / ascend (hold) | Space | A |
| Take off (from ground) | Double-tap Space | Double-tap A |
| Descend | Ctrl | B (hold) |
| Boost toward sonic speed (hold) | Shift | Left stick click / LB |
| Punch combo / uppercut (hold) | Left click | X |
| Heat vision (hold, aim with reticle) | Right click | RT |
| Freeze breath (hold) | F | LT |
| Grab / throw | E (grab), Left click (throw) | Y |
| Ground slam / dive slam | Q | RB |
| Nova blast (hold to charge, release) | R | LB + RB (hold) |
| Slow motion toggle | T | D-pad up |
| Photo mode / free camera | P | View button |
| Debug panel | F1 | — |
| Sandbox spawn menu | Tab | D-pad down |
| Reset city (same seed) | F5 in debug panel | — |

---

## 5. Flight and movement

### 5.1 Movement states

| State | Feel | Default top speed (tunable) |
|---|---|---|
| Grounded walk / run | Heavy footfalls; cracks pavement when sprinting | 6 / 14 m/s |
| Superhuman leap | Hold to charge; leaps over buildings | — |
| Hover | Precise, near-instant acceleration; stops dead on release | 20 m/s |
| Cruise | Momentum, banking into turns, wide arcs | 50 m/s |
| Boost | Acceleration builds; wind roar rises | up to 160 m/s |
| Sonic (above threshold) | Vapor cone, sonic boom, can penetrate buildings | threshold 110 m/s |
| Dive | Pointing down at speed; ends in a dive slam if he hits the ground | — |

The sonic threshold is a **gameplay value**, not literal Mach 1 (343 m/s), which would cross the city in two seconds. It should feel like breaking the sound barrier.

### 5.2 Feel requirements

- Arcade, not simulation: no stalling, no lift or drag modeling, no inertia that fights the player in hover.
- Acceleration and turn-rate curves are exposed in config. Momentum grows with speed: hover turns instantly, while sonic needs wide arcs.
- Smooth transitions between states with no snapping.
- **Never stuck.** Robust depenetration from geometry and debris, and no wedging into collapsed rubble.

### 5.3 Camera

- Third-person over the shoulder, on a spring arm with collision. It pulls in when walls are near and never clips inside geometry.
- Field of view widens with speed (70° at rest to about 100° at max boost).
- Speed effects: streaks and air distortion at high speed, and optional motion blur.
- Camera shake scales with impact energy and distance (punches, landings, collapses, the Nova).
- **Sonic boom:** crossing the threshold triggers a vapor cone, a visible shockwave ring and an audio crack. Below him, windows shatter within a radius and people are knocked down.

### 5.4 Impacts and landings

- **Hard landings** (from height or speed): a crater decal, cracked and deformed ground, a radial shockwave, and dust. Size scales with impact speed.
- **Hitting a building below sonic speed:** he slams into it. The facade panel cracks or holes depending on speed, he stops or bounces, and the camera shakes. He can then punch his way in.
- **Hitting a building at or above sonic speed:** he goes straight through it (Section 7.7).

---

## 6. Powers

All powers are available from the start. Meters exist to create rhythm, not progression.

### 6.1 Super strength

- **Punch combo:**
  - People are ragdolled, or dismembered above force thresholds.
  - Cars crumple and flip.
  - Facade panels crack, then hole.
  - Interior walls blow apart.
- **Uppercut:** launches cars, people and debris skyward.
- **Grab:** anything under the reticle within reach, with mass limits tuned to "almost anything":
  - people, cars, buses, trucks, tanks, helicopters (pulled out of the air);
  - lamp posts, debris chunks;
  - building pieces. Grabbing a damaged facade chunk rips it free.
- **Carry:** he can fly while carrying. A held object dangles with physics.
- **Throw:** aimed at the reticle. The thrown object's momentum translates directly into damage on whatever it hits, so a bus thrown through a lobby wrecks the lobby.
- **People thrown into walls** leave a blood splatter decal and suffer an impact death (Section 9.6).
- **No limit or meter** on strength.

### 6.2 Heat vision

- Twin beams from the eyes, aimed at the reticle, continuous while held. An **overheat meter** forces a brief cooldown when full (tunable; default about 8 s of continuous fire).
- **Visuals:**
  - bright white-hot core with orange edges, bloom and heat shimmer;
  - sparks and molten droplets at the impact point;
  - a glowing scar decal that cools from white to orange to dark red to black soot over about 10 s.
- **Material behavior:**
  - **Concrete and brick:** scorches, glows, then melts a groove. Sustained fire burns through.
  - **Glass:** shatters instantly and melts at the edges.
  - **Steel:** glows orange and loses structural strength while hot. Holding the beam on steel can make a frame sag and fail.
  - **Interiors:** whatever is behind a burned-through panel ignites (furniture, drywall), and fire spreads (Section 7.9).
  - **Vehicles:** ignite. Sustained fire on the fuel tank makes them explode.
  - **People:** see Section 9.6.
- **Exterior plus interior damage:** burning the outside of a building must damage the outside **and** the room behind it. The scar on the facade corresponds to scorching, fire and broken objects inside that unit. Burn-through opens the facade and exposes the burning room.
- **Cutting:** sweeping the beam cuts a continuous line through pieces it fully burns through. Implement this as plane or line slicing of the affected pieces; `three-bvh-csg` is one option for runtime cuts. Cutting through supports feeds the structural system (Section 7.6), so a diagonal slice through a tower's base can bring the top down.

### 6.3 Freeze breath

- A cone of freezing breath with a breath meter (tunable; default about 5 s).
- **People** freeze into rigid statues (frozen material, frost particles). Any impact shatters them (Section 9.6).
- **Vehicles** frost over and become brittle. A punch shatters them into frozen chunks.
- **Facade panels** frost over and take double damage from blunt impacts while frozen.
- **Fire** is extinguished.
- **Ground** gets a frost decal; puddles and fountains freeze.
- Frozen objects thaw after a tunable duration (default 30 s).

### 6.4 Ground slam and dive slam

- **From the ground:** he punches the ground, sending out a radial shockwave.
- **From the air:** a dive at speed ends in a slam. Force scales with altitude and speed.
- **Effects:**
  - crater (deformed ground mesh plus decal) and lifted road chunks;
  - cars flipped and people thrown;
  - windows shattered in a radius;
  - dust ring;
  - nearby building foundations damaged, which can trigger structural failures.

### 6.5 Sonic boom and fly-through

See Section 5.3 for the boom and Section 7.7 for penetrating buildings.

**Low-altitude sonic pass:** flying down a street above the threshold shatters every window along the route, sets off car alarms and knocks people flat.

### 6.6 Nova blast (the nuclear power)

The signature power. It levels multiple city blocks at once.

#### Charge meter

The meter fills from carnage: property damage in dollars plus casualties. The debug panel can fill it instantly. The default fill takes a few minutes of heavy destruction (tunable).

#### Wind-up (hold R, about 2.5 s)

- He stops and hovers in place; this can't be cancelled by movement.
- An inner glow builds through his body and suit seams.
- Nearby loose debris, cars and people start lifting and orbiting slowly.
- Ground cracks spread beneath him.
- Street lights and building lights flicker. Car alarms go off.
- Screen shake rises and color saturation drains. A low rumble builds into a high whine.
- NPCs within line of sight look up, point, then flee.

#### Release

- **Flash:** full-screen white-out for about 0.3 s, then exposure recovers.
- **Shockwave:** a visible expanding dome travels outward at finite speed (default 250 m/s) to its maximum radius (default 200 m, tunable up to the whole city). Damage applies as the wave front reaches each piece, never all at once.

#### Damage zones (fractions of maximum radius)

| Zone | Radius | Buildings | People | Vehicles |
|---|---|---|---|---|
| **Core** | 0–25% | **Vaporized.** Pieces are deleted and replaced with a dust and ash burst plus a few glowing fragments. | Vaporized (instant ash burst) | Vaporized |
| **Blast** | 25–65% | Torn apart. All pieces break loose, fly outward from the center with a strong radial impulse, and are scorched. | Flung burning ragdolls, heavy dismemberment | Thrown, crushed, burning |
| **Edge** | 65–100% | Facades stripped, all glass gone. Partial collapses wherever supports fail. Interiors burning. | Knocked down, burned, injured | Flipped, on fire |
| **Fringe** | 100–150% | Windows blown in. | Knocked down | Alarms, glass broken |

#### Aftermath

- A mushroom cloud rises and spreads over about 20 s (stacked soft particles and billboards; it must read as a mushroom cloud from across the city).
- A dust ring rolls outward along the streets and slowly settles.
- A glowing crater: deformed ground with a hot center that cools over minutes.
- Ash falls across the city for a while.
- Ambient light shifts orange and gray, and fires burn everywhere in the edge zone.
- Audio:
  - near-silence, then the shockwave roar arrives with distance-based delay;
  - ringing ears (tinnitus whine plus a muffled mix) for several seconds.
- Response heat jumps to maximum immediately (Section 8).

#### Performance rules

This is the hardest moment in the game to keep smooth.

- The core zone never simulates pieces; it deletes them and spawns effects.
- Activation is spread across frames as the wave front advances.
- The global rigid-body budget is enforced. Excess blast-zone pieces become short-lived visual debris (simple ballistic motion, no collision) or are merged.
- Character LODs drop aggressively during and right after the blast.
- Target: never below 30 fps on the reference hardware (Section 13).

---

## 7. Destruction system (the heart of the game)

### 7.1 Building construction model

Every building is assembled from **pieces**:

- **Structural core and columns:** reinforced concrete or steel.
- **Floor slabs:** one or more sections per floor.
- **Facade panels:** one per bay per floor (bay width about 3–4 m, floor height about 3.5 m). Each panel has a material: glass curtain wall, concrete panel, or brick.
- **Interior walls:** partitions between units and rooms.
- **Units:** offices, apartments and shops (Section 7.5).
- **Roof elements:** parapets, HVAC boxes, water tanks, antennas.

Per-piece data:

- material
- current HP
- damage state
- mass
- temperature
- frozen flag
- links in the support graph

Store piece data in typed arrays (structure of arrays). A city can hold tens of thousands of pieces.

**Rendering:**

- Intact pieces are merged or instanced per building for very few draw calls.
- When a piece's state changes, it's split out of the batch and rendered individually, or swapped to its fractured variant.

### 7.2 Damage states

Every piece moves through these states:

1. **Intact.**
2. **Damaged:** cracks, chips, scorch marks or frost, shown with decals or texture blending. Applies at about 70% HP and again at about 40%.
3. **Breached:**
   - The piece swaps to a fractured version with a hole.
   - Some fragments fall.
   - The interior behind it becomes visible (Section 7.5).
4. **Destroyed:** the piece detaches entirely, and its fragments become dynamic rigid bodies (debris).

### 7.3 Damage types

- **Blunt:** punches, thrown objects, falling debris, vehicle impacts.
- **Thermal:** heat vision, fire. Builds temperature; weakens steel; ignites flammables.
- **Cryo:** freeze breath. Makes materials brittle.
- **Blast:** explosions, rockets, the Nova, ground slams. Radial with falloff.
- **Ballistic:** gunfire. Chips concrete, cracks and shatters glass, pocks cars. Cosmetic on most materials, but the military's heavy weapons do real damage.

### 7.4 Materials

Defined in config; each material has its own HP, fracture style, dust color, sounds and thermal behavior.

| Material | Used for | Relative HP | Breaks into | Thermal behavior |
|---|---|---|---|---|
| Reinforced concrete | Columns, cores, slabs | Very high | Chunks with exposed rebar | Scorches, glows, cuts slowly |
| Concrete panel | Facades | High | Chunks plus gray dust | Scorches, burns through |
| Brick | Low-rise facades | Medium | Bricks and clumps, red-brown dust | Scorches |
| Glass curtain wall | Towers | Very low | Shards (falling glass rain) | Shatters, melts at edges |
| Steel | Frames, beams | High | Bends and tears (doesn't shatter) | Glows; loses strength when hot |
| Drywall | Interior walls | Low | Plates plus white dust | Chars, burns |
| Wood and furniture | Interiors | Low | Splinters, broken parts | Highly flammable |
| Vehicles | Cars, trucks, military | Medium to high | Crumple, then parts detach | Ignite; fuel explodes |
| Ground and asphalt | Streets | — | Craters, cracks, lifted slabs | Scorch decals |

### 7.5 Interiors

Every building has real interiors behind its facades.

- **Units:** each floor is divided into units, generated from the building seed.
  - **Office:** desks, cubicle partitions, chairs, monitors, filing cabinets, ceiling light panels, water coolers, plants, meeting tables.
  - **Apartment:** couch, TV, bed, kitchen counter, fridge, dining table, shelves, rugs.
  - **Retail:** shelving, counters, displays.
  - **Parking:** cars.
- **Intact windows** use an **interior-mapping shader**: a fake 3D room seen through the glass, with randomized room layouts and lights on or off (more on at night). This costs almost nothing and makes every building look full.
- **When a facade panel is breached,** the real geometry spawns for that unit and its neighbors:
  - furniture
  - interior walls
  - lighting (cheap emissive fixtures plus a small number of real lights)
  - occupants (Section 9)
- **Persistence:** damaged interiors persist, simplified when far away. Undamaged spawned interiors can despawn when far away and out of view.
- **Power failure:** heavy structural damage cuts the power. Lights flicker and go out floor by floor; at night, damaged buildings go dark.
- **Everything inside is destructible:** furniture breaks, walls blow out, people inside die, and debris and bodies can be blown out of windows.

### 7.6 Structural integrity and collapse

This is what makes the damage feel real.

- **Support graph:** ground → foundation → columns and core → slabs → facades, with each piece linked to the pieces that support it.
- **Disconnection:** when pieces are destroyed, run a connectivity check from the ground. Any cluster no longer connected to the ground falls.
  - Falling clusters start as one (or a few) large rigid bodies.
  - They break apart only on impact, and only within the debris budget.
- **Stress and delayed failure:** clusters that are still connected but badly under-supported accumulate stress. Examples: a tower with a tunnel through it, or one floor with most of its columns cut. The failure sequence:
  1. creaking and groaning audio
  2. dust trickling from cracks, small debris falling
  3. visible sag (slight rotation or offset of the upper section)
  4. collapse after a randomized 2–8 s

  The delay is essential. It's what makes collapses feel heavy and real.
- **Progressive collapse:** falling upper floors hit lower floors and damage them, which can cascade into a pancake collapse down the whole building.
- **Toppling:** a building cut diagonally or on one side tips over and falls into its neighbors, damaging them.
- **Collapse dust:** a huge, dense cloud that rolls down the streets, cuts visibility and slowly settles. This is one of the most important visual effects in the game.
- **Steel weakening:** heated steel members (Section 6.2) temporarily lose support capacity, so heat vision alone can bring a structure down.

### 7.7 Fly-through penetration (sonic speed)

- At or above the sonic threshold, building collisions **do not stop the player**.
- **Implementation:**
  - Each physics step, sweep a sphere (default radius 1.5 m) along the player's path. Never let the player tunnel through without registering hits.
  - Everything inside the swept volume is destroyed: facades, interior walls, furniture, people, and floor slabs if diving.
  - Pieces within a wider radius (default 4 m) take heavy blast damage.
- **Exit:** the exit facade blows outward, and debris sprays out along his velocity: furniture, bodies, glass, chunks.
- **Speed cost:** each building costs some speed (default 15%). Drop below the threshold and he crashes to a stop inside the building, amid the wreckage.
- **Chaining:** keep enough speed and he passes through multiple buildings in a row.
- **Feel:**
  - a brief hitch on entry (about 50 ms of slow motion);
  - heavy camera shake;
  - muffled audio inside, then a burst of sound on exit.
- **Aftermath:** the tunnel triggers a structural check. Tunneled buildings often fail after the delay in Section 7.6.

### 7.8 Debris lifecycle and persistence

1. **Active:** a dynamic rigid body. Counts toward the budget.
2. **Sleeping:** the physics engine has put it to sleep.
3. **Settled:** after a few seconds asleep, it converts to static rubble, merged into instanced or batched geometry. It costs nothing to simulate but **stays visible forever**.

Small fragments (glass, small bits) and dust particles fade out. Large chunks always persist as rubble. Rubble piles form at the bases of collapsed buildings.

**Nothing visible disappears** except particles and the smallest fragments.

### 7.9 Fire and smoke

- Fire spreads between flammable items inside a unit, then to neighboring units, then up floors through broken windows. Spread is slow and tunable, and capped for performance.
- Smoke pours from windows and holes, building into columns that rise above the skyline.
- Fires burn out over time, leaving charred surfaces.
- Vehicle fires; fuel explosions damage nearby pieces and people.
- At night, fires are the main light source in destroyed districts. Use a capped number of real flickering lights plus emissive and bloom.

### 7.10 Vehicles

- **Types:**
  - civilian: sedans, SUVs, vans, buses, box trucks, taxis
  - response: police cruisers, SWAT trucks, Humvees, APCs, tanks, police and military helicopters, fighter jets
- **Damage:**
  - vertex crumple deformation around the impact point
  - glass shatters
  - doors, hoods and bumpers detach
  - burning, then exploding (blast damage plus a burning wreck)
- **Traffic:**
  - Cars follow a lane graph and obey lights.
  - In panic, drivers abandon their cars or drive recklessly, causing crashes and pileups.

### 7.11 Ground and streets

- Craters: deformed ground mesh sections plus decals.
- Cracks and lifted road slabs from heavy impacts.
- Broken hydrants spray water.
- Downed light poles and traffic lights.

---

## 8. Response escalation (heat)

### 8.1 Heat meter

- **Five levels.**
- **Rises** with property damage, casualties and witnessed violence. It rises faster when police witness it.
- **Decays** when he's out of sight long enough (hiding in rubble, flying high and far away).
- **The Nova sets heat to 5 immediately.**
- The debug and spawn menu can set any level or spawn any unit directly.

### 8.2 Levels

| Level | Units | Behavior |
|---|---|---|
| **1: Police** | Cruisers, officers with pistols and shotguns | Respond to the scene, set up perimeters, evacuate civilians, take cover behind cars, open fire. Bullets spark off him. Radio chatter. |
| **2: SWAT and air** | Armored trucks, rifle squads, rooftop snipers, police helicopters with searchlights | Coordinated squads with flanking and flashbangs. Helicopters track him in the air, so flying away isn't a free escape. |
| **3: National Guard** | Humvees, APCs, rocket squads, roadblocks, military helicopters with miniguns and rockets | Rockets stagger him. Their missed shots blow up buildings, cars and civilians: collateral damage caused by the defenders. |
| **4: Military** | Tanks, anti-aircraft vehicles, attack helicopters, fighter jets | Jets make strafing and missile runs, loop around and come back. Tank shells stagger him hard. Air strikes level things themselves. |
| **5: Task Force HALT** | Specialist units carrying dampener technology (Section 8.3), plus everything from level 4 | The only force that can actually hurt him. |

### 8.3 The weakness: Task Force HALT and dampener tech

This is an original weakness, not a copy of any comic hero's.

- **Dampener field pylons:** deployed by Task Force units on the ground and on rooftops. Each projects a visible distortion field (a shimmering sphere with a low hum).
- **Dampener rounds:** from Task Force rifles and vehicle weapons.
- **Dampener drones:** small, fast, swarm toward him.
- **Inside a field or under fire:**
  - Flight ceiling and top speed drop.
  - Heat vision and freeze breath weaken.
  - The Nova can't charge.
  - He **actually takes damage.**
  - The screen desaturates and a heartbeat plays.
- **Counterplay:** destroy the pylons (they're physical and destructible), kill the operators, throw things at drones, or flee the field.
- **Player health** only matters against HALT. It regenerates outside fields.
- **At zero health:**
  1. He collapses.
  2. A brief slow-motion fade.
  3. He respawns on a rooftop elsewhere in the city with heat reset to 2. All destruction persists.
- **God mode toggle** in the sandbox menu ignores HALT damage entirely.

### 8.4 Response AI

- **Spawning:** units spawn out of view (city edges, behind buildings) and drive or fly in. **Never spawn in view.**
- **Tracking:** units converge on his last known position, then search when they lose sight of him.
- **Combat:** cover use, flanking, suppression, and squad formations for SWAT, Guard and HALT.
- **Morale:** units can break and flee when overwhelmed (squad wiped, tank thrown into them). Fleeing and screaming soldiers sell the power fantasy.
- **Vehicles:**
  - Police cars pursue on roads.
  - Helicopters orbit at a standoff distance.
  - Jets do attack runs.
- **All their weapons damage the world and civilians** with the same systems the player uses.

---

## 9. Humans (civilians, police, soldiers)

### 9.1 Realism requirement (non-negotiable)

- **No blocky, boxy or low-poly-faceted humans.** No sharp edges.
- Smooth, realistic, skinned meshes with realistic proportions.
- PBR materials for skin, hair and clothing.
- Smooth animation blending.
- Aim for the most realistic humans achievable within the performance budget, using LOD so detail stays high close to the camera.

### 9.2 Asset pipeline

- **Source:** Mixamo (Adobe's free character and animation library; royalty-free for use in projects). The user downloads characters and animations into `assets-src/mixamo/` (shopping list in Appendix A).
- **Pipeline script** (`scripts/build-characters.ts` or similar; run with `npm run assets`):
  1. **Convert** FBX to GLB, using `fbx2gltf` or the Blender command line, whichever works best on the user's machine. Document the setup.
  2. **Retarget** all animations to one shared skeleton. Mixamo rigs share bone names, so animations transfer across characters.
  3. **Compress** with `@gltf-transform` (meshopt geometry compression, KTX2 textures).
  4. **Generate LODs** with meshoptimizer simplification: LOD0 full, LOD1 about 40%, LOD2 about 12%.
  5. **Bake animations to textures** (vertex animation textures) for the crowd LOD.
  6. **Pre-split each character's mesh into dismemberment regions** by dominant bone weight, and generate wound-cap geometry at each cut boundary (Section 9.6):
     - head
     - left and right upper arm and forearm
     - left and right thigh and shin
     - upper and lower torso
- **Variety:** several base bodies, with clothing and skin tint variation via shader parameters, hair variants, and ±8% height variation. Crowds must not look cloned.
- **Placeholders:** until the user provides assets, use smooth procedural humanoids (capsules and spheres with soft normals). **Never boxes.** Build every system so swapping in real assets requires no code changes beyond config.

### 9.3 Rendering and LOD budget

| Tier | Distance (default) | Technique | Max count |
|---|---|---|---|
| LOD0 | < 25 m | Full skinned mesh, full animation rate | 40 |
| LOD1 | 25–80 m | Simplified skinned mesh, reduced animation update rate | 150 |
| LOD2 crowd | > 80 m | Instanced, animation baked to textures, one draw call per variant | Hundreds |

Animation updates are throttled by distance and visibility. Off-screen characters animate at a very low rate or not at all.

### 9.4 Civilian behavior

- **Ambient life:**
  - walk the sidewalks
  - wait at crosswalks
  - sit on benches
  - stand at bus stops
  - enter and exit buildings
  - drive (Section 7.10)
- **Panic state machine:**
  1. **Notice:** sight of the player doing violence, a loud sound, a blast, or nearby panic.
  2. **React:** startle, look, point, scream, or freeze in place.
  3. **Flee:** away from the threat, down sidewalks, into alleys and buildings, away from collapse zones. People stumble and fall in crowds.
  - **Hide:** some cower behind cars or in doorways.
  - **Film:** some hold up phones and film from what they think is a safe distance.
  - **Injured:** some limp, crawl or call for help.
  - Panic spreads by proximity and sound, so a crowd stampedes outward from an event.
- **Inside buildings:** occupants flee toward stairwells, hide under desks, and can be blown out of windows.
- **Navigation:** navmesh for streets, sidewalks and spawned interiors (`recast-navigation` for three.js). Local avoidance so crowds flow, with no stacking or jitter.

### 9.5 Ragdolls

- On a lethal or high-force hit, the character switches from animation to a physics ragdoll:
  - capsules per major bone, joint limits
  - inherits the current pose and velocity, so there's no pop
- Budget: at most 30 ragdolls active at once.
- When a ragdoll comes to rest, it freezes into a static posed corpse (cheap) and stays in the world.
- Corpses are capped at about 400; past that, the oldest off-screen corpses fade.

### 9.6 Gore

The gore system is a core feature, not an afterthought.

- **Dismemberment** (per region, Section 9.2), triggered by force thresholds or specific damage:
  - The region's bone is collapsed (scaled to zero) on the body.
  - A severed-limb mesh spawns with its own physics.
  - Wound caps (flesh and bone material) appear on the stump and the limb.
  - Blood spurts from the stump for a few seconds.
- **Full-body destruction** at extreme force: a direct sonic fly-through hit, a thrown bus, the Nova blast zone, a point-blank ground slam. The body breaks into multiple chunks with a large blood burst and a red mist cloud.
- **Blood:**
  - GPU particle sprays and droplets with gravity.
  - Splatter decals on walls, ground, vehicles, interiors and the player's suit.
  - Pools that grow under corpses, and drag trails from crawling injured people.
  - Decals live in a capped pool (default 600) and recycle the oldest.
- **Deaths by power:**
  - **Strength:** impact dismemberment, ragdoll flight, wall splats.
  - **Heat vision:** clothing and skin char (material blends to burned), embers, smoke. Sustained fire burns the body to a charred husk, then collapses it into ash.
  - **Freeze breath:** a frozen statue. Any impact shatters it into ice-glazed frozen chunks with almost no blood.
  - **Sonic fly-through:** anyone directly in the path is obliterated.
  - **Nova:** vaporized in the core (instant ash burst); flung, burning and dismembered in the blast zone.
  - **Falling debris:** crushed under rubble, with blood pooling out.
  - **Explosions** (vehicles, military fire): thrown, dismembered, burning.
- **Gore level setting:** Off / Normal / Max, defaulting to **Max**. It exists only so the user can isolate performance problems.

---

## 10. Sandbox features and HUD

### 10.1 HUD (minimal, clean)

- Reticle
- Heat level indicator
- Power meters: heat vision overheat, freeze breath, Nova charge (glows when full)
- Speed indicator with a marker at the sonic threshold
- **Damage bill:** running property-damage total in dollars, ticking up live
- Casualty counter
- HUD fades out after a few seconds without combat. Toggle to hide completely.

### 10.2 Slow motion

Toggle to 0.25× speed with audio pitch-shifted down, including physics and effects. It must work smoothly during collapses and the Nova.

### 10.3 Photo mode / free camera

Pause the simulation, detach the camera and fly freely. Adjustable FOV, depth of field, exposure, and a hide-HUD option. Screenshot key.

### 10.4 Spawn menu

- Set heat level
- Spawn any response unit or vehicle
- Spawn a crowd or traffic burst at the reticle
- Fill the Nova meter
- God mode toggle
- Time of day slider
- Reset city (same seed or new seed)

### 10.5 Settings

Graphics quality presets (which also scale budgets), gore level, mouse sensitivity, invert Y, key and gamepad rebinding, audio volumes.

---

## 11. Audio

Audio sells weight and scale as much as visuals do.

- **Impacts:** material-based (concrete, glass, metal, flesh), layered by mass. Big debris adds a low-frequency rumble.
- **Collapses:** groaning steel, cracking concrete, then a long roar, then a rolling rumble as the dust spreads.
- **Glass:** distinct sounds for single panes versus curtain-wall cascades (glass rain).
- **Powers:**
  - heat vision hum and sizzle (pitch varies by material)
  - freeze breath crackle
  - punch thuds
  - sonic boom crack
  - Nova wind-up whine, then a silence beat, then the roar
- **Distance:** realistic falloff, plus **sound travel delay** for big events, so distant collapses and the Nova are seen first and heard later.
- **World:**
  - sirens with Doppler
  - helicopter rotors, jet flybys
  - gunfire by weapon type with distance falloff
  - radio chatter
  - car alarms
  - crowd screams and a panic bed scaled by nearby crowd density
- **Spaces:** muffled mix inside buildings and wreckage; ringing ears after near blasts.
- **Sources:** start with synthesized placeholders (Web Audio). The user can drop CC0 sound packs into `assets-src/audio/`; map them through a config file.

---

## 12. Visual quality

- PBR materials throughout, filmic tone mapping (AgX or ACES), HDR environment lighting.
- Sun with cascaded shadow maps.
- Ambient occlusion (SSAO or GTAO).
- Bloom for heat vision, fire, explosions and the Nova.
- Soft, depth-faded particles for dust, smoke and fire, with lighting from the sun and fires where affordable.
- Heat distortion around beams, fires and the Nova.
- Projected decals for scorch, cracks, blood, frost and craters.
- Optional motion blur at high speed; depth of field in photo mode.
- **Renderer:** use the three.js WebGPU renderer if it's stable in the current release (with its built-in post-processing), otherwise WebGLRenderer with the `postprocessing` library. Log the choice in `docs/DECISIONS.md`.

---

## 13. Performance (hard rules)

### Reference target

- 60 fps at 1080p on a mid-range gaming desktop (RTX 3060 class GPU, 6-core CPU), Chrome.
- Never below 30 fps during a Nova on that hardware.
- Quality presets scale everything down for weaker machines.

### Default budgets (tunable, enforced at runtime)

| Resource | Budget |
|---|---|
| Active dynamic rigid bodies | 800 |
| Active ragdolls | 30 |
| LOD0 characters | 40 |
| Decals | 600 |
| Particles | 60,000 |
| Shadow-casting lights | 4 |
| Non-shadow dynamic lights | 32 |
| Draw calls (typical gameplay) | < 1,000 |

### Required techniques

- Instancing and merging, LOD, frustum and distance culling.
- Physics sleeping, plus debris-to-static conversion (Section 7.8).
- Spread heavy work (activation waves, structural checks, interior spawning) across frames.
- Object pools for particles, debris, decals and characters.
- No garbage-collector churn in hot loops.
- Fixed-timestep physics at 60 Hz with interpolated rendering. Substep for the player at high speed.
- Move structural analysis or other heavy computation into Web Workers if it causes frame spikes.

### Performance HUD (always available)

FPS, frame-time graph, draw calls, triangles, active bodies, ragdolls, characters per LOD tier, decals, particles, and memory.

---

## 14. Engineering

### 14.1 Stack

- TypeScript (strict mode), Vite, three.js.
- Rapier physics (`@dimforge/rapier3d-compat`).
- `recast-navigation` (navmesh), `three-bvh-csg` (runtime cuts, if needed).
- `@gltf-transform` and meshoptimizer (asset pipeline).
- Tweakpane or lil-gui (debug panel).
- Vitest (unit tests for logic: structural graph, heat system, damage math).
- Playwright (smoke tests, screenshots, performance runs).
- ESLint and Prettier.

### 14.2 Architecture

- System-based (or lightweight ECS) game loop:
  - fixed-timestep update for simulation
  - variable rendering with interpolation
- Central event bus for game events: damage, death, collapse, heat change, Nova, and so on. Audio, effects, HUD and the response system subscribe to it.
- Data-driven config for powers, materials, NPC types, response units, budgets and controls.
- Deterministic city generation from a seed.

### 14.3 Folder structure

```
ground-zero/
  CLAUDE.md
  DESIGN.md
  docs/DECISIONS.md
  assets-src/          # raw downloads (Mixamo FBX, audio) — not shipped
  public/assets/       # processed GLB, KTX2 textures, audio
  scripts/             # asset pipeline, perf runner
  src/
    config/            # all tunables
    core/              # loop, time, input, events, pools, workers
    render/            # renderer, post, LOD, decals, interior-mapping shader
    physics/           # Rapier setup, layers, queries
    world/             # city generation, streets, props, traffic graph, time of day
    destruction/       # pieces, damage, fracture, structural graph, debris lifecycle, fire
    interiors/         # unit generation, furnishing, spawn/despawn
    player/            # controller, flight states, camera, animation
    powers/            # strength, heat vision, freeze, slam, sonic, nova
    npc/               # civilians, crowds, navigation, panic, ragdoll, gore
    response/          # heat, police, SWAT, guard, military, HALT
    vehicles/
    fx/                # particles, dust, smoke, fire, blood, shockwaves, mushroom cloud
    audio/
    ui/                # HUD, debug panel, spawn menu, photo mode, settings
  tests/
```

### 14.4 Verification (every milestone)

- `npm run dev` starts the game with no console errors.
- `npm test` passes.
- **Playwright smoke test:** load the game, fly a scripted path, punch a wall, screenshot key moments into `test-results/`. Look at the screenshots yourself before reporting a milestone done.
- **Playwright perf run** (`npm run perf`): a scripted camera path through heavy destruction (and a Nova, once it exists). Logs average and 95th-percentile frame times plus peak body counts, and fails if they exceed budgets. Report the numbers to the user.

### 14.5 Debug tools

- Debug panel bound to all config values.
- Physics wireframe view.
- **Structural overlay:** pieces colored by stress (green → red), unsupported clusters highlighted.
- Navmesh view.
- Time scale control.
- Spawn tools.
- Teleport.
- Seed input.

---

## 15. Milestones

Each milestone ends with verification (Section 14.4) and a stop for the user's playtest.

### M0: Foundation

- Vite, TypeScript, three.js and Rapier project.
- `CLAUDE.md` and `docs/DECISIONS.md`.
- Game loop, input (keyboard and gamepad), config system, debug panel, performance HUD.
- Playwright smoke test and perf runner scaffolding.
- Empty ground plane with sky and sun.

**Done when:** it runs, the HUD shows stats, and the tests pass.

### M1: Flight and camera

- Smooth placeholder hero.
- All movement states (Section 5) with full camera behavior.
- Sonic boom effects.
- Gray-box city of simple blocks.

**Done when:** flying feels effortless and fast, transitions are smooth, he never gets stuck, and the boom feels huge.

### M2: Destructible buildings

- Procedural city with real building construction (Section 7.1).
- Materials, damage states, fracture.
- Debris lifecycle and persistence.
- Support graph with delayed and progressive collapse.
- Collapse dust.
- Punch, grab and throw (pieces), ground and dive slam.

**Done when:**
- Punching visibly cracks, then holes, a wall.
- Cutting a building's supports makes it creak, sag and collapse.
- Debris stays.
- 60 fps holds.

### M3: Interiors and fire

- Units and furnishing.
- Interior-mapping shader on windows.
- Breach spawns the real interior.
- Power failure.
- Fire and smoke spread.

**Done when:** every building looks occupied through its windows, and breaking any wall reveals a real, furnished, destructible room.

### M4: Heat vision, freeze breath, sonic fly-through

- Full behavior from Sections 6.2, 6.3 and 7.7.
- Heat vision damages the exterior and the interior behind it, and its cuts can drop buildings.

**Done when:** flying through a tower at sonic speed blows a tunnel through it, sprays debris out the far side, and the tower may collapse seconds later.

### M5: Humans and traffic

- Asset pipeline (requires the user's Mixamo downloads; use smooth placeholders until then).
- LOD tiers and crowd rendering.
- Ambient behavior, panic, navigation.
- Interior occupants.
- Vehicles, traffic, vehicle damage.

**Done when:** streets feel alive with realistic people, and violence triggers believable, spreading panic.

### M6: Ragdolls and gore

- The full Section 9.5–9.6 systems, including power-specific deaths.

**Done when:** every power kills in its own distinct, visceral way within budget.

### M7: Response, levels 1–3

- Heat meter, police, SWAT, helicopters, National Guard, response AI.

**Done when:** a rampage escalates naturally from police to the Guard, and units act like squads, not targets.

### M8: Nova blast

- Full Section 6.6 implementation.

**Done when:**
- The wind-up builds dread.
- The release levels several blocks with readable zones.
- The mushroom cloud reads from across the city.
- Never below 30 fps on the reference hardware.

### M9: Military and Task Force HALT

- Response levels 4–5.
- Jets, tanks, air strikes.
- Dampener tech, player health, respawn, god mode.

**Done when:** HALT is genuinely threatening, and destroying its pylons is satisfying.

### M10: Polish

- Audio pass.
- Visual pass (post-processing, lighting, effects).
- Day/night cycle.
- Slow motion, photo mode, spawn menu, settings.
- Suit grime accumulation.

### M11: Scale and optimization

- City grows toward 2 km × 2 km with streaming and LOD for distant districts.
- Full optimization pass against the budgets.
- Quality presets.

---

## 16. Never do

- Blocky, boxy or faceted human models, including placeholders.
- Respawning or resetting damaged buildings during a session, except via an explicit "reset city".
- Despawning visible debris or rubble (only particles and tiny fragments may fade).
- Invisible walls inside the city bounds, or a player who can get stuck in geometry.
- Spawning units or civilians inside the player's view.
- Loading screens or hitches during play. Stream and spread work across frames.
- Hardcoded tunables. Everything goes in config.
- Copying any existing comic character's name, costume, emblem or signature weakness.
- Silently dropping or weakening a requirement. Log trade-offs in `docs/DECISIONS.md` and tell the user.

---

## Appendix A: Mixamo shopping list (for the user)

Download from mixamo.com (free Adobe account). Put character files in `assets-src/mixamo/characters/` and animation files in `assets-src/mixamo/animations/`.

### Download settings

- **Characters:** Format **FBX Binary (.fbx)**, Pose **T-pose**.
- **Animations:** Format **FBX Binary**, Skin **Without Skin**, **30 fps**, Keyframe reduction **none**. Tick **In Place** whenever the option appears (walks, runs).

### Characters

Pick the most realistic-looking ones available:

- 6–10 civilians: mixed ages, body types and clothing (business, casual, workwear)
- 1–2 police officers (or a uniformed character to retexture)
- 1–2 SWAT or tactical characters
- 1–2 soldiers
- 1 for the hero (a tall, strong build; the suit gets retextured)

### Animations

Search Mixamo for the closest match to each:

- **Civilian:**
  - several idles
  - walk, run, sprint
  - scared and terrified idle, cower or crouch-and-cover, looking up and pointing
  - panicked run
  - stumble and fall, get up
  - crawl, limping walk
  - sitting idle
  - holding a phone up
- **Combat (police, SWAT, soldiers):**
  - pistol idle and aim, pistol shoot, pistol run
  - rifle idle and aim, rifle shoot, rifle run, reload
  - crouch with rifle, take cover
  - throwing (grenades, flashbangs)
  - talking on radio
- **Reactions:** hit reactions (front, back), knockdowns, death variations (fallbacks for when ragdolls are over budget).
- **Hero:**
  - flying or hovering poses
  - superhero-style landing
  - punch combos, uppercut
  - lift heavy object, throw object
  - a power-up or charging pose for the Nova wind-up

If the repo is ever made public, keep the raw Mixamo files out of it.

## Appendix B: Open decisions for the user

- Final hero name and look (working name: ZERO).
- City name (working name: Port Halcyon).
- Whether to keep the casualty counter visible on the HUD.
- Nova default radius once it can be playtested.
