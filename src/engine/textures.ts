/**
 * Texture pages: 256×256 RGB24 `.raw`, colour key #00FF00 = transparent (COLORKEYENABLE).
 * "Original" keeps the 256² page with nearest filtering. HD/Remaster upscale 4× (see upscale4x:
 * Scale2x for flat pixel art, bicubic for painted texture) and filter with mipmaps + 16× aniso.
 * The pixel work runs in a pool of workers so a track's pages are processed in parallel.
 */
import * as THREE from 'three';
import { processPage, type PageJob, type Quality } from './pixels';

export type { Quality } from './pixels';
export { cropRaw, bicubic4x, upscale4x, scale2x, dilate, decodeRaw } from './pixels';

type Done = { data: Uint8Array; w: number; h: number };
const pool: Worker[] = [];
const pending = new Map<number, (d: Done) => void>();
let nextId = 0, rr = 0;

function worker() {
  if (typeof Worker === 'undefined') return null;
  if (!pool.length) {
    const n = Math.max(1, Math.min((navigator.hardwareConcurrency ?? 4) - 1, 6));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./textureWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<Done & { id: number }>) => {
        pending.get(e.data.id)?.(e.data);
        pending.delete(e.data.id);
      };
      pool.push(w);
    }
  }
  return pool[rr++ % pool.length];
}

function run(job: PageJob): Promise<Done> {
  const w = worker();
  if (!w) return Promise.resolve(processPage(job));
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    w.postMessage({ id, job: { ...job, rgb: job.rgb.slice() } });
  });
}

/**
 * AI-upscaled page (Real-ESRGAN PNG, any size): its RGB replaces the 4× result, scaled to fit.
 * Alpha keeps coming from the original colour key so cut-outs stay pixel-exact.
 */
async function applyHd(out: Done, png: Uint8Array) {
  try {
    const img = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
    const c = new OffscreenCanvas(out.w, out.h);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, out.w, out.h);
    img.close();
    const ai = g.getImageData(0, 0, out.w, out.h).data;
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = ai[i];
      out.data[i + 1] = ai[i + 1];
      out.data[i + 2] = ai[i + 2];
    }
  } catch (e) {
    console.warn('Textura HD no válida, uso la escalada normal', e);
  }
}

export async function makePageTexture(
  rgb: Uint8Array,
  quality: Quality,
  maxAniso: number,
  opts: { w?: number; h?: number; colorKey?: boolean; wrap?: boolean; hd?: Uint8Array | null } = {},
): Promise<THREE.DataTexture> {
  const out = await run({ rgb, w: opts.w ?? 256, h: opts.h ?? 256, colorKey: opts.colorKey ?? true, wrap: !!opts.wrap, quality });
  if (opts.hd && quality !== 'original') await applyHd(out, opts.hd);
  const tex = new THREE.DataTexture(out.data, out.w, out.h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = opts.wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  if (quality !== 'original') {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = maxAniso;
  } else {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
  }
  tex.needsUpdate = true;
  return tex;
}
