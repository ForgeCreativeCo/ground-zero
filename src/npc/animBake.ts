import { CLIPS, PoseBuilder, poseMatrices, type SkeletonDef } from './poses';

/** Baked frames per second of clip time. */
const BAKE_FPS = 30;

export interface BakedClip {
  /** First texture row of this clip for this body. */
  start: number;
  /** Frame intervals (rows = frames + 1). */
  frames: number;
  duration: number;
  loop: boolean;
}

export interface AnimBake {
  /** Texels per row: 3 per joint (rows of a 3x4 matrix). */
  width: number;
  height: number;
  /** RGBA float data, row-major (width * height * 4). */
  data: Float32Array;
  /** [body][clip] */
  clips: BakedClip[][];
}

/**
 * Bakes every clip for every body into one bone-matrix texture (DESIGN.md §9.2 step 5): one row
 * per frame, 3 texels (a 3x4 matrix) per joint. Looping clips repeat their first frame at the end
 * so linear filtering between rows wraps seamlessly. Pure: returns plain arrays.
 */
export function bakeAnimations(skels: SkeletonDef[]): AnimBake {
  const joints = skels[0]!.joints.length;
  const width = joints * 3;
  const clips: BakedClip[][] = [];
  let rows = 0;
  for (let s = 0; s < skels.length; s++) {
    const list: BakedClip[] = [];
    for (const c of CLIPS) {
      const frames = Math.max(8, Math.round(c.duration * BAKE_FPS));
      list.push({ start: rows, frames, duration: c.duration, loop: c.loop });
      rows += frames + 1;
    }
    clips.push(list);
  }
  const data = new Float32Array(width * rows * 4);
  const mats = new Float32Array(joints * 12);
  skels.forEach((skel, s) => {
    const b = new PoseBuilder(skel);
    CLIPS.forEach((c, ci) => {
      const info = clips[s]![ci]!;
      for (let f = 0; f <= info.frames; f++) {
        const t = c.loop
          ? ((f % info.frames) / info.frames) * c.duration
          : (f / info.frames) * c.duration;
        b.reset();
        c.sample(b, t);
        poseMatrices(skel, b.pose, mats);
        const row = info.start + f;
        data.set(mats, row * width * 4);
      }
    });
  });
  return { width, height: rows, data, clips };
}

/** Texture row (float, before the half-texel offset) for a clip at time t (s). */
export function clipRow(c: BakedClip, t: number): number {
  if (c.loop) {
    const ph = t / c.duration;
    return c.start + (ph - Math.floor(ph)) * c.frames;
  }
  return c.start + Math.min(1, Math.max(0, t / c.duration)) * c.frames;
}
