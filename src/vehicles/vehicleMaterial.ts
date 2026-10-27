import * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  Fn,
  max,
  mix,
  normalLocal,
  normalize,
  positionGeometry,
  select,
  uniform,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Vehicle material (DESIGN.md §7.10): every vehicle type, every wreck and the traffic lights draw
 * with it, from per-instance attributes on an InstancedBufferGeometry:
 * - vPos   (vec4): world position, wheel spin angle (rad)
 * - vRot   (vec4): world rotation quaternion
 * - vPaint (vec4): body colour rgb, glass broken (0/1)
 * - vState (vec4): charred 0..1, frosted 0..1, lamp (traffic light: 0 red 1 amber 2 green;
 *                  vehicles: beacons on 0/1), headlights 0/1
 * Per-vertex: _role (scripts/build-assets.mjs ROLE) and _wheel (axle centre, is-wheel).
 */
export const VEHICLE_ATTRS = ['vPos', 'vRot', 'vPaint', 'vState'] as const;
export const VEHICLE_FLOATS = VEHICLE_ATTRS.length * 4;

/** Seconds, for flashing beacons (set each frame). */
export const vehicleTime = uniform(0);

const a4 = (n: string) => attribute<'vec4'>(n, 'vec4');

function qrot(q: Node<'vec4'>, v: Node<'vec3'>) {
  const t = q.xyz.cross(v).mul(2);
  return v.add(t.mul(q.w)).add(q.xyz.cross(t));
}

/** Rotation about the x axis (wheel spin). */
function rotX(v: Node<'vec3'>, a: Node<'float'>) {
  const c = a.cos();
  const s = a.sin();
  return vec3(v.x, v.y.mul(c).sub(v.z.mul(s)), v.y.mul(s).add(v.z.mul(c)));
}

export function createVehicleMaterial(roles: Record<string, number>) {
  const R = (n: string) => float(roles[n] ?? -1);
  const role = attribute<'float'>('_role', 'float');
  const is = (n: string) => role.sub(R(n)).abs().lessThan(0.5);

  const position = Fn(() => {
    const pos = a4('vPos');
    const rot = a4('vRot');
    const wheel = a4('_wheel');
    const spin = wheel.w.greaterThan(0.5);
    const local = positionGeometry.sub(wheel.xyz);
    const p = select(spin, rotX(local, pos.w).add(wheel.xyz), positionGeometry);
    const n = select(spin, rotX(normalLocal, pos.w), normalLocal);
    normalLocal.assign(normalize(qrot(rot, n)));
    return qrot(rot, p).add(pos.xyz);
  })();

  const paint = a4('vPaint');
  const st = a4('vState');
  const vcol = attribute<'vec3'>('color', 'vec3');
  const isPaint = is('paint');
  const isDark = is('paintDark');
  const isGlass = is('glass');
  let col: Node<'vec3'> = select(isPaint, paint.rgb, select(isDark, paint.rgb.mul(0.45), vcol));
  // Broken glass: the dark cabin shows through.
  col = select(isGlass.and(paint.w.greaterThan(0.5)), vec3(0.01, 0.01, 0.01), col);
  // Lights.
  const flash = vehicleTime.mul(9).sin().greaterThan(0);
  const beaconOn = st.z.greaterThan(0.5);
  const lampRed = is('lampRed').and(st.z.lessThan(0.5));
  const lampAmber = is('lampYellow').and(st.z.greaterThan(0.5)).and(st.z.lessThan(1.5));
  const lampGreen = is('lampGreen').and(st.z.greaterThan(1.5));
  const lampLit = lampRed.or(lampAmber).or(lampGreen);
  const blue = is('beaconBlue').and(beaconOn).and(flash);
  const white = is('beaconWhite').and(beaconOn).and(flash.not());
  const head = is('headlight');
  const tail = is('taillight');
  const lit = st.w;
  const charred = st.x;
  const frost = st.y;
  let emissive: Node<'vec3'> = vec3(0, 0, 0);
  emissive = select(head, vcol.mul(lit.mul(6).add(0.15)), emissive);
  emissive = select(tail, vcol.mul(lit.mul(3).add(0.3)), emissive);
  emissive = select(blue.or(white), vcol.mul(8), emissive);
  emissive = select(lampLit, vcol.mul(7), emissive);
  // Dim unlit traffic-light lamps.
  const lamp = is('lampRed').or(is('lampYellow')).or(is('lampGreen'));
  col = select(lamp.and(lampLit.not()), vcol.mul(0.12), col);
  // Fire damage: soot black; frost: icy white-blue.
  col = mix(col, vec3(0.018, 0.016, 0.015), charred);
  col = mix(col, vec3(0.7, 0.84, 0.95), frost.mul(0.8));
  emissive = emissive.mul(float(1).sub(charred));

  const rough = select(
    isPaint.or(isDark),
    float(0.32),
    select(
      isGlass,
      select(paint.w.greaterThan(0.5), float(1), float(0.06)),
      select(is('trim'), float(0.45), float(0.75)),
    ),
  );
  const metal = select(isPaint.or(isDark), float(0.35), select(is('trim'), float(0.7), float(0)));

  const m = new THREE.MeshStandardNodeMaterial();
  m.positionNode = position;
  m.colorNode = col;
  m.emissiveNode = emissive;
  m.roughnessNode = mix(mix(rough, float(0.95), charred), float(0.15), frost);
  m.metalnessNode = mix(metal, float(0), max(charred, frost));
  return m;
}
