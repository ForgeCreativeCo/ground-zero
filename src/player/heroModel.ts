import * as THREE from 'three/webgpu';
import { config } from '../config';
import { smoothstep } from './flightModel';

/**
 * ZERO placeholder (DESIGN.md §3): a smooth humanoid of capsules and spheres on a joint
 * hierarchy, never boxes. Procedural poses stand in for the animation set until the Mixamo
 * pipeline (M5) supplies a skinned model; swapping in that model only replaces this class.
 */

type JointName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'elbowL'
  | 'shoulderR'
  | 'elbowR'
  | 'hipL'
  | 'kneeL'
  | 'hipR'
  | 'kneeR';

const JOINTS: JointName[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'elbowL',
  'shoulderR',
  'elbowR',
  'hipL',
  'kneeL',
  'hipR',
  'kneeR',
];
const JOINT_INDEX = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;

export interface HeroPoseInput {
  state: 'grounded' | 'airborne' | 'flying';
  speed: number;
  horizontalSpeed: number;
  verticalSpeed: number;
  /** Unit velocity direction (any when slow). */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Camera yaw, used for facing when he is not moving. */
  lookYaw: number;
  charging: number;
  landing: boolean;
  diving: boolean;
  boosting: boolean;
  /** Strength action layered over the movement pose (see powers/strength.ts). */
  action: string;
  /** 0..1 progress of the action. */
  actionT: number;
}

const _qUp = new THREE.Quaternion();
const _qFly = new THREE.Quaternion();
const _qBank = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);

export class HeroModel {
  /** Placed at the body centre; rotations pivot here. */
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private joints = {} as Record<JointName, THREE.Group>;
  private target = new Float32Array(JOINTS.length * 3);
  private current = new Float32Array(JOINTS.length * 3);
  private hipDrop = 0;
  private hipDropTarget = 0;
  private phase = 0;
  private heading = 0;
  private bank = 0;
  private flyBlend = 0;
  private time = 0;
  readonly suit: THREE.MeshStandardNodeMaterial;

  constructor(scene: THREE.Scene) {
    this.suit = new THREE.MeshStandardNodeMaterial({
      color: 0x15171b,
      roughness: 0.62,
      metalness: 0.18,
    });
    const skin = this.suit;
    const h = config.player.height;
    this.body.position.y = -h / 2;
    this.root.add(this.body);

    const j = (name: JointName, parent: THREE.Object3D, x: number, y: number, z: number) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      this.joints[name] = g;
      return g;
    };
    // Smooth limb: capsule hanging below (or rising above) its joint.
    const limb = (
      parent: THREE.Object3D,
      radius: number,
      length: number,
      dir: 1 | -1,
      sx = 1,
      sz = 1,
    ) => {
      const geo = new THREE.CapsuleGeometry(radius, length, 8, 20);
      const m = new THREE.Mesh(geo, skin);
      m.position.y = (dir * length) / 2;
      m.scale.set(sx, 1, sz);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const ball = (parent: THREE.Object3D, r: number, y: number, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), skin);
      m.position.y = y;
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // Proportions for a 1.95 m, heavily built figure.
    const hips = j('hips', this.body, 0, 1.0, 0);
    ball(hips, 0.16, 0.0, 1.25, 0.85, 0.9);
    const spine = j('spine', hips, 0, 0.06, 0);
    limb(spine, 0.15, 0.14, 1, 1.15, 0.82);
    const chest = j('chest', spine, 0, 0.24, 0);
    limb(chest, 0.18, 0.16, 1, 1.38, 0.85);
    const neck = j('neck', chest, 0, 0.36, 0);
    limb(neck, 0.06, 0.06, 1);
    const head = j('head', neck, 0, 0.1, 0);
    ball(head, 0.115, 0.1, 0.9, 1.12, 1.0);

