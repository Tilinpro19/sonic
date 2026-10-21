/**
 * Remaster lighting derived from each track's own art:
 *  - Sun direction = the brightest blob in the parallax panorama (Resort Island's painted sun),
 *    mapped through the same projection the sky shader uses; tracks without one get a default.
 *  - Hemisphere ambient = mean colours of the sky (top) and the horizon (bottom rows).
 * Lambert divides by π, so intensities are given in "×π" units: 1.0 ≈ the original brightness.
 * The baked 1998 gouraud stays as the albedo modulation; the dynamic light adds relief and shadow.
 */
import * as THREE from 'three';
import { SKY_W, SKY_H, skyDirection } from './sky';

export interface SkyAnalysis { sun: THREE.Vector3; sunFound: boolean; sky: THREE.Color; horizon: THREE.Color }

export function analyzeSky(rgb: Uint8Array): SkyAnalysis {
  const lum = (i: number) => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  // Box-blurred luminance (8×8 cells) so a single bright cloud pixel doesn't win.
  const C = 8;
  let best = -1, bx = 0, by = 0;
  for (let cy = 0; cy < SKY_H * 0.7; cy += C / 2)
    for (let cx = 0; cx < SKY_W; cx += C / 2) {
      let s = 0;
      for (let y = cy; y < cy + C; y++) for (let x = cx; x < cx + C; x++) s += lum(y * SKY_W + (x % SKY_W));
      if (s > best) { best = s; bx = cx + C / 2; by = cy + C / 2; }
    }
  const sunFound = best / (C * C) > 215;
  const sun = sunFound ? skyDirection(bx / SKY_W, by / SKY_H) : new THREE.Vector3(0.45, 0.75, -0.5).normalize();
  // Very low painted suns would give endless shadows; keep at least ~25° of elevation.
  if (sun.y < 0.42) { sun.y = 0.42; sun.normalize(); }

  const mean = (y0: number, y1: number) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < SKY_W; x++) {
      const i = (y * SKY_W + x) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++;
    }
    return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  };
  return { sun, sunFound, sky: mean(0, SKY_H / 3), horizon: mean(SKY_H - 24, SKY_H) };
}

export function buildLights(a: SkyAnalysis, bounds: THREE.Box3) {
  const white = new THREE.Color(1, 1, 1);
  const hemi = new THREE.HemisphereLight(
    white.clone().lerp(a.sky, 0.3), white.clone().lerp(a.horizon, 0.45).multiplyScalar(0.7), 0.64 * Math.PI,
  );
  const sunColor = new THREE.Color(1, 0.95, 0.86);
  const sun = new THREE.DirectionalLight(sunColor, 0.62 * Math.PI);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  sun.position.copy(center).addScaledVector(a.sun, radius * 1.5);
  sun.target.position.copy(center);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -radius;
  sc.right = sc.top = radius;
  sc.near = radius * 0.2;
  sc.far = radius * 3;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2.5;
  return { hemi, sun, objects: [hemi, sun, sun.target] as THREE.Object3D[] };
}
