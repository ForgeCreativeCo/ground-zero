import {
  abs,
  cameraPosition,
  color,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  select,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { config } from '../config';

/** 0 by day, 1 at night (set from the sun's elevation each frame). */
export const nightFactor = uniform(0);
/** Window glow by day / night and the lit fractions (live config). */
export const uWindowGlowDay = uniform(config.interiors.windowGlowDay);
export const uWindowGlowNight = uniform(config.interiors.windowGlowNight);
export const uLitDay = uniform(config.interiors.litDay);
export const uLitNight = uniform(config.interiors.litNight);
export const uRoomDepth = uniform(config.interiors.roomDepth);

/** Updates the shared uniforms (call once per frame). */
export function updateInteriorUniforms(sunElevationDeg: number) {
  nightFactor.value = Math.min(1, Math.max(0, (6 - sunElevationDeg) / 12));
  const c = config.interiors;
  uWindowGlowDay.value = c.windowGlowDay;
  uWindowGlowNight.value = c.windowGlowNight;
  uLitDay.value = c.litDay;
  uLitNight.value = c.litNight;
  uRoomDepth.value = c.roomDepth;
}

export function hash(a: Node<'float'>, b: Node<'float'>) {
  return fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453));
}

export interface RoomInputs {
  /** 0..1 across and up the window's wall (the panel face). */
  u: Node<'float'>;
  v: Node<'float'>;
  /** World axis along the wall (unit vector) and outward normal of the wall. */
  tangent: Node<'vec3'>;
  outward: Node<'vec3'>;
  /** Room size along the wall and up (m). */
  width: Node<'float'> | number;
  height: Node<'float'> | number;
  /** 0..1 room seed: decor and whether its light is switched on. */
  seed: Node<'float'>;
  /** Power: 1 on, 0 off, 0.5 flickering (outage front). */
  power: Node<'float'>;
  /** Fire 0..1 (orange glow), and burnt 0..1 (charred). */
  fire: Node<'float'>;
  burnt: Node<'float'>;
}

/**
 * Interior mapping (DESIGN.md §7.5): a fake 3D room behind a window, found by casting the view
 * ray into a box (wall, floor, ceiling, back wall) behind the glass. Returns the room's radiance
 * (to be added as emissive behind the glass: interiors aren't sunlit).
 */
export function roomRadiance(r: RoomInputs) {
  const W = typeof r.width === 'number' ? float(r.width) : r.width;
  const H = typeof r.height === 'number' ? float(r.height) : r.height;
  const D = uRoomDepth;
  const view = normalize(positionWorld.sub(cameraPosition));
  const dx = view.dot(r.tangent);
  const dy = view.y;
  const dz = view.dot(r.outward).negate(); // into the room
  const px = r.u.mul(W);
  const py = r.v.mul(H);
  const sx = select(dx.greaterThan(0), W.sub(px), px.negate()).div(
    select(abs(dx).lessThan(1e-4), float(1e-4), dx),
  );
  const sy = select(dy.greaterThan(0), H.sub(py), py.negate()).div(
    select(abs(dy).lessThan(1e-4), float(1e-4), dy),
  );
  const sz = D.div(max(dz, 1e-4));
  const t = min(min(sx, sy), sz);
  const hx = px.add(dx.mul(t));
  const hy = py.add(dy.mul(t));
  const hz = dz.mul(t);
  const back = step(sz, min(sx, sy));
  const onFloorOrCeil = float(1).sub(back).mul(step(sy, sx));
  const ceiling = onFloorOrCeil.mul(step(0, dy));
  const floorHit = onFloorOrCeil.mul(float(1).sub(step(0, dy)));
  const side = float(1).sub(back).sub(onFloorOrCeil);

  // Decor from the seed: wall tone, floor tone.
  const s1 = hash(r.seed, float(1.7));
  const s2 = hash(r.seed, float(5.3));
  const wall = mix(color(0xd9d4c8), color(0xbfcad3), s1).mul(mix(0.8, 1.05, s2));
  const floorCol = mix(color(0x5a4a3c), color(0x6d6f73), s2);
  const ceil = color(0xe8e8e6);
  // Furniture silhouettes along the back and side walls: desks, cabinets, sofas.
  const along = select(back.greaterThan(0.5), hx, hz);
  const furn = step(hy, mix(0.75, 1.1, s1)).mul(
    step(fract(along.div(mix(1.4, 2.4, s2)).add(s1)), 0.62),
  );
  let col = wall.mul(back.add(side)).add(floorCol.mul(floorHit)).add(ceil.mul(ceiling));
  col = mix(col, col.mul(0.35), furn.mul(float(1).sub(ceiling)).mul(float(1).sub(floorHit)));
  // Ceiling light panels.
  const panel = ceiling
    .mul(step(abs(fract(hx.div(3)).sub(0.5)), 0.2))
    .mul(step(abs(fract(hz.div(3)).sub(0.5)), 0.12));

  // Is this room's light on? More rooms are lit at night; power cuts and flickers override.
  const litFrac = mix(uLitDay, uLitNight, nightFactor);
  const switchedOn = step(hash(r.seed, float(9.1)), litFrac);
  const flick = step(0.5, fract(sin(time.mul(23).add(r.seed.mul(91))).mul(437.5)));
  const powered = select(
    r.power.greaterThan(0.75),
    float(1),
    select(r.power.greaterThan(0.25), flick, float(0)),
  );
  const lit = switchedOn.mul(powered);
  const glow = mix(uWindowGlowDay, uWindowGlowNight, nightFactor);
  // Light falls off toward the back of the room.
  const falloff = mix(1, 0.55, hz.div(D));
  const daylight = mix(float(0.18), float(0.012), nightFactor); // unlit rooms: what spills in from outside
  const lightCol = vec3(1.0, 0.94, 0.82);
  let rad = col.mul(lightCol).mul(lit.mul(glow).mul(falloff).add(daylight));
  rad = rad.add(lightCol.mul(panel).mul(lit).mul(glow).mul(1.5));
  // Fire: flickering orange light, and soot on everything once it has burned.
  const fireFlick = sin(time.mul(17).add(r.seed.mul(40)))
    .mul(0.25)
    .add(0.75);
  rad = rad.add(
    vec3(2.4, 0.9, 0.25)
      .mul(r.fire)
      .mul(fireFlick)
      .mul(smoothstep(0, 1, float(1).sub(hy.div(H)).add(0.3))),
  );
  rad = mix(rad, rad.mul(0.12), r.burnt);
  return { radiance: rad, roomFloor: floor(hy) };
}
