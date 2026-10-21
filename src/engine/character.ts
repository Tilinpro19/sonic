/**
 * Racer models. Port of the character renderer at 0x469ae0:
 *  - There is NO bone hierarchy. Every animation record places its part directly in character
 *    space: v' = R(rx, ry, rz) · v + t, then Z is negated (same left→right-handed flip as the
 *    track loader). R is built from the sin/cos LUTs exactly as below (yaw is offset by +0x400).
 *  - Lighting is baked: `.grd` holds 32 headings × nVerts × RGB8 and 0x430638 copies the row for
 *    heading index (31 − (yaw >> 7)) into the vertex colours. 128 = neutral, like the track.
 *  - Faces with flag bit 0 (the face: eyes, muzzle) are skipped by 0x469ae0 and drawn by another
 *    pass; they render as ordinary textured faces here. Models face −X.
 *  - Remaster rounds each part with the track's PN-triangle tessellator (sharp creases kept, UVs
 *    untouched). Its lighting is heading-independent, so the colour is baked before subdividing.
 */
import * as THREE from 'three';
import type { ModelPart, AnimKey } from '../formats/model';
import type { Quality } from './textures';
import { tessellate, type Soup } from './tessellate';

const TURN = Math.PI / 2048;
const uvByte = (b: number) => (b + (b & 1)) / 256;

/** Character-space rotation of one animation record (row-major 3×3, Y up, before the Z flip). */
export function partRotation(rot: readonly number[], out = new THREE.Matrix4()) {
  const a = rot[0] * TURN, b = (rot[1] + 0x400) * TURN, c = rot[2] * TURN;
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b), sc = Math.sin(c), cc = Math.cos(c);
  return out.set(
    cb * ca - sb * sc * sa, -cc * sa, sb * ca + sc * cb * sa, 0,
    sb * sc * ca + cb * sa, cc * ca, sa * sb - ca * sc * cb, 0,
    -sb * cc, sc, cc * cb, 0,
    0, 0, 0, 1,
  );
}

/** Pre-decomposed key: translation + rotation quaternion (for smooth interpolation in HD). */
interface Key { t: THREE.Vector3; q: THREE.Quaternion }
const toKey = (k: AnimKey): Key => ({
  t: new THREE.Vector3(...k.t),
  q: new THREE.Quaternion().setFromRotationMatrix(partRotation(k.rot)),
});

export interface Character {
  group: THREE.Group;
  /** Lowest point of the first animation's first frame (character units), for ground placement. */
  footY: number;
  setAnim(i: number): void;
  /** Advance to time t (seconds). Original: steps at the 30 Hz tick; HD/Remaster: interpolated. */
  update(t: number): void;
  /** Re-bake the per-heading vertex lighting (Original/HD) for a yaw in 12-bit units. */
  setHeading(yaw12: number): void;
  dispose(): void;
}

const FLIP_Z = new THREE.Matrix4().makeScale(1, 1, -1);
export const ANIM_FPS = 30;

