import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from '../formats/track';
import { parseTerrain } from '../formats/terrain';
import { TRACKS } from '../formats/tracks';
import { Collision } from './collision';
import { Race } from './race';
import { createBot, updateBotInput, type BotState } from './ai';
import { startSlot } from './original';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

/** One CPU racer from grid slot 0 for 3 laps; per tick: P0 index, rescue, distance moved. */
function race(key: string, char: number) {
  const t = TRACKS.find((x) => x.key === key)!;
  const track = parseTrack(readFileSync(join(GAME, t.bin)));
  const col = new Collision(parseTerrain(readFileSync(join(GAME, t.ter))), t.playfield ? 0 : null, t.id);
  const s = startSlot(track.lists.P4, t.id, 0);
  const loop = new Race(track.lists.P0, [], s, t.route).loop;
  // Loop index → P0 index (the loop starts at the grid; Ruin has no route, so P0 = unrotated loop).
  const p0 = new Race(track.lists.P0, []).loop, off = p0.findIndex((q) => q[0] === loop[0][0] && q[2] === loop[0][2]);
  const b: BotState = createBot(col, char, 'b', 'b', 0, 0.95);
  b.runner.spawn(s.x, s.y, s.z, s.yaw, s.pri);
  const ticks: { p: number; prog: number; rescued: boolean; step: number }[] = [];
  for (let tick = 0; tick < 30 * 400 && !b.finished; tick++) {
    const { x, y, z } = b.runner, r0 = b.rescues;
    b.runner.tick(updateBotInput(b, loop, tick / 30));
    const step = Math.hypot(b.runner.x - x, b.runner.y - y, b.runner.z - z);
    ticks.push({ p: (b.progress + off) % loop.length, prog: b.progress, rescued: b.rescues > r0, step });
  }
  return { b, ticks, N: loop.length };
}

describe.skipIf(!existsSync(GAME))('C6: trajectories on the real tracks', () => {
  // Emerald's loop runs through its branches (TrackInfo.route): no teleports, so the racer moves
  // at most its speed per tick, its progress never skips ahead, and it never needs a rescue.
  for (const [char, name] of [[0, 'Sonic'], [1, 'Tails']] as const)
    it(`Radical Emerald: ${name} laps the route with no jump, skip or rescue`, () => {
      const { b, ticks, N } = race('emerald', char);
      expect(b.finished).toBe(true);
      expect(ticks.filter((k) => k.rescued)).toEqual([]);
      expect(Math.max(...ticks.map((k) => k.step))).toBeLessThan(100);
      const skips = ticks.flatMap((k, i) => { const d = (k.prog - (ticks[i - 1]?.prog ?? 0) + N) % N; return i && d > 4 && d < N - 4 ? [k.prog] : []; });
      expect(skips).toEqual([]);
    }, 120_000);

  // Ruin p323–340: past the crest at p322 the line is the original AI's jump, up to 500 over the
  // dip. Measured against the road under it (ai.ts surfacesOf) the bot keeps going, crosses the
  // dip and takes off from its lip; measured against the line it braked to a stop at p331–333.
  for (const [char, name] of [[0, 'Sonic'], [1, 'Tails']] as const)
    it(`Regal Ruin: ${name} crosses the jump at p318–342 every lap, in order and without rescue`, () => {
      const { b, ticks } = race('ruin', char);
      expect(b.finished).toBe(true);
      const arc = ticks.map((k, i) => ({ ...k, i })).filter((k) => k.p >= 318 && k.p <= 342);
      expect(arc.filter((k) => k.rescued)).toEqual([]);
      // Three passes, each moving forward along P0 and taking under 5 s.
      const passes: (typeof arc)[] = [];
      for (const k of arc) (passes.length && k.i === passes[passes.length - 1].at(-1)!.i + 1 ? passes[passes.length - 1] : (passes.push([]), passes[passes.length - 1])).push(k);
      expect(passes).toHaveLength(3);
      for (const pass of passes) {
        expect(pass.length).toBeLessThan(150);
        expect(pass.every((k, j) => !j || (k.p >= pass[j - 1].p && k.p - pass[j - 1].p <= 4))).toBe(true);
        expect(pass.at(-1)!.p).toBe(342);
      }
    }, 120_000);
});
