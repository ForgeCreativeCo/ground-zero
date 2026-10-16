import * as THREE from 'three/webgpu';
import { Synth } from '../audio/synth';
import { config, getSeed, loadOverrides } from '../config';
import { DestructionSystem } from '../destruction/destruction';
import { HeatBeams } from '../fx/beams';
import { Effects } from '../fx/effects';
import { EnergyBallFx } from '../fx/energyBallFx';
import { FireSystem } from '../fx/fire';
import { InteriorSystem } from '../interiors/interiorSystem';
import { EnergyBall } from '../powers/energyBall';
import { FlyThrough } from '../powers/flyThrough';
import { FreezeBreath } from '../powers/freezeBreath';
import { HeatVision } from '../powers/heatVision';
import { Strength } from '../powers/strength';
import { Environment } from '../render/environment';
import { updateInteriorUniforms } from '../render/interiorMapping';
import { glowBrightness } from '../render/pieceMaterials';
import { ShaderWarmup } from '../render/shaderWarmup';
import { GameRenderer } from '../render/renderer';
import { Physics } from '../physics/physics';
import { TestBodies } from '../physics/testBodies';
import { CameraRig, type CameraTarget } from '../player/cameraRig';
import { PlayerController } from '../player/controller';
import { FreeCamera } from '../player/freeCamera';
import { HeroModel, type HeroPoseInput } from '../player/heroModel';
import { DebugPanel } from '../ui/debugPanel';
import { Hud } from '../ui/hud';
import { emptySnapshot, PerfHud, type PerfSnapshot } from '../ui/perfHud';
import { Speedometer } from '../ui/speedometer';
import { GrayboxCity } from '../world/city';
import { Ground } from '../world/ground';
import { events } from './events';
import { FrameStats } from './frameStats';
import { Input } from './input';
import { FixedStepLoop } from './loop';
import { PerfRecorder } from './perfRecorder';

const _spawnAt = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _center = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _slam = new THREE.Vector3();
const _eyeL = new THREE.Vector3();
const _eyeR = new THREE.Vector3();

/** Wires every system together and owns the frame loop (DESIGN.md §14.2). */
export class Game {
  readonly seed = getSeed();
  readonly scene = new THREE.Scene();
  readonly renderer: GameRenderer;
  readonly input: Input;
  readonly stats = new FrameStats(config.debug.graphFrames);
  readonly snapshot: PerfSnapshot = emptySnapshot();
  readonly recorder = new PerfRecorder();
  readonly freeCam = new FreeCamera();
  physics!: Physics;
  testBodies!: TestBodies;
  environment!: Environment;
  ground!: Ground;
  city!: GrayboxCity;
  player!: PlayerController;
  hero!: HeroModel;
  rig!: CameraRig;
  effects!: Effects;
  synth!: Synth;
  destruction!: DestructionSystem;
  strength!: Strength;
  hud!: Hud;
  interiors!: InteriorSystem;
  fire!: FireSystem;
  heat!: HeatVision;
  breath!: FreezeBreath;
  flyThrough!: FlyThrough;
  beams!: HeatBeams;
  energy!: EnergyBall;
  energyFx!: EnergyBallFx;
  perfHud!: PerfHud;
  speedometer!: Speedometer;
  debugPanel!: DebugPanel;
  ready = false;
  frame = 0;
  /** Interpolated hero feet position used for rendering this frame. */
  readonly heroPos = new THREE.Vector3();

