import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from '../formats/track';
import { parseTerrain } from '../formats/terrain';
import { TRACKS } from '../formats/tracks';
import { Collision } from './collision';
import { Race } from './race';
import { sinLut, startSlot } from './original';
import { OriginalRunner } from './runner';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

// C7: start grid 0x47108c. Racer i stands on P4[[7, 6, 8, 5, 9][i]] with the stage's heading and
// floor layer from 0x4feb00; stage ids follow the exe (Factory 3, Ruin 4).
describe('start grid (0x47108c)', () => {
  it('slot order, coordinates and per-stage heading', () => {
    const p4 = Array.from({ length: 11 }, (_, i) => [i * 10, i * 100, i * 1000]);
    expect([0, 1, 2, 3, 4].map((s) => startSlot(p4, 1, s).x)).toEqual([70, 60, 80, 50, 90]);
    expect(startSlot(p4, 1, 0)).toEqual({ x: 70, y: -700, z: -7000, yaw: 3072, pri: 0 });
    expect([1, 2, 3, 4, 5].map((t) => [startSlot(p4, t, 0).yaw, startSlot(p4, t, 0).pri]))
      .toEqual([[3072, 0], [3648, 2], [3072, 0], [0, 0], [2560, 2]]);
  });

  it.skipIf(!existsSync(GAME)).each(TRACKS)('$name: all five slots on the floor, facing down the line', (t) => {
    const track = parseTrack(readFileSync(join(GAME, t.bin)));
    const col = new Collision(parseTerrain(readFileSync(join(GAME, t.ter))), t.playfield ? 0 : null, t.id);
    const s0 = startSlot(track.lists.P4, t.id, 0);
    const loop = new Race(track.lists.P0, [], s0).loop;
    for (let slot = 0; slot < 5; slot++) {
      const s = startSlot(track.lists.P4, t.id, slot);
      const r = new OriginalRunner(col, 0);
      r.spawn(s.x, s.y, s.z, s.yaw, s.pri);
      expect(r.grounded).toBe(true);
      expect(Math.abs(r.y - s.y)).toBeLessThan(16);
      expect(r.orig.pri).toBe(s.pri);
      // Nearest race-line point: within 500 units, and the heading runs along the line there.
      let i = 0, best = Infinity;
      loop.forEach(([x, , z], k) => { const d = Math.hypot(x - s.x, z - s.z); if (d < best) { best = d; i = k; } });
      expect(best).toBeLessThan(500);
      const a = loop[i], b = loop[(i + 2) % loop.length];
      const tx = b[0] - a[0], tz = b[2] - a[2];
      const cos = (sinLut[s.yaw] * tx + sinLut[s.yaw + 1024] * tz) / 16384 / Math.hypot(tx, tz);
      expect(cos).toBeGreaterThan(0.99);
    }
    // The lap starts at the grid: P1 is next to loop[0].
    expect(Math.hypot(loop[0][0] - s0.x, loop[0][2] - s0.z)).toBeLessThan(300);
  });
});
