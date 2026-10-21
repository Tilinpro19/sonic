import { describe, expect, it } from 'vitest';
import { LAPS, Race, mainLoop } from './race';
import type { OriginalRunner } from './runner';

type V3 = [number, number, number];
// Synthetic race line: a circle of radius 5000 (raw file coords, Y up), closed back onto P0[0],
// followed by a loose piece far away that must be ignored.
const N = 200;
const circle = (i: number): V3 => [Math.cos((i / N) * 2 * Math.PI) * 5000, 100, Math.sin((i / N) * 2 * Math.PI) * 5000];
const p0: V3[] = [...Array.from({ length: N + 1 }, (_, i) => circle(i % N)), [90000, 0, 90000], [91000, 0, 90000]];
const at = (i: number) => { const [x, y, z] = circle(((i % N) + N) % N); return { x, y: -y + 100, z: -z } as OriginalRunner; };

describe('race rules', () => {
  it('main loop stops at the first return to the start', () => {
    expect(mainLoop(p0)).toHaveLength(N);
  });

  it(`counts ${LAPS} laps and stops the clock at the finish`, () => {
    const race = new Race(p0, []);
    let laps = 0;
    for (let i = 0; i <= N * LAPS; i++) if (race.tick(at(i)).lap) laps++;
    expect(laps).toBe(LAPS);
    expect(race.finished).toBe(true);
    expect(race.lapTimes).toHaveLength(LAPS);
    const t = race.time;
    race.tick(at(5));
    expect(race.time).toBe(t);
  });

  it('does not count a lap when driving backwards over the line', () => {
    const race = new Race(p0, []);
    for (let i = 0; i > -N * LAPS * 2; i--) expect(race.tick(at(i)).lap).toBe(false);
    expect(race.lap).toBe(1);
  });

  it('collects each ring once, near the body', () => {
    const [x, y, z] = circle(10);
    // Ring in loader space (Z already negated, Y up), 60 units above the floor point.
    const race = new Race(p0, [[x, y - 100 + 60, -z], [x, y + 2000, -z]]);
    expect(race.tick(at(10)).rings).toBe(1);
    expect(race.tick(at(10)).rings).toBe(0);
    expect(race.ringCount).toBe(1);
    expect(race.ringAge(0)).toBeGreaterThan(0);
    expect(race.ringAge(1)).toBe(-1);
  });
});
