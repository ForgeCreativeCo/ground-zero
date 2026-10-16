import { config } from '../config';
import type { Game } from './game';
import { runPerfPath } from './perfRun';

/** window.__GZ__: the surface Playwright (smoke + perf) drives the game through. */
export function installTestHooks(game: Game) {
  const hooks = {
    get ready() {
      return game.ready;
    },
    /** Background shader warm-up finished. */
    get warm() {
      return game.warm;
    },
    get frame() {
      return game.frame;
    },
    seed: game.seed,
    backend: game.renderer.backendName,
    config,
    snapshot: () => ({ ...game.snapshot }),
    /** Hold/release a raw input id ("KeyW", "Space", "Mouse0", "Pad:A"). */
    setHeld: (id: string, held: boolean) => game.input.setHeld(id, held),
    /** Free-fly debug camera pose (when debug.freeCamera is on). */
    cameraPose: () => {
      const c = game.freeCam;
      return { x: c.position.x, y: c.position.y, z: c.position.z, yaw: c.yaw, pitch: c.pitch };
    },
    setCameraPose: (x: number, y: number, z: number, yaw: number, pitch: number) =>
      game.freeCam.setPose(x, y, z, yaw, pitch),
    /** Rendered camera position (third-person or free). */
    renderCamera: () => {
      const p = game.renderer.camera.position;
      return { x: p.x, y: p.y, z: p.z, fov: game.renderer.camera.fov };
    },
    /** True if the rendered camera is inside solid geometry (it never should be). */
    cameraInsideGeometry: () => {
      const p = game.renderer.camera.position;
      const hit = game.physics.world.projectPoint(
        { x: p.x, y: p.y, z: p.z },
        true,
        game.physics.R.QueryFilterFlags.EXCLUDE_DYNAMIC,
        undefined,
        game.player.playerCollider,
      );
      return !!hit?.isInside;
    },
    player: () => {
      const pl = game.player;
      return {
        x: pl.position.x,
        y: pl.position.y,
        z: pl.position.z,
        vx: pl.velocity.x,
        vy: pl.velocity.y,
        vz: pl.velocity.z,
        speed: pl.speed,
        state: pl.state,
        band: pl.band,
        diving: pl.diving,
        stats: { ...pl.stats },
      };
    },
    setLook: (yaw: number, pitch: number) => {
      game.rig.yaw = yaw;
      game.rig.pitch = pitch;
    },
    look: () => ({ yaw: game.rig.yaw, pitch: game.rig.pitch }),
    /** World position of the hero model's chest (render side), for framing checks. */
    heroModel: () => {
      const v = game.hero.chestWorld();
      return { x: v.x, y: v.y, z: v.z };
    },
    teleportPlayer: (x: number, y: number, z: number) => game.teleport(x, y, z),
    /** Sets the hero's velocity (m/s): sonic runs without a long runway. */
    setPlayerVelocity: (vx: number, vy: number, vz: number) => {
      const v = game.player.velocity;
      v.x = vx;
      v.y = vy;
      v.z = vz;
    },
    resetPlayer: () => game.resetPlayer(),
    /** City footprint for tests that need a building to aim at. */
    buildings: () => game.city.layout.buildings.map((b) => ({ ...b })),
    spawnTestBodies: (n: number) => game.spawnTestBodies(n),
    toggleDebugPanel: () => game.debugPanel.toggle(),
    debugPanelVisible: () => game.debugPanel.visible,
    runPerfPath: (seconds?: number) => runPerfPath(game, seconds),
    /** Destruction counters (pieces, colliders, debris, rubble, falling sections, bill). */
    destruction: () => ({
      ...game.destruction.stats(),
      failing: game.destruction.structure.failures.size,
      craters: game.ground.craterCount,
      strength: { ...game.strength.stats },
      holding: !!game.strength.holding,
      action: game.strength.action,
    }),
    /** Destructible buildings: index, footprint, floors, district. */
    structures: () =>
      game.destruction.city.buildings.map((b) => ({
        index: b.id,
        x0: b.x0,
        x1: b.x1,
        z0: b.z0,
        z1: b.z1,
        floors: b.floors,
        height: b.height,
        district: b.src.district,
        pieces: b.count,
      })),
    /** State of the piece nearest a point: id, kind, state, hp fraction (or null). */
    pieceAt: (x: number, y: number, z: number, r = 1.5) => {
      const id = game.destruction.city.nearestPiece(x, y, z, r);
      if (id < 0) return null;
      const s = game.destruction.city.store;
      return {
        id,
        kind: s.kind[id]!,
        state: s.state[id]!,
        hp: s.hp[id]! / s.maxHp[id]!,
        material: s.mat[id]!,
      };
    },
    piecesInSphere: (x: number, y: number, z: number, r: number) => {
      const ids: number[] = [];
      game.destruction.city.forEachPieceInSphere(x, y, z, r, (id) => ids.push(id));
      return ids.length;
    },
    pieceState: (id: number) => {
      const s = game.destruction.city.store;
      return {
        state: s.state[id]!,
        hp: s.hp[id]! / s.maxHp[id]!,
        inCluster: (s.flags[id]! & 4) !== 0,
      };
    },
    interiors: () => ({
      ...game.interiors.stats(),
      burning: game.fire.burning.size,
      openFires: game.fire.points.length,
      unitsBurnt: game.fire.unitsBurnt,
    }),
    unitAt: (x: number, y: number, z: number) => {
      const u = game.interiors.unitAt(x, y, z);
      if (u < 0) return null;
      const us = game.interiors.units;
      return {
        id: u,
        type: us.type[u]!,
        flags: us.flags[u]!,
        fire: us.fire[u]!,
        fuel: us.fuel[u]!,
        spawned: game.interiors.isSpawned(u),
      };
    },
    /** Heat vision, freeze breath and fly-through state (M4). */
    powers: () => ({
      heat: {
        ...game.heat.stats,
        level: game.heat.meter.level,
        locked: game.heat.meter.locked,
        firing: game.heat.firing,
        target: game.heat.target,
        hit: { x: game.heat.hit.x, y: game.heat.hit.y, z: game.heat.hit.z },
      },
      breath: {
        ...game.breath.stats,
        level: game.breath.meter.level,
        exhausted: game.breath.meter.exhausted,
        firing: game.breath.firing,
      },
      fly: { ...game.flyThrough.stats, inside: game.flyThrough.inside.size },
      energy: {
        ...game.energy.stats,
        charging: game.energy.charging,
        charge: game.energy.charge,
        inFlight: game.energy.balls.filter((b) => b.live).length,
      },
      penetrating: game.player.penetrating,
      hotPieces: game.destruction.hot.size,
      frozenPieces: game.destruction.frozenSet.size,
      decals: game.effects.decals.count,
    }),
    /** Nova state (M8). */
    nova: () => ({
      ...game.nova.stats,
      meter: game.nova.meter,
      phase: game.nova.phase,
      windup: game.nova.windupK,
      front: game.nova.front,
      radius: game.nova.radius,
      locked: game.player.locked,
      cloud: game.novaFx.cloud.active,
    }),
    fillNova: () => game.nova.fill(),
    /** Temperature (°C) and frozen seconds of a piece. */
    pieceThermal: (id: number) => {
      const s = game.destruction.city.store;
      return { temperature: s.temperature[id]!, frozen: s.frozen[id]!, soot: s.soot[id]! };
    },
    igniteAt: (x: number, y: number, z: number) => game.fire.igniteAt(x, y, z),
    igniteUnit: (u: number) => game.fire.ignite(u, 0.6),
    fireUnderReticle: () => game.fireUnderReticle(),
    floorPower: (b: number, f: number) => game.interiors.floorPower(b, f),
    cutStory: (building: number, story: number, fraction = 1) =>
      game.destruction.cutStory(building, story, fraction),
    /** Buildings currently failing (creaking/sagging), by index. */
    failingBuildings: () => [...game.destruction.structure.failures.keys()],
    /** Static pieces left in a building. */
    buildingIntact: (building: number) => {
      const b = game.destruction.city.buildings[building]!;
      const s = game.destruction.city.store;
      let n = 0;
      for (let id = b.base; id < b.end; id++) if (s.isStatic(id)) n++;
      return { staticPieces: n, total: b.count };
    },
    bodySample: (i: number) => game.testBodies.debugSample(i),
  };
  (window as unknown as { __GZ__: typeof hooks }).__GZ__ = hooks;
  return hooks;
}

export type TestHooks = ReturnType<typeof installTestHooks>;
