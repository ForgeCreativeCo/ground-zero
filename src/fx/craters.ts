import * as THREE from 'three/webgpu';
import { config } from '../config';
import { Rng } from '../core/rng';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Impact crater decals (DESIGN.md §5.4): flat cracked-and-scorched quads in one InstancedMesh,
 * capped by budgets.decals and recycling the oldest. Damage is permanent (pillar 1), so they
 * never fade. Real ground deformation arrives with the destructible ground in M2.
 */
export class Craters {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private rng = new Rng(0xc4a7);

  constructor(scene: THREE.Scene) {
    const cap = config.budgets.decals;
    const tex = new THREE.CanvasTexture(drawCraterTexture(new Rng(0x5eed)));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardNodeMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      roughness: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  get count() {
    return this.mesh.count;
  }

  add(x: number, y: number, z: number, radius: number) {
    const cap = config.budgets.decals;
    if (cap <= 0) return;
    const i = this.next % Math.min(cap, this.mesh.instanceMatrix.count);
    this.next++;
    _q.setFromAxisAngle(_up, this.rng.range(0, Math.PI * 2));
    _m.compose(_p.set(x, y + 0.03, z), _q, _s.set(radius, 1, radius));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Procedural crater: scorched centre, a pressure ring and radial cracks, alpha fading out. */
function drawCraterTexture(rng: Rng) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const mid = size / 2;
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  grad.addColorStop(0, 'rgba(20,18,16,0.95)');
  grad.addColorStop(0.35, 'rgba(38,34,30,0.85)');
  grad.addColorStop(0.55, 'rgba(70,64,58,0.55)');
  grad.addColorStop(1, 'rgba(70,64,58,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // Pressure ring.
  g.strokeStyle = 'rgba(25,22,20,0.6)';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(mid, mid, mid * 0.42, 0, Math.PI * 2);
  g.stroke();
  // Radial cracks with jagged branches.
  g.strokeStyle = 'rgba(12,10,9,0.9)';
  g.lineCap = 'round';
  const cracks = 14;
  for (let k = 0; k < cracks; k++) {
    let a = (k / cracks) * Math.PI * 2 + rng.range(-0.2, 0.2);
    let r = mid * 0.12;
    let x = mid + Math.cos(a) * r;
    let y = mid + Math.sin(a) * r;
    const len = mid * rng.range(0.55, 0.95);
    let w = 5;
    g.beginPath();
    g.moveTo(x, y);
    while (r < len) {
      r += rng.range(10, 24);
      a += rng.range(-0.25, 0.25);
      x = mid + Math.cos(a) * r;
      y = mid + Math.sin(a) * r;
      g.lineWidth = w;
      g.lineTo(x, y);
      w = Math.max(1, w * 0.9);
      if (rng.next() < 0.18) {
        const ba = a + rng.range(-0.9, 0.9);
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(ba) * rng.range(15, 45), y + Math.sin(ba) * rng.range(15, 45));
        g.moveTo(x, y);
      }
    }
    g.stroke();
  }
  return c;
}
