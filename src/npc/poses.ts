/**
 * Procedural animation clips for the civilian skeleton (DESIGN.md §9.2, §9.4). The Quaternius base
 * characters ship without animations, so every clip is authored here as a function of time and
 * baked into a bone-matrix texture at startup (npc/animBake.ts). Pure math: no three.js, no DOM.
 *
 * Poses are rotations *relative to the bind T-pose, in model axes* (x = the character's left,
 * y = up, z = forward), applied about each joint and composed down the chain:
 *   C(bone) = C(parent) * D(bone),  joint'(bone) = S(parent)(joint(bone))
 * so "lower the arm" is a rotation about z and "swing it forward" a rotation about x, whatever
 * the bones' own local axes are.
 */

export interface SkeletonDef {
  joints: string[];
  parents: number[];
  /** Bind (T-pose) joint positions in model space. */
  bind: number[][];
}

/** A pose: one delta quaternion per joint (x, y, z, w) plus root and hips offsets (m). */
export interface Pose {
  q: Float32Array;
  root: [number, number, number];
  hips: [number, number, number];
}

export interface ClipDef {
  name: string;
  /** Seconds per cycle (loop) or total length (one-shot). */
  duration: number;
  loop: boolean;
  /** Writes the pose at time t (s, 0..duration). */
  sample: (b: PoseBuilder, t: number) => void;
}

const DEG = Math.PI / 180;

// --- quaternion helpers (x, y, z, w) ---------------------------------------------------------

