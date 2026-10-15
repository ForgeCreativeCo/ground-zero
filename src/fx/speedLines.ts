import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { config } from '../config';
import { Rng } from '../core/rng';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const NEAR_Z = 2;
const FAR_Z = -70;

/**
 * Speed streaks (DESIGN.md §5.3): thin lines in a tube around the camera rushing past at high
 * speed. Camera-space, one draw call, fades in with speed.
 */
export class SpeedLines {
  readonly mesh: THREE.InstancedMesh;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private opacity = uniform(0);

  constructor(camera: THREE.Camera) {
    const n = config.fx.speedLines.count;
    const rng = new Rng(0x5eed1);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(1.6, 7);
      this.x[i] = Math.cos(a) * r;
      this.y[i] = Math.sin(a) * r;
      this.z[i] = rng.range(FAR_Z, NEAR_Z);
    }
    const mat = new THREE.MeshBasicNodeMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mat.opacityNode = this.opacity;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.012, 0.012, 1),
      mat,
      Math.max(1, n),
    );
    this.mesh.count = n;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 20;
    camera.add(this.mesh);
  }

  update(speed: number, dt: number) {
    const c = config.fx.speedLines;
    const k = c.enabled
      ? Math.min(1, Math.max(0, (speed - c.startSpeed) / Math.max(1, c.fullSpeed - c.startSpeed)))
      : 0;
    this.opacity.value = k * k * c.maxOpacity;
    this.mesh.visible = k > 0.001;
    if (!this.mesh.visible) return;
    const len = Math.min(14, 0.6 + speed * 0.07);
    const span = NEAR_Z - FAR_Z;
    for (let i = 0; i < this.mesh.count; i++) {
      let z = this.z[i]! + speed * dt * 0.9;
      if (z > NEAR_Z) z -= span;
      this.z[i] = z;
      _m.compose(_p.set(this.x[i]!, this.y[i]!, z), _q, _s.set(1, 1, len));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
