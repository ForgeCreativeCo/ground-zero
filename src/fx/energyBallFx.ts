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
import { EnergyBall, type Projectile } from '../powers/energyBall';
import type { Effects } from './effects';

const MAX_BALLS = 5;
const MAX_FLASH = 4;
const _up = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();

interface Flash {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  size: number;
}

/**
 * Energy ball visuals: a white-blue plasma ball (a crackling core inside a soft halo) growing in
 * his hands as it charges and flying when thrown, and the burst: an expanding flash, a shockwave
 * ring, a dust ring and a shower of sparks. Every mesh is created up front (no mid-play compiles).
 */
export class EnergyBallFx {
  private cores: THREE.Mesh[] = [];
  private halos: THREE.Mesh[] = [];
  private flashes: Flash[] = [];
  private uBright = uniform(config.energyBall.brightness);
  private rng = new Rng(0xe9b1);
  private t = 0;

  constructor(
    scene: THREE.Scene,
    private readonly fx: Effects,
  ) {
    const geo = new THREE.SphereGeometry(1, 24, 16);
    const facing = abs(normalView.z);
    // Core: crackling plasma, brightest where it faces the camera.
    const crackle = mx_noise_float(positionLocal.mul(4).add(vec3(0, time.mul(6), time.mul(3))));
    const coreMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    coreMat.colorNode = mix(vec3(0.35, 0.6, 1), vec3(0.92, 0.97, 1), smoothstep(0.2, 0.95, facing))
      .mul(crackle.mul(0.35).add(0.85))
      .mul(this.uBright)
      .mul(0.35);
    coreMat.opacityNode = facing.pow(0.8);
    const haloMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    haloMat.colorNode = vec3(0.3, 0.55, 1).mul(this.uBright).mul(0.08);
    haloMat.opacityNode = facing.pow(3);
    for (let i = 0; i < MAX_BALLS; i++) {
      const c = new THREE.Mesh(geo, coreMat);
      const h = new THREE.Mesh(geo, haloMat);
      for (const m of [c, h]) {
        m.visible = false;
        m.frustumCulled = false;
        m.renderOrder = 12;
        scene.add(m);
      }
      this.cores.push(c);
      this.halos.push(h);
    }

    // Burst flash: a camera-facing radial glow that swells and fades.
    const flashMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const r = length(uv().sub(0.5)).mul(2);
    const glow = float(1)
      .sub(smoothstep(0, 1, r))
      .pow(1.6);
    flashMat.colorNode = mix(vec3(0.3, 0.55, 1), vec3(1, 0.97, 0.92), glow.pow(2))
      .mul(this.uBright)
      .mul(0.3);
    flashMat.opacityNode = glow;
    const quad = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_FLASH; i++) {
      const m = new THREE.Mesh(quad, flashMat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 13;
      scene.add(m);
      this.flashes.push({ mesh: m, age: 1, life: 1, size: 1 });
    }

    events.on('power:energyBlast', (e) => this.burst(e.x, e.y, e.z, e.radius, e.charge));
  }

  private burst(x: number, y: number, z: number, radius: number, charge: number) {
    const f = this.flashes.find((q) => q.age >= q.life) ?? this.flashes[0]!;
    f.age = 0;
    f.life = 0.35 + 0.35 * charge;
    f.size = radius * 2.6;
    f.mesh.position.set(x, y, z);
    f.mesh.visible = true;
    const fx = this.fx;
    _p.set(x, y, z);
    fx.shockwaves.spawn(_p, _up, radius * 2.2, 0.55, 0.9);
    _p.set(x, Math.max(0.15, y - radius * 0.3), z);
    fx.shockwaves.spawn(_p, _up, radius * 1.6, 0.7, 0.6);
    fx.dust.ring(x, y, z, radius * 0.5, Math.round(40 + 120 * charge), 6 + 14 * charge);
    fx.collapseDust.ring(x, y, z, radius * 0.6, Math.round(4 + 10 * charge), 3 + 6 * charge);
    const n = Math.round(60 + 220 * charge);
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const el = this.rng.range(-0.6, 1.2);
      const sp = this.rng.range(8, 30) * (0.6 + charge);
      fx.sparks.spawn(
        x,
        y,
        z,
        Math.cos(a) * Math.cos(el) * sp,
        Math.sin(el) * sp,
        Math.sin(a) * Math.cos(el) * sp,
        this.rng.range(0.08, 0.2),
        -0.05,
        this.rng.range(0.4, 1.1),
      );
    }
  }

  /** Per frame: the charging ball, balls in flight, flashes. */
  update(ball: EnergyBall, camera: THREE.Camera, dt: number) {
    this.uBright.value = config.energyBall.brightness;
    this.t += dt;
    const pulse = 1 + 0.06 * Math.sin(this.t * 31) + 0.04 * Math.sin(this.t * 13);
    let k = 0;
    if (ball.charging) {
      const c = Math.max(config.energyBall.minCharge, ball.charge);
      this.show(k++, ball.hand, EnergyBall.radius(c) * pulse);
    }
    for (const b of ball.balls) {
      if (!b.live || k >= MAX_BALLS) continue;
      this.show(k++, b.pos, EnergyBall.radius(b.charge) * pulse);
      this.trail(b, dt);
    }
    for (; k < MAX_BALLS; k++) {
      this.cores[k]!.visible = false;
      this.halos[k]!.visible = false;
    }
    for (const f of this.flashes) {
      if (f.age >= f.life) {
        f.mesh.visible = false;
        continue;
      }
      f.age += dt;
      const u = Math.min(1, f.age / f.life);
      f.mesh.quaternion.copy(camera.quaternion);
      f.mesh.scale.setScalar(f.size * (0.35 + 0.65 * Math.sqrt(u)) * (1 - u * u * 0.3));
      f.mesh.visible = u < 1;
      // Collapses at the end (the material is shared, so it fades by size, not opacity).
      if (u > 0.6) f.mesh.scale.multiplyScalar(1 - (u - 0.6) * 1.5);
    }
  }

  private show(i: number, p: THREE.Vector3, r: number) {
    const c = this.cores[i]!;
    const h = this.halos[i]!;
    c.position.copy(p);
    h.position.copy(p);
    c.scale.setScalar(r);
    h.scale.setScalar(r * 1.45);
    c.visible = h.visible = true;
  }

  /** Sparks shed behind a ball in flight. */
  private trail(b: Projectile, dt: number) {
    const n = Math.round(dt * 120 * (0.4 + b.charge));
    for (let i = 0; i < n; i++) {
      const t = this.rng.next();
      this.fx.sparks.spawn(
        b.prev.x + (b.pos.x - b.prev.x) * t + this.rng.range(-0.3, 0.3),
        b.prev.y + (b.pos.y - b.prev.y) * t + this.rng.range(-0.3, 0.3),
        b.prev.z + (b.pos.z - b.prev.z) * t + this.rng.range(-0.3, 0.3),
        this.rng.range(-2, 2),
        this.rng.range(-2, 2),
        this.rng.range(-2, 2),
        this.rng.range(0.06, 0.14),
        -0.05,
        0.35,
      );
    }
  }
}
