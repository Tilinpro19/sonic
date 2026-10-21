/**
 * Queries against the `.ter` collision mesh, in its own space (raw file units, Y down).
 * Approximation of 0x4d6c1c (height + normal per triangle) and the wall handling; not yet traced
 * against the original, so step heights and wall radius are tuned by eye.
 */
import { GRID, type Terrain } from '../formats/terrain';
import type { Loop } from './loops';
import { OrigTerrain } from './original';

/** Quads steeper than this (|ny| below it) are walls, the rest floors. */
const FLOOR_NY = 0.2;

/** `attr`: the sector's zone id; `trigger`: its launcher value (see formats/terrain.ts), 0 = none. */
export interface Ground { y: number; nx: number; ny: number; nz: number; attr: number; trigger: number }

export class Collision {
  /** `baseY`: the flat playfield (grass/sand plane at y = 0) under tracks that have one. */
  /** The track's vertical loops (engine/loops.ts), set once the race line is known. */
  loops: readonly Loop[] = [];
  readonly origTerrain?: OrigTerrain;

  constructor(readonly t: Terrain, readonly baseY: number | null = null) {
    if (t.raw) this.origTerrain = new OrigTerrain(t.raw);
  }

  /** Sector indices of the broadphase cell containing (x, z), or none outside the grid. */
  cell(x: number, z: number): Int32Array {
    const cx = Math.floor((x - this.t.x0) / this.t.cellX), cz = Math.floor((z - this.t.z0) / this.t.cellZ);
    if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) return EMPTY;
    return this.t.cells[cz * GRID + cx];
  }

  private v(i: number, k: number) { return this.t.verts[i * 3 + k]; }

  /**
   * Highest floor under (x, z) that is not more than `stepUp` above `feetY` (Y down: "above" is
   * smaller y). Null when there is no floor below (off the mesh / over a hole).
   */
  ground(x: number, z: number, feetY: number, stepUp: number): Ground | null {
    const { quads, normals, sectors } = this.t;
    let best: Ground | null = this.baseY !== null && this.baseY >= feetY - stepUp
      ? { y: this.baseY, nx: 0, ny: -1, nz: 0, attr: 0, trigger: 0 } : null;
    for (const s of this.cell(x, z)) {
      const sec = sectors[s];
      for (let q = sec.first; q < sec.first + sec.count; q++) {
        const ny = normals[q * 3 + 1];
        if (ny > -FLOOR_NY) continue;
        const a = quads[q * 4], b = quads[q * 4 + 1], c = quads[q * 4 + 2], d = quads[q * 4 + 3];
        if (!this.inTri(x, z, a, b, c) && !this.inTri(x, z, a, c, d)) continue;
        const nx = normals[q * 3], nz = normals[q * 3 + 2];
        const y = this.v(a, 1) - (nx * (x - this.v(a, 0)) + nz * (z - this.v(a, 2))) / ny;
        if (y < feetY - stepUp) continue;
        if (!best || y < best.y) best = { y, nx, ny, nz, attr: sec.attr, trigger: sec.trigger };
      }
    }
    return best;
  }

  private inTri(x: number, z: number, a: number, b: number, c: number) {
    const ax = this.v(a, 0), az = this.v(a, 2), bx = this.v(b, 0), bz = this.v(b, 2), cx = this.v(c, 0), cz = this.v(c, 2);
    const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
    const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
    const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }

  /**
   * Nearest quad hit by the ray o + d·t (t in 0..len, d unit) whose normal is within ~60° of
   * `n` (a surface the racer can stay on: steep banks and quarter-pipes, any ny). For riding
   * steep surfaces, where the vertical `ground` query can't see them.
   */
  surface(o: V3, d: V3, len: number, n: V3): (Ground & { x: number; z: number }) | null {
    const { quads, normals, sectors, verts } = this.t;
    const b: V3 = [d[0] * len, d[1] * len, d[2] * len];
    const ids = new Set<number>();
    for (const f of [0, 0.5, 1]) for (const id of this.cell(o[0] + b[0] * f, o[2] + b[2] * f)) ids.add(id);
    const P = (i: number): V3 => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
    let best = 1, hit: (Ground & { x: number; z: number }) | null = null;
    for (const id of ids) {
      const sec = sectors[id];
      for (let q = sec.first; q < sec.first + sec.count; q++) {
        const nx = normals[q * 3], ny = normals[q * 3 + 1], nz = normals[q * 3 + 2];
        if (nx * n[0] + ny * n[1] + nz * n[2] < 0.5) continue;
        const v0 = P(quads[q * 4]), v1 = P(quads[q * 4 + 1]), v2 = P(quads[q * 4 + 2]), v3 = P(quads[q * 4 + 3]);
        const t = Math.min(rayTri(o, b, v0, v1, v2), rayTri(o, b, v0, v2, v3));
        if (t >= best) continue;
        best = t;
        hit = { x: o[0] + b[0] * t, y: o[1] + b[1] * t, z: o[2] + b[2] * t, nx, ny, nz, attr: sec.attr, trigger: sec.trigger };
      }
    }
    return hit;
  }

  /**
   * Pushes a vertical cylinder (feet at feetY, height h, radius r) out of wall quads. Returns the
   * horizontal push (dx, dz) and the wall normal of the deepest hit, or null.
   */
  walls(x: number, z: number, feetY: number, h: number, r: number, ignore?: V3) {
    const { quads, normals, sectors } = this.t;
    let px = 0, pz = 0, hit: { nx: number; nz: number } | null = null;
    for (const s of this.cell(x, z)) {
      const sec = sectors[s];
      for (let q = sec.first; q < sec.first + sec.count; q++) {
        if (normals[q * 3 + 1] <= -FLOOR_NY) continue;
        // The bank being ridden (walls() would push the racer off its own steep floor).
        if (ignore && normals[q * 3] * ignore[0] + normals[q * 3 + 1] * ignore[1] + normals[q * 3 + 2] * ignore[2] > 0.3) continue;
        let nx = normals[q * 3], nz = normals[q * 3 + 2];
        const l = Math.hypot(nx, nz);
        if (l < 1e-3) continue;
        nx /= l; nz /= l;
        // Quad extents: along the wall (tangent) and vertically.
        const tx = -nz, tz = nx;
        let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        const a = quads[q * 4];
        for (let k = 0; k < 4; k++) {
          const i = quads[q * 4 + k];
          const t = (this.v(i, 0) - this.v(a, 0)) * tx + (this.v(i, 2) - this.v(a, 2)) * tz;
          tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
          yMin = Math.min(yMin, this.v(i, 1)); yMax = Math.max(yMax, this.v(i, 1));
        }
        // Y down: body spans [feetY − h, feetY]; ignore walls entirely below the step height.
        if (yMin > feetY - STEP || yMax < feetY - h) continue;
        const rx = x + px - this.v(a, 0), rz = z + pz - this.v(a, 2);
        const t = rx * tx + rz * tz;
        if (t < tMin - r || t > tMax + r) continue;
        const d = rx * nx + rz * nz;
        if (Math.abs(d) >= r) continue;
        const push = (d >= 0 ? r : -r) - d;
        px += nx * push; pz += nz * push;
        hit = { nx: d >= 0 ? nx : -nx, nz: d >= 0 ? nz : -nz };
      }
    }
    return hit ? { dx: px, dz: pz, ...hit } : null;
  }
}

