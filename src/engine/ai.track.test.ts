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
import { calculateGridSlot, createBot, updateBotInput, aiLine } from './ai';
import { startSlot } from './original';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

describe.skipIf(!existsSync(GAME))('CPU rivals on the real tracks', () => {
  for (const t of TRACKS)
    it(`${t.name}: rivals from all grid slots finish ${LAPS} laps`, () => {
      const track = parseTrack(readFileSync(join(GAME, t.bin)));
      const col = new Collision(parseTerrain(readFileSync(join(GAME, t.ter))), t.playfield ? 0 : null, t.id);
      const s0 = startSlot(track.lists.P4, t.id, 0);
      const race = new Race(track.lists.P0, track.rings.map((r) => r.pos), s0, t.route);
      let loop = race.loop;
      if (t.ai) {
        loop = aiLine(readFileSync(join(GAME, t.ai)), col, loop, s0);
      }
      col.loops = loopsOf(loop, col);
      const bots = [1, 2, 3].map((slot) => {
        const b = createBot(col, slot - 1, `b${slot}`, `b${slot}`, slot === 1 ? -20 : slot === 2 ? 20 : 0, 0.95, race.rings);
        const s = startSlot(track.lists.P4, t.id, slot);
        b.runner.spawn(s.x, s.y, s.z, s.yaw, s.pri);
        return b;
      });
      for (let tick = 0; tick < 30 * 300 && !bots.every((b) => b.finished); tick++)
        for (const b of bots) b.runner.tick(updateBotInput(b, loop, tick / 30));
      const report = bots.map((b) => `${b.name}: lap ${b.lap} p${b.progress}/${loop.length} t=${b.finishTime.toFixed(1)}`);
      console.log(t.name, report.join(' | '));
      for (const b of bots) expect(b.finished, report.join('\n')).toBe(true);
    }, 60000);

  it('Resort Island: bot using OriginalRunner finishes 3 laps', () => {
    const info = TRACKS.find((t) => t.key === 'island')!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const col = new Collision(parseTerrain(readFileSync(join(GAME, info.ter))), 0);
    const loop = new Race(track.lists.P0, []).loop;
    col.loops = loopsOf(loop, col);
    const b = createBot(col, 0, 'sonic', 'Sonic', 0, 0.95);
    expect(b.runner).toBeInstanceOf(OriginalRunner);
    const s = calculateGridSlot(loop, 1);
    b.runner.spawn(s.x, s.y, s.z, s.yaw);
    for (let tick = 0; tick < 30 * 200 && !b.finished; tick++) {
      b.runner.tick(updateBotInput(b, loop, tick / 30));
    }
    expect(b.finished).toBe(true);
    expect(b.lap).toBe(4);
  });

  // C5: Ruin p21–52 is the climb where the approximated Runner's flight (rising for 120 ticks
  // after any tap) carried Tails ~700 above the line. The original only hovers while jump is held.
  it('Regal Ruin: Tails finishes 3 laps with no rescue on p21–52', () => {
    const info = TRACKS.find((t) => t.key === 'ruin')!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const col = new Collision(parseTerrain(readFileSync(join(GAME, info.ter))), 0, info.id);
    const loop = new Race(track.lists.P0, []).loop;
    const b = createBot(col, 1, 'tails', 'Tails', 0, 0.95);
    expect(b.runner).toBeInstanceOf(OriginalRunner);
    const s = calculateGridSlot(loop, 1);
    b.runner.spawn(s.x, s.y, s.z, s.yaw);
    const rescuedAt: number[] = [];
    for (let tick = 0; tick < 30 * 300 && !b.finished; tick++) {
      const before = b.rescues, at = b.progress;
      b.runner.tick(updateBotInput(b, loop, tick / 30));
      if (b.rescues > before) rescuedAt.push(at);
    }
    expect(b.finished, `lap ${b.lap} p${b.progress}`).toBe(true);
    expect(b.lap).toBe(4);
    expect(rescuedAt.filter((p) => p >= 21 && p <= 52)).toEqual([]);
  }, 60_000);
});
