/**
 * Builds the Three.js scene graph for a track: one merged geometry per texture page (the original
 * also batches DrawIndexedPrimitive per page), the water surfaces, and the rings.
 *
 * Space: track geometry is Y-up, left-handed (D3D). The loader already negates Z, which is exactly
 * the right-handed Three.js frame, so the world group only applies a uniform scale.
 * (The runner physics struct is Y-down; that conversion belongs to the sim, not here.)
 */
import * as THREE from 'three';
import type { Track, TrackMesh, Vec3 } from '../formats/track';
import { tessellate, type OutArrays, type Soup } from './tessellate';
import { addDetail } from './detail';
import type { Quality } from './textures';

export const WORLD_SCALE = 1 / 100;
const WATER = 1000;

/**
 * Baked gouraud → colour multiplier. The original modulates the texture in gamma space; 128 is
 * treated as neutral (×1), so values up to 255 brighten. Returned in linear space for Three.js.
 */
function gouraud(c: number, emeraldRand: boolean) {
  const v = emeraldRand ? Math.random() * 256 : c;
  const k = Math.min(Math.max(v, 0), 255) / 128;
  return Math.pow(k, 2.2);
}

const YAW_IDENTITY = 3073;
const ang = (a: number) => (((a + 2048) & 4095) - 2048) * (Math.PI / 2048);

/** Section B local models → loader space: pos + Ry(yaw) · Rx(tilt x) · Rz(tilt z) · v. */
export function placeMesh(m: TrackMesh): Vec3[] {
  if (!m.place) return m.pos;
  const [tx, yaw, tz] = m.place.rot;
  const ay = ang(yaw - YAW_IDENTITY), ax = ang(tx), az = ang(tz);
  if (!ay && !ax && !az && m.place.pos.every((v) => v === 0)) return m.pos;
  const R = new THREE.Matrix4().makeRotationY(ay)
    .multiply(new THREE.Matrix4().makeRotationX(ax))
    .multiply(new THREE.Matrix4().makeRotationZ(az))
    .setPosition(...m.place.pos);
  const v = new THREE.Vector3();
  return m.pos.map((p) => v.set(p[0], p[1], p[2]).applyMatrix4(R).toArray() as Vec3);
}

/** Odd UV bytes are widened to the texel edge by the loader (`<<16 | 0xffff`). */
const uvByte = (b: number) => (b + (b & 1)) / 256;

/**
 * Water: all five tracks load island\island03.raw, whose 64×64 tile at (128..192, 0..64) is the
 * shared water texture. In remaster mode those faces get an animated, reflective material that
 * still uses that original tile as its colour.
 */
export const WATER_PAGE = 'island/island03.raw';
export const WATER_TILE = { x: 128, y: 0, w: 64, h: 64 };
const isWaterUV = (uv: Uint8Array) => {
  for (let i = 0; i < uv.length; i += 2)
    if (uv[i] < WATER_TILE.x || uv[i] > WATER_TILE.x + WATER_TILE.w || uv[i + 1] > WATER_TILE.y + WATER_TILE.h) return false;
  return true;
};

export interface BuiltTrack {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  water: THREE.Mesh | null;
  materials: THREE.Material[];
  textures: THREE.Texture[];
  stats: { triangles: number; drawCalls: number };
  update(t: number): void;
}

/** Runs the tessellation in a worker (falls back to the main thread). */
function tessellateAsync(soup: Soup, level: number): Promise<Map<number, OutArrays>> {
  if (typeof Worker === 'undefined') {
    const m = new Map<number, OutArrays>();
    for (const [g, b] of tessellate(soup, level))
      m.set(g, { pos: new Float32Array(b.pos), nrm: new Float32Array(b.nrm), uv: new Float32Array(b.uv), col: new Float32Array(b.col) });
    return Promise.resolve(m);
  }
  const w = new Worker(new URL('./geometryWorker.ts', import.meta.url), { type: 'module' });
  const msg = { pos: new Float64Array(soup.pos), uv: new Float32Array(soup.uv), col: new Float32Array(soup.col), group: new Int32Array(soup.group) };
  return new Promise((res, rej) => {
    w.onmessage = (e: MessageEvent<(OutArrays & { g: number })[]>) => {
      w.terminate();
      res(new Map(e.data.map((x) => [x.g, x])));
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message)); };
    w.postMessage({ soup: msg, level }, [msg.pos.buffer, msg.uv.buffer, msg.col.buffer, msg.group.buffer]);
  });
}

