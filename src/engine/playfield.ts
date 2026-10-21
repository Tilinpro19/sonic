/**
 * "Playfield": the flat tiled ground under each track (grass, sand…).
 *  - `.ply`: 320×384 RGB24 atlas = 10×12 tiles of 32×32 (colour key #00FF00).
 *  - `.map`: 256×256 u8 tile indices, only the first 128×128 used; tile 0 = empty.
 * World → cell mapping from 0x47b794 (the runner's "what am I standing on" query):
 *   a = (x/s − x0)/(x1 − x0)·4096,  b = (z/s − z0)/(z1 − z0)·4096,  cell = (a>>5, (4095 − b)>>5)
 * with x0,z0,x1,z1,s set per track in Init<Track> (globals 0x6d75cc/d0/d4/d8/c0).
 *
 * Built on a stock Basic/Lambert material whose texture lookup is swapped for a tilemap lookup,
 * so the remaster gets lighting, shadows and fog for free.
 */
import * as THREE from 'three';
import { makePageTexture, type Quality } from './textures';
import { WORLD_SCALE } from './trackScene';
import { addDetail } from './detail';

export interface PlayfieldBounds { x0: number; z0: number; x1: number; z1: number; s: number }

const TILE_LOOKUP = /* glsl */ `
#ifdef USE_MAP
  ivec2 cell = ivec2(floor(vMapUv));
  if (cell.x < 0 || cell.y < 0 || cell.x > 127 || cell.y > 127) discard;
  int tile = int(texelFetch(cells, cell, 0).r * 255.0 + 0.5);
  if (tile == 0) discard;
  vec2 local = clamp(fract(vMapUv), 0.5 / 32.0, 1.0 - 0.5 / 32.0);
  vec2 tileOrigin = vec2(float(tile % 10), float(tile / 10)) * 32.0;
  vec2 atlasUv = (tileOrigin + local * 32.0) / vec2(320.0, 384.0);
  vec2 sc = 32.0 / vec2(320.0, 384.0);
  vec4 sampledDiffuseColor = textureGrad(map, atlasUv, dFdx(vMapUv) * sc, dFdy(vMapUv) * sc);
  if (sampledDiffuseColor.a < 0.5) discard;
  diffuseColor *= sampledDiffuseColor;
#endif
`;

export async function buildPlayfield(ply: Uint8Array, map: Uint8Array, b: PlayfieldBounds, quality: Quality, maxAniso: number, y = 0) {
  const atlas = await makePageTexture(ply, quality, maxAniso, { w: 320, h: 384 });
  const mapTex = new THREE.DataTexture(map, 256, 256, THREE.RedFormat, THREE.UnsignedByteType);
  mapTex.magFilter = mapTex.minFilter = THREE.NearestFilter;
  mapTex.needsUpdate = true;

  // A quad over the whole 128×128-cell area; uv = cell coordinates (column, row).
  const X0 = b.x0 * b.s, X1 = b.x1 * b.s, Z0 = b.z0 * b.s, Z1 = b.z1 * b.s;
  const g = new THREE.BufferGeometry();
  const pos = [X0, y, Z0, X1, y, Z0, X1, y, Z1, X0, y, Z1].map((v) => v * WORLD_SCALE);
  // At z = Z0: b = 0 → row 127.99; at Z1: row 0. At x = X0: column 0; at X1: column 128.
  const uv = [0, 128, 128, 128, 128, 0, 0, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);

  const params = { map: atlas, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 };
  const mat = quality === 'remaster' ? new THREE.MeshLambertMaterial(params) : new THREE.MeshBasicMaterial(params);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.cells = { value: mapTex };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D cells;')
      .replace('#include <map_fragment>', TILE_LOOKUP);
  };
  mat.customProgramCacheKey = () => 'sonicr-playfield';
  if (quality === 'remaster') addDetail(mat, 32, 1);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'playfield';
  mesh.receiveShadow = quality === 'remaster';
  return { mesh, disposables: [atlas, mapTex, g, mat] };
}
