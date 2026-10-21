/**
 * Collision mesh `bin/extras/*.ter` — LoadTerrain @ 0x42a3f8 + 0x4d8904 (plan A.3.2).
 * Its own low-res mesh, separate from the render geometry. Runner units (pos >> 12), **Y down**
 * (floors have ny < 0); X and Z are the same as the track's loader space.
 *
 *   u32 off[10]; i32 p[13]   (p: nVerts, nQuads, nSectors, …, listLen, …, x0, z0, cellX, cellZ)
 *   off[0] vertices  i16 x,y,z                       (6 B; quads address them by byte offset)
 *   off[1] quads     u16 vOff[4]; i16 n[3]           (14 B; n = (v2−v0)×(v1−v0), 4096 = 1.0)
 *   off[2] sectors   i16 firstQuad, nQuads, cx, cz, ?, attr, trigger, ?   (16 B)
 *            attr: small zone id that grows along the course. trigger (+0x0C, read by 0x4855e8 as
 *            `[sec + 0x0A] >> 16`): ≠ 0 launches the racer on contact — vy = −(t & 0xfff)·0xd05;
 *            & 0x8000 also adds floor normal (x, z) · (t & 0xfff), & 0x4000 first stops it dead.
 *   off[7] grid      32×32 i16 → start index into off[8]
 *   off[8] lists     i16 sector | flags (bits 14–15), each run terminated by −1
 *   cell = ((z − z0) / cellZ) · 32 + (x − x0) / cellX
 */
import { Reader } from './reader';

export interface Terrain {
  /** x,y,z per vertex. */
  verts: Int16Array;
  /** 4 vertex indices per quad. */
  quads: Uint16Array;
  /** Unit normal per quad (x,y,z). */
  normals: Float32Array;
  sectors: { first: number; count: number; attr: number; trigger: number }[];
  /** Per grid cell: sector indices (deduplicated). */
  cells: Int32Array[];
  x0: number; z0: number; cellX: number; cellZ: number;
  raw?: Uint8Array;
}

export const GRID = 32;

export function parseTerrain(buf: ArrayBuffer | Uint8Array): Terrain {
  const raw = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(raw);
  const off = Array.from({ length: 10 }, () => r.u32());
  const p = Array.from({ length: 13 }, () => r.i32());
  const [nV, nQ, nS] = p;

  r.o = off[0];
  const verts = new Int16Array(nV * 3);
  for (let i = 0; i < verts.length; i++) verts[i] = r.i16();

  r.o = off[1];
  const quads = new Uint16Array(nQ * 4), normals = new Float32Array(nQ * 3);
  for (let q = 0; q < nQ; q++) {
    for (let k = 0; k < 4; k++) quads[q * 4 + k] = r.u16() / 6;
    for (let k = 0; k < 3; k++) normals[q * 3 + k] = r.i16() / 4096;
  }

  r.o = off[2];
  const sectors = Array.from({ length: nS }, () => {
    const first = r.i16(), count = r.i16();
    r.o += 6;
    const attr = r.u16(), trigger = r.u16();
    r.o += 2;
    return { first, count, attr, trigger };
  });

  const grid = new Int16Array(GRID * GRID);
  r.o = off[7];
  for (let i = 0; i < grid.length; i++) grid[i] = r.i16();
  const list = new Int16Array(p[7]);
  r.o = off[8];
  for (let i = 0; i < list.length; i++) list[i] = r.i16();
  const cells = Array.from(grid, (start) => {
    const s = new Set<number>();
    for (let i = start; i < list.length && list[i] !== -1; i++) s.add(list[i] & 0x3fff);
    return Int32Array.from(s);
  });

  return { verts, quads, normals, sectors, cells, x0: p[9], z0: p[10], cellX: p[11], cellZ: p[12], raw };
}
