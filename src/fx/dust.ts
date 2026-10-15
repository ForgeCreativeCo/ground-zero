import * as THREE from 'three/webgpu';
import {
  color,
  float,
  instancedDynamicBufferAttribute,
  positionView,
  smoothstep,
  uniform,
  uv,
} from 'three/tsl';
import { config } from '../config';
import { Rng } from '../core/rng';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export interface DustOptions {
  capacity: () => number;
  color: () => string;
  lifetime: () => number;
  drag: () => number;
  /** Peak opacity of a particle. */
  opacity: number;
  /** Upward acceleration (m/s²): smoke rises. Default: settles slowly. */
  lift?: () => number;
  /** Wind drift added to motion (m/s). */
  windX?: () => number;
  windZ?: () => number;
  /** Additive glow (flames, embers) instead of soft alpha. */
  additive?: boolean;
  /** Colour multiplier (above 1 glows with bloom). */
  brightness?: number;
  /** Fade curve: fast in and out for flames; the default lingers like dust. */
  flicker?: boolean;
}

const defaultDust: DustOptions = {
  capacity: () => config.fx.dust.capacity,
  color: () => config.fx.dust.color,
  lifetime: () => config.fx.dust.lifetime,
  drag: () => config.fx.dust.drag,
  opacity: 0.55,
};

/**
 * Pooled dust particles: camera-facing soft quads in one InstancedMesh (one draw call).
 * Structure-of-arrays state, swap-remove on death, no allocation after construction.
 * M2's collapse dust builds on this.
 */
export class Dust {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  count = 0;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size: Float32Array;
  private grow: Float32Array;
  private alpha: THREE.InstancedBufferAttribute;
  private uColor = uniform(color(config.fx.dust.color));
  private rng = new Rng(0xd057);

  constructor(
    scene: THREE.Scene,
    private readonly opts: DustOptions = defaultDust,
  ) {
    const n = (this.capacity = opts.capacity());
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const a = instancedDynamicBufferAttribute<'float'>(this.alpha, 'float', 1, 0);
    const d = uv().sub(0.5).length();
    mat.colorNode = opts.brightness ? this.uColor.mul(opts.brightness) : this.uColor;
    // Soft round puff; fades out right in front of the camera so a cloud at the lens doesn't
    // white out the screen.
    const nearFade = smoothstep(1.5, 6, positionView.z.negate());
    mat.opacityNode = float(1)
      .sub(smoothstep(0.15, 0.5, d))
      .mul(a)
      .mul(nearFade);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, n);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  /** A ring of dust rolling outward along the ground from (x, y, z). */
  ring(x: number, y: number, z: number, radius: number, count: number, speed: number) {
    for (let k = 0; k < count; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = radius * this.rng.range(0.2, 0.6);
      const s = speed * this.rng.range(0.6, 1.2);
      this.spawn(
        x + Math.cos(a) * r,
        y + this.rng.range(0.2, 1.2),
        z + Math.sin(a) * r,
        Math.cos(a) * s,
        this.rng.range(0.5, 3),
        Math.sin(a) * s,
        this.rng.range(1.5, 3.5),
        this.rng.range(1.5, 3),
      );
    }
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    grow: number,
    life = -1,
  ) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life > 0 ? life : this.opts.lifetime() * this.rng.range(0.7, 1.3);
    this.size[i] = size;
    this.grow[i] = grow;
  }

  update(dt: number, camera: THREE.Camera) {
    this.uColor.value.set(this.opts.color());
    const drag = Math.exp(-this.opts.drag() * dt);
    const alpha = this.alpha.array as Float32Array;
    const lift = this.opts.lift ? this.opts.lift() : -0.4;
    const wx = this.opts.windX ? this.opts.windX() * dt : 0;
    const wz = this.opts.windZ ? this.opts.windZ() * dt : 0;
    const flicker = !!this.opts.flicker;
    let i = 0;
    while (i < this.count) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        this.kill(i);
        continue;
      }
      this.vx[i]! *= drag;
      this.vy[i] = this.vy[i]! * drag + lift * dt;
      this.vz[i]! *= drag;
      this.px[i]! += this.vx[i]! * dt + wx;
      this.py[i] = Math.max(0.2, this.py[i]! + this.vy[i]! * dt);
      this.pz[i]! += this.vz[i]! * dt + wz;
      const t = this.age[i]! / this.life[i]!;
      let s = this.size[i]! + this.grow[i]! * this.age[i]!;
      _p.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      // A puff on the lens would be a full-screen blended quad (expensive, and it just greys the
      // screen), so particles this close to the camera aren't drawn at all.
      if (_p.distanceToSquared(camera.position) < (s * 0.5 + config.fx.dust.nearCull) ** 2) s = 0;
      _m.compose(_p, camera.quaternion, _s.set(s, s, s));
      this.mesh.setMatrixAt(i, _m);
      alpha[i] = flicker
        ? Math.min(1, t * 12) * (1 - t) * this.opts.opacity
        : Math.min(1, t * 8) * (1 - t) * (1 - t) * this.opts.opacity;
      i++;
    }
    this.mesh.count = this.count;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alpha.needsUpdate = true;
    }
  }

  private kill(i: number) {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last]!;
    this.py[i] = this.py[last]!;
    this.pz[i] = this.pz[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.vz[i] = this.vz[last]!;
    this.age[i] = this.age[last]!;
    this.life[i] = this.life[last]!;
    this.size[i] = this.size[last]!;
    this.grow[i] = this.grow[last]!;
  }
}
