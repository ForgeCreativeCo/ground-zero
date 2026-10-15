import * as THREE from 'three/webgpu';
import { config } from '../config';
import { Rng } from '../core/rng';
import type { Physics } from '../physics/physics';
import { generateCity, type Box, type CityLayout } from './cityLayout';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * The non-destructible parts of the city: the elevated highway, the park (with trees) and the
 * plaza. Buildings are destructible pieces owned by the DestructionSystem (M2).
 */
export class GrayboxCity {
  readonly layout: CityLayout;
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene, physics: Physics, seed: number) {
    this.layout = generateCity(seed, config.city);
    this.buildHighway();
    this.buildParksAndPlazas(seed);
    this.buildColliders(physics);
    scene.add(this.group);
  }

  private buildHighway() {
    const list = this.layout.highway;
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x8c8880, roughness: 0.9 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, list.length);
    list.forEach((b, i) => {
      setBoxMatrix(b, _m);
      mesh.setMatrixAt(i, _m);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'highway';
    this.group.add(mesh);
  }

  private buildParksAndPlazas(seed: number) {
    const size = config.city.blockSize;
    const lawn = new THREE.MeshStandardNodeMaterial({ color: config.city.parkColor, roughness: 1 });
    const paving = new THREE.MeshStandardNodeMaterial({
      color: config.city.plazaColor,
      roughness: 0.8,
    });
    const slab = new THREE.BoxGeometry(size, 0.12, size);
    const trunks: THREE.Vector3[] = [];
    const rng = new Rng(seed ^ 0x7ee5);
    for (const b of this.layout.blocks) {
      if (b.kind !== 'park' && b.kind !== 'plaza') continue;
      const m = new THREE.Mesh(slab, b.kind === 'park' ? lawn : paving);
      m.position.set(b.x, 0.06, b.z);
      m.receiveShadow = true;
      this.group.add(m);
      if (b.kind === 'park') {
        for (let k = 0; k < 40; k++) {
          trunks.push(new THREE.Vector3(b.x + rng.range(-44, 44), 0, b.z + rng.range(-44, 44)));
        }
      }
    }
    if (trunks.length === 0) return;
    // Smooth, simple trees: a trunk and a round crown each (two draw calls for the whole park).
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.25, 0.35, 1, 8),
      new THREE.MeshStandardNodeMaterial({ color: 0x4a3a2c, roughness: 1 }),
      trunks.length,
    );
    const crownMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshStandardNodeMaterial({ color: 0x3f5f2e, roughness: 1 }),
      trunks.length,
    );
    trunks.forEach((t, i) => {
      const h = rng.range(4, 7);
      _m.compose(_p.set(t.x, h / 2, t.z), _q.identity(), _s.set(1, h, 1));
      trunkMesh.setMatrixAt(i, _m);
      const r = rng.range(2.2, 3.6);
      _m.compose(_p.set(t.x, h + r * 0.6, t.z), _q.identity(), _s.set(r, r * 0.9, r));
      crownMesh.setMatrixAt(i, _m);
    });
    for (const m of [trunkMesh, crownMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  private buildColliders(physics: Physics) {
    const R = physics.R;
    const body = physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const b of this.layout.highway) {
      physics.world.createCollider(
        R.ColliderDesc.cuboid(b.w / 2, b.h / 2, b.d / 2).setTranslation(b.x, b.y0 + b.h / 2, b.z),
        body,
      );
    }
  }

  update() {}

  /** Height of the tallest building (m), for the HUD and tests. */
  get maxHeight() {
    return this.layout.buildings.reduce((m, b) => Math.max(m, b.h), 0);
  }
}

function setBoxMatrix(b: Box, out: THREE.Matrix4) {
  out.compose(_p.set(b.x, b.y0 + b.h / 2, b.z), _q.identity(), _s.set(b.w, b.h, b.d));
}
