/**
 * Pure pixel processing for texture pages (no Three.js), shared by the main thread and the
 * texture worker pool.
 */
export type Quality = 'original' | 'hd' | 'remaster';

/** RGB24 → RGBA (as packed u32, little-endian ABGR). Key colour becomes alpha 0. */
export function decodeRaw(rgb: Uint8Array, w: number, h: number, colorKey = true): Uint32Array {
  const out = new Uint32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    const r = rgb[j], g = rgb[j + 1], b = rgb[j + 2];
    const a = colorKey && r === 0 && g === 255 && b === 0 ? 0 : 255;
    out[i] = (a << 24) | (b << 16) | (g << 8) | r;
  }
  return out;
}

/**
 * Bleed opaque colours into transparent texels so bilinear/mip filtering never pulls in the green
 * key colour (the classic "green fringe" of colour-keyed textures on modern filtering).
 */
export function dilate(px: Uint32Array, w: number, h: number, passes = 4) {
  for (let p = 0; p < passes; p++) {
    const src = px.slice();
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (src[i] >>> 24) continue;
        if ((src[i] & 0xffffff) !== 0x00ff00 && p > 0) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const c = src[yy * w + xx];
          if (!(c >>> 24) && (c & 0xffffff) === 0x00ff00) continue;
          r += c & 255; g += (c >>> 8) & 255; b += (c >>> 16) & 255; n++;
        }
        if (n) {
          px[i] = (Math.round(b / n) << 16) | (Math.round(g / n) << 8) | Math.round(r / n);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // Anything still untouched (fully keyed regions) goes neutral grey instead of green.
  for (let i = 0; i < px.length; i++) if (px[i] === 0x00ff00) px[i] = 0x808080;
}

/** Scale2x / EPX: doubles resolution, keeps hard pixel-art edges, introduces no new colours. */
export function scale2x(src: Uint32Array, w: number, h: number): Uint32Array {
  const W = w * 2, out = new Uint32Array(W * h * 2);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y, yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
      const P = src[y * w + x];
      const A = src[ym * w + x], B = src[y * w + xp], C = src[y * w + xm], D = src[yp * w + x];
      let e0 = P, e1 = P, e2 = P, e3 = P;
      if (C === A && C !== D && A !== B) e0 = A;
      if (A === B && A !== C && B !== D) e1 = B;
      if (D === C && D !== B && C !== A) e2 = C;
      if (B === D && B !== A && D !== C) e3 = D;
      const o = y * 2 * W + x * 2;
      out[o] = e0; out[o + 1] = e1; out[o + W] = e2; out[o + W + 1] = e3;
    }
  }
  return out;
}

/** Catmull-Rom weights for the 4 output phases of an exact 4× upscale (pixel-centre aligned). */
const PHASES = [0, 1, 2, 3].map((p) => {
  const x = (p + 0.5) / 4 - 0.5, base = Math.floor(x), t = x - base;
  const w = [((-t + 2) * t - 1) * t / 2, ((3 * t - 5) * t * t + 2) / 2, ((-3 * t + 4) * t + 1) * t / 2, ((t - 1) * t * t) / 2];
  return { base, w };
});

/** Separable bicubic (Catmull-Rom) 4× upscale of packed RGBA. */
export function bicubic4x(src: Uint32Array, w: number, h: number, wrap: boolean): Uint32Array {
  const W = w * 4, H = h * 4;
  const idx = (i: number, n: number) => (wrap ? ((i % n) + n) % n : Math.min(Math.max(i, 0), n - 1));
  const tmp = new Float32Array(W * h * 4);
  for (let y = 0; y < h; y++)
    for (let X = 0; X < W; X++) {
      const { base, w: k } = PHASES[X & 3], sx = (X >> 2) + base;
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0; t < 4; t++) {
        const c = src[y * w + idx(sx - 1 + t, w)], kt = k[t];
        r += (c & 255) * kt; g += ((c >>> 8) & 255) * kt; b += ((c >>> 16) & 255) * kt; a += (c >>> 24) * kt;
      }
      const o = (y * W + X) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  const out = new Uint32Array(W * H);
  const cl = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let Y = 0; Y < H; Y++) {
    const { base, w: k } = PHASES[Y & 3], sy = (Y >> 2) + base;
    const rows = [0, 1, 2, 3].map((t) => idx(sy - 1 + t, h) * W * 4);
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0; t < 4; t++) {
        const o = rows[t] + X * 4, kt = k[t];
        r += tmp[o] * kt; g += tmp[o + 1] * kt; b += tmp[o + 2] * kt; a += tmp[o + 3] * kt;
      }
      out[Y * W + X] = ((cl(a) << 24) | (cl(b) << 16) | (cl(g) << 8) | cl(r)) >>> 0;
    }
  }
  return out;
}

/**
 * 4× "remaster" upscale. Flat-colour pixel art (signs, icons, stripes) keeps crisp Scale2x edges;
 * noisy painted texture (rock, grass, wood) gets smooth bicubic instead of 4×4 blocks. The choice
 * is made per source pixel: "flat" when it exactly matches at least 4 of its 8 neighbours.
 */
export function upscale4x(px: Uint32Array, w: number, h: number, wrap = false): Uint32Array {
  let epx = scale2x(px, w, h);
  epx = scale2x(epx, w * 2, h * 2);
  const bic = bicubic4x(px, w, h, wrap);
  const W = w * 4;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = px[y * w + x];
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = Math.min(Math.max(x + dx, 0), w - 1), yy = Math.min(Math.max(y + dy, 0), h - 1);
        if (px[yy * w + xx] === c) same++;
      }
      if (same < 4) continue;
      for (let r = 0; r < 4; r++) {
        const o = (y * 4 + r) * W + x * 4;
        bic.set(epx.subarray(o, o + 4), o);
      }
    }
  return bic;
}


export interface PageJob { rgb: Uint8Array; w: number; h: number; colorKey: boolean; wrap: boolean; quality: Quality }

/** Full page pipeline → RGBA bytes + final size. */
export function processPage(j: PageJob) {
  let px = decodeRaw(j.rgb, j.w, j.h, j.colorKey);
  let W = j.w, H = j.h;
  if (j.quality !== 'original') {
    dilate(px, j.w, j.h);
    px = upscale4x(px, j.w, j.h, j.wrap); W *= 4; H *= 4;
  }
  return { data: new Uint8Array(px.buffer), w: W, h: H };
}

/** Cuts a w×h RGB24 tile out of a 256-wide page (e.g. the shared water tile). */
export function cropRaw(rgb: Uint8Array, x: number, y: number, w: number, h: number, pageW = 256) {
  const out = new Uint8Array(w * h * 3);
  for (let r = 0; r < h; r++) out.set(rgb.subarray(((y + r) * pageW + x) * 3, ((y + r) * pageW + x + w) * 3), r * w * 3);
  return out;
}
