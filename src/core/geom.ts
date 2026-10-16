/**
 * Geometry helpers (ray/box and segment/box tests, cones, sweep cuts) for the powers and the
 * destruction queries. Pure math: no three.js or DOM, so it is unit-tested.
 */

/** Result of a ray/box test. */
export interface RayBoxHit {
  tEnter: number;
  tExit: number;
  /** Axis of the face the ray enters through (0 x, 1 y, 2 z) and the sign of its outward normal. */
  axis: number;
  sign: number;
}

/**
 * Slab test of a ray (origin o, direction d) against an axis-aligned box (centre c, half-extents h).
 * Returns false if it misses or the box is entirely behind the origin. A ray starting inside
 * reports tEnter < 0.
 */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  out: RayBoxHit,
): boolean {
  _slab.tmin = -Infinity;
  _slab.tmax = Infinity;
  _slab.axis = 0;
  _slab.sign = 1;
  if (!slab(ox - cx, dx, hx, 0) || !slab(oy - cy, dy, hy, 1) || !slab(oz - cz, dz, hz, 2))
    return false;
  if (_slab.tmax < 0) return false;
  out.tEnter = _slab.tmin;
  out.tExit = _slab.tmax;
  out.axis = _slab.axis;
  out.sign = _slab.sign;
  return true;
}

const _slab = { tmin: 0, tmax: 0, axis: 0, sign: 1 };

/** One axis of the slab test (o relative to the box centre). False once the ray misses. */
function slab(o: number, d: number, h: number, axis: number) {
  if (Math.abs(d) < 1e-9) return o >= -h && o <= h;
  const inv = 1 / d;
  let t1 = (-h - o) * inv;
  let t2 = (h - o) * inv;
  // Entering through the -h face when moving +, the +h face when moving -.
  let s = -1;
  if (t1 > t2) {
    const tmp = t1;
    t1 = t2;
    t2 = tmp;
    s = 1;
  }
  if (t1 > _slab.tmin) {
    _slab.tmin = t1;
    _slab.axis = axis;
    _slab.sign = s;
  }
  if (t2 < _slab.tmax) _slab.tmax = t2;
  return _slab.tmin <= _slab.tmax;
}

/** Parameter (0..1) of the point on segment a→b closest to p. */
export function closestOnSegment(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  px: number,
  py: number,
  pz: number,
) {
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const len2 = ex * ex + ey * ey + ez * ez;
  if (len2 < 1e-12) return 0;
  const t = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Squared distance from a point to an axis-aligned box (0 inside). */
export function pointBoxDistSq(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
) {
  const dx = Math.max(0, Math.abs(px - cx) - hx);
  const dy = Math.max(0, Math.abs(py - cy) - hy);
  const dz = Math.max(0, Math.abs(pz - cz) - hz);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Approximate squared distance from segment a→b to a box: the box distance of the segment point
 * closest to the box centre, refined once from the nearest point on the box. Exact for the
 * cases that matter here (boxes much smaller or larger than the segment).
 */
export function segmentBoxDistSq(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
) {
  let t = closestOnSegment(ax, ay, az, bx, by, bz, cx, cy, cz);
  let px = ax + (bx - ax) * t;
  let py = ay + (by - ay) * t;
  let pz = az + (bz - az) * t;
  // Clamp to the box and re-project: handles long boxes (slabs, facade strips) beside the path.
  const qx = Math.max(cx - hx, Math.min(cx + hx, px));
  const qy = Math.max(cy - hy, Math.min(cy + hy, py));
  const qz = Math.max(cz - hz, Math.min(cz + hz, pz));
  t = closestOnSegment(ax, ay, az, bx, by, bz, qx, qy, qz);
  px = ax + (bx - ax) * t;
  py = ay + (by - ay) * t;
  pz = az + (bz - az) * t;
  return pointBoxDistSq(px, py, pz, cx, cy, cz, hx, hy, hz);
}

/**
 * Which axis a sweeping beam slices a box along (DESIGN.md §6.2). The cut plane contains the beam
 * direction d and the sweep direction s, so its normal is d × s. Pieces are boxes, so the cut is
 * made across the box's long axis that lines up best with that normal (never its thin axis).
 * Returns -1 if the sweep is too small to define a plane.
 */
export function cutAxis(
  dx: number,
  dy: number,
  dz: number,
  sx: number,
  sy: number,
  sz: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  const nx = dy * sz - dz * sy;
  const ny = dz * sx - dx * sz;
  const nz = dx * sy - dy * sx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) return -1;
  const n = [Math.abs(nx) / len, Math.abs(ny) / len, Math.abs(nz) / len];
  const h = [hx, hy, hz];
  // Drop the thinnest axis (a panel's thickness) unless the piece is roughly cubic.
  let thin = 0;
  for (let a = 1; a < 3; a++) if (h[a]! < h[thin]!) thin = a;
  const sorted = [...h].sort((p, q) => p - q);
  const cubic = sorted[0]! > sorted[1]! * 0.6;
  let best = -1;
  let bestN = -1;
  for (let a = 0; a < 3; a++) {
    if (!cubic && a === thin) continue;
    if (n[a]! > bestN) {
      bestN = n[a]!;
      best = a;
    }
  }
  return best;
}

/** True if p lies inside the cone (apex a, unit axis d, cosine of the half-angle, length). */
export function inCone(
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
  cosHalf: number,
  length: number,
  px: number,
  py: number,
  pz: number,
) {
  const vx = px - ax;
  const vy = py - ay;
  const vz = pz - az;
  const along = vx * dx + vy * dy + vz * dz;
  if (along <= 0 || along > length) return false;
  const dist = Math.hypot(vx, vy, vz);
  return along >= dist * cosHalf;
}
