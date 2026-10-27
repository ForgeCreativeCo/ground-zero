import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { config } from '../config';
import { events } from '../core/events';
import type { Input } from '../core/input';
import { PLAYER_QUERY_GROUPS, type Physics } from '../physics/physics';
import { smoothstep } from './flightModel';

const _pivot = new THREE.Vector3();
const _back = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _want = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _fwdAxis = new THREE.Vector3(0, 0, -1);
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const _vec = { x: 0, y: 0, z: 0 };
const _pos = { x: 0, y: 0, z: 0 };

export interface CameraTarget {
  /** Interpolated hero feet position. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  grounded: boolean;
}

/**
 * Third-person camera (DESIGN.md §5.3): over the shoulder on a spring arm that pulls in against
 * walls and never clips into geometry, FOV that widens with speed, and trauma-based shake.
 */
export class CameraRig {
  yaw = 0;
  pitch = -0.12;
  /** A power is firing (set each frame): the camera moves to the aim offset. */
  aiming = false;
  private aimK = 0;
  private arm = 4;
  private pivotY = 1.6;
  private fov = 70;
  private fovKick = 0;
  private trauma = 0;
  private time = 0;
  private lag = new THREE.Vector3();
  private probe: RAPIER.Ball;
  private probeRadius = 0;

  constructor(
    private readonly physics: Physics,
    private readonly exclude: RAPIER.Collider,
  ) {
    this.probe = new physics.R.Ball(config.camera.probeRadius);
    this.probeRadius = config.camera.probeRadius;
    this.arm = config.camera.distanceGround;
    this.fov = config.camera.fovRest;
    events.on('camera:shake', ({ trauma }) => this.addTrauma(trauma));
    events.on('player:sonicBoom', () => (this.fovKick = 8));
  }

  addTrauma(t: number) {
    this.trauma = Math.min(1, this.trauma + t);
  }

  get shake() {
    return this.trauma;
  }

  look(input: Input, dt: number) {
    const c = config.camera;
    const inv = c.invertY ? -1 : 1;
    this.yaw -= input.mouseDelta.x * c.mouseSensitivity + input.lookStick.x * c.stickLookSpeed * dt;
    this.pitch -=
      (input.mouseDelta.y * c.mouseSensitivity + input.lookStick.y * c.stickLookSpeed * dt) * inv;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch,
      THREE.MathUtils.degToRad(c.minPitchDeg),
      THREE.MathUtils.degToRad(c.maxPitchDeg),
    );
  }

  update(camera: THREE.PerspectiveCamera, t: CameraTarget, dt: number) {
    const c = config.camera;
    const p = config.player;
    this.time += dt;

    // Arm length by speed: close on foot, pulled back in cruise, further at boost.
    const cruiseK = t.grounded ? 0 : smoothstep(0, p.cruiseSpeed, t.speed);
    const boostK = smoothstep(p.cruiseSpeed, p.boostSpeed, t.speed);
    this.aimK += ((this.aiming ? 1 : 0) - this.aimK) * (1 - Math.exp(-c.aimResponse * dt));
    const wantArm = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(c.distanceGround, c.distanceCruise, cruiseK) +
        (c.distanceBoost - c.distanceCruise) * boostK,
      c.aimDistance,
      this.aimK,
    );

    // Lag a little behind at speed so speed reads, capped so he never leaves the frame.
    _want.set(-t.vx, -t.vy, -t.vz).multiplyScalar(c.velocityLag);
    if (_want.length() > c.maxLag) _want.setLength(c.maxLag);
    this.lag.lerp(_want, 1 - Math.exp(-6 * dt));

    _euler.set(this.pitch, this.yaw, 0);
    _q.setFromEuler(_euler);
    _back.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);

    // Rise above his back as he levels out into fast flight.
    const flightK = t.grounded ? 0 : smoothstep(p.hoverSpeed * 0.5, p.cruiseSpeed, t.speed);
    this.pivotY +=
      (THREE.MathUtils.lerp(c.pivotHeight, c.pivotHeightFlight, flightK) - this.pivotY) *
      (1 - Math.exp(-4 * dt));
    _pivot.set(t.x, t.y + this.pivotY, t.z).add(this.lag);
    // Desired camera point: behind and over the right shoulder.
    _want
      .copy(_back)
      .multiplyScalar(wantArm)
      .addScaledVector(
        _right,
        THREE.MathUtils.lerp(c.shoulderOffset, c.aimShoulderOffset, this.aimK),
      );
    const wantLen = _want.length();
    _want.divideScalar(wantLen);

    // Spring arm: sphere-cast from the pivot; snap in on a hit, ease back out when clear.
    const allowed = this.castArm(_pivot, _want, wantLen);
    if (allowed < this.arm) this.arm = allowed;
    else this.arm += (allowed - this.arm) * (1 - Math.exp(-c.extendResponse * dt));

    camera.position.copy(_pivot).addScaledVector(_want, this.arm);

    // Shake: trauma² scaled noise, decaying.
    this.trauma = Math.max(0, this.trauma - c.shakeDecay * dt);
    const s = this.trauma * this.trauma;
    if (s > 1e-4) {
      const f = c.shakeFrequency;
      const n1 = noise(this.time * f, 1.3);
      const n2 = noise(this.time * f, 7.1);
      const n3 = noise(this.time * f, 3.7);
      camera.position.addScaledVector(_right, n1 * c.shakeMaxOffset * s);
      camera.position.addScaledVector(_up, n2 * c.shakeMaxOffset * s);
      _roll.setFromAxisAngle(_fwdAxis, THREE.MathUtils.degToRad(c.shakeMaxRollDeg) * s * n3);
      _q.multiply(_roll);
    }
    camera.quaternion.copy(_q);

    // FOV widens with speed (plus a kick on the sonic boom).
    const wantFov = THREE.MathUtils.lerp(c.fovRest, c.fovMax, smoothstep(0, p.boostSpeed, t.speed));
    this.fov += (wantFov - this.fov) * (1 - Math.exp(-c.fovResponse * dt));
    this.fovKick *= Math.exp(-3 * dt);
    return this.fov + this.fovKick;
  }

  /** Free length along `dir` from `from` before the probe sphere touches static geometry. */
  private castArm(from: THREE.Vector3, dir: THREE.Vector3, maxLen: number): number {
    const R = this.physics.R;
    if (this.probeRadius !== config.camera.probeRadius) {
      this.probeRadius = config.camera.probeRadius;
      this.probe = new R.Ball(this.probeRadius);
    }
    _pos.x = from.x;
    _pos.y = from.y;
    _pos.z = from.z;
    _vec.x = dir.x;
    _vec.y = dir.y;
    _vec.z = dir.z;
    const hit = this.physics.world.castShape(
      _pos,
      _rot,
      _vec,
      this.probe,
      0,
      maxLen,
      true,
      R.QueryFilterFlags.EXCLUDE_DYNAMIC,
      PLAYER_QUERY_GROUPS,
      this.exclude,
    );
    if (!hit) return maxLen;
    return Math.max(0.2, hit.time_of_impact - 0.05);
  }
}

/** Smooth 1D noise in [-1, 1] from layered sines (cheap, no allocation). */
function noise(t: number, seed: number) {
  return (
    Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.3 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.1 + seed * 2.9) * 0.2
  );
}
