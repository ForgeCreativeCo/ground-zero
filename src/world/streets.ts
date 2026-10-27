import type { CityLayout } from './cityLayout';

/**
 * Street network derived from the block grid (DESIGN.md §2, §7.10): street centrelines,
 * intersections, road edges with lanes, sidewalk rings around blocks, and traffic-light phases.
 * Pure data and math (no three.js), unit-tested.
 *
 * Lines: N-S streets run along z at x = xs[i]; E-W streets run along x at z = zs[j]. The outermost
 * lines are the half-width perimeter streets at the city edge (one lane each way).
 */
export interface StreetParams {
  blocksX: number;
  blocksZ: number;
  blockSize: number;
  streetWidth: number;
  laneOffsets: [number, number];
}

export interface RoadEdge {
  id: number;
  /** Intersection node ids at the start (a) and end (b) in the +axis direction. */
  a: number;
  b: number;
  /** 0 = along x (E-W street), 1 = along z (N-S street). */
  axis: 0 | 1;
  /** Fixed coordinate of the centreline (z for axis 0, x for axis 1). */
  line: number;
  /** Start and end coordinates along the axis (intersection centres). */
  from: number;
  to: number;
  /** Lanes each way (1 on perimeter streets, 2 inside). */
  lanes: number;
  /** Half width of the street (m). */
  half: number;
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  i: number;
  j: number;
  /** Edge ids touching this node: [-x, +x, -z, +z] (-1 if none). */
  edges: [number, number, number, number];
  /** Has a traffic light (three or more approaches). */
  signal: boolean;
  /** Light phase offset (s). */
  offset: number;
  /** Half widths of the crossing streets: along x (E-W street) and along z (N-S street). */
  halfX: number;
  halfZ: number;
}

export interface Streets {
  xs: number[];
  zs: number[];
  nodes: RoadNode[];
  edges: RoadEdge[];
  laneOffsets: [number, number];
  blockSize: number;
  pitch: number;
}

export function buildStreets(layout: CityLayout, p: StreetParams, seed: number): Streets {
  const pitch = layout.pitch;
  const lineCoords = (n: number, half: number) => {
    const out: number[] = [];
    for (let i = 0; i <= n; i++) {
      if (i === 0) out.push(-half + p.streetWidth / 4);
      else if (i === n) out.push(half - p.streetWidth / 4);
      else out.push((i - n / 2) * pitch);
    }
    return out;
  };
  const xs = lineCoords(p.blocksX, layout.halfExtentX);
  const zs = lineCoords(p.blocksZ, layout.halfExtentZ);
  const halfOf = (k: number, n: number) =>
    k === 0 || k === n ? p.streetWidth / 4 : p.streetWidth / 2;
  const nodes: RoadNode[] = [];
  const nodeId = (i: number, j: number) => j * xs.length + i;
  for (let j = 0; j < zs.length; j++)
    for (let i = 0; i < xs.length; i++) {
      nodes.push({
        id: nodeId(i, j),
        x: xs[i]!,
        z: zs[j]!,
        i,
        j,
        edges: [-1, -1, -1, -1],
        signal: false,
        offset: (((seed >>> 0) * 0.37 + i * 7.3 + j * 3.1) % 1) * 30,
        halfX: halfOf(j, p.blocksZ),
        halfZ: halfOf(i, p.blocksX),
      });
    }
  const edges: RoadEdge[] = [];
  // E-W edges (axis 0) along each z line.
  for (let j = 0; j < zs.length; j++)
    for (let i = 0; i + 1 < xs.length; i++) {
      const perim = j === 0 || j === p.blocksZ;
      const e: RoadEdge = {
        id: edges.length,
        a: nodeId(i, j),
        b: nodeId(i + 1, j),
        axis: 0,
        line: zs[j]!,
        from: xs[i]!,
        to: xs[i + 1]!,
        lanes: perim ? 1 : 2,
        half: halfOf(j, p.blocksZ),
      };
      edges.push(e);
      nodes[e.a]!.edges[1] = e.id;
      nodes[e.b]!.edges[0] = e.id;
    }
  for (let i = 0; i < xs.length; i++)
    for (let j = 0; j + 1 < zs.length; j++) {
      const perim = i === 0 || i === p.blocksX;
      const e: RoadEdge = {
        id: edges.length,
        a: nodeId(i, j),
        b: nodeId(i, j + 1),
        axis: 1,
        line: xs[i]!,
        from: zs[j]!,
        to: zs[j + 1]!,
        lanes: perim ? 1 : 2,
        half: halfOf(i, p.blocksX),
      };
      edges.push(e);
      nodes[e.a]!.edges[3] = e.id;
      nodes[e.b]!.edges[2] = e.id;
    }
  for (const n of nodes) n.signal = n.edges.filter((e) => e >= 0).length >= 3;
  return { xs, zs, nodes, edges, laneOffsets: p.laneOffsets, blockSize: p.blockSize, pitch };
}