export async function buildTrack(
  track: Track,
  pagesP: Promise<THREE.Texture[]>,
  opts: { emerald: boolean; quality: Quality; waterPage: number; waterMap: Promise<THREE.Texture | null> },
): Promise<BuiltTrack> {
  const remaster = opts.quality === 'remaster';
  const soup: Soup = { pos: [], uv: [], col: [], group: [] };
  for (const m of track.meshes) {
    const world = placeMesh(m);
    // Emerald's rainbow: per-vertex random colour re-rolled once at load (rand()*0x40+0x20).
    const cols = m.col.map((c) => c.map((x) => gouraud(x, opts.emerald && m.kind === 'A')) as Vec3);
    for (const f of m.faces) {
      const water = remaster && f.tpage === opts.waterPage && isWaterUV(f.uv);
      const tris = f.idx.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
      for (const t of tris) {
        for (const k of t) {
          soup.pos.push(...world[f.idx[k]]);
          soup.col.push(...cols[f.idx[k]]);
          soup.uv.push(uvByte(f.uv[k * 2]), uvByte(f.uv[k * 2 + 1]));
        }
        soup.group.push(water ? WATER : f.tpage);
      }
    }
  }

  const [buffers, pages, waterMap] = await Promise.all([tessellateAsync(soup, remaster ? 3 : 1), pagesP, opts.waterMap]);
  const group = new THREE.Group();
  group.name = 'track';
  group.scale.setScalar(WORLD_SCALE);
  const meshes: THREE.Mesh[] = [], materials: THREE.Material[] = [], textures: THREE.Texture[] = [];
  let triangles = 0, water: THREE.Mesh | null = null, waterNormals: THREE.Texture | null = null;

  for (const [tp, b] of [...buffers].sort((a, z) => a[0] - z[0])) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.computeBoundingSphere();
    let mat: THREE.Material;
    if (tp === WATER) {
      // World-space UVs so the original tile can repeat and flow (one tile ≈ 4 m). Flat water is
      // mapped from above; steep faces (waterfalls) along their horizontal tangent and height,
      // so the scrolling reads as falling water.
      const uv: number[] = [];
      const a = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
      for (let i = 0; i < b.pos.length; i += 9) {
        a.fromArray(b.pos, i);
        e1.fromArray(b.pos, i + 3).sub(a);
        e2.fromArray(b.pos, i + 6).sub(a);
        const n = e1.cross(e2).normalize();
        const steep = Math.abs(n.y) < 0.6;
        const th = Math.hypot(n.x, n.z) || 1, tx = -n.z / th, tz = n.x / th;
        for (let k = i; k < i + 9; k += 3) {
          const x = b.pos[k], y = b.pos[k + 1], z = b.pos[k + 2];
          uv.push(steep ? (x * tx + z * tz) / 400 : x / 400, steep ? y / 400 : z / 400);
        }
      }
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      waterNormals = makeWaterNormals();
      textures.push(waterNormals);
      mat = new THREE.MeshStandardMaterial({
        map: waterMap, vertexColors: true, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.86,
        normalMap: waterNormals, normalScale: new THREE.Vector2(0.4, 0.4), envMapIntensity: 1.1,
        side: THREE.DoubleSide, depthWrite: false,
      });
    } else {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      const common = { map: pages[tp] ?? null, vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 }; // CULLMODE = NONE
      mat = remaster ? new THREE.MeshLambertMaterial(common) : new THREE.MeshBasicMaterial(common);
      if (remaster) addDetail(mat, 256, 8);
      mat.alphaToCoverage = opts.quality !== 'original';
    }
    materials.push(mat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = tp === WATER ? 'water' : `tpage${tp}`;
    if (tp === WATER) {
      water = mesh;
      mesh.renderOrder = 1;
      mesh.receiveShadow = true;
    } else {
      mesh.castShadow = mesh.receiveShadow = remaster;
      meshes.push(mesh);
    }
    group.add(mesh);
    triangles += b.pos.length / 9;
  }

  const update = (t: number) => {
    if (waterNormals) waterNormals.offset.set(t * 0.03, t * 0.017);
    if (waterMap) waterMap.offset.set(t * 0.05, t * 0.02);
  };
  if (waterMap) textures.push(waterMap);
  return { group, meshes, water, materials, textures, stats: { triangles, drawCalls: buffers.size }, update };
}

/** Tileable ripple normal map: a sum of integer-frequency waves, so it wraps seamlessly. */
function makeWaterNormals(size = 256) {
  const waves = [[3, 1, 0.9], [-2, 4, 0.7], [5, -3, 0.45], [1, 7, 0.3], [-7, -2, 0.25], [9, 5, 0.15]];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const [fx, fy, a] of waves) {
        const ph = ((fx * x + fy * y) / size) * Math.PI * 2 + fx * 1.7;
        const d = Math.cos(ph) * a;
        dx += d * fx * 0.12; dy += d * fy * 0.12;
      }
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Loader-space point → Three.js world position. */
export function toWorld(p: Vec3, out = new THREE.Vector3()) {
  return out.set(p[0], p[1], p[2]).multiplyScalar(WORLD_SCALE);
}

/** Gold rings, rendered as real PBR metal (the original uses flat sprites). */
export function buildRings(track: Track, envMap: THREE.Texture | null) {
  const geo = new THREE.TorusGeometry(0.42, 0.075, 20, 48);
  // Mostly self-lit gold: a pure metal would just tint the (blue) sky reflection green.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffc43a, metalness: 0.85, roughness: 0.25, envMap, envMapIntensity: 0.7,
    emissive: 0xd98a00, emissiveIntensity: 0.55,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(track.rings.length, 1));
  mesh.count = track.rings.length;
  mesh.name = 'rings';
  const base = track.rings.map((r) => toWorld(r.pos));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  /** `pop(i)`: seconds since ring i was collected (< 0 = still there); it shrinks and rises, then hides. */
  const update = (t: number, pop?: (i: number) => number) => {
    for (let i = 0; i < base.length; i++) {
      const age = pop?.(i) ?? -1;
      const k = age < 0 ? 1 : Math.max(0, 1 - age / 0.25);
      q.setFromAxisAngle(up, t * 3 + i * 0.35 + (age > 0 ? age * 40 : 0));
      p.copy(base[i]).y += age > 0 ? age * 2.5 : 0;
      m4.compose(p, q, s.setScalar(k));
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { mesh, update };
}
