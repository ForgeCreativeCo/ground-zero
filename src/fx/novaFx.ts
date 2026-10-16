import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  length,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { config } from '../config';
import { events } from '../core/events';
import { Rng } from '../core/rng';
import type { Nova } from '../powers/nova';
import { uLightFlicker } from '../render/interiorMapping';
import type { GameRenderer } from '../render/renderer';
import { Dust } from './dust';
import type { Effects } from './effects';
import { MushroomCloud } from './mushroomCloud';

const _up = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const AFTER_TINT = new THREE.Color(1.08, 0.8, 0.62);

/**
 * Nova visuals (DESIGN.md §6.6). Wind-up: a glow building around him, cracks spreading on the
 * ground below, the city's lights flickering, colour draining, the shake rising. Release: a
 * white-out flash, a shockwave dome riding the front, dust rolling out along the ground behind
 * it, ash bursts where the core vaporizes buildings, a glowing crater, the mushroom cloud, ash
 * falling around the camera, and an orange-grey cast that fades over minutes. Every mesh exists
 * from the start (no mid-play shader compiles).
 */
export class NovaFx {
  readonly cloud: MushroomCloud;
  readonly ash: Dust;
  private aura: THREE.Mesh;
  private dome: THREE.Mesh;
  private fireball: THREE.Mesh;
  private craterGlow: THREE.Mesh;
  private uAura = uniform(0);
  private uDome = uniform(0);
  private uFire = uniform(0);
  private uCrater = uniform(0);
  private rng = new Rng(0x40f2);
  private crackStage = 0;
  private sinceRelease = Infinity;
  private ashAcc = 0;
  private ringAcc = 0;
  private center = new THREE.Vector3();
  private craterAge = Infinity;
  /** Ground height below a point (set by the game: a physics ray down). */
  groundBelow: (x: number, y: number, z: number) => number = () => 0;

  constructor(
    scene: THREE.Scene,
    private readonly fx: Effects,
    private readonly renderer: GameRenderer,
  ) {
    const sphere = new THREE.SphereGeometry(1, 32, 20);
    const facing = abs(normalView.z);
    const additive = () =>
      new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

    // Wind-up aura: a hot shell around him, rippling, brightest at the rim.
    const auraMat = additive();
    const ripple = mx_noise_float(positionLocal.mul(3).add(vec3(0, time.mul(4), 0)))
      .mul(0.4)
      .add(0.8);
    auraMat.colorNode = vec3(1, 0.62, 0.3)
      .mul(float(1).sub(facing).pow(4).mul(ripple))
      .mul(this.uAura.mul(2.5));
    this.aura = new THREE.Mesh(sphere, auraMat);

    // Shockwave dome: a faint shell, bright where it's seen edge-on.
    const domeMat = additive();
    domeMat.side = THREE.DoubleSide;
    domeMat.colorNode = vec3(1, 0.85, 0.7)
      .mul(float(1).sub(facing).pow(3).add(0.04))
      .mul(this.uDome.mul(3));
    this.dome = new THREE.Mesh(sphere, domeMat);

    // Fireball: blinding at first, cooling to orange as it swells and fades.
    const fireMat = additive();
    const churn = mx_noise_float(positionLocal.mul(2.5).add(vec3(time.mul(0.8), time, 0)));
    fireMat.colorNode = mix(vec3(1, 0.35, 0.08), vec3(1, 0.95, 0.85), this.uFire)
      .mul(facing.pow(0.6).mul(churn.mul(0.3).add(0.85)))
      .mul(this.uFire.mul(25));
    this.fireball = new THREE.Mesh(sphere, fireMat);

    // Crater glow: a hot disc on the ground that cools over minutes.
    const craterMat = additive();
    const r = length(uv().sub(0.5)).mul(2);
    const hotN = mx_noise_float(vec3(uv().mul(9), 1));
    const heat = float(1)
      .sub(smoothstep(0, 1, r.add(hotN.mul(0.15))))
      .pow(1.5);
    craterMat.colorNode = mix(vec3(0.6, 0.06, 0), vec3(1, 0.55, 0.15), heat.mul(this.uCrater))
      .mul(heat)
      .mul(this.uCrater.mul(this.uCrater).mul(8));
    craterMat.polygonOffset = true;
    craterMat.polygonOffsetFactor = -6;
    craterMat.polygonOffsetUnits = -6;
    const disc = new THREE.PlaneGeometry(1, 1);
    disc.rotateX(-Math.PI / 2);
    this.craterGlow = new THREE.Mesh(disc, craterMat);

    for (const m of [this.aura, this.dome, this.fireball, this.craterGlow]) {
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 11;
      scene.add(m);
    }

    this.cloud = new MushroomCloud(scene);
    this.ash = new Dust(scene, {
      capacity: () => Math.max(10, config.nova.ashParticles),
      color: () => '#8a8580',
      lifetime: () => 9,
      drag: () => 0.6,
      opacity: 0.8,
      lift: () => -0.15,
      windX: () => config.fire.windX * 0.4,
      windZ: () => config.fire.windZ * 0.4,
    });

    events.on('nova:windup', (e) => {
      this.center.set(e.x, e.y, e.z);
      this.crackStage = 0;
    });
    events.on('nova:release', (e) => this.onRelease(e.x, e.y, e.z, e.radius));
  }

