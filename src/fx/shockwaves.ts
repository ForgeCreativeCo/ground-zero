import * as THREE from 'three/webgpu';
import { color, float, mix, smoothstep, uniform, uv } from 'three/tsl';

interface Wave {
  mesh: THREE.Mesh;
  opacity: { value: number };
  age: number;
  life: number;
  radius: number;
  active: boolean;
  /** Carried along at this velocity for the first followTime seconds. */
  vel: THREE.Vector3;
  followTime: number;
  strength: number;
}

const _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);
const _d = new THREE.Vector3();

/** Expanding shockwave rings (sonic boom, hard landings). A small fixed pool, oldest reused. */
export class Shockwaves {
  private waves: Wave[] = [];

  constructor(scene: THREE.Scene, poolSize = 8) {
    // Ring in the XY plane; a soft band brightest at its outer edge.
    const geo = new THREE.RingGeometry(0.55, 1, 96, 1);
    for (let i = 0; i < poolSize; i++) {
      const opacity = uniform(0);
      const mat = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      // RingGeometry UVs map the ring's disc to 0..1, so r is radius / outer radius.
      const r = uv().sub(0.5).length().mul(2);
      // Pale band with a slightly darker leading edge so it reads against bright sky too.
      mat.colorNode = mix(color(0xf3f6fa), color(0xa9b3bd), smoothstep(0.85, 1.0, r));
      mat.opacityNode = smoothstep(0.55, 0.9, r)
        .mul(float(1).sub(smoothstep(0.96, 1.0, r)))
        .mul(opacity)
        .mul(0.85);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      scene.add(mesh);
      this.waves.push({
        mesh,
        opacity,
        age: 0,
        life: 1,
        radius: 1,
        active: false,
        vel: new THREE.Vector3(),
        followTime: 0,
        strength: 1,
      });
    }
  }

  /**
   * Spawns a ring at `pos` facing `normal` (ring plane is perpendicular to it). With `follow`, the
   * ring rides along at that velocity for `followTime` seconds first, so a chase camera sees it
   * form around the hero before it is left behind.
   */
  spawn(
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    life: number,
    strength = 1,
    follow?: THREE.Vector3,
    followTime = 0,
  ) {
    let w = this.waves.find((v) => !v.active);
    if (!w) w = this.waves.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    w.active = true;
    w.age = 0;
    w.life = life;
    w.radius = radius;
    w.mesh.visible = true;
    w.mesh.position.copy(pos);
    _d.copy(normal).normalize();
    _q.setFromUnitVectors(_z, _d);
    w.mesh.quaternion.copy(_q);
    w.mesh.scale.setScalar(0.01);
    w.opacity.value = strength;
    w.strength = strength;
    if (follow) w.vel.copy(follow);
    else w.vel.set(0, 0, 0);
    w.followTime = follow ? followTime : 0;
  }

  /** Startup shader prewarm only. */
  setAllVisible(on: boolean) {
    for (const w of this.waves) w.mesh.visible = on || w.active;
  }

  update(dt: number) {
    for (const w of this.waves) {
      if (!w.active) continue;
      w.age += dt;
      const t = w.age / w.life;
      if (t >= 1) {
        w.active = false;
        w.mesh.visible = false;
        continue;
      }
      if (w.age < w.followTime) w.mesh.position.addScaledVector(w.vel, dt);
      // Fast start so it reads immediately, then a long expanding tail.
      const ease = 1 - Math.pow(1 - t, 4);
      w.mesh.scale.setScalar(Math.max(0.01, 2 + (w.radius - 2) * ease));
      w.opacity.value = w.strength * (1 - t) * (1 - t);
    }
  }
}
