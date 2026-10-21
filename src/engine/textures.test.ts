import { describe, expect, it } from 'vitest';
import { bicubic4x, upscale4x } from './textures';

describe('upscale', () => {
  it('bicubic keeps a flat colour flat and quadruples size', () => {
    const src = new Uint32Array(16 * 16).fill(0xff336699);
    const out = bicubic4x(src, 16, 16, false);
    expect(out.length).toBe(64 * 64);
    expect(out.every((c) => c === 0xff336699)).toBe(true);
  });
  it('keeps hard pixel-art edges crisp', () => {
    const src = new Uint32Array(8 * 8).map((_, i) => ((i % 8) < 4 ? 0xff0000ff : 0xffffffff));
    const out = upscale4x(src, 8, 8);
    const row = [...out.slice(10 * 32, 11 * 32)];
    expect(new Set(row).size).toBe(2); // no blended in-between colours
  });
});
