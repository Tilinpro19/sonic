import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from '../formats/track';
import { parseTerrain } from '../formats/terrain';
import { TRACKS } from '../formats/tracks';
import { Collision } from './collision';
import { Race } from './race';
import { loopsOf } from './loops';
import { Runner } from './runner';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

describe.skipIf(!existsSync(GAME))('loops and tubes on the real tracks', () => {
  const load = (key: string) => {
    const t = TRACKS.find((x) => x.key === key)!;
    const col = new Collision(parseTerrain(readFileSync(join(GAME, t.ter))), t.playfield ? 0 : null);
    const loop = new Race(parseTrack(readFileSync(join(GAME, t.bin))).lists.P0, []).loop;
    col.loops = loopsOf(loop, col);
    return { col, loop };
  };

  it('finds exactly Island\'s loop, Ruin\'s tube and Factory\'s loop (not springs or jump gaps)', () => {
    const found = Object.fromEntries(TRACKS.map((t) => {
      const { col, loop } = load(t.key);
      return [t.key, col.loops.map((l) => [loop.indexOf(l.pts[0] as typeof loop[0]), loop.indexOf(l.pts[l.pts.length - 1] as typeof loop[0])])];
    }));
    expect(found).toEqual({ island: [[220, 232]], city: [], ruin: [[244, 306]], factory: [[71, 83]], emerald: [] });
  });

  for (const [key, from, past] of [['island', 214, 236], ['ruin', 238, 310]] as const)
    it(`${key}: Sonic at full speed is carried through and comes out on the floor past p${past}`, () => {
      const { col, loop } = load(key);
      const r = new Runner(col, 0);
      const p = loop[from], q = loop[from + 1];
      const yaw = ((Math.atan2(q[0] - p[0], q[2] - p[2]) * 2048) / Math.PI + 4096) % 4096;
      r.spawn(p[0], p[1], p[2], yaw);
      r.vx = Math.sin((yaw * Math.PI) / 2048) * r.vmax;
      r.vz = Math.cos((yaw * Math.PI) / 2048) * r.vmax;
      let rode = false;
      for (let t = 0; t < 200 && (r.ride || !rode); t++) {
        r.tick({ accel: true, brake: false, steer: 0, jump: false });
        rode ||= !!r.ride;
      }
      expect(rode).toBe(true);
      const end = loop[past];
      expect(Math.hypot(r.x - end[0], r.z - end[2])).toBeLessThan(600);
      expect(r.grounded).toBe(true);
      expect(Math.hypot(r.vx, r.vz)).toBeGreaterThan(r.vmax * 0.6); // the ride keeps the speed
    });
});
