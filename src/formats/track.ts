/**
 * Sonic R track `*_?.bin` — port of work/tools/sr_track.py (LoadTrack3 @ 0x426db8).
 * Coordinates are returned in "loader space": raw file coords with Z negated, exactly as the
 * original loader stores them (Y up).
 */
import { Reader } from './reader';

export type Vec3 = [number, number, number];

export interface Face {
  /** Vertex indices into the owning mesh, in loop order (3 or 4). */
  idx: number[];
  /** u,v byte pairs on a 256×256 page, same order as idx. */
  uv: Uint8Array;
  tpage: number;
  flags: number;
}

export interface TrackMesh {
  kind: 'A' | 'B';
  origin: Vec3;
  attr: number;
  pos: Vec3[];
  /** Section A: signed gouraud (≈0..255, can go negative). Section B: u8. */
  col: Vec3[];
  faces: Face[];
  /**
   * Section B placement: most scenery is a local model (palms, rocks, flowers, water patches)
   * placed at `pos` (loader space) with 12-bit angles `rot` = [tilt x, yaw, tilt z]. Yaw 3073
   * (≈ 3/4 turn) is the exporter's "unrotated". Big static meshes use pos = 0, yaw 3073.
   */
  place?: { pos: Vec3; rot: Vec3 };
}

export interface Ring { tag: number; pos: Vec3 }

export interface Track {
  pvs: Uint8Array[];
  meshes: TrackMesh[];
  nA: number;
  rings: Ring[];
  lists: Record<'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5', Vec3[]>;
  p6: Vec3[];
  p6Declared: number;
  consumed: number;
  size: number;
}

export function parseTrack(buf: ArrayBuffer | Uint8Array): Track {
  const r = new Reader(buf);
  const nCells = r.u32();
  const pvs: Uint8Array[] = [];
  for (let i = 0; i < nCells; i++) pvs.push(r.bytes(0x80));

  const meshes: TrackMesh[] = [];
  const rings: Ring[] = [];

  // Section A: road ribbons. Quads have no indices: quad i = (2i, 2i+1, 2i+3, 2i+2).
  const nA = r.i32();
  for (let m = 0; m < nA; m++) {
    const ox = r.i32(), oy = r.i32(), oz = r.i32();
    const attr = r.i32();
    const nv = r.i32();
    const pos: Vec3[] = [], col: Vec3[] = [];
    for (let i = 0; i < nv; i++) {
      const dx = r.i16(), dy = r.i16(), dz = r.i16();
      pos.push([ox + dx, oy + dy, -oz - dz]);
      col.push([r.i16(), r.i16(), r.i16()]);
    }
    const nq = r.i32();
    const faces: Face[] = [];
    for (let i = 0; i < nq; i++) {
      const tp = r.u16();
      const uv = r.bytes(8);
      const flags = r.u16();
      faces.push({ idx: [2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2], uv, tpage: tp & 0xff, flags });
    }
    for (;;) {
      const tag = r.i32();
      if (tag === -1) break;
      const x = r.i32(), y = r.i32(), z = r.i32();
      rings.push({ tag, pos: [x, y, -z] });
    }
    meshes.push({ kind: 'A', origin: [ox, oy, -oz], attr, pos, col, faces });
  }

  // Section B: indexed scenery. Vertices are absolute (not origin-relative).
  const nB = r.i32();
  for (let m = 0; m < nB; m++) {
    const ox = r.i32(), oy = r.i32(), oz = r.i32();
    const attr = r.i32();
    const bx = r.i32(), by = r.i32(), bz = r.i32();
    const rot: Vec3 = [r.u16(), r.u16(), r.u16()];
    const faces: Face[] = [];
    const nt = r.i32();
    for (let i = 0; i < nt; i++) {
      const idx = [r.u16(), r.u16(), r.u16()];
      const uv = r.bytes(6);
      faces.push({ idx, uv, tpage: r.u16(), flags: r.u16() });
    }
    const nq = r.i32();
    for (let i = 0; i < nq; i++) {
      const idx = [r.u16(), r.u16(), r.u16(), r.u16()];
      const uv = r.bytes(8);
      faces.push({ idx, uv, tpage: r.u16(), flags: r.u16() });
    }
    const nv = r.i32();
    const pos: Vec3[] = [], col: Vec3[] = [];
    for (let i = 0; i < nv; i++) {
      const x = r.i16(), y = r.i16(), z = r.i16();
      pos.push([x, y, -z]);
      col.push([r.u8(), r.u8(), r.u8()]);
      r.u8();
    }
    meshes.push({ kind: 'B', origin: [ox, oy, -oz], attr, pos, col, faces, place: { pos: [bx, by, -bz], rot } });
  }

  const readList = () => {
    const n = r.i32();
    const out: Vec3[] = [];
    for (let i = 0; i < n; i++) out.push([r.i32(), r.i32(), r.i32()]);
    return out;
  };
  const lists = {
    P0: readList(), P1: readList(), P2: readList(), P3: readList(), P4: readList(), P5: readList(),
  };
  // All 5 shipped tracks declare one more P6 entry than the file holds; the original fread hits EOF.
  const p6Declared = r.i32();
  const p6: Vec3[] = [];
  const avail = Math.floor(r.left / 6);
  for (let i = 0; i < Math.min(p6Declared, avail); i++) p6.push([r.i16(), r.i16(), r.i16()]);

  return { pvs, meshes, nA, rings, lists, p6, p6Declared, consumed: r.o, size: r.size };
}