    for (const side of [1, -1] as const) {
      const L = side === 1;
      const shoulder = j(L ? 'shoulderL' : 'shoulderR', chest, side * 0.27, 0.3, 0);
      ball(shoulder, 0.085, 0, 1.1, 1, 1);
      limb(shoulder, 0.066, 0.24, -1);
      const elbow = j(L ? 'elbowL' : 'elbowR', shoulder, 0, -0.3, 0);
      limb(elbow, 0.056, 0.22, -1);
      ball(elbow, 0.058, -0.32, 0.9, 1.1, 1.05);

      const hip = j(L ? 'hipL' : 'hipR', hips, side * 0.11, -0.04, 0);
      limb(hip, 0.09, 0.32, -1, 1, 1.05);
      const knee = j(L ? 'kneeL' : 'kneeR', hip, 0, -0.47, 0);
      limb(knee, 0.07, 0.34, -1);
      const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.14, 6, 12), skin);
      foot.rotation.x = Math.PI / 2;
      foot.position.set(0, -0.46, -0.06);
      foot.castShadow = true;
      knee.add(foot);
    }
    scene.add(this.root);
  }

  /** Render-frame update: position (body centre), facing, banking and the blended pose. */
  update(x: number, y: number, z: number, s: HeroPoseInput, dt: number) {
    const p = config.player;
    this.time += dt;
    this.root.position.set(x, y + p.height / 2, z);

    // Heading: where he moves, or where the camera looks when still.
    const prevHeading = this.heading;
    if (s.horizontalSpeed > 1.5) {
      this.heading = dampAngle(this.heading, Math.atan2(-s.dirX, -s.dirZ), 12, dt);
    } else if (s.state !== 'grounded' || s.charging > 0) {
      this.heading = dampAngle(this.heading, s.lookYaw, 6, dt);
    }
    const yawRate = wrapAngle(this.heading - prevHeading) / Math.max(dt, 1e-4);

    // Upright orientation (with a forward lean in hover) vs. horizontal "superhero" flight.
    const flying = s.state === 'flying';
    const flyTarget = flying ? smoothstep(p.hoverSpeed * 0.6, p.cruiseSpeed * 0.8, s.speed) : 0;
    this.flyBlend += (flyTarget - this.flyBlend) * (1 - Math.exp(-5 * dt));
    const lean = flying ? Math.min(0.35, (s.horizontalSpeed / p.hoverSpeed) * 0.35) : 0;
    _qUp.setFromAxisAngle(_axisY, this.heading);
    _qBank.setFromAxisAngle(_x.set(1, 0, 0), -lean);
    _qUp.multiply(_qBank);

    if (this.flyBlend > 1e-3) {
      // Body up axis along velocity, chest facing the ground (or the look direction in a dive).
      _y.set(s.dirX, s.dirY, s.dirZ).normalize();
      _z.set(0, -1, 0).addScaledVector(_y, _y.y); // down minus its component along velocity
      if (_z.lengthSq() < 1e-4) _z.set(Math.sin(s.lookYaw), 0, Math.cos(s.lookYaw)).negate();
      _z.normalize().negate(); // model front is -Z
      _x.crossVectors(_y, _z).normalize();
      _z.crossVectors(_x, _y);
      _m.makeBasis(_x, _y, _z);
      _qFly.setFromRotationMatrix(_m);
      const bankTarget = THREE.MathUtils.clamp(
        -yawRate * 0.35,
        -THREE.MathUtils.degToRad(p.bankMaxDeg),
        THREE.MathUtils.degToRad(p.bankMaxDeg),
      );
      this.bank += (bankTarget - this.bank) * (1 - Math.exp(-p.bankResponse * dt));
      _qBank.setFromAxisAngle(_y, this.bank);
      _qFly.premultiply(_qBank);
      this.root.quaternion.slerpQuaternions(_qUp, _qFly, this.flyBlend);
    } else {
      this.bank *= Math.exp(-p.bankResponse * dt);
      this.root.quaternion.copy(_qUp);
    }

    this.computePose(s, dt);
    this.applyAction(s.action, s.actionT);
    const k = 1 - Math.exp(-p.poseResponse * dt);
    for (let i = 0; i < this.current.length; i++) {
      this.current[i]! += (this.target[i]! - this.current[i]!) * k;
    }
    this.hipDrop += (this.hipDropTarget - this.hipDrop) * k;
    for (let i = 0; i < JOINTS.length; i++) {
      const c = this.current;
      this.joints[JOINTS[i]!].rotation.set(c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!);
    }
    this.joints.hips.position.y = 1.0 - this.hipDrop;
  }

  /** World-space chest position (tests check the camera frames him). */
  chestWorld() {
    this.root.updateMatrixWorld(true);
    return this.joints.chest.getWorldPosition(new THREE.Vector3());
  }

  private set(name: JointName, x: number, y = 0, z = 0) {
    const i = JOINT_INDEX[name] * 3;
    this.target[i] = x;
    this.target[i + 1] = y;
    this.target[i + 2] = z;
  }

  /**
   * Pose conventions: limbs hang along -Y, so +X swings them forward; the spine points up, so
   * -X leans it forward. Left side is +X, and +Z rotation moves a left limb outward.
   */
  /** Arm/torso overrides for punches, uppercuts, carrying, throwing and slams. */
  private applyAction(action: string, t: number) {
    if (action === 'none') return;
    // Strike curve: snaps out by 30% of the action, eases back after.
    const k = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    const hit = Math.max(0, Math.min(1, k));
    switch (action) {
      case 'punchR':
        this.set('shoulderR', 1.55 * hit, 0, -0.15);
        this.set('elbowR', 0.15 + 1.2 * (1 - hit));
        this.set('chest', 0, -0.35 * hit, 0);
        this.set('shoulderL', 0.5, 0, 0.2);
        this.set('elbowL', 1.5);
        break;
      case 'punchL':
        this.set('shoulderL', 1.55 * hit, 0, 0.15);
        this.set('elbowL', 0.15 + 1.2 * (1 - hit));
        this.set('chest', 0, 0.35 * hit, 0);
        this.set('shoulderR', 0.5, 0, -0.2);
        this.set('elbowR', 1.5);
        break;
      case 'finisher':
        this.set('shoulderR', 1.5 * hit, 0.3 * hit, -0.45 * hit);
        this.set('elbowR', 0.25);
        this.set('chest', 0, -0.7 * hit, 0);
        this.set('spine', -0.2 * hit, -0.3 * hit, 0);
        break;
      case 'uppercutCharge':
        this.hipDropTarget = Math.max(this.hipDropTarget, 0.25 * t);
        this.set('shoulderR', -0.4, 0, -0.25);
        this.set('elbowR', 1.8);
        this.set('spine', -0.25 * t, -0.3 * t, 0);
        break;
      case 'uppercut':
        this.set('shoulderR', -0.4 + 3.3 * Math.min(1, t / 0.3), 0, -0.15);
        this.set('elbowR', 1.8 - 1.5 * Math.min(1, t / 0.3));
        this.set('spine', 0.15 * hit, 0.2 * hit, 0);
        break;
      case 'carry':
        this.set('shoulderR', 2.95, 0, -0.32);
        this.set('shoulderL', 2.95, 0, 0.32);
        this.set('elbowR', 0.35);
        this.set('elbowL', 0.35);
        break;
      case 'throw':
        this.set('shoulderR', 2.9 - 1.6 * Math.min(1, t / 0.4), 0, -0.2);
        this.set('shoulderL', 2.9 - 2.2 * Math.min(1, t / 0.4), 0, 0.2);
        this.set('elbowR', 0.2);
        this.set('elbowL', 0.2);
        this.set('chest', -0.3 * hit, 0, 0);
        break;
      case 'slam':
        this.hipDropTarget = Math.max(this.hipDropTarget, 0.45 * (1 - t));
        this.set('spine', -0.5 * (1 - t));
        this.set('shoulderR', 1.2 * (1 - t), 0, -0.3);
        this.set('shoulderL', 1.2 * (1 - t), 0, 0.3);
        this.set('elbowR', 0.3);
        this.set('elbowL', 0.3);
        break;
    }
  }

  private computePose(s: HeroPoseInput, dt: number) {
    this.target.fill(0);
    this.hipDropTarget = 0;
    const t = this.time;

    if (s.landing || s.charging > 0) {
      // Crouched impact / leap charge: one fist toward the ground.
      const c = s.landing ? 1 : 0.35 + 0.65 * s.charging;
      this.hipDropTarget = 0.42 * c;
      this.set('spine', -0.45 * c);
      this.set('chest', -0.25 * c);
      this.set('neck', 0.35 * c);
      this.set('hipL', 1.45 * c, 0, 0.12);
      this.set('kneeL', -2.1 * c);
      this.set('hipR', 0.5 * c, 0, -0.15);
      this.set('kneeR', -1.6 * c);
      this.set('shoulderL', 0.25 * c, 0, 0.5 * c);
      this.set('elbowL', 0.5 * c);
      this.set('shoulderR', 0.9 * c, 0, -0.2);
      this.set('elbowR', 0.15);
      return;
    }

    if (s.state === 'grounded') {
      const sp = s.horizontalSpeed;
      const run = smoothstep(4, 12, sp);
      const amp = Math.min(1, sp / 4);
      this.phase += dt * (5 + sp * 0.55);
      const ph = this.phase;
      const legA = (0.45 + 0.45 * run) * amp;
      const sinp = Math.sin(ph);
      this.set('spine', -0.08 - 0.25 * run * amp);
      this.set('neck', 0.1 + 0.15 * run * amp);
      this.set('hipL', legA * sinp);
      this.set('hipR', -legA * sinp);
      this.set('kneeL', -(0.15 + (0.6 + run) * amp * Math.max(0, -Math.sin(ph + 0.6))));
      this.set('kneeR', -(0.15 + (0.6 + run) * amp * Math.max(0, Math.sin(ph + 0.6))));
      const armA = (0.35 + 0.55 * run) * amp;
      this.set('shoulderL', -armA * sinp, 0, 0.12);
      this.set('shoulderR', armA * sinp, 0, -0.12);
      this.set('elbowL', 0.25 + 0.9 * run * amp);
      this.set('elbowR', 0.25 + 0.9 * run * amp);
      // Idle breathing.
      this.set('chest', 0.02 * Math.sin(t * 1.8) * (1 - amp));
      this.hipDropTarget = 0.04 * run * amp * Math.abs(Math.sin(ph));
      return;
    }

    if (s.state === 'airborne') {
      const up = s.verticalSpeed > 0;
      this.set('spine', up ? -0.1 : 0.05);
      this.set('hipL', up ? 0.9 : 0.35, 0, 0.1);
      this.set('kneeL', up ? -1.4 : -0.5);
      this.set('hipR', up ? 0.3 : 0.15, 0, -0.1);
      this.set('kneeR', up ? -0.7 : -0.3);
      this.set('shoulderL', up ? -0.5 : 0.2, 0, 0.7);
      this.set('shoulderR', up ? 2.6 : 0.2, 0, -0.5);
      this.set('elbowL', 0.3);
      this.set('elbowR', 0.2);
      return;
    }

    // Flying: hover pose blends into the streamlined flight pose with speed.
    const f = this.flyBlend;
    const sway = Math.sin(t * 1.3) * 0.06 * (1 - f);
    const fast = s.boosting || s.diving;
    // Hover: one knee bent, arms loose and slightly out.
    const h = 1 - f;
    this.set('spine', -0.05 * h + sway);
    this.set('hipL', 0.12 * h, 0, 0.04);
    this.set('kneeL', -0.3 * (1 - f) - 0.08 * f);
    this.set('hipR', 0.45 * h, 0, -0.04);
    this.set('kneeR', -0.85 * (1 - f) - 0.12 * f);
    // Flight: right arm punched forward along the body (overhead in body space); in boost/dive
    // both arms. Left arm tucked at the side when cruising.
    const reachR = 2.95 * f;
    const reachL = fast ? 2.95 * f : -0.1 * f;
    this.set('shoulderR', reachR + 0.15 * (1 - f), 0, -0.25 * (1 - f) - 0.1 * f);
    this.set('shoulderL', reachL + 0.15 * (1 - f), 0, 0.25 * (1 - f) + (fast ? 0.1 : 0.15) * f);
    this.set('elbowR', 0.35 * (1 - f) + 0.05 * f);
    this.set('elbowL', 0.35 * (1 - f) + (fast ? 0.05 : 0.15) * f);
    this.set('neck', 0.55 * f); // look ahead when horizontal
  }
}

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function dampAngle(a: number, b: number, rate: number, dt: number) {
  return a + wrapAngle(b - a) * (1 - Math.exp(-rate * dt));
}
