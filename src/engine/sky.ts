/**
 * Parallax panorama (832×256 RGB24, horizon at the bottom row) drawn as an infinitely distant sky.
 * The original scrolls a 2D strip with the camera yaw; here it is a true direction-mapped
 * backdrop. HD mode removes the interlace lines baked into the source art.
 */
import * as THREE from 'three';
import type { Quality } from './textures';

const W = 832, H = 256;
export const SKY_W = W, SKY_H = H;
/** Elevation (radians) of the bottom and top rows, and how many times the strip wraps 360°. */
const EL_BOTTOM = -0.04, EL_TOP = 0.78, REPEAT = 2;

/** Texture coords (0..1) → world direction; the inverse of the mapping in the fragment shader. */
export function skyDirection(u: number, v: number) {
  const a = (u * Math.PI * 2) / REPEAT;
  const e = EL_TOP - v * (EL_TOP - EL_BOTTOM);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

/** Vertical [1 2 1] filter: the art alternates bright/dark scanlines; this averages them out. */
function deinterlace(rgb: Uint8Array) {
  const out = rgb.slice();
  const row = W * 3;
  for (let y = 1; y < H - 1; y++)
    for (let i = 0; i < row; i++) {
      const o = y * row + i;
      out[o] = (rgb[o - row] + 2 * rgb[o] + rgb[o + row] + 2) >> 2;
    }
  return out;
}

export function buildSky(rgbIn: Uint8Array, quality: Quality, maxAniso: number) {
  const rgb = quality !== 'original' ? deinterlace(rgbIn) : rgbIn;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = quality !== 'original' ? THREE.LinearFilter : THREE.NearestFilter;
  tex.minFilter = quality !== 'original' ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  tex.generateMipmaps = quality !== 'original';
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;

  // Below the horizon there is no art: fill with the mean colour of the bottom rows (linear).
  const ground = new THREE.Color();
  {
    let r = 0, g = 0, b = 0;
    const n = W * 4;
    for (let i = (H - 4) * W * 3; i < H * W * 3; i += 3) { r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
    ground.setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace).multiplyScalar(0.8);
  }

  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, ground: { value: ground } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // depth = far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 ground;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float u = atan(d.x, -d.z) / 6.2831853 * ${REPEAT.toFixed(1)};
        float e = asin(clamp(d.y, -1.0, 1.0));
        float v = clamp((${EL_TOP} - e) / (${EL_TOP} - (${EL_BOTTOM})), 0.0, 1.0);
        // Above the strip the top row extends (clamp); below it fades to the ground colour. Gradients are taken from
        // whichever of u / fract(u+.5) is continuous here, so the atan seam doesn't pick a tiny mip.
        float u2 = fract(u + 0.5);
        vec2 gx = vec2(abs(dFdx(u)) < abs(dFdx(u2)) ? dFdx(u) : dFdx(u2), dFdx(v));
        vec2 gy = vec2(abs(dFdy(u)) < abs(dFdy(u2)) ? dFdy(u) : dFdy(u2), dFdy(v));
        vec3 c = textureGrad(map, vec2(u, v), gx, gy).rgb;
        c = mix(ground, c, smoothstep(${EL_BOTTOM} - 0.05, ${EL_BOTTOM}, e));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.onBeforeRender = (_r, _s, cam) => mesh.position.copy(cam.position);
  return { mesh, texture: tex };
}
