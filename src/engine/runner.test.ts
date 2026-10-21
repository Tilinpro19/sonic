import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from '../formats/track';
import { parseTerrain } from '../formats/terrain';
import { TRACKS } from '../formats/tracks';
import { Collision } from './collision';
import { loopsOf } from './loops';
import { OriginalRunner } from './runner';
import { LAPS, Race } from './race';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

describe.skipIf(!existsSync(GAME))('runner on .ter', () => {
  const load = (key: string) => {
    const info = TRACKS.find((t) => t.key === key)!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const col = new Collision(parseTerrain(readFileSync(join(GAME, info.ter))), info.playfield ? 0 : null, info.id);
    // P0 is raw file coords → .ter (x, −y, −z).
    return { col, line: track.lists.P0.map(([x, y, z]) => [x, -y, -z]) };
  };

  for (const t of TRACKS)
    it(`${t.name}: lands on the floor at the start of P0`, () => {
      const { col, line } = load(t.key);
      const r = new OriginalRunner(col, 0);
      r.spawn(line[0][0], line[0][1], line[0][2], 0);
      // The original physics drops the racer under gravity until it touches the floor.
      for (let t = 0; t < 60 && !r.grounded; t++) r.tick({ accel: false, brake: false, steer: 0, jump: false });
      expect(r.grounded).toBe(true);
      expect(r.y - line[0][1]).toBeGreaterThan(0); // floor is below the line (Y down)
      expect(r.y - line[0][1]).toBeLessThan(400);
    });

  for (const t of TRACKS)
    it(`${t.name}: a ghost along the main loop scores ${LAPS} laps forwards, none backwards`, () => {
      const p0 = parseTrack(readFileSync(join(GAME, t.bin))).lists.P0;
      const L = new Race(p0, []).loop, N = L.length;
      const run = (order: number[]) => {
        const race = new Race(p0, []);
        let laps = 0;
        for (const k of order) { const p = L[k % N]; if (race.tick({ x: p[0], y: p[1] + 100, z: p[2] } as OriginalRunner).lap) laps++; }
        return laps;
      };
      const ks = Array.from({ length: N * LAPS + 1 }, (_, i) => i);
      expect(run(ks)).toBe(LAPS);
      expect(run(ks.reverse())).toBe(0);
    });

  it('OriginalRunner drives 3 laps of Resort Island using bit-exact physics', () => {
    const info = TRACKS.find((t) => t.key === 'island')!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const { col } = load('island');
    const race = new Race(track.lists.P0, track.rings.map((r) => r.pos));
    const L = race.loop, N = L.length;
    col.loops = loopsOf(L, col);
    const r = new OriginalRunner(col, 0);
    r.spawn(L[0][0], L[0][1], L[0][2], (Math.atan2(L[1][0] - L[0][0], L[1][2] - L[0][2]) * 2048) / Math.PI);
    let lapsCompleted = 0;
    for (let t = 0; t < 30 * 180 && !race.finished; t++) {
      const p = L[(race.progress + 4) % N];
      const d = ((((Math.atan2(p[0] - r.x, p[2] - r.z) * 2048) / Math.PI - r.yaw) % 4096) + 6144) % 4096 - 2048;
      r.tick({ accel: Math.abs(d) < 400, brake: Math.abs(d) > 900, steer: Math.max(-1, Math.min(1, d / 25)), jump: false });
      const ev = race.tick(r);
      if (ev.lap) { lapsCompleted++; }
    }
    expect(race.finished).toBe(true);
    for (const lap of race.lapTimes) {
      expect(lap).toBeGreaterThan(25);
      expect(lap).toBeLessThan(45);
    }
  });

});