  private simLoop: FixedStepLoop;
  /** The debug camera ignores pause/time scale, so it has its own fixed loop. */
  private camLoop: FixedStepLoop;
  private lastTime = -1;
  private wireframe: THREE.LineSegments | null = null;
  private statsTimer = 0;
  /** Reused every frame (no per-frame allocation). */
  private pose: HeroPoseInput = {
    state: 'grounded',
    speed: 0,
    horizontalSpeed: 0,
    verticalSpeed: 0,
    dirX: 0,
    dirY: 1,
    dirZ: 0,
    lookYaw: 0,
    charging: 0,
    landing: false,
    diving: false,
    boosting: false,
    aim: 0,
    lookPitch: 0,
    action: 'none',
    actionT: 0,
  };
  /** Fly-through entry hitch: real seconds of slow motion left. */
  private hitchTimer = 0;
  private sonicTimer = 0;
  private camTarget: CameraTarget = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    grounded: true,
  };
  /** Per-frame hook for scripted runs (perf path, tests). */
  onFrame: ((realDt: number) => void) | null = null;

  constructor(private readonly root: HTMLElement) {
    const rejected = loadOverrides();
    if (rejected.length) console.warn('[config] ignored stale overrides:', rejected);
    this.renderer = new GameRenderer(root, this.scene);
    this.input = new Input(this.renderer.canvas);
    const stepDt = 1 / config.loop.stepHz;
    this.simLoop = new FixedStepLoop(stepDt);
    this.camLoop = new FixedStepLoop(stepDt);
  }

  async init() {
    await this.renderer.init();
    this.physics = await Physics.create(this.simLoop.stepDt);
    this.environment = new Environment(this.scene, this.renderer.renderer);
    this.city = new GrayboxCity(this.scene, this.physics, this.seed);
    this.ground = new Ground(this.scene, this.physics, this.city.layout);
    this.testBodies = new TestBodies(this.physics, this.scene, config.budgets.activeRigidBodies);
    this.player = new PlayerController(this.physics);
    this.hero = new HeroModel(this.scene);
    this.rig = new CameraRig(this.physics, this.player.playerCollider);
    this.scene.add(this.renderer.camera); // speed lines ride on the camera
    this.effects = new Effects(this.scene, this.renderer.camera);
    this.synth = new Synth();
    const tD = performance.now();
    this.destruction = new DestructionSystem(
      this.scene,
      this.physics,
      this.city.layout,
      this.seed,
      this.effects,
    );
    this.strength = new Strength(this.physics, this.destruction, this.player, (x, y, z, sp, dive) =>
      this.slamAt(x, y, z, sp, dive),
    );
    this.wireDestructionEvents();
    this.interiors = new InteriorSystem(this.scene, this.destruction, this.seed);
    this.fire = new FireSystem(this.scene, this.destruction, this.interiors);
    this.heat = new HeatVision(
      this.physics,
      this.destruction,
      this.interiors,
      this.fire,
      this.effects,
      this.player,
    );
    this.breath = new FreezeBreath(
      this.physics,
      this.destruction,
      this.fire,
      this.effects,
      this.player,
    );
    this.flyThrough = new FlyThrough(this.destruction, this.interiors, this.effects, this.player);
    this.player.penetrator = this.flyThrough;
    this.beams = new HeatBeams(this.scene);
    this.energy = new EnergyBall(
      this.physics,
      this.destruction,
      this.interiors,
      this.fire,
      this.player,
    );
    this.energyFx = new EnergyBallFx(this.scene, this.effects);
    this.effects.decals.pieceStanding = (id) => this.destruction.city.store.isStatic(id);
    events.on('player:tunnelEnter', () => (this.hitchTimer = config.flyThrough.hitchTime));
    console.log('[boot] destruction', (performance.now() - tD).toFixed(0), 'ms');
    this.hud = new Hud(this.root);
    this.perfHud = new PerfHud(this.root);
    this.speedometer = new Speedometer(this.root);
    this.debugPanel = new DebugPanel(this.root, this.seed, {
      spawnTestBodies: () => this.spawnTestBodies(config.debug.testBodiesPerSpawn),
      clearTestBodies: () => this.testBodies.clear(),
      resetCamera: () => this.resetPlayer(),
      teleport: (x, y, z) => this.teleport(x, y, z),
      toggleFullscreen: () => void toggleFullscreen(),
      cutStory: () => this.cutStoryUnderReticle(),
      startFire: () => this.fireUnderReticle(),
      toggleNight: () => {
        config.sun.elevationDeg = config.sun.elevationDeg > 0 ? -12 : 38;
      },
    });
    this.snapshot.backend = this.renderer.backendName;
    this.snapshot.seed = this.seed;
    this.resetPlayer();
    // Compile only what is on screen now, so the game starts quickly. Everything that shows up
    // later (debris, falling sections, furniture, fire...) warms up in the background.
    const tC = performance.now();
    await this.renderer.compileForScenePass(this.scene);
    console.log(
      '[boot] compile',
      (performance.now() - tC).toFixed(0),
      'ms',
      'programs',
      this.renderer.renderer.info.memory.programs,
      'materials',
      countMaterials(this.scene),
    );
    events.emit('city:reset', { seed: this.seed });
    this.renderer.setAnimationLoop(this.tick);
    void this.warmUp();
  }

  /** True once every shader that can appear later has been compiled. */
  warm = false;

  /** Background shader warm-up (see render/shaderWarmup.ts). */
  private async warmUp() {
    const t0 = performance.now();
    const w = new ShaderWarmup(this.scene, this.destruction.structure.pool.allMeshes());
    await w.run(this.renderer.camera, (root, cam) => this.renderer.compileForScenePass(root, cam));
    // Pieces revealed during warm-up keep their counts; re-sync the batches anyway.
    this.destruction.renderer.markAllDirty();
    this.warm = true;
    console.log(
      '[boot] background warm-up',
      (performance.now() - t0).toFixed(0),
      'ms',
      w.size,
      'meshes',
    );
  }

  resetPlayer() {
    const s = config.player.spawn;
    this.player.teleport(s[0], s[1], s[2]);
    this.player.forceState('grounded');
    this.rig.yaw = 0;
    this.rig.pitch = -0.12;
    this.freeCam.reset();
  }

  teleport(x: number, y: number, z: number) {
    if (config.debug.freeCamera) {
      this.freeCam.setPose(x, y, z, this.freeCam.yaw, this.freeCam.pitch);
      return;
    }
    this.player.teleport(x, y, z);
    this.player.forceState(y > 1 ? 'flying' : 'grounded');
  }

  spawnTestBodies(n: number): number {
    const cam = this.renderer.camera;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _spawnAt.copy(cam.position).addScaledVector(_fwd, config.debug.testBodySpawnDistance);
    _spawnAt.y = Math.max(_spawnAt.y, 8);
    return this.testBodies.spawn(n, _spawnAt);
  }

  private tick = (time: number) => {
    const cpuStart = performance.now();
    const realDt = this.lastTime < 0 ? 1 / 60 : (time - this.lastTime) / 1000;
    this.lastTime = time;
    this.frame++;
    // Skip startup frames (shader compilation) so the HUD average reflects play.
    if (this.frame > 10) {
      this.stats.push(realDt * 1000);
      this.recorder.push(realDt * 1000);
    }

    this.input.update(time);
    if (this.input.action('debugPanel').pressed) this.debugPanel.toggle();
    if (this.input.action('perfHud').pressed) config.debug.showPerfHud = !config.debug.showPerfHud;
    this.onFrame?.(realDt);

    const free = config.debug.freeCamera;
    if (free) {
      this.freeCam.look(this.input, realDt);
      this.camLoop.advance(
        realDt,
        {
          timeScale: 1,
          maxFrameDt: config.loop.maxFrameDt,
          maxSteps: config.loop.maxStepsPerFrame,
          paused: false,
        },
        (dt) => this.freeCam.fixedUpdate(this.input, dt),
      );
    } else {
      this.rig.look(this.input, realDt);
    }
    this.player.lookYaw = this.rig.yaw;
    this.player.lookPitch = this.rig.pitch;

    // Simulation: fixed 60 Hz, scaled and pausable. A fly-through entry hitches briefly.
    const hitch = this.hitchTimer > 0 ? config.flyThrough.hitchScale : 1;
    this.hitchTimer = Math.max(0, this.hitchTimer - realDt);
    const alpha = this.simLoop.advance(
      realDt,
      {
        timeScale: config.loop.timeScale * hitch,
        maxFrameDt: config.loop.maxFrameDt,
        maxSteps: config.loop.maxStepsPerFrame,
        paused: config.loop.paused,
      },
      this.fixedUpdate,
    );
    const simDt = config.loop.paused ? 0 : realDt * config.loop.timeScale * hitch;

    // Interpolated hero, body animation, camera.
    const pl = this.player;
    this.heroPos.set(
      pl.prevPosition.x + (pl.position.x - pl.prevPosition.x) * alpha,
      pl.prevPosition.y + (pl.position.y - pl.prevPosition.y) * alpha,
      pl.prevPosition.z + (pl.position.z - pl.prevPosition.z) * alpha,
    );
    _vel.set(pl.velocity.x, pl.velocity.y, pl.velocity.z);
    const speed = _vel.length();
    const hs = Math.hypot(_vel.x, _vel.z);
    const pose = this.pose;
    pose.state = pl.state;
    pose.speed = speed;
    pose.horizontalSpeed = hs;
    pose.verticalSpeed = _vel.y;
    pose.dirX = speed > 1e-3 ? _vel.x / speed : 0;
    pose.dirY = speed > 1e-3 ? _vel.y / speed : 1;
    pose.dirZ = speed > 1e-3 ? _vel.z / speed : 0;
    pose.lookYaw = this.rig.yaw;
    pose.charging = pl.charging ? Math.max(0.01, pl.leapCharge) : 0;
    pose.landing = pl.landingTimer > 0;
    pose.diving = pl.diving;
    pose.boosting = this.input.action('boost').down && pl.state === 'flying';
    pose.aim = this.heat.firing ? 1 : this.breath.firing ? 2 : this.energy.charging ? 3 : 0;
    pose.lookPitch = this.rig.pitch;
    pose.action = this.strength.action;
    pose.actionT = this.strength.actionT;
    this.hero.update(this.heroPos.x, this.heroPos.y, this.heroPos.z, pose, simDt);
    const cam = this.renderer.camera;
    if (free) {
      this.freeCam.apply(cam, 1);
      this.renderer.setFov(config.render.camera.fovDeg);
    } else {
      const t = this.camTarget;
      t.x = this.heroPos.x;
      t.y = this.heroPos.y;
      t.z = this.heroPos.z;
      t.vx = _vel.x;
      t.vy = _vel.y;
      t.vz = _vel.z;
      t.speed = speed;
      t.grounded = pl.state === 'grounded';
      this.rig.aiming = this.heat.firing || this.breath.firing || this.energy.charging;
      const fov = this.rig.update(cam, t, realDt);
      this.renderer.setFov(fov);
    }

    this.strength.setAim(cam);
    this.heat.setAim(cam);
    this.breath.setAim(cam);
    this.energy.setAim(cam);
    // The charging ball sits in front of his chest, out along the aim.
    _fwd.set(this.energy.aimDir.x, 0, this.energy.aimDir.z);
    if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const br = EnergyBall.radius(Math.max(config.energyBall.minCharge, this.energy.charge));
    this.energy.hand
      .copy(this.heroPos)
      .addScaledVector(_fwd, 0.7 + br)
      .addScaledVector(_up, config.player.height * 0.66);
    this.energyFx.update(this.energy, cam, simDt);
    this.heat.frameUpdate(simDt);
    this.breath.frameUpdate(simDt);
    this.hero.setEyeGlow(Math.max(this.heat.ramp, this.heat.meter.level * 0.15));
    this.hero.eyeWorld(-1, _eyeL);
    this.hero.eyeWorld(1, _eyeR);
    this.hero.mouthWorld(this.breath.mouth);
    this.beams.update(this.heat.ramp > 0, _eyeL, _eyeR, this.heat.hit, cam, this.heat.ramp, simDt);
    glowBrightness.value = config.heatVision.brightness * 0.45;
    this.synth.setCharge(this.energy.charging, this.energy.charge);
    this.synth.setPowers(
      this.heat.firing,
      this.heat.hitMaterial,
      this.heat.target,
      this.breath.firing,
    );
    this.synth.setListener(cam.position.x, cam.position.y, cam.position.z);
    _center.set(this.heroPos.x, this.heroPos.y + config.player.height / 2, this.heroPos.z);
    this.effects.update(_center, _vel, cam, simDt);
    this.synth.update(speed);
    this.speedometer.update(speed, pl.state, pl.band, pl.diving);
    this.testBodies.render(alpha);
    this.destruction.frameUpdate(alpha);
    this.interiors.update(simDt, this.heroPos, cam);
    this.fire.update(simDt, cam);
    this.hud.update(realDt, !config.debug.freeCamera && this.strength.inReach());
    this.hud.meters(
      this.energy.charging ? Math.max(config.energyBall.minCharge, this.energy.charge) : -1,
      this.heat.meter.level,
      this.heat.meter.locked,
      this.breath.meter.level,
      this.breath.meter.exhausted,
    );
    this.environment.focus.copy(this.heroPos);
    this.environment.update(realDt);
    updateInteriorUniforms(config.sun.elevationDeg);
    this.ground.update();
    this.city.update();
    this.updateWireframe();
    this.renderer.update();
    this.renderer.render();
    // CPU cost of the frame (sim + render submission); GPU time is the rest of the frame time.
    const cpuMs = performance.now() - cpuStart;
    this.snapshot.cpuMs += (cpuMs - this.snapshot.cpuMs) * 0.05;
    if (this.frame > 10) this.recorder.pushCpu(cpuMs);
    this.updateSnapshot(realDt);
    this.perfHud.update(realDt, this.stats, this.snapshot);
    if (!this.ready && this.frame > 3) this.ready = true;
  };

  private fixedUpdate = (dt: number) => {
    const input = config.debug.freeCamera ? null : this.input;
    this.player.fixedUpdate(input, dt);
    this.strength.fixedUpdate(input, dt);
    this.heat.fixedUpdate(input, dt);
    this.breath.fixedUpdate(input, dt);
    this.energy.fixedUpdate(input, dt);
    if (this.player.speed >= config.player.sonicThreshold * 0.9) this.flyThrough.lookAhead(dt);
    this.physics.step();
    this.destruction.fixedUpdate(dt);
    if (!config.debug.freeCamera) {
      const pv = this.player.velocity;
      const pp = this.player.position;
      this.interiors.heroSmash(pp.x, pp.y + config.player.height / 2, pp.z, pv.x, pv.y, pv.z);
    }
    // Low sonic pass: windows along the route blow out.
    const pl = this.player;
    this.sonicTimer -= dt;
    if (pl.speed >= config.player.sonicThreshold && this.sonicTimer <= 0) {
      this.sonicTimer = 0.1;
      this.destruction.sonicPass(pl.position.x, pl.position.y, pl.position.z);
    }
    this.testBodies.afterStep();
    this.input.consumeLatches();
  };

  /** Ground slam / dive slam (DESIGN.md §6.4). */
  slamAt(x: number, y: number, z: number, speed: number, dive: boolean) {
    const c = config.slam;
    const radius = Math.min(c.maxRadius, c.radius + speed * c.radiusPerSpeed);
    const damage = c.damage + speed * c.damagePerSpeed;
    this.destruction.blast(x, y + 1, z, radius, damage, c.launch * (1 + speed / 80));
    this.destruction.shatterWindows(x, y + 6, z, radius * c.windowRadiusScale);
    const onGround = y < 1.5;
    const craterR = c.craterRadius + speed * c.craterRadiusPerSpeed;
    if (onGround) {
      this.ground.addCrater(x, z, craterR, c.craterDepth * (0.6 + Math.min(1, speed / 120)));
      this.destruction.roadChunks(x, z, craterR, c.roadChunks);
    } else {
      this.effects.craters.add(x, y, z, craterR);
    }
    this.effects.shockwaves.spawn(_slam.set(x, y + 0.3, z), _up, radius * 1.4, 0.6, 1);
    this.effects.dust.ring(x, y, z, craterR, Math.min(220, 60 + speed * 1.2), 8 + speed * 0.12);
    this.effects.collapseDust.ring(x, y, z, craterR, 6, 6);
    events.emit('camera:shake', { trauma: 0.45 + Math.min(0.5, speed / 200) });
    events.emit('player:slam', { x, y, z, radius, dive });
    this.strength.countSlam();
  }

  private wireDestructionEvents() {
    const d = this.destruction;
    events.on('player:sonicBoom', (e) =>
      d.shatterWindows(e.x, e.y, e.z, config.sonicCity.boomShatterRadius),
    );
    events.on('player:impact', (e) => {
      // Slamming into a facade below sonic speed: it cracks or holes depending on speed.
      d.hitAt(
        e.x - e.nx * 0.3,
        e.y,
        e.z - e.nz * 0.3,
        1.8,
        e.speed * config.damage.heroImpactPerSpeed,
        -e.nx * e.speed * 0.2,
        0,
        -e.nz * e.speed * 0.2,
      );
    });
    events.on('player:landing', (e) => {
      // Hard landings on rooftops crack the roof under him.
      if (e.hard && e.y > 1.5)
        d.hitAt(e.x, e.y - 0.3, e.z, 2.5, e.impactSpeed * 2.5, 0, -e.impactSpeed * 0.2, 0);
    });
  }

  /** Debug tool: set fire to whatever is under the reticle. */
  fireUnderReticle(): boolean {
    const cam = this.renderer.camera;
    cam.getWorldDirection(_fwd);
    const ray = new this.physics.R.Ray(
      { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      { x: _fwd.x, y: _fwd.y, z: _fwd.z },
    );
    const hit = this.physics.world.castRay(
      ray,
      600,
      true,
      undefined,
      undefined,
      this.player.playerCollider,
    );
    if (!hit) return false;
    // A little past the surface, so a wall's fire starts in the room behind it.
    const t = hit.timeOfImpact + 1.5;
    return this.fire.igniteAt(
      cam.position.x + _fwd.x * t,
      cam.position.y + _fwd.y * t,
      cam.position.z + _fwd.z * t,
    );
  }

  /** Debug tool: cut every column of the story under the reticle (supports test). */
  cutStoryUnderReticle(): boolean {
    const cam = this.renderer.camera;
    cam.getWorldDirection(_fwd);
    const ray = new this.physics.R.Ray(
      { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      { x: _fwd.x, y: _fwd.y, z: _fwd.z },
    );
    const hit = this.physics.world.castRay(
      ray,
      600,
      true,
      undefined,
      undefined,
      this.player.playerCollider,
    );
    if (!hit) return false;
    const bi = this.destruction.colliders.buildingOfCollider.get(hit.collider.handle);
    if (bi === undefined) return false;
    const y = cam.position.y + _fwd.y * hit.timeOfImpact;
    const story = Math.max(0, Math.floor(y / config.construction.floorHeight));
    return this.destruction.cutStory(bi, story, 1);
  }

  private updateSnapshot(realDt: number) {
    const s = this.snapshot;
    const info = this.renderer.renderer.info;
    s.drawCalls = info.render.drawCalls;
    s.triangles = info.render.triangles;
    s.simSteps = this.simLoop.lastSteps;
    s.particles = this.effects.particleCount + this.fire.particleCount;
    s.decals = this.effects.decalCount;
    const ds = this.destruction.stats();
    s.piecesShown = ds.shown;
    s.pieces = ds.pieces;
    s.colliders = ds.colliders;
    s.debrisActive = ds.active;
    s.debrisVisual = ds.visual;
    s.rubble = ds.rubble;
    s.clusters = ds.clusters;
    this.recorder.observe(s);
    this.statsTimer -= realDt;
    if (this.statsTimer > 0) return;
    this.statsTimer = 1 / config.debug.hudRefreshHz;
    s.avgMs = this.stats.average();
    s.fps = s.avgMs > 0 ? 1000 / s.avgMs : 0;
    s.p95Ms = this.stats.percentile(95);
    s.maxMs = this.stats.max();
    s.activeBodies = this.physics.countActiveDynamic();
    s.totalBodies = this.physics.countDynamic();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    s.jsHeapMB = mem ? mem.usedJSHeapSize / 1048576 : 0;
    s.gpuMB = (info.memory as { total?: number }).total
      ? (info.memory as { total: number }).total / 1048576
      : 0;
  }

  private updateWireframe() {
    const on = config.debug.physicsWireframe;
    if (!on) {
      if (this.wireframe) this.wireframe.visible = false;
      return;
    }
    if (!this.wireframe) {
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.LineBasicNodeMaterial({ vertexColors: true });
      this.wireframe = new THREE.LineSegments(geo, mat);
      this.wireframe.frustumCulled = false;
      this.scene.add(this.wireframe);
    }
    // Debug-only path: Rapier returns fresh arrays each call.
    const { vertices, colors } = this.physics.world.debugRender();
    const geo = this.wireframe.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this.wireframe.visible = true;
  }
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
  // Keyboard Lock (Chromium) lets Ctrl+W / Esc reach the game while fullscreen.
  const kb = (navigator as unknown as { keyboard?: { lock?: () => Promise<void> } }).keyboard;
  await kb?.lock?.().catch(() => undefined);
}

function countMaterials(scene: THREE.Scene) {
  const set = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (Array.isArray(m)) m.forEach((x) => set.add(x));
    else if (m) set.add(m);
  });
  return set.size;
}
