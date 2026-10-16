import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  float,
  instancedDynamicBufferAttribute,
  length,
  max,
  mix,
  mx_noise_float,
  positionWorld,
  select,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { config } from '../config';
import { craterCapacity } from './craters';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export const DECAL = { scar: 0, frost: 1 } as const;

/**
 * Surface decals for the powers (DESIGN.md §6.2, §6.3, §12): glowing heat-vision scars that cool
 * from white to orange to dark red to black soot, and frost patches that fade as they thaw. One
 * InstancedMesh and one material for both (the look comes from a per-instance attribute), within
 * the decal budget left after craters, recycling the oldest. A decal on a building piece goes away
 * with the piece. The piece itself keeps its soot, so recycled scars on buildings stay charred.
 */
export class SurfaceDecals {
  readonly mesh: THREE.InstancedMesh;
  private info: THREE.InstancedBufferAttribute;
  private piece: Int32Array;
  private next = 0;
  private live = 0;
  private time = 0;
  private checkTimer = 0;
  private uTime = uniform(0);
  private uCool = uniform(config.heatVision.scarCoolTime);
  private uBright = uniform(config.heatVision.brightness);
  private uThaw = uniform(config.freezeBreath.thawTime);
  private uFade = uniform(config.freezeBreath.fadeTime);
  /** True while a piece id is still standing (set by the destruction system). */
  pieceStanding: (id: number) => boolean = () => true;

  constructor(scene: THREE.Scene) {
    const cap = Math.max(1, config.budgets.decals - craterCapacity());
    this.piece = new Int32Array(cap).fill(-1);
    // x = birth time, y = kind (DECAL), z = random seed.
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.info.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const info = instancedDynamicBufferAttribute<'vec3'>(this.info, 'vec3', 3, 0);
    const age = this.uTime.sub(info.x);
    const isFrost = info.y.greaterThan(0.5);
    const p = uv();
    const n = mx_noise_float(positionWorld.mul(3.1).add(info.z.mul(17)));

    // Scar: a groove along the segment (u along, v across), ragged edges, rounded ends.
    const across = abs(p.y.sub(0.5)).mul(2);
    const ends = smoothstep(0, 0.12, p.x).mul(smoothstep(1, 0.88, p.x));
    const scarAlpha = float(1)
      .sub(smoothstep(0.55, 1, across.add(n.mul(0.25))))
      .mul(ends);
    const core = float(1).sub(smoothstep(0, 0.5, across));
    const t = age.div(this.uCool).clamp(0, 1);
    const ramp = mix(
      mix(vec3(1, 0.93, 0.8), vec3(1, 0.38, 0.06), smoothstep(0, 0.2, t)),
      mix(vec3(0.42, 0.02, 0), vec3(0, 0, 0), smoothstep(0.5, 1, t)),
      smoothstep(0.2, 0.5, t),
    );
    const heat = float(1).sub(t).pow(2).mul(core.mul(0.75).add(0.25));
    // Frost: a round, blotchy patch fading out over the last seconds before it thaws.
    const d = length(p.sub(0.5)).mul(2);
    const frostFade = float(1).sub(smoothstep(this.uThaw.sub(this.uFade), this.uThaw, age));
    // Rime: a dense core breaking up into feathery crystals toward a ragged edge.
    const fine = mx_noise_float(positionWorld.mul(14).add(info.z.mul(31)));
    const feather = smoothstep(-0.15, 0.35, fine.add(float(0.6).sub(d)));
    const frostAlpha = float(1)
      .sub(smoothstep(0.55, 1, d.add(n.mul(0.3))))
      .mul(feather)
      .mul(frostFade)
      .mul(0.9);

    mat.colorNode = select(isFrost, color(0xdbe9f3), color(0x0b0a09));
    mat.roughnessNode = select(
      isFrost,
      mix(float(0.15), float(0.45), fine.mul(0.5).add(0.5)),
      float(0.95),
    );
    mat.emissiveNode = select(isFrost, vec3(0, 0, 0), ramp.mul(heat).mul(this.uBright));
    mat.opacityNode = max(select(isFrost, frostAlpha, scarAlpha.mul(0.92)), 0);

    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  get count() {
    return this.live;
  }

  /** Sim time, for decal ages. */
  get now() {
    return this.time;
  }

  /**
   * Adds a decal on a surface at p with normal n. `along` orients it (a scar segment runs along
   * it), `length` × `width` is its size. `piece` = building piece it sits on (-1 for none).
   * Returns the slot, so a dwelling beam can keep its newest scar white hot.
   */
  add(
    kind: number,
    p: THREE.Vector3,
    n: THREE.Vector3,
    along: THREE.Vector3,
    length: number,
    width: number,
    piece: number,
    seed: number,
  ) {
    const cap = this.piece.length;
    const i = this.next % cap;
    this.next++;
    _z.copy(n).normalize();
    _x.copy(along).addScaledVector(_z, -along.dot(_z));
    if (_x.lengthSq() < 1e-6) _x.set(_z.y, _z.z, _z.x).cross(_z);
    _x.normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    _p.copy(p).addScaledVector(_z, 0.03);
    _m.compose(_p, _q, _s.set(length, width, 1));
    this.mesh.setMatrixAt(i, _m);
    this.info.setXYZ(i, this.time, kind, seed);
    this.piece[i] = piece;
    this.live = Math.min(cap, this.live + 1);
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.info.needsUpdate = true;
    return i;
  }

  /** Makes a decal young again (a beam held on one spot stays white hot). */
  renew(slot: number) {
    this.info.setX(slot, this.time);
    this.info.needsUpdate = true;
  }

  update(dt: number) {
    this.time += dt;
    this.uTime.value = this.time;
    this.uCool.value = config.heatVision.scarCoolTime;
    this.uBright.value = config.heatVision.brightness;
    this.uThaw.value = config.freezeBreath.thawTime;
    this.uFade.value = config.freezeBreath.fadeTime;
    // Decals on pieces that have since been destroyed (or fallen away) go with them.
    this.checkTimer -= dt;
    if (this.checkTimer > 0 || this.live === 0) return;
    this.checkTimer = 0.2;
    let changed = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const id = this.piece[i]!;
      if (id >= 0 && !this.pieceStanding(id)) {
        this.mesh.setMatrixAt(i, _zero);
        this.piece[i] = -1;
        changed = true;
      }
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
