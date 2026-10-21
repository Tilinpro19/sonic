import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from '../formats/track';
import { parseTerrain } from '../formats/terrain';
import { TRACKS } from '../formats/tracks';
import { Collision } from './collision';
import { FixedStep } from './clock';
import { OriginalRunner, type Input } from './runner';

const RATES = [30, 60, 144, 240];
/** Frame deltas as rAF would give them: differences of whole-µs timestamps. */
const frames = (hz: number, seconds: number) =>
  Array.from({ length: Math.round(hz * seconds) }, (_, k) => (Math.round(((k + 1) * 1e6) / hz) - Math.round((k * 1e6) / hz)) / 1e6);

describe('FixedStep', () => {
  for (const hz of RATES)
    it(`${hz} Hz runs exactly 30 ticks per second`, () => {
      const c = new FixedStep();
      let n = 0;
      for (const dt of frames(hz, 20)) {
        n += c.advance(dt);
        expect(c.alpha).toBeGreaterThanOrEqual(0);
        expect(c.alpha).toBeLessThan(1);
      }
      expect(n).toBe(600);
    });

  it('drops time after a long stall instead of fast-forwarding', () => {
    const c = new FixedStep();
    expect(c.advance(5)).toBe(7);
    expect(c.alpha).toBeGreaterThanOrEqual(0);
    expect(c.alpha).toBeLessThan(1);
  });
});

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

describe.skipIf(!existsSync(GAME))('game speed is independent of the frame rate', () => {
  if (!existsSync(GAME)) return;
  const info = TRACKS.find((t) => t.key === 'island')!;
  const col = new Collision(parseTerrain(readFileSync(join(GAME, info.ter))), info.playfield ? 0 : null);
  const p0 = parseTrack(readFileSync(join(GAME, info.bin))).lists.P0;
  // Scripted input as a function of the tick number, like a replay.
  const input = (t: number): Input => ({ accel: t % 200 < 170, brake: t % 200 >= 185, steer: Math.sin(t / 40) * 0.6, jump: t % 90 === 45 });

  const run = (hz: number) => {
    const r = new OriginalRunner(col, 0);
    r.spawn(p0[0][0], -p0[0][1], -p0[0][2], 0);
    const c = new FixedStep();
    let t = 0;
    for (const dt of frames(hz, 15)) for (let n = c.advance(dt); n > 0; n--) r.tick(input(t++));
    return { t, x: r.x, y: r.y, z: r.z, speed: r.speed };
  };

  it('Island: 15 s of driving ends in the same state at 30, 60, 144 and 240 Hz', () => {
    const ref = run(30);
    expect(ref.t).toBe(450);
    expect(Math.hypot(ref.x - p0[0][0], ref.z + p0[0][2])).toBeGreaterThan(1000); // it actually moved
    for (const hz of RATES.slice(1)) expect(run(hz)).toEqual(ref);
  });
});
