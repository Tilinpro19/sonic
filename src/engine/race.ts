/**
 * Race rules for one player (M6 prototype): ring pickup, lap counting along P0, race clock.
 * Everything runs in `.ter` space on the 30 Hz tick, so it stays in step with the runner.
 *
 * - P0 (raw file coords → `.ter` (x, −y, −z)) starts with the main loop: P0[0..k] where P0[k] is
 *   the first return to P0[0] (Island 315, City 274, Ruin 363, Factory 303, Emerald 180); the
 *   rest are loose pieces. Some loops have out-of-order points (City, Emerald), so progress is the
 *   nearest loop point in 3D and a lap needs the 25/50/75 % checkpoints in order.
 * - Rings sit 50–75 units above the floor: picked up inside a sphere around the body centre.
 */
import type { OriginalRunner } from './runner';

type V3 = [number, number, number];

export const LAPS = 3;
export const PICKUP = 95, BODY = 60;

/**
 * Main loop of the race line, in `.ter` space: P0[0..k], or the track's `route` (TrackInfo).
 *
 * Radical Emerald's P0[0..180) hops between branches (p99→p100, p149→p150, p179→p0: 2–5k
 * against ~400). They are not teleporters: the original has no trigger object there (its 0x47f13c
 * table only holds the ring dash pad and balloons) nor `.ter` trigger sector, and the floor at p99
 * runs on into p265. Its loop is the `route` through the branches instead.
 */
export function mainLoop(p0: readonly V3[], route?: readonly (readonly [number, number])[]): V3[] {
  const L = p0.map(([x, y, z]) => [x, -y, -z] as V3);
  if (route) return route.flatMap(([a, b]) => Array.from({ length: Math.abs(b - a) + 1 }, (_, k) => L[a + Math.sign(b - a) * k]));
  let end = L.length, best = Infinity;
  for (let i = 50; i < L.length; i++) {
    const d = Math.hypot(L[i][0] - L[0][0], L[i][2] - L[0][2]);
    if (d < best) { best = d; end = i; }
    if (d < 1) break;
  }
  return best < 400 ? L.slice(0, end) : L;
}

export interface RaceEvents { rings: number; lap: boolean; finished: boolean }

export class Race {
  readonly loop: V3[];
  /** Ring positions in `.ter` space; `taken[i]` once collected. */
  readonly rings: V3[];
  readonly taken: Uint8Array;
  /** Clock tick at which each ring was collected. */
  readonly takenAt: Int32Array;
  ringCount = 0;
  lap = 1;
  ticks = 0;
  lapStart = 0;
  lapTimes: number[] = [];
  finished = false;
  /** Index of the nearest main-loop point. */
  progress = 0;
  private checkpoint = 0;
  private quarter = 0;
  /** Ticks since creation; keeps running after the finish (ring pop timing). */
  private clock = 0;

  /**
   * `start` (`.ter`): P1's grid slot. The grid (P4) is not at P0[0] on Island, City, Ruin and
   * Factory, so the loop is rotated to begin at the line point nearest to it: laps count from there.
   * `route`: the track's (TrackInfo.route), see mainLoop.
   */
  constructor(p0: readonly V3[], ringsLoader: readonly V3[], start?: { x: number; y: number; z: number }, route?: readonly (readonly [number, number])[]) {
    const L = mainLoop(p0, route);
    let s = 0;
    if (start) {
      let best = Infinity;
      L.forEach(([x, y, z], i) => {
        const d = (x - start.x) ** 2 + ((y - start.y) * 2) ** 2 + (z - start.z) ** 2;
        if (d < best) { best = d; s = i; }
      });
    }
    this.loop = [...L.slice(s), ...L.slice(0, s)];
    this.rings = ringsLoader.map(([x, y, z]) => [x, -y, z] as V3); // loader space → .ter
    this.taken = new Uint8Array(this.rings.length);
    this.takenAt = new Int32Array(this.rings.length);
  }

  /** Seconds since ring i was collected, or −1 if it is still there (for the pickup pop). */
  ringAge(i: number) { return this.taken[i] ? (this.clock - this.takenAt[i]) / 30 : -1; }

  reset() {
    this.taken.fill(0);
    this.ringCount = 0;
    this.lap = 1;
    this.ticks = this.lapStart = 0;
    this.lapTimes = [];
    this.finished = false;
    this.progress = this.checkpoint = this.quarter = 0;
  }

  /** Seconds on the race clock (30 Hz ticks). */
  get time() { return this.ticks / 30; }
  get lapTime() { return (this.ticks - this.lapStart) / 30; }

  /** Call once per runner tick. */
  tick(r: OriginalRunner | { x: number; y: number; z: number }): RaceEvents {
    const ev: RaceEvents = { rings: 0, lap: false, finished: false };
    this.clock++;
    if (!this.finished) this.ticks++;

    const cy = r.y - BODY;
    for (let i = 0; i < this.rings.length; i++) {
      if (this.taken[i]) continue;
      const p = this.rings[i];
      const dx = p[0] - r.x, dy = p[1] - cy, dz = p[2] - r.z;
      if (dx * dx + dy * dy + dz * dz < PICKUP * PICKUP) { this.taken[i] = 1; this.takenAt[i] = this.clock; this.ringCount++; ev.rings++; }
    }

    const L = this.loop, N = L.length;
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      const p = L[i], dx = p[0] - r.x, dy = (p[1] - r.y) * 2, dz = p[2] - r.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; this.progress = i; }
    }
    // Checkpoints only count when crossed forwards (from the previous quarter), so driving
    // backwards over the line, even for several laps, never adds one.
    const q = Math.floor((this.progress / N) * 4), from = this.quarter;
    this.quarter = q;
    if (q === this.checkpoint + 1 && from === this.checkpoint) this.checkpoint = q;
    else if (q === 0 && from === 3 && this.checkpoint === 3) {
      this.checkpoint = 0;
      if (!this.finished) {
        this.lapTimes.push(this.lapTime);
        this.lapStart = this.ticks;
        ev.lap = true;
        if (this.lap === LAPS) { this.finished = ev.finished = true; } else this.lap++;
      }
    }
    return ev;
  }
}