  private onRelease(x: number, y: number, z: number, radius: number) {
    this.center.set(x, y, z);
    this.sinceRelease = 0;
    this.ringAcc = 0;
    const ground = this.groundBelow(x, y, z);
    this.cloud.start(x, ground, z, radius);
    _p.set(x, ground + 0.4, z);
    this.fx.shockwaves.spawn(_p, _up, radius * 1.5, (radius * 1.5) / config.nova.waveSpeed, 1);
    events.emit('camera:shake', { trauma: 1 });
    // A hot crater only when he's close to the ground.
    const h = y - ground;
    const k = 1 - h / Math.max(1, radius * config.nova.coreFraction);
    if (k > 0) {
      const r = config.nova.craterRadius * (0.4 + 0.6 * k) * 1.25;
      this.craterGlow.position.set(x, ground + 0.08, z);
      this.craterGlow.scale.set(r * 2, 1, r * 2);
      this.craterAge = 0;
    }
  }

  update(nova: Nova, camera: THREE.Camera, heroCenter: THREE.Vector3, dt: number) {
    const c = config.nova;
    const g = this.renderer.grade;
    const wk = nova.windupK;

    // --- wind-up --------------------------------------------------------------------------
    if (nova.phase === 'windup') {
      this.aura.visible = true;
      this.aura.position.copy(heroCenter);
      this.aura.scale.setScalar(1.1 + 0.9 * wk * wk);
      this.uAura.value = wk;
      uLightFlicker.value =
        wk < 0.25 ? 1 : this.rng.next() < 0.18 + 0.3 * wk ? 0.15 : 0.7 + 0.3 * this.rng.next();
      g.saturation.value = 1 - 0.8 * wk;
      if (this.rng.next() < dt * 20) events.emit('camera:shake', { trauma: 0.02 + 0.08 * wk * wk });
      // Cracks spread out beneath him in stages.
      const stage = Math.floor(wk * 5);
      if (stage > this.crackStage) {
        this.crackStage = stage;
        const ground = this.groundBelow(heroCenter.x, heroCenter.y, heroCenter.z);
        if (heroCenter.y - ground < c.crackRadius * 2) {
          this.fx.craters.add(heroCenter.x, ground, heroCenter.z, (c.crackRadius * stage) / 5);
          this.fx.dust.ring(heroCenter.x, ground, heroCenter.z, (c.crackRadius * stage) / 5, 20, 3);
        }
      }
    } else {
      this.aura.visible = false;
      if (nova.phase === 'idle' && this.sinceRelease === Infinity) {
        uLightFlicker.value = 1;
        g.saturation.value = 1;
      }
    }

    // --- release and aftermath --------------------------------------------------------------
    if (this.sinceRelease < Infinity) {
      this.sinceRelease += dt;
      const t = this.sinceRelease;
      const R = nova.radius;
      const o = this.center;
      // Flash: hold white, then recover.
      g.flash.value =
        t < c.flashHold
          ? 1
          : Math.max(0, 1 - (t - c.flashHold) / Math.max(0.05, c.flashRecover)) ** 2;
      uLightFlicker.value = t < 3 ? 0.2 : 1;
      // Dome riding the front, fading as it reaches the fringe.
      const reach = R * c.fringeFraction;
      const front = Math.min(reach, t * c.waveSpeed);
      this.dome.visible = front < reach;
      this.dome.position.copy(o);
      this.dome.scale.setScalar(Math.max(1, front));
      this.uDome.value = 1 - front / reach;
      // Fireball: swells to a fifth of the radius, cools and fades in ~4 s.
      const fk = Math.min(1, t / 4);
      this.fireball.visible = fk < 1;
      this.fireball.position.set(o.x, o.y + t * 6, o.z);
      this.fireball.scale.setScalar(R * 0.2 * (0.3 + 0.7 * Math.sqrt(fk)));
      this.uFire.value = 1 - fk;
      // Dust rolling out along the streets behind the front.
      if (front < reach) {
        this.ringAcc += dt * 160;
        const ground = this.groundBelow(o.x, o.y, o.z);
        while (this.ringAcc >= 1) {
          this.ringAcc--;
          const a = this.rng.range(0, Math.PI * 2);
          const rr = front * this.rng.range(0.85, 1);
          this.fx.collapseDust.spawn(
            o.x + Math.cos(a) * rr,
            ground + this.rng.range(1, 10),
            o.z + Math.sin(a) * rr,
            Math.cos(a) * this.rng.range(6, 16),
            this.rng.range(0.5, 2),
            Math.sin(a) * this.rng.range(6, 16),
            this.rng.range(8, 14),
            this.rng.range(1.5, 3),
          );
        }
      }
      // Aftermath grade: colour comes back slowly under an orange-grey cast.
      const after = Math.max(0, 1 - t / c.gradeFade);
      g.saturation.value = 1 - 0.45 * after;
      const tint = g.tint.value as THREE.Color;
      tint.setRGB(1, 1, 1).lerp(AFTER_TINT, after);
      // Ash falling around the camera.
      if (t < c.ashTime) {
        this.ashAcc += dt * 70 * (1 - t / c.ashTime);
        while (this.ashAcc >= 1) {
          this.ashAcc--;
          this.ash.spawn(
            camera.position.x + this.rng.range(-60, 60),
            camera.position.y + this.rng.range(5, 40),
            camera.position.z + this.rng.range(-60, 60),
            this.rng.range(-0.3, 0.3),
            -this.rng.range(0.8, 1.6),
            this.rng.range(-0.3, 0.3),
            this.rng.range(0.08, 0.16),
            0,
          );
        }
      }
      if (t > c.gradeFade && t > c.ashTime && !this.cloud.active) this.sinceRelease = Infinity;
    }
    // Where the core vaporizes: bursts of ash and dust with a few glowing fragments.
    const b = nova.bursts;
    for (let i = 0; i + 3 < b.length; i += 4) {
      const big = b[i + 3]! > 1.5;
      this.fx.collapseDust.ring(
        b[i]!,
        b[i + 1]!,
        b[i + 2]!,
        big ? 14 : 5,
        big ? 10 : 3,
        big ? 9 : 5,
      );
      for (let k = 0; k < (big ? 10 : 3); k++) {
        this.fx.droplets.spawn(
          b[i]! + this.rng.range(-4, 4),
          b[i + 1]! + this.rng.range(-4, 4),
          b[i + 2]! + this.rng.range(-4, 4),
          this.rng.range(-12, 12),
          this.rng.range(2, 18),
          this.rng.range(-12, 12),
          this.rng.range(0.2, 0.45),
          -0.05,
          this.rng.range(1, 2.5),
        );
      }
    }
    b.length = 0;
    // Crater cools over minutes.
    if (this.craterAge < Infinity) {
      this.craterAge += dt;
      const k = Math.max(0, 1 - this.craterAge / c.craterCoolTime);
      this.craterGlow.visible = k > 0;
      this.uCrater.value = k;
      if (k <= 0) this.craterAge = Infinity;
    }
    this.cloud.update(dt, camera);
    this.ash.update(dt, camera);
  }

  get particleCount() {
    return this.ash.count + (this.cloud.active ? config.nova.cloudParticles : 0);
  }
}
