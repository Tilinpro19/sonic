/**
 * Loops and tubes: Resort Island's loop (p219–233), Reactive Factory's (p70–83) and Regal Ruin's
 * corkscrew tube (p243–308). The `.ter` only holds their lower ramps/banks, so the rest can't be
 * run on. The golden recording of the original (work/tools/golden, Island, two passes) shows the
 * loop is a scripted ride: the world velocity (+2c…+34) and heading (+10) stay frozen at their
 * entry values, gravity is off, pitch (+0c) turns a full 4096 and the racer leaves heading the
 * way it came in, shifted sideways (a corkscrew).
 * [P] The trigger isn't located in the exe; the rides are taken from the race line instead: a
 * stretch of P0 with no collision floor under it that no jump could follow — its horizontal
 * direction reverses, or it climbs again after dropping.
 */
import * as THREE from 'three';
import type { Collision } from './collision';

type V3 = readonly [number, number, number] | readonly number[];

export interface Loop {
  /** Line points from the entry (bottom of the first ramp) to the exit (back on the floor). */
  pts: readonly V3[];
  /** Entry direction (unit, ter XZ). */
  dx: number; dz: number;
  /** Centre of the loop (mean of its reversed stretch). */
  cx: number; cy: number; cz: number;
}

/** Recorded: the feet run 30–70 units outside P0 around the loop. */
const OUTSIDE = 50;
/** Entry trigger: within this of the entry point (horizontally), heading along the line. */
export const ENTRY_RADIUS = 220;

const CACHE = new WeakMap<readonly V3[], Loop[]>();
const SUPPORTED = new WeakMap<readonly V3[], boolean[]>();

/** Per line point: is there collision floor at most SUPPORT under it (Y down)? Cached per line. */
export function supportOf(line: readonly V3[], col: Collision): boolean[] {
  let s = SUPPORTED.get(line);
  if (!s) {
    s = line.map((p) => {
      const g = col.ground(p[0], p[2], p[1] + SUPPORT, SUPPORT);
      return !!g && g.y >= p[1] - 1 && g.y <= p[1] + SUPPORT;
    });
    SUPPORTED.set(line, s);
  }
  return s;
}

/** The line runs 80–190 above the floor: further than this above any floor, it is unsupported. */
const SUPPORT = 250;
/** Line points ridden before and after the unsupported stretch (up the ramp, down to the floor). */
const LEAD = 3;
/** Line points (from the ride's start) where a racer can join it. */
export const LEAD_IN = LEAD + 1;

export function loopsOf(line: readonly V3[], col: Collision): Loop[] {
  let found = CACHE.get(line);
  if (found) return found;
  found = [];
  const N = line.length;
  const at = (i: number) => line[((i % N) + N) % N];
  const supported = supportOf(line, col);
  const dir = (i: number) => {
    const p = at(i), q = at(i + 1), l = Math.hypot(q[0] - p[0], q[2] - p[2]) || 1;
    return [(q[0] - p[0]) / l, (q[2] - p[2]) / l, l];
  };
  const first = supported.indexOf(true);
  if (N < 16 || first < 0) return found;
  for (let k = 0; k < N; k++) {
    const i = (first + k) % N;
    if (supported[i] || !supported[(i - 1 + N) % N]) continue;
    let len = 0;
    while (len < N && !supported[(i + len) % N]) len++;
    const run = Array.from({ length: len }, (_, j) => at(i + j));
    // Something no jump can do: reverse direction, or climb back up after dropping (Y down).
    // Against the heading where the ride starts (a loop's first unsupported step is already
    // turning over); near-vertical steps (a spring's lift) have no heading.
    const d0 = dir(i - LEAD - 1);
    const reverses = run.some((_, j) => { const d = dir(i + j); return d[2] > 40 && d[0] * d0[0] + d[1] * d0[1] < -0.3; });
    // (Springs and ramps only climb: the drop must come first.)
    let low = run[0][1], climbsBack = false;
    for (const p of run) { low = Math.max(low, p[1]); if (low - run[0][1] > 50 && low - p[1] > 150) climbsBack = true; }
    if (!reverses && !climbsBack) continue; // a gap to jump
    const pts = Array.from({ length: len + 2 * LEAD }, (_, j) => at(i - LEAD + j));
    const mean = (a: number) => run.reduce((t, p) => t + p[a], 0) / len;
    found.push({ pts, dx: d0[0], dz: d0[1], cx: mean(0), cy: mean(1), cz: mean(2) });
  }
  CACHE.set(line, found);
  return found;
}