function qMul(a: Float32Array | number[], ai: number, b: number[], out: Float32Array, oi: number) {
  const ax = a[ai]!,
    ay = a[ai + 1]!,
    az = a[ai + 2]!,
    aw = a[ai + 3]!;
  const [bx, by, bz, bw] = b as [number, number, number, number];
  out[oi] = aw * bx + ax * bw + ay * bz - az * by;
  out[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

const _r = [0, 0, 0, 1];
const _tmp = new Float32Array(4);

/** Rotates vector v by quaternion q (in place into out). */
function qRotate(q: Float32Array, qi: number, v: number[], out: number[]) {
  const x = q[qi]!,
    y = q[qi + 1]!,
    z = q[qi + 2]!,
    w = q[qi + 3]!;
  const [vx, vy, vz] = v as [number, number, number];
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
}

/** Builds a pose by stacking rotations onto joints (applied in call order). */
export class PoseBuilder {
  readonly pose: Pose;
  private index = new Map<string, number>();

  constructor(readonly skel: SkeletonDef) {
    this.pose = { q: new Float32Array(skel.joints.length * 4), root: [0, 0, 0], hips: [0, 0, 0] };
    skel.joints.forEach((n, i) => this.index.set(n, i));
    this.reset();
  }

  reset() {
    const q = this.pose.q;
    for (let i = 0; i < q.length; i += 4) {
      q[i] = q[i + 1] = q[i + 2] = 0;
      q[i + 3] = 1;
    }
    this.pose.root = [0, 0, 0];
    this.pose.hips = [0, 0, 0];
  }

  has(bone: string) {
    return this.index.has(bone);
  }

  /** Applies a rotation about a model axis (degrees) after whatever the joint already has. */
  rot(bone: string, axis: 'x' | 'y' | 'z', deg: number) {
    const i = this.index.get(bone);
    if (i === undefined || deg === 0) return this;
    const h = (deg * DEG) / 2;
    const s = Math.sin(h);
    _r[0] = axis === 'x' ? s : 0;
    _r[1] = axis === 'y' ? s : 0;
    _r[2] = axis === 'z' ? s : 0;
    _r[3] = Math.cos(h);
    // New delta = R * D (R applied after the existing delta).
    _tmp[0] = _r[0];
    _tmp[1] = _r[1];
    _tmp[2] = _r[2];
    _tmp[3] = _r[3];
    const q = this.pose.q;
    qMul(_tmp, 0, [q[i * 4]!, q[i * 4 + 1]!, q[i * 4 + 2]!, q[i * 4 + 3]!], q, i * 4);
    return this;
  }

  hips(x: number, y: number, z: number) {
    this.pose.hips = [x, y, z];
    return this;
  }

  root(x: number, y: number, z: number) {
    this.pose.root = [x, y, z];
    return this;
  }

  // --- body-part helpers (degrees; sides: 1 = left, -1 = right) -----------------------------

  /** Upper arm: lowered from the T-pose by `down`, then swung forward by `fwd`, out by `out`. */
  arm(side: 1 | -1, down: number, fwd: number, out = 0) {
    const n = side === 1 ? 'upperarm_l' : 'upperarm_r';
    this.rot(n, 'z', -side * down);
    this.rot(n, 'x', -fwd);
    if (out) this.rot(n, 'z', side * out);
    return this;
  }

  /** Elbow bend (hand toward the front), forearm twist. */
  elbow(side: 1 | -1, bend: number) {
    return this.rot(side === 1 ? 'lowerarm_l' : 'lowerarm_r', 'y', -side * bend);
  }

  /** Hip flexion (leg forward), knee bend, ankle (toes up +). */
  leg(side: 1 | -1, hip: number, knee: number, ankle = 0, spread = 0) {
    const s = side === 1 ? '_l' : '_r';
    this.rot(`thigh${s}`, 'x', -hip);
    if (spread) this.rot(`thigh${s}`, 'z', side * spread);
    this.rot(`calf${s}`, 'x', knee);
    this.rot(`foot${s}`, 'x', -ankle);
    return this;
  }

  /** Fingers curled into a loose fist (amount 0..1). */
  fist(side: 1 | -1, amount: number) {
    const s = side === 1 ? '_l' : '_r';
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      // T-pose palms face down, so fingers curl about the forward axis.
      for (const k of ['01', '02', '03']) this.rot(`${f}_${k}${s}`, 'z', -side * amount * 70);
    }
    this.rot(`thumb_02${s}`, 'y', -side * amount * 30);
    return this;
  }

  /** Spine: forward lean, twist (yaw) and side bend, spread over the three spine joints. */
  spine(lean: number, twist = 0, side = 0) {
    for (const n of ['spine_01', 'spine_02', 'spine_03']) {
      this.rot(n, 'x', lean / 3);
      if (twist) this.rot(n, 'y', twist / 3);
      if (side) this.rot(n, 'z', side / 3);
    }
    return this;
  }

  head(pitch: number, yaw = 0, roll = 0) {
    this.rot('neck_01', 'x', pitch * 0.4);
    this.rot('Head', 'x', pitch * 0.6);
    if (yaw) {
      this.rot('neck_01', 'y', yaw * 0.4);
      this.rot('Head', 'y', yaw * 0.6);
    }
    if (roll) this.rot('Head', 'z', roll);
    return this;
  }

  pelvis(pitch: number, yaw = 0, roll = 0) {
    this.rot('pelvis', 'x', pitch);
    if (yaw) this.rot('pelvis', 'y', yaw);
    if (roll) this.rot('pelvis', 'z', roll);
    return this;
  }

  /** Relaxed standing arms (the base of most clips). */
  restArms(sway = 0) {
    this.arm(1, 74, 4 + sway).arm(-1, 74, 4 - sway);
    this.elbow(1, 12).elbow(-1, 12);
    this.fist(1, 0.35).fist(-1, 0.35);
    return this;
  }
}

/**
 * Skinning matrices for a pose: 12 floats per joint (3 rows of [r0 r1 r2 t]), mapping bind-pose
 * model space to posed model space.
 */
export function poseMatrices(skel: SkeletonDef, pose: Pose, out: Float32Array) {
  const n = skel.joints.length;
  const C = new Float32Array(n * 4);
  const J = new Float32Array(n * 3);
  const v = [0, 0, 0];
  const r = [0, 0, 0];
  for (let b = 0; b < n; b++) {
    const p = skel.parents[b]!;
    const jb = skel.bind[b]!;
    if (p < 0) {
      C.set(pose.q.subarray(b * 4, b * 4 + 4), b * 4);
      J[b * 3] = jb[0]! + pose.root[0];
      J[b * 3 + 1] = jb[1]! + pose.root[1];
      J[b * 3 + 2] = jb[2]! + pose.root[2];
    } else {
      qMul(
        C,
        p * 4,
        [pose.q[b * 4]!, pose.q[b * 4 + 1]!, pose.q[b * 4 + 2]!, pose.q[b * 4 + 3]!],
        C,
        b * 4,
      );
      // joint' = C_p (j_b - j_p) + j'_p
      const jp = skel.bind[p]!;
      v[0] = jb[0]! - jp[0]!;
      v[1] = jb[1]! - jp[1]!;
      v[2] = jb[2]! - jp[2]!;
      qRotate(C, p * 4, v, r);
      J[b * 3] = r[0]! + J[p * 3]!;
      J[b * 3 + 1] = r[1]! + J[p * 3 + 1]!;
      J[b * 3 + 2] = r[2]! + J[p * 3 + 2]!;
      if (skel.joints[b] === 'pelvis') {
        // Hips offset, in the root's rotated frame.
        qRotate(C, p * 4, pose.hips, r);
        J[b * 3] = J[b * 3]! + r[0]!;
        J[b * 3 + 1] = J[b * 3 + 1]! + r[1]!;
        J[b * 3 + 2] = J[b * 3 + 2]! + r[2]!;
      }
    }
    // Matrix rows: R(C_b) and t = joint' - R joint.
    const x = C[b * 4]!,
      y = C[b * 4 + 1]!,
      z = C[b * 4 + 2]!,
      w = C[b * 4 + 3]!;
    const m00 = 1 - 2 * (y * y + z * z),
      m01 = 2 * (x * y - z * w),
      m02 = 2 * (x * z + y * w);
    const m10 = 2 * (x * y + z * w),
      m11 = 1 - 2 * (x * x + z * z),
      m12 = 2 * (y * z - x * w);
    const m20 = 2 * (x * z - y * w),
      m21 = 2 * (y * z + x * w),
      m22 = 1 - 2 * (x * x + y * y);
    const o = b * 12;
    out[o] = m00;
    out[o + 1] = m01;
    out[o + 2] = m02;
    out[o + 3] = J[b * 3]! - (m00 * jb[0]! + m01 * jb[1]! + m02 * jb[2]!);
    out[o + 4] = m10;
    out[o + 5] = m11;
    out[o + 6] = m12;
    out[o + 7] = J[b * 3 + 1]! - (m10 * jb[0]! + m11 * jb[1]! + m12 * jb[2]!);
    out[o + 8] = m20;
    out[o + 9] = m21;
    out[o + 10] = m22;
    out[o + 11] = J[b * 3 + 2]! - (m20 * jb[0]! + m21 * jb[1]! + m22 * jb[2]!);
  }
  return out;
}

// --- clips -----------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const pos = (x: number) => Math.max(0, x);
const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shared gait: amplitude set, used by walk / run / panic / limp. */
interface Gait {
  hip: number;
  knee: number;
  kneeStance: number;
  ankle: number;
  bob: number;
  lean: number;
  armSwing: number;
  armFwd: number;
  armDown: number;
  elbow: number;
  pelvisYaw: number;
  limp?: number;
}

function gait(b: PoseBuilder, p: number, g: Gait) {
  const s = Math.sin(p);
  const c = Math.cos(p);
  // Left leg leads at p = π/2 (heel strike); swing phase while cos > 0.
  for (const side of [1, -1] as const) {
    const ph = side === 1 ? p : p + Math.PI;
    const ss = Math.sin(ph);
    const cc = Math.cos(ph);
    const lame = side === -1 && g.limp ? g.limp : 0;
    const hip = g.hip * ss * (1 - lame * 0.4);
    const knee = g.kneeStance + g.knee * pos(cc) ** 2 * (1 - lame * 0.8) + 6 * pos(ss);
    b.leg(side, hip, knee, g.ankle * ss);
  }
  const bob = g.bob * Math.cos(2 * p) - g.bob - (g.limp ? g.limp * 0.04 * pos(-s) : 0);
  b.hips(0, bob, 0);
  b.pelvis(0, g.pelvisYaw * s, 3 * c + (g.limp ? g.limp * 6 * pos(-s) : 0));
  b.spine(g.lean + 1.5 * Math.cos(2 * p), -g.pelvisYaw * 1.2 * s);
  b.head(-g.lean * 0.6, g.pelvisYaw * 0.4 * s);
  // Arms swing against the legs.
  b.arm(1, g.armDown, g.armFwd - g.armSwing * s).arm(-1, g.armDown, g.armFwd + g.armSwing * s);
  b.elbow(1, g.elbow + 10 * pos(-s)).elbow(-1, g.elbow + 10 * pos(s));
}

/** Lying flat: whole body pitched about the feet (prone = face down, +1; supine = -1). */
function lying(b: PoseBuilder, face: 1 | -1, k = 1) {
  b.rot('root', 'x', face * 90 * k);
  b.root(0, 0.14 * k, 0);
}

export const CLIPS: ClipDef[] = [
  {
    name: 'idle',
    duration: 4,
    loop: true,
    sample(b, t) {
      const p = (t / 4) * TAU;
      b.restArms(1.5 * Math.sin(p));
      b.spine(1 + 1.2 * Math.sin(p * 2), 2 * Math.sin(p));
      b.hips(0.015 * Math.sin(p), -0.006, 0);
      b.pelvis(0, 0, 2.5 * Math.sin(p));
      b.leg(1, 2, 3 + 4 * pos(Math.sin(p)), 0, 2);
      b.leg(-1, 2, 3 + 4 * pos(-Math.sin(p)), 0, 2);
      b.head(2 + 1.5 * Math.sin(p * 2), 14 * Math.sin(p + 0.7) * Math.abs(Math.sin(p * 0.5)));
    },
  },
  {
    name: 'phone',
    duration: 5,
    loop: true,
    sample(b, t) {
      const p = (t / 5) * TAU;
      b.arm(1, 74, 4).elbow(1, 14).fist(1, 0.3);
      // Right hand up in front of the chest holding a phone, head down to it.
      b.arm(-1, 70, 34, -10).elbow(-1, 98).fist(-1, 0.6);
      b.spine(4 + 1 * Math.sin(p * 2));
      b.leg(1, 3, 4, 0, 3).leg(-1, -2, 2, 0, 2);
      b.pelvis(0, 0, -3);
      b.head(26 + 3 * Math.sin(p), 4 * Math.sin(p * 0.5));
    },
  },
  {
    name: 'walk',
    duration: 1.1,
    loop: true,
    sample(b, t) {
      gait(b, (t / 1.1) * TAU, {
        hip: 22,
        knee: 48,
        kneeStance: 5,
        ankle: 14,
        bob: 0.02,
        lean: 3,
        armSwing: 15,
        armFwd: 4,
        armDown: 76,
        elbow: 14,
        pelvisYaw: 6,
      });
      b.fist(1, 0.35).fist(-1, 0.35);
    },
  },
  {
    name: 'run',
    duration: 0.68,
    loop: true,
    sample(b, t) {
      gait(b, (t / 0.68) * TAU, {
        hip: 40,
        knee: 95,
        kneeStance: 18,
        ankle: 18,
        bob: 0.045,
        lean: 12,
        armSwing: 38,
        armFwd: 8,
        armDown: 72,
        elbow: 85,
        pelvisYaw: 10,
      });
      b.fist(1, 0.8).fist(-1, 0.8);
    },
  },
  {
    name: 'panic',
    duration: 0.6,
    loop: true,
    sample(b, t) {
      const p = (t / 0.6) * TAU;
      gait(b, p, {
        hip: 44,
        knee: 100,
        kneeStance: 20,
        ankle: 18,
        bob: 0.05,
        lean: 16,
        armSwing: 30,
        armFwd: 40,
        armDown: 40,
        elbow: 95,
        pelvisYaw: 12,
      });
      // Flailing, looking back over a shoulder now and then.
      b.arm(1, 0, 10 * Math.sin(p * 2)).arm(-1, 0, -10 * Math.sin(p * 2));
      b.head(-10, 30 * Math.sin(p * 0.5) ** 3);
      b.fist(1, 0.2).fist(-1, 0.2);
    },
  },
  {
    name: 'cower',
    duration: 1.2,
    loop: true,
    sample(b, t) {
      const tr = Math.sin((t / 1.2) * TAU * 6) * 1.2;
      b.hips(0, -0.47, -0.06);
      b.leg(1, 105, 125, 22, 8).leg(-1, 100, 128, 24, 8);
      b.spine(38 + tr * 0.5);
      b.head(28);
      // Arms wrapped over the head.
      b.arm(1, 74, 150 + tr, -15)
        .elbow(1, 128)
        .fist(1, 0.6);
      b.arm(-1, 74, 150 - tr, -15)
        .elbow(-1, 128)
        .fist(-1, 0.6);
    },
  },
  {
    name: 'point',
    duration: 1.6,
    loop: true,
    sample(b, t) {
      const p = (t / 1.6) * TAU;
      b.arm(1, 74, 6).elbow(1, 25).fist(1, 0.4);
      // Right arm up, pointing at the sky / the hero, jabbing.
      b.arm(-1, 74, 135 + 8 * Math.sin(p * 2), -6).elbow(-1, 6 + 6 * pos(Math.sin(p * 2)));
      b.fist(-1, 0.5);
      b.spine(-6, -8);
      b.head(-22, -6 + 4 * Math.sin(p));
      b.leg(1, 4, 4, 0, 3).leg(-1, -3, 3, 0, 3);
    },
  },
  {
    name: 'film',
    duration: 3,
    loop: true,
    sample(b, t) {
      const p = (t / 3) * TAU;
      // Phone held up at eye level in both hands.
      b.arm(1, 74, 78 + 3 * Math.sin(p), 18)
        .elbow(1, 70)
        .fist(1, 0.6);
      b.arm(-1, 74, 84 + 3 * Math.sin(p), 22)
        .elbow(-1, 62)
        .fist(-1, 0.6);
      b.spine(-3, 4 * Math.sin(p * 0.5));
      b.head(-4, 3 * Math.sin(p * 0.5));
      b.leg(1, 3, 5, 0, 4).leg(-1, -2, 4, 0, 4);
    },
  },
  {
    name: 'sit',
    duration: 5,
    loop: true,
    sample(b, t) {
      const p = (t / 5) * TAU;
      b.hips(0, -0.41, -0.08);
      b.leg(1, 88, 92, 4, 6).leg(-1, 86, 90, 2, 6);
      b.spine(6 + Math.sin(p * 2));
      b.arm(1, 74, 34, -6).elbow(1, 50).fist(1, 0.4);
      b.arm(-1, 74, 32, -6).elbow(-1, 52).fist(-1, 0.4);
      b.head(6, 16 * Math.sin(p) * Math.abs(Math.sin(p * 0.5)));
    },
  },
  {
    name: 'fall',
    duration: 1,
    loop: false,
    sample(b, t) {
      const k = clamp01(t / 1);
      const buckle = ease(clamp01(k / 0.35));
      const drop = clamp01((k - 0.15) / 0.7) ** 2;
      b.rot('root', 'x', 90 * drop);
      b.root(0, 0.14 * drop, 0);
      b.leg(1, 30 * buckle * (1 - drop), 60 * buckle * (1 - drop * 0.7));
      b.leg(-1, 10 * buckle * (1 - drop), 40 * buckle * (1 - drop * 0.6));
      b.spine(20 * buckle * (1 - drop));
      // Arms thrown forward to brace.
      b.arm(1, 74 - 40 * buckle, 110 * buckle).elbow(1, 30);
      b.arm(-1, 74 - 40 * buckle, 120 * buckle).elbow(-1, 25);
      b.head(-30 * drop);
    },
  },
  {
    name: 'prone',
    duration: 4,
    loop: true,
    sample(b, t) {
      const p = (t / 4) * TAU;
      lying(b, 1);
      b.arm(1, 30, 120, 10).elbow(1, 60);
      b.arm(-1, 50, 70, 10).elbow(-1, 30);
      b.leg(1, 4, 8, -30, 6).leg(-1, -2, 30, -30, 4);
      b.spine(-2 + 0.6 * Math.sin(p));
      b.head(-25, 60);
    },
  },
  {
    name: 'crawl',
    duration: 1.8,
    loop: true,
    sample(b, t) {
      const p = (t / 1.8) * TAU;
      const s = Math.sin(p);
      lying(b, 1);
      b.root(0, 0.2, 0);
      b.arm(1, 20, 140 + 25 * s, 10).elbow(1, 50 - 30 * s);
      b.arm(-1, 20, 140 - 25 * s, 10).elbow(-1, 50 + 30 * s);
      b.leg(1, 10 + 12 * pos(-s), 20 + 30 * pos(-s), -30, 10);
      b.leg(-1, 4, 12, -30, 6);
      b.spine(-6, 6 * s, 4 * s);
      b.head(-35, 10 * s);
    },
  },
  {
    name: 'limp',
    duration: 1.35,
    loop: true,
    sample(b, t) {
      gait(b, (t / 1.35) * TAU, {
        hip: 16,
        knee: 40,
        kneeStance: 6,
        ankle: 10,
        bob: 0.025,
        lean: 10,
        armSwing: 8,
        armFwd: 6,
        armDown: 70,
        elbow: 20,
        pelvisYaw: 5,
        limp: 1,
      });
      // Clutching the hurt side.
      b.arm(-1, 0, 20).elbow(-1, 60);
    },
  },
  {
    name: 'dieBack',
    duration: 1.1,
    loop: false,
    sample(b, t) {
      const k = clamp01(t / 1.1);
      const buckle = ease(clamp01(k / 0.3));
      const drop = clamp01((k - 0.1) / 0.75) ** 2;
      b.rot('root', 'x', -90 * drop);
      b.root(0, 0.14 * drop, 0);
      b.leg(1, 40 * buckle * (1 - drop), 70 * buckle * (1 - drop * 0.5));
      b.leg(-1, 25 * buckle * (1 - drop), 50 * buckle * (1 - drop * 0.4));
      b.spine(-20 * buckle);
      b.arm(1, lerp(74, 10, buckle), 30 * buckle).elbow(1, 40 * buckle);
      b.arm(-1, lerp(74, 0, buckle), 50 * buckle).elbow(-1, 30 * buckle);
      b.head(-30 * buckle);
    },
  },
  {
    name: 'supine',
    duration: 4,
    loop: true,
    sample(b) {
      lying(b, -1);
      b.arm(1, 20, -10, 20).elbow(1, 30);
      b.arm(-1, 55, 10, 10).elbow(-1, 70);
      b.leg(1, 8, 14, 20, 8).leg(-1, 2, 4, 25, 5);
      b.head(-10, 40);
    },
  },
  {
    name: 'startle',
    duration: 0.9,
    loop: false,
    sample(b, t) {
      const k = clamp01(t / 0.9);
      const f = Math.sin(Math.PI * clamp01(k / 0.85));
      b.hips(0, -0.12 * f, -0.05 * f);
      b.leg(1, 18 * f, 30 * f).leg(-1, 14 * f, 28 * f);
      b.spine(10 * f, 0);
      b.head(-14 * f, 25 * f);
      // Arms snap up in front of the face.
      b.arm(1, 74, lerp(4, 120, f), -10 * f)
        .elbow(1, lerp(12, 120, f))
        .fist(1, 0.5);
      b.arm(-1, 74, lerp(4, 115, f), -10 * f)
        .elbow(-1, lerp(12, 125, f))
        .fist(-1, 0.5);
    },
  },
  {
    name: 'getUp',
    duration: 1.3,
    loop: false,
    sample(b, t) {
      const k = clamp01(t / 1.3);
      // Push up to a kneel, then stand.
      const up = ease(clamp01(k / 0.6));
      const stand = ease(clamp01((k - 0.5) / 0.5));
      b.rot('root', 'x', 90 * (1 - up));
      b.root(0, 0.14 * (1 - up), 0);
      b.hips(0, -0.45 * up * (1 - stand), -0.1 * up * (1 - stand));
      b.leg(1, 95 * up * (1 - stand), 120 * up * (1 - stand), 20 * up * (1 - stand));
      b.leg(-1, 20 * up * (1 - stand), 110 * up * (1 - stand), 10 * up * (1 - stand));
      b.spine(30 * up * (1 - stand));
      b.arm(1, 74, lerp(110, 4, stand), 0).elbow(1, lerp(30, 12, stand));
      b.arm(-1, 74, lerp(100, 4, stand), 0).elbow(-1, lerp(30, 12, stand));
      b.head(-20 * (1 - stand));
    },
  },
  {
    name: 'help',
    duration: 1.4,
    loop: true,
    sample(b, t) {
      const p = (t / 1.4) * TAU;
      // Sitting hurt on the ground, waving an arm for help.
      b.hips(0, -0.8, -0.1);
      b.leg(1, 82, 20, 10, 10).leg(-1, 76, 50, 10, 6);
      b.spine(-12, 10);
      b.arm(1, 74, 170, 12 * Math.sin(p)).elbow(1, 20 + 15 * Math.sin(p));
      b.arm(-1, 80, -35, 0).elbow(-1, 8);
      b.head(-20, -10 * Math.sin(p));
    },
  },
];

export const CLIP_INDEX: Record<string, number> = Object.fromEntries(
  CLIPS.map((c, i) => [c.name, i]),
);
