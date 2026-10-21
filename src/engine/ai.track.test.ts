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
import { calculateGridSlot, createBot, updateBotInput } from './ai';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

describe.skipIf(!existsSync(GAME))('CPU rivals on the real tracks', () => {
  for (const t of TRACKS)
    it(`${t.name}: rivals from all grid slots finish ${LAPS} laps`, () => {
      const track = parseTrack(readFileSync(join(GAME, t.bin)));
      const col = new Collision(parseTerrain(readFileSync(join(GAME, t.ter))), t.playfield ? 0 : null);
      const loop = new Race(track.lists.P0, []).loop;
      const bots = [1, 2, 3].map((slot) => {
        const b = createBot(col, slot - 1, `b${slot}`, `b${slot}`, slot === 1 ? -20 : slot === 2 ? 20 : 0);
        const s = calculateGridSlot(loop, slot);
        b.runner.spawn(s.x, s.y, s.z, s.yaw);
        return b;
      });
      for (let tick = 0; tick < 30 * 300 && !bots.every((b) => b.finished); tick++)
        for (const b of bots) b.runner.tick(updateBotInput(b, loop, tick / 30));
      const report = bots.map((b) => `${b.name}: lap ${b.lap} p${b.progress}/${loop.length} t=${b.finishTime.toFixed(1)}`);
      console.log(t.name, report.join(' | '));
      for (const b of bots) expect(b.finished, report.join('\n')).toBe(true);
    });

  it('Resort Island: bot using OriginalRunner finishes 3 laps', () => {
    const info = TRACKS.find((t) => t.key === 'island')!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const col = new Collision(parseTerrain(readFileSync(join(GAME, info.ter))), 0);
    const loop = new Race(track.lists.P0, []).loop;
    col.loops = loopsOf(loop, col);
    const b = createBot(col, 0, 'sonic', 'Sonic', 0, 0.95, true);
    expect(b.runner).toBeInstanceOf(OriginalRunner);
    const s = calculateGridSlot(loop, 1);
    b.runner.spawn(s.x, s.y, s.z, s.yaw);
    for (let tick = 0; tick < 30 * 200 && !b.finished; tick++) {
      b.runner.tick(updateBotInput(b, loop, tick / 30));
    }
    expect(b.finished).toBe(true);
    expect(b.lap).toBe(4);
  });
});
