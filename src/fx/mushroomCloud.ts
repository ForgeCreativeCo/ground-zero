import * as THREE from 'three/webgpu';
import {
  float,
  instancedDynamicBufferAttribute,
  length,
  mix,
  mx_noise_float,
  positionView,
  smoothstep,
  uv,
  vec3,
} from 'three/tsl';
import { config } from '../config';
import { Rng } from '../core/rng';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

const STEM = 0;
const CAP = 1;
const SKIRT = 2;

/**
 * The Nova's mushroom cloud (DESIGN.md §6.6): stacked soft billboards. Every particle's place is
 * a closed-form function of time (stem rising up into the cap, the cap rolling over as a torus
 * and spreading, a skirt of dust at the base), so it costs no simulation. Hot and glowing at
 * first, cooling to grey-brown smoke lit from above; it hangs for config.nova.cloudLife seconds,
 * drifting with the wind, then thins out.
 */
export class MushroomCloud {
  readonly mesh: THREE.InstancedMesh;
  private n: number;
  private kind: Uint8Array;
  private a: Float32Array;
  private b: Float32Array;
  private phase: Float32Array;
  private size: Float32Array;
  /** Per instance: x shade (0 dark .. 1 lit), y glow, z alpha. */
  private look: THREE.InstancedBufferAttribute;
  private t = -1;
  private origin = new THREE.Vector3();
  private R = 200;

  constructor(scene: THREE.Scene) {
    const n = (this.n = Math.max(10, Math.round(config.nova.cloudParticles)));
    const rng = new Rng(0x3c10d);
    this.kind = new Uint8Array(n);
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = i / n;
      this.kind[i] = r < 0.3 ? STEM : r < 0.85 ? CAP : SKIRT;
      this.a[i] = rng.next();
      this.b[i] = rng.next();
      this.phase[i] = rng.range(0, Math.PI * 2);
      this.size[i] = rng.range(0.75, 1.3);
    }
    this.look = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.look.setUsage(THREE.DynamicDrawUsage);
    const look = instancedDynamicBufferAttribute<'vec3'>(this.look, 'vec3', 3, 0);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const p = uv().sub(0.5);
    const puff = mx_noise_float(vec3(p.mul(3.2), look.x.mul(7)));
    const r = length(p).mul(2).add(puff.mul(0.25));
    const soft = float(1).sub(smoothstep(0.35, 1, r));
    // Lit from above: the top of each puff brighter.
    const lit = mix(float(0.35), float(1.25), p.y.add(0.5).mul(0.45).add(look.x.mul(0.55)));
    const smoke = vec3(0.34, 0.3, 0.27).mul(lit);
    const hot = mix(vec3(1, 0.45, 0.12), vec3(1, 0.9, 0.7), look.y).mul(look.y.mul(9));
    mat.colorNode = smoke.add(hot);
    // Fade out right at the camera so flying through it doesn't white out the screen.
    const near = smoothstep(4, 30, positionView.z.negate());
    mat.opacityNode = soft.mul(look.z).mul(near);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, n);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  /** Starts a cloud at the blast centre (ground level below it) for a blast of radius R. */
  start(x: number, groundY: number, z: number, R: number) {
    this.origin.set(x, groundY, z);
    this.R = R;
    this.t = 0;
  }

  get active() {
    return this.t >= 0;
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.t < 0) {
      this.mesh.count = 0;
      return;
    }
    const c = config.nova;
    this.t += dt;
    const t = this.t;
    const R = this.R;
    const life = c.cloudLife;
    if (t > life + 60) {
      this.t = -1;
      this.mesh.count = 0;
      return;
    }
    const H = R * c.cloudHeight * (1 - Math.exp(-t / 5));
    const capR = R * c.cloudCapRadius * (0.25 + 0.75 * (1 - Math.exp(-t / 7)));
    const stemR = R * 0.09 * (0.6 + 0.4 * Math.min(1, t / 4));
    const fadeIn = Math.min(1, t / 0.4);
    const fadeOut = t > life ? Math.max(0, 1 - (t - life) / 60) : 1;
    const glowBase = Math.exp(-t / 5);
    const driftX = config.fire.windX * t * 0.6;
    const driftZ = config.fire.windZ * t * 0.6;
    const look = this.look.array as Float32Array;
    const o = this.origin;
    for (let i = 0; i < this.n; i++) {
      const a = this.a[i]!;
      const b = this.b[i]!;
      const ph = this.phase[i]!;
      let x: number;
      let y: number;
      let z: number;
      let size: number;
      let shade: number;
      let glow: number;
      let alpha = 0.85;
      if (this.kind[i] === STEM) {
        // Flowing up the column into the cap, wider near the ground.
        const h = (a + t * 0.04) % 1;
        const rr = stemR * (1 + 1.5 * (1 - h) ** 3) * (0.35 + 0.65 * b);
        x = Math.cos(ph + t * 0.1) * rr;
        z = Math.sin(ph + t * 0.1) * rr;
        y = H * h;
        size = stemR * 2.8 * this.size[i]!;
        shade = 0.2 + 0.35 * h;
        glow = glowBase * (1 - h) * 0.6;
      } else if (this.kind[i] === CAP) {
        // A torus rolling up and over (outward at the top, back in underneath), filled at the top.
        const major = capR * (0.25 + 0.75 * b);
        const minor = capR * 0.42;
        const roll = ph + t * 0.35;
        const ang = a * Math.PI * 2 + t * 0.015;
        const rad = major + minor * Math.cos(roll);
        x = Math.cos(ang) * rad;
        z = Math.sin(ang) * rad;
        y = H + minor * 0.65 * Math.sin(roll);
        size = capR * 0.75 * this.size[i]!;
        // Lit on top of the roll, deep shadow underneath the cap.
        shade = 0.5 + 0.5 * Math.sin(roll);
        glow = glowBase * (0.6 + 0.4 * (1 - b));
      } else {
        // Dust skirt rolling out along the ground.
        const rr = R * 0.5 * (1 - Math.exp(-t / 4)) * (0.5 + 0.5 * b);
        x = Math.cos(a * Math.PI * 2) * rr;
        z = Math.sin(a * Math.PI * 2) * rr;
        y = R * 0.04 * (0.5 + b);
        size = R * 0.2 * this.size[i]!;
        shade = 0.45;
        glow = glowBase * 0.2;
        alpha = 0.6 * Math.max(0, 1 - t / (life * 0.5));
      }
      const hFrac = Math.min(1, y / Math.max(1, H));
      _p.set(o.x + x + driftX * hFrac, o.y + y, o.z + z + driftZ * hFrac);
      _m.compose(_p, camera.quaternion, _s.setScalar(Math.max(0.01, size)));
      this.mesh.setMatrixAt(i, _m);
      look[i * 3] = shade;
      look[i * 3 + 1] = Math.min(1, glow);
      look[i * 3 + 2] = alpha * fadeIn * fadeOut;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.look.needsUpdate = true;
  }
}