/** A ride's path, sampled densely: xyz per point plus the arc length at each point. */
export interface RidePath {
  xyz: Float64Array; arc: Float64Array; length: number; cx: number; cy: number; cz: number;
  /** Direction of the line where the ride ends (unit, ter XZ): the racer leaves along it. */
  ex: number; ez: number;
}

/**
 * The path a racer at (x, y, z) follows round `loop`: P0 pushed out to the running surface and
 * shifted by the racer's sideways offset from the line, from its own position to the floor past
 * the exit (`exitY`).
 */
export function ridePath(loop: Loop, x: number, y: number, z: number, exitY: number): RidePath {
  const { pts, dx, dz, cx, cy, cz } = loop;
  // Sideways (in the floor plane, across the loop) offset of the racer from the entry point.
  const sx = -dz, sz = dx, lat = (x - pts[0][0]) * sx + (z - pts[0][2]) * sz;
  const ctrl = [new THREE.Vector3(x, y, z)];
  const m = pts.length - 1;
  for (let k = 1; k < m; k++) {
    const p = pts[k];
    // Radial direction in the loop's vertical plane (entry direction × up).
    const along = (p[0] - cx) * dx + (p[2] - cz) * dz, up = p[1] - cy;
    const l = Math.hypot(along, up) || 1;
    // The sideways offset fades out along the ride and the push to the surface over the last
    // points, so it comes out on the line (Ruin's exit road is only ~300 wide).
    const side = lat * (1 - k / m), out = (OUTSIDE * Math.min(1, (m - k) / 3)) / l;
    ctrl.push(new THREE.Vector3(p[0] + sx * side + dx * along * out, p[1] + up * out, p[2] + sz * side + dz * along * out));
  }
  const last = pts[m];
  ctrl.push(new THREE.Vector3(last[0], exitY, last[2]));
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const n = ctrl.length * 12;
  const xyz = new Float64Array((n + 1) * 3), arc = new Float64Array(n + 1);
  const v = new THREE.Vector3();
  for (let k = 0; k <= n; k++) {
    curve.getPoint(k / n, v);
    xyz[k * 3] = v.x; xyz[k * 3 + 1] = v.y; xyz[k * 3 + 2] = v.z;
    if (k) arc[k] = arc[k - 1] + Math.hypot(v.x - xyz[k * 3 - 3], v.y - xyz[k * 3 - 2], v.z - xyz[k * 3 - 1]);
  }
  const prev = pts[pts.length - 2], el = Math.hypot(last[0] - prev[0], last[2] - prev[2]) || 1;
  return { xyz, arc, length: arc[n], cx, cy, cz, ex: (last[0] - prev[0]) / el, ez: (last[2] - prev[2]) / el };
}

/** Point at arc length s along the path (clamped), into out[0..2]. */
export function rideAt(p: RidePath, s: number, out: number[]) {
  const { xyz, arc } = p;
  let lo = 0, hi = arc.length - 1;
  s = Math.max(0, Math.min(p.length, s));
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arc[m] <= s) lo = m; else hi = m; }
  const t = arc[hi] > arc[lo] ? (s - arc[lo]) / (arc[hi] - arc[lo]) : 0;
  for (let a = 0; a < 3; a++) out[a] = xyz[lo * 3 + a] + (xyz[hi * 3 + a] - xyz[lo * 3 + a]) * t;
  return out;
}
