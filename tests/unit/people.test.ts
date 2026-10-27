import { describe, expect, it } from 'vitest';
import { bakeAnimations, clipRow } from '../../src/npc/animBake';
import { CLIPS, PoseBuilder, poseMatrices, type SkeletonDef } from '../../src/npc/poses';
import { generateCity } from '../../src/world/cityLayout';
import {
  buildStreets,
  edgeLength,
  lanePoint,
  lightState,
  ringParam,
  ringPoint,
} from '../../src/world/streets';
import { city } from '../../src/config/city';

/** A tiny T-pose skeleton with the joint names the clips use. */
function skeleton(): SkeletonDef {
  const joints: string[] = [];
  const parents: number[] = [];
  const bind: number[][] = [];
  const add = (name: string, parent: string | null, p: number[]) => {
    joints.push(name);
    parents.push(parent ? joints.indexOf(parent) : -1);
    bind.push(p);
  };
  add('root', null, [0, 0, 0]);
  add('pelvis', 'root', [0, 0.95, 0]);
  add('spine_01', 'pelvis', [0, 1.07, 0]);
  add('spine_02', 'spine_01', [0, 1.18, 0]);
  add('spine_03', 'spine_02', [0, 1.31, 0]);
  add('neck_01', 'spine_03', [0, 1.52, 0]);
  add('Head', 'neck_01', [0, 1.6, 0]);
  for (const [s, x] of [
    ['l', 1],
    ['r', -1],
  ] as const) {
    add(`clavicle_${s}`, 'spine_03', [0.03 * x, 1.5, 0]);
    add(`upperarm_${s}`, `clavicle_${s}`, [0.21 * x, 1.46, 0]);
    add(`lowerarm_${s}`, `upperarm_${s}`, [0.46 * x, 1.46, 0]);
    add(`hand_${s}`, `lowerarm_${s}`, [0.71 * x, 1.46, 0]);
    add(`thigh_${s}`, 'pelvis', [0.11 * x, 0.97, 0]);
    add(`calf_${s}`, `thigh_${s}`, [0.11 * x, 0.54, 0]);
    add(`foot_${s}`, `calf_${s}`, [0.11 * x, 0.09, 0]);
  }
  return { joints, parents, bind };
}

/** Applies joint b's 3x4 skinning matrix to a point. */
function apply(m: Float32Array, b: number, p: number[]) {
  const o = b * 12;
  return [0, 1, 2].map(
    (r) =>
      m[o + r * 4]! * p[0]! +
      m[o + r * 4 + 1]! * p[1]! +
      m[o + r * 4 + 2]! * p[2]! +
      m[o + r * 4 + 3]!,
  );
}

describe('procedural poses', () => {
  const skel = skeleton();
  const hand = skel.joints.indexOf('hand_l');
  const handBind = skel.bind[hand]!;

  it('the rest pose leaves every vertex where it is', () => {
    const b = new PoseBuilder(skel);
    const m = poseMatrices(skel, b.pose, new Float32Array(skel.joints.length * 12));
    expect(apply(m, hand, handBind).map((v) => +v.toFixed(5))).toEqual(handBind);
  });

  it('lowering the arm brings the hand down to the hip, on the same side', () => {
    const b = new PoseBuilder(skel);
    b.arm(1, 80, 0);
    const m = poseMatrices(skel, b.pose, new Float32Array(skel.joints.length * 12));
    const p = apply(m, hand, handBind);
    expect(p[1]!).toBeLessThan(1.05);
    expect(p[0]!).toBeGreaterThan(0.15);
    // Bone length is preserved.
    const sh = skel.bind[skel.joints.indexOf('upperarm_l')]!;
    expect(Math.hypot(p[0]! - sh[0]!, p[1]! - sh[1]!, p[2]! - sh[2]!)).toBeCloseTo(0.5, 3);
  });

  it('hip flexion swings the foot forward (+z), knee bend sends it back', () => {
    const foot = skel.joints.indexOf('foot_l');
    const b = new PoseBuilder(skel);
    b.leg(1, 30, 0);
    let m = poseMatrices(skel, b.pose, new Float32Array(skel.joints.length * 12));
    expect(apply(m, foot, skel.bind[foot]!)[2]!).toBeGreaterThan(0.3);
    b.reset();
    b.leg(1, 0, 60);
    m = poseMatrices(skel, b.pose, new Float32Array(skel.joints.length * 12));
    expect(apply(m, foot, skel.bind[foot]!)[2]!).toBeLessThan(-0.3);
  });

  it('lying prone puts the head on the ground in front of the feet', () => {
    const head = skel.joints.indexOf('Head');
    const prone = CLIPS.find((c) => c.name === 'prone')!;
    const b = new PoseBuilder(skel);
    prone.sample(b, 0);
    const m = poseMatrices(skel, b.pose, new Float32Array(skel.joints.length * 12));
    const p = apply(m, head, skel.bind[head]!);
    expect(p[1]!).toBeLessThan(0.5);
    expect(p[2]!).toBeGreaterThan(1.2);
  });

  it('bakes every clip for every body, looping clips wrap seamlessly', () => {
    const bake = bakeAnimations([skel, skel]);
    expect(bake.width).toBe(skel.joints.length * 3);
    expect(bake.clips.length).toBe(2);
    expect(bake.clips[0]!.length).toBe(CLIPS.length);
    const walk = bake.clips[1]![CLIPS.findIndex((c) => c.name === 'walk')]!;
    const row = (r: number) => bake.data.subarray(r * bake.width * 4, (r + 1) * bake.width * 4);
    expect(Array.from(row(walk.start))).toEqual(Array.from(row(walk.start + walk.frames)));
    expect(clipRow(walk, walk.duration * 1.25)).toBeCloseTo(walk.start + walk.frames * 0.25, 4);
    // Every value finite.
    expect(bake.data.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('streets', () => {
  const layout = generateCity(1234, city);
  const st = buildStreets(layout, { ...city, laneOffsets: [1.9, 5.4] }, 1234);

  it('has a full grid of intersections and edges', () => {
    const n = (city.blocksX + 1) * (city.blocksZ + 1);
    expect(st.nodes.length).toBe(n);
    expect(st.edges.length).toBe(
      city.blocksX * (city.blocksZ + 1) + city.blocksZ * (city.blocksX + 1),
    );
    expect(st.edges.every((e) => edgeLength(e) > 0)).toBe(true);
  });

  it('drives on the right', () => {
    const e = st.edges.find((x) => x.axis === 0 && x.lanes === 2)!;
    const out = [0, 0, 0];
    lanePoint(st, e, 1, 0, 10, out);
    // Heading +x: the right-hand side is +z.
    expect(out[1]!).toBeGreaterThan(e.line);
    lanePoint(st, e, -1, 0, 10, out);
    expect(out[1]!).toBeLessThan(e.line);
  });

  it('never shows green both ways at a signal', () => {
    const node = st.nodes.find((n) => n.signal)!;
    for (let t = 0; t < 120; t += 0.25) {
      const a = lightState(node, 0, t, 14, 3);
      const b = lightState(node, 1, t, 14, 3);
      expect(a === 2 || b === 2).toBe(true);
    }
  });

  it('ring parameters round-trip', () => {
    const out = [0, 0, 0, 0];
    for (const s of [0, 10, 95, 150, 260, 340]) {
      ringPoint(0, 0, 45, s, out);
      expect(ringParam(0, 0, 45, out[0]!, out[1]!)).toBeCloseTo(s % 360, 3);
    }
  });
});