/**
 * Light state for traffic moving along `axis` at a node at time t: 0 green, 1 amber, 2 red.
 * Phases: axis 0 green, amber, then axis 1 green, amber (plus 1 s all-red each change).
 */
export function lightState(node: RoadNode, axis: 0 | 1, t: number, green: number, amber: number) {
  if (!node.signal) return 0;
  const half = green + amber + 1;
  const cyc = (((t + node.offset) % (half * 2)) + half * 2) % (half * 2);
  const mine = axis === 0 ? cyc < half : cyc >= half;
  if (!mine) return 2;
  const k = axis === 0 ? cyc : cyc - half;
  return k < green ? 0 : k < green + amber ? 1 : 2;
}

/**
 * World position on an edge lane: `dir` +1 travels from a to b (+axis), -1 back. Right-hand
 * traffic: lanes sit to the right of the direction of travel. `s` is distance from the start
 * node of travel. Writes [x, z, heading yaw] (yaw: rotation about +y, 0 = facing +z).
 */
export function lanePoint(
  st: Streets,
  e: RoadEdge,
  dir: 1 | -1,
  lane: number,
  s: number,
  out: number[],
) {
  const off = st.laneOffsets[Math.min(lane, e.lanes - 1)]!;
  const start = dir === 1 ? e.from : e.to;
  const along = start + dir * s;
  if (e.axis === 0) {
    // Travelling +x: right side is -z... facing +x, right hand points to +z? Heading +x, up +y:
    // right = forward x up = (1,0,0) x (0,1,0) = (0,0,1). So right of +x travel is +z.
    out[0] = along;
    out[1] = e.line + dir * off;
    out[2] = dir === 1 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    // Heading +z: right = (0,0,1) x (0,1,0) = (-1,0,0).
    out[0] = e.line - dir * off;
    out[1] = along;
    out[2] = dir === 1 ? 0 : Math.PI;
  }
  return out;
}

export function edgeLength(e: RoadEdge) {
  return e.to - e.from;
}

/** Edge in travel direction leaving node n towards side k (0 -x, 1 +x, 2 -z, 3 +z). */
export function exitDir(k: number): { axis: 0 | 1; dir: 1 | -1 } {
  return { axis: k < 2 ? 0 : 1, dir: k % 2 === 0 ? -1 : 1 };
}

/**
 * Sidewalk ring around a block: a rectangle `inset` metres inside the block edge. Parameter
 * s runs counter-clockwise from the block's (-x, -z) corner; returns [x, z, dirX, dirZ].
 */
export function ringPoint(cx: number, cz: number, half: number, s: number, out: number[]) {
  const side = half * 2;
  const per = side * 4;
  let u = ((s % per) + per) % per;
  if (u < side) {
    out[0] = cx - half + u;
    out[1] = cz - half;
    out[2] = 1;
    out[3] = 0;
    return out;
  }
  u -= side;
  if (u < side) {
    out[0] = cx + half;
    out[1] = cz - half + u;
    out[2] = 0;
    out[3] = 1;
    return out;
  }
  u -= side;
  if (u < side) {
    out[0] = cx + half - u;
    out[1] = cz + half;
    out[2] = -1;
    out[3] = 0;
    return out;
  }
  u -= side;
  out[0] = cx - half;
  out[1] = cz + half - u;
  out[2] = 0;
  out[3] = -1;
  return out;
}

/** Ring parameter of the point on the ring nearest (x, z). */
export function ringParam(cx: number, cz: number, half: number, x: number, z: number) {
  const side = half * 2;
  const lx = Math.min(half, Math.max(-half, x - cx));
  const lz = Math.min(half, Math.max(-half, z - cz));
  // Distance to each side; pick the nearest.
  const d = [
    Math.abs(z - cz + half),
    Math.abs(x - cx - half),
    Math.abs(z - cz - half),
    Math.abs(x - cx + half),
  ];
  let k = 0;
  for (let i = 1; i < 4; i++) if (d[i]! < d[k]!) k = i;
  if (k === 0) return lx + half;
  if (k === 1) return side + lz + half;
  if (k === 2) return side * 2 + (half - lx);
  return side * 3 + (half - lz);
}