/**
 * First hit of segment a→b against any quad (floor or wall), as a fraction 0..1 of the way, or 1
 * if clear. For the chase camera: keeps it from ending up inside cliffs.
 */
export function segmentHit(c: Collision, a: V3, b: V3): number {
  const { quads, sectors, verts } = c.t;
  const seen = new Set<number>();
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / (Math.min(c.t.cellX, c.t.cellZ) / 2)));
  for (let s = 0; s <= steps; s++) for (const id of c.cell(a[0] + ((b[0] - a[0]) * s) / steps, a[2] + ((b[2] - a[2]) * s) / steps)) seen.add(id);
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  let best = 1;
  const P = (i: number): V3 => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  for (const id of seen) {
    const sec = sectors[id];
    for (let q = sec.first; q < sec.first + sec.count; q++) {
      const v0 = P(quads[q * 4]), v1 = P(quads[q * 4 + 1]), v2 = P(quads[q * 4 + 2]), v3 = P(quads[q * 4 + 3]);
      best = Math.min(best, rayTri(a, d, v0, v1, v2), rayTri(a, d, v0, v2, v3));
    }
  }
  return best;
}

type V3 = [number, number, number];
/** Möller–Trumbore; returns t in [0, 1] or 1 on a miss. */
function rayTri(o: V3, d: V3, a: V3, b: V3, c: V3) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-9) return 1;
  const inv = 1 / det, s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return 1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return 1;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t >= 0 && t <= 1 ? t : 1;
}

/**
 * Max climbable ledge (units), shared by floor snapping and wall filtering. 0x4d7853 counts a floor
 * up to 0x40000 (64 units) from the feet as under the racer; Regal Ruin's stairs are 41 high.
 */
export const STEP = 64;
const EMPTY = new Int32Array(0);
