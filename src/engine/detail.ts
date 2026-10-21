/**
 * Detail texturing: a tileable grain that fades in only where the original texture is magnified
 * (a texel covering several screen pixels), restoring micro-contrast to 256² art seen up close.
 * At normal viewing distance it is invisible, so the original look is untouched.
 */
import * as THREE from 'three';

let shared: THREE.DataTexture | null = null;

/** 128² tileable fBm value noise, grey around 0.5. */
export function detailTexture() {
  if (shared) return shared;
  const N = 128, data = new Uint8Array(N * N * 4);
  const lattice = (s: number) => {
    const g = new Float32Array(s * s);
    for (let i = 0; i < g.length; i++) g[i] = Math.random();
    return (x: number, y: number) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const at = (a: number, b: number) => g[(((b % s) + s) % s) * s + (((a % s) + s) % s)];
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const top = at(xi, yi) * (1 - sx) + at(xi + 1, yi) * sx;
      const bot = at(xi, yi + 1) * (1 - sx) + at(xi + 1, yi + 1) * sx;
      return top * (1 - sy) + bot * sy;
    };
  };
  const octaves = [8, 16, 32, 64].map((s) => ({ s, f: lattice(s) }));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let v = 0, amp = 0.5, tot = 0;
      for (const o of octaves) {
        v += o.f((x / N) * o.s, (y / N) * o.s) * amp;
        tot += amp;
        amp *= 0.6;
      }
      const c = Math.round((v / tot) * 255);
      const i = (y * N + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = c;
      data[i + 3] = 255;
    }
  shared = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  shared.wrapS = shared.wrapT = THREE.RepeatWrapping;
  shared.minFilter = THREE.LinearMipmapLinearFilter;
  shared.magFilter = THREE.LinearFilter;
  shared.generateMipmaps = true;
  shared.needsUpdate = true;
  return shared;
}

/**
 * @param texelsPerUv  source texels per uv unit (256 for a page, 32 for playfield cells)
 * @param repeatPerUv  detail tiles per uv unit (≈ 4 detail pixels per source texel)
 */
export function addDetail(mat: THREE.Material, texelsPerUv: number, repeatPerUv: number, strength = 0.32) {
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.detailMap = { value: detailTexture() };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D detailMap;')
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
#ifdef USE_MAP
{
  vec2 tuv = vMapUv * ${texelsPerUv.toFixed(1)};
  float texelsPerPx = max(length(dFdx(tuv)), length(dFdy(tuv)));
  float k = 1.0 - smoothstep(0.3, 1.0, texelsPerPx);
  float d = texture2D(detailMap, vMapUv * ${repeatPerUv.toFixed(1)}).r;
  diffuseColor.rgb *= mix(1.0, 1.0 + (d - 0.5) * ${strength.toFixed(3)} * 2.0, k);
}
#endif`);
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|detail${texelsPerUv}`;
}