export function buildCharacter(
  parts: ModelPart[],
  grd: Uint8Array,
  anims: AnimKey[][][],
  pages: THREE.Texture[],
  quality: Quality,
): Character {
  const remaster = quality === 'remaster';
  const nVerts = parts.reduce((n, p) => n + p.pos.length, 0);
  const dirs = Math.floor(grd.length / (nVerts * 3));

  // Remaster is lit by the scene: the brightest baked direction is used as the albedo tint so the
  // authored colour variation (and darkened crevices) survives without double lighting.
  const materials = pages.map((map) => remaster
    ? new THREE.MeshStandardMaterial({ map, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55, metalness: 0 })
    : new THREE.MeshBasicMaterial({ map, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide }));

  // Remaster albedo tint: brightest baked direction per vertex (see setHeading).
  const tint = (v: number, c: number) => {
    let x = 0;
    for (let d = 0; d < dirs; d++) x = Math.max(x, grd[(d * nVerts + v) * 3 + c]);
    return Math.pow(Math.min(x / 200, 1), 2.2);
  };
  // The tessellator welds at ½ unit, so blow the tiny character units up for it and back after.
  const extent = Math.max(1e-6, ...parts.flatMap((p) => p.pos.flatMap((v) => v.map(Math.abs))));
  const K = 4000 / extent;

  const group = new THREE.Group();
  group.name = 'character';
  const meshes: THREE.Mesh[] = [];
  // Per part: which source vertex each emitted (non-indexed) vertex comes from, to recolour.
  const vertexMap: Int32Array[] = [];
  let base = 0;
  for (const p of parts) {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], src: number[] = [];
    const geo = new THREE.BufferGeometry();
    if (remaster) {
      const soup: Soup = { pos: [], uv: [], col: [], group: [] };
      for (const f of p.faces) {
        const tris = f.idx.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
        for (const t of tris) {
          for (const k of t) {
            const v = f.idx[k];
            soup.pos.push(p.pos[v][0] * K, p.pos[v][1] * K, p.pos[v][2] * K);
            soup.uv.push(uvByte(f.uv[k * 2]), uvByte(f.uv[k * 2 + 1]));
            soup.col.push(tint(base + v, 0), tint(base + v, 1), tint(base + v, 2));
          }
          soup.group.push(f.tpage);
        }
      }
      const out = tessellate(soup, 3, 60);
      const col: number[] = [];
      for (let page = 0; page < pages.length; page++) {
        const b = out.get(page);
        if (!b?.pos.length) continue;
        geo.addGroup(pos.length / 3, b.pos.length / 3, page);
        for (const x of b.pos) pos.push(x / K);
        nrm.push(...b.nrm); uv.push(...b.uv); col.push(...b.col);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    } else for (let page = 0; page < pages.length; page++) {
      const start = pos.length / 3;
      for (const f of p.faces) {
        if (f.tpage !== page) continue;
        const tris = f.idx.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
        for (const t of tris)
          for (const k of t) {
            const v = f.idx[k];
            pos.push(...p.pos[v]);
            const n = p.nrm[v], l = Math.hypot(...n) || 1;
            nrm.push(n[0] / l, n[1] / l, n[2] / l);
            uv.push(uvByte(f.uv[k * 2]), uvByte(f.uv[k * 2 + 1]));
            src.push(base + v);
          }
      }
      if (pos.length / 3 > start) geo.addGroup(start, pos.length / 3 - start, page);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (!remaster) geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    const mesh = new THREE.Mesh(geo, materials);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = mesh.receiveShadow = remaster;
    group.add(mesh);
    meshes.push(mesh);
    vertexMap.push(Int32Array.from(src));
    base += p.pos.length;
  }

  const gamma = (c: number) => Math.pow(Math.min(c, 255) / 128, 2.2);
  function setHeading(yaw12: number) {
    if (remaster) return; // tint baked at build time
    const row = (31 - ((yaw12 & 4095) >> 7)) % Math.max(dirs, 1);
    meshes.forEach((m, i) => {
      const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      const map = vertexMap[i];
      const rgb = [0, 0, 0];
      for (let j = 0; j < map.length; j++) {
        const v = map[j];
        for (let c = 0; c < 3; c++) {
          rgb[c] = gamma(grd[(row * nVerts + v) * 3 + c]);
        }
        col.setXYZ(j, rgb[0], rgb[1], rgb[2]);
      }
      col.needsUpdate = true;
    });
  }
  setHeading(0);

  const keys = anims.map((frames) => frames.map((f) => f.map(toKey)));
  let footY = 0;
  if (keys[0]?.[0]) {
    footY = Infinity;
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    keys[0][0].forEach((k, i) => {
      m.makeRotationFromQuaternion(k.q).setPosition(k.t);
      for (const p of parts[i]?.pos ?? []) footY = Math.min(footY, v.set(...p).applyMatrix4(m).y);
    });
  }

  let anim = 0;
  const q = new THREE.Quaternion(), t = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  function update(time: number) {
    const frames = keys[anim];
    if (!frames?.length) return;
    const ft = time * ANIM_FPS;
    const f0 = Math.floor(ft) % frames.length;
    const f1 = (f0 + 1) % frames.length;
    const a = quality === 'original' ? 0 : ft - Math.floor(ft);
    meshes.forEach((m, i) => {
      const k0 = frames[f0][i], k1 = frames[f1][i];
      if (!k0) { m.visible = false; return; }
      m.visible = true;
      t.lerpVectors(k0.t, k1.t, a);
      q.slerpQuaternions(k0.q, k1.q, a);
      m.matrix.compose(t, q, one).premultiply(FLIP_Z);
      m.matrixWorldNeedsUpdate = true;
    });
  }

  return {
    group, footY, update, setHeading,
    setAnim(i) { anim = Math.max(0, Math.min(i, keys.length - 1)); },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
