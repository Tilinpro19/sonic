/**
 * Character mesh `*_h.bin` / `*z.bin` (0x42e034) and animation `*anN.bin` (0x42e78c).
 * Port of work/tools/sr_model.py. One part = one rigid bone; hierarchy still unknown (plan A.6).
 */
import { Reader } from './reader';
import type { Face, Vec3 } from './track';

export interface ModelPart {
  pos: Vec3[];
  nrm: Vec3[];
  col: Vec3[];
  faces: Face[];
}

export function parseModel(buf: ArrayBuffer | Uint8Array) {
  const r = new Reader(buf);
  const parts: ModelPart[] = [];
  for (;;) {
    const nv = r.i32();
    if (nv === -1) break;
    const pos: Vec3[] = [], nrm: Vec3[] = [], col: Vec3[] = [];
    for (let i = 0; i < nv; i++) {
      pos.push([r.i16(), r.i16(), r.i16()]);
      nrm.push([r.i16(), r.i16(), r.i16()]);
      col.push([r.u8(), r.u8(), r.u8()]);
      r.u8();
    }
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
    parts.push({ pos, nrm, col, faces });
  }
  return { parts, consumed: r.o, size: r.size };
}

export interface AnimKey { t: Vec3; rot: Vec3 }

/**
 * i32 nParts, then {i32 tx,ty,tz, rx,ry,rz} per part per frame (angles: 4096 = one turn).
 * kan16, mran13 and mran14 ship big-endian (Saturn leftovers); detected from the header.
 */
export function parseAnim(buf: ArrayBuffer | Uint8Array) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(u8, u8[0] !== 0 || u8[3] === 0);
  const nParts = r.i32();
  const keys: AnimKey[] = [];
  while (r.left >= 24) keys.push({ t: [r.i32(), r.i32(), r.i32()], rot: [r.i32(), r.i32(), r.i32()] });
  const frames: AnimKey[][] = [];
  for (let f = 0; f + nParts <= keys.length; f += nParts) frames.push(keys.slice(f, f + nParts));
  return { nParts, frames, remainder: r.left };
}
