import * as THREE from 'three/webgpu';
import { config } from '../config';
import type { Input } from '../core/input';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * Free-fly debug camera (M0 stand-in for the player; photo mode reuses it in M10).
 * Look is applied per rendered frame for responsiveness; movement runs at the fixed rate and
 * is interpolated for rendering.
 */
export class FreeCamera {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private prevPosition = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  /** Scripted control (perf runner, tests): when set, input is ignored. */
  scripted = false;

  constructor() {
    this.reset();
  }

  reset() {
    const c = config.debugCamera;
    this.position.fromArray(c.startPosition);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = THREE.MathUtils.degToRad(c.startYawDeg);
    this.pitch = THREE.MathUtils.degToRad(c.startPitchDeg);
  }

  setPose(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH);
  }

  /** Per rendered frame (real time, unscaled). */
  look(input: Input, realDt: number) {
    if (this.scripted) return;
    const c = config.debugCamera;
    const inv = c.invertY ? -1 : 1;
    this.yaw -=
      input.mouseDelta.x * c.mouseSensitivity + input.lookStick.x * c.stickLookSpeed * realDt;
    this.pitch -=
      (input.mouseDelta.y * c.mouseSensitivity + input.lookStick.y * c.stickLookSpeed * realDt) *
      inv;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -MAX_PITCH, MAX_PITCH);
  }

  /** Fixed step. */
  fixedUpdate(input: Input, dt: number) {
    this.prevPosition.copy(this.position);
    const c = config.debugCamera;
    if (!this.scripted) {
      _euler.set(this.pitch, this.yaw, 0);
      _fwd.set(0, 0, -1).applyEuler(_euler);
      _right.set(1, 0, 0).applyEuler(_euler);
      const speed = input.action('boost').down ? c.boostSpeed : c.speed;
      _wish.set(0, 0, 0).addScaledVector(_fwd, input.move.y).addScaledVector(_right, input.move.x);
      _wish.multiplyScalar(speed);
      const up = input.action('jump').value - input.action('descend').value;
      _wish.y += up * (input.action('boost').down ? c.boostSpeed : c.verticalSpeed);
      const k = 1 - Math.exp(-c.acceleration * dt);
      this.velocity.lerp(_wish, k);
    }
    this.position.addScaledVector(this.velocity, dt);
    if (this.position.y < c.minAltitude) {
      this.position.y = c.minAltitude;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
  }

  apply(camera: THREE.PerspectiveCamera, alpha: number) {
    camera.position.lerpVectors(this.prevPosition, this.position, alpha);
    camera.quaternion.setFromEuler(_euler.set(this.pitch, this.yaw, 0));
  }
}
