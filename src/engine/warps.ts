/**
 * Teleporters (Radiant Emerald). The race line P0 jumps across them in one segment — p99→p100,
 * p149→p150 and p179→p0, 2–5k units against a median of ~400 — so they are taken from the line:
 * reaching the start of such a segment moves the racer to its end, keeping its speed and turning
 * it down the line. [P] The original's portal objects/trigger volumes are not located yet.
 */
import type { Runner, OriginalRunner } from './runner';

type V3 = readonly [number, number, number] | readonly number[];

export interface Warp { from: V3; to: V3; yaw: number }

/** Entry trigger: horizontal radius and vertical reach around the segment's first point. */
const RADIUS = 260, REACH = 350;

const CACHE = new WeakMap<readonly V3[], Warp[]>();

/** Segments of the closed loop longer than 4× the median. */
export function warpsOf(loop: readonly V3[]): Warp[] {
  let w = CACHE.get(loop);
  if (w) return w;
  const N = loop.length;
  const len = (i: number) => {
    const p = loop[i], q = loop[(i + 1) % N];
    return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  };
  const lens = Array.from({ length: N }, (_, i) => len(i));
  const median = [...lens].sort((a, b) => a - b)[N >> 1] ?? 0;
  w = [];
  for (let i = 0; i < N; i++) {
    if (N < 8 || lens[i] <= median * 4) continue;
    const to = loop[(i + 1) % N], next = loop[(i + 2) % N];
    const yaw = ((Math.atan2(next[0] - to[0], next[2] - to[2]) * 2048) / Math.PI + 4096) % 4096;
    w.push({ from: loop[i], to, yaw });
  }
  CACHE.set(loop, w);
  return w;
}

/** Teleports `r` if it is at a warp's entry. Returns whether it did. */
export function applyWarp(r: Runner | OriginalRunner, loop: readonly V3[]): boolean {
  for (const w of warpsOf(loop)) {
    if (Math.hypot(r.x - w.from[0], r.z - w.from[2]) > RADIUS || Math.abs(r.y - w.from[1]) > REACH) continue;
    const speed = Math.hypot(r.vx, r.vz), a = (w.yaw * Math.PI) / 2048;
    r.x = w.to[0]; r.y = w.to[1]; r.z = w.to[2]; r.yaw = w.yaw;
    r.vx = Math.sin(a) * speed; r.vz = Math.cos(a) * speed;
    r.prev = { x: r.x, y: r.y, z: r.z, yaw: r.yaw };
    if ('orig' in r && (r as any).orig) {
      const orig = (r as any).orig;
      orig.px = orig.x; orig.py = orig.y; orig.pz = orig.z;
    }
    return true;
  }
  return false;
}
