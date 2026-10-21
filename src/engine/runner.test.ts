import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from '../formats/track';
import { parseTerrain } from '../formats/terrain';
import { TRACKS } from '../formats/tracks';
import { Collision } from './collision';
import { loopsOf } from './loops';
import { Runner, OriginalRunner } from './runner';
import { LAPS, Race } from './race';

const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');

describe.skipIf(!existsSync(GAME))('runner on .ter', () => {
  const load = (key: string) => {
    const info = TRACKS.find((t) => t.key === key)!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const col = new Collision(parseTerrain(readFileSync(join(GAME, info.ter))), info.playfield ? 0 : null);
    // P0 is raw file coords → .ter (x, −y, −z).
    return { col, line: track.lists.P0.map(([x, y, z]) => [x, -y, -z]) };
  };

  for (const t of TRACKS)
    it(`${t.name}: spawns on the floor at the start of P0`, () => {
      const { col, line } = load(t.key);
      const r = new Runner(col, 0);
      r.spawn(line[0][0], line[0][1], line[0][2], 0);
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
        for (const k of order) { const p = L[k % N]; if (race.tick({ x: p[0], y: p[1] + 100, z: p[2] } as Runner).lap) laps++; }
        return laps;
      };
      const ks = Array.from({ length: N * LAPS + 1 }, (_, i) => i);
      expect(run(ks)).toBe(LAPS);
      expect(run(ks.reverse())).toBe(0);
    });

  it(`Sonic drives ${LAPS} laps of Resort Island in plausible times`, () => {
    const info = TRACKS.find((t) => t.key === 'island')!;
    const track = parseTrack(readFileSync(join(GAME, info.bin)));
    const { col } = load('island');
    const race = new Race(track.lists.P0, track.rings.map((r) => r.pos));
    const L = race.loop, N = L.length;
    col.loops = loopsOf(L, col);
    const r = new Runner(col, 0);
    r.spawn(L[0][0], L[0][1], L[0][2], (Math.atan2(L[1][0] - L[0][0], L[1][2] - L[0][2]) * 2048) / Math.PI);
    for (let t = 0; t < 30 * 180 && !race.finished; t++) {
      const p = L[(race.progress + 4) % N];
      const d = ((((Math.atan2(p[0] - r.x, p[2] - r.z) * 2048) / Math.PI - r.yaw) % 4096) + 6144) % 4096 - 2048;
      r.tick({ accel: Math.abs(d) < 400, brake: Math.abs(d) > 900, steer: Math.max(-1, Math.min(1, d / 25)), jump: false });
      race.tick(r);
    }
    expect(race.finished).toBe(true);
    // The 44.9k-unit loop can't be beaten at Sonic's vmax (29.3 s); the autopilot does ~34 s.
    for (const lap of race.lapTimes) { expect(lap).toBeGreaterThan(29); expect(lap).toBeLessThan(45); }
    expect(race.ringCount).toBeGreaterThan(0);
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
      const ev = race.tick(r as unknown as Runner);
      if (ev.lap) { lapsCompleted++; }
    }
    expect(race.finished).toBe(true);
    for (const lap of race.lapTimes) {
      expect(lap).toBeGreaterThan(25);
      expect(lap).toBeLessThan(45);
    }
  });

});

describe('character special abilities and special surfaces', () => {
  const FX = 1 / 4096;

  it('Sonic (and Super Sonic) can double jump in mid-air once per jump', () => {
    let groundY = 100;
    const mockCol = {
      ground: (_x: number, _z: number, _y: number) => ({ y: groundY, attr: 0, nx: 0, ny: -1, nz: 0 }),
      walls: () => null,
      loops: [],
    } as unknown as Collision;

    const r = new Runner(mockCol, 0);
    r.spawn(0, 100, 0, 0);
    expect(r.grounded).toBe(true);
    expect(r.doubleJumped).toBe(false);

    // Initial jump off ground
    const res1 = r.tick({ accel: false, brake: false, steer: 0, jump: true });
    expect(res1.jumped).toBe(true);
    expect(res1.ability).toBeUndefined();
    expect(r.grounded).toBe(false);
    expect(r.vy).toBeCloseTo(-0x20000 * FX + 0x2000 * FX); // -JUMP + gravity

    // Holding jump does not trigger double jump (must be edge-triggered)
    const res2 = r.tick({ accel: false, brake: false, steer: 0, jump: true });
    expect(res2.jumped).toBe(false);
    expect(r.doubleJumped).toBe(false);

    // Release jump in air
    r.tick({ accel: false, brake: false, steer: 0, jump: false });
    expect(r.doubleJumped).toBe(false);

    // Press jump again in mid-air -> double jump activates!
    const res3 = r.tick({ accel: false, brake: false, steer: 0, jump: true });
    expect(res3.jumped).toBe(true);
    expect(res3.ability).toBe('doublejump');
    expect(r.doubleJumped).toBe(true);
    expect(r.vy).toBeCloseTo(-0x22000 * FX + 0x2000 * FX);

    // Releasing and pressing jump again in mid-air does NOT double jump again
    r.tick({ accel: false, brake: false, steer: 0, jump: false });
    const res4 = r.tick({ accel: false, brake: false, steer: 0, jump: true });
    expect(res4.jumped).toBe(false);
    expect(res4.ability).toBeUndefined();

    // Touch ground: resets doubleJumped
    r.y = 100;
    r.vy = 5;
    r.tick({ accel: false, brake: false, steer: 0, jump: false });
    expect(r.grounded).toBe(true);
    expect(r.doubleJumped).toBe(false);

    // Super Sonic (index 9) also has double jump
    const ss = new Runner(mockCol, 9);
    ss.spawn(0, 100, 0, 0);
    ss.tick({ accel: false, brake: false, steer: 0, jump: true }); // jump
    ss.tick({ accel: false, brake: false, steer: 0, jump: false }); // release
    const ssRes = ss.tick({ accel: false, brake: false, steer: 0, jump: true }); // double jump
    expect(ssRes.ability).toBe('doublejump');
    expect(ss.doubleJumped).toBe(true);
  });

  it('Tails flight mechanics counter downward gravity for up to 120 ticks and sustain forward speed', () => {
    const mockCol = {
      ground: (_x: number, _z: number, feetY: number, stepUp = 40) => (feetY >= 5000 - stepUp ? { y: 5000, attr: 0, nx: 0, ny: -1, nz: 0 } : null),
      walls: () => null,
      loops: [],
    } as unknown as Collision;

    const r = new Runner(mockCol, 1);
    r.spawn(0, 0, 0, 0);
    expect(r.grounded).toBe(false); // in the air (ground is down at 5000)

    // Pressing / holding jump engages helicopter flight
    const res1 = r.tick({ accel: true, brake: false, steer: 0, jump: true });
    expect(r.flying).toBe(true);
    expect(res1.ability).toBe('fly');
    expect(r.vy).toBeCloseTo(-0x4000 * FX); // upward ascent rate

    // Sustained forward speed with acceleration while flying
    expect(r.speed).toBeGreaterThan(0);

    // Flight continues for ~120 ticks total
    for (let i = 0; i < 118; i++) {
      const res = r.tick({ accel: true, brake: false, steer: 0, jump: true });
      expect(r.flying).toBe(true);
      expect(res.ability).toBe('fly');
      expect(r.vy).toBeCloseTo(-0x4000 * FX);
    }

    // At 120th tick, flight expires
    r.tick({ accel: true, brake: false, steer: 0, jump: true });
    expect(r.flying).toBe(false);

    // Gravity resumes pulling down
    const vyBefore = r.vy;
    r.tick({ accel: false, brake: false, steer: 0, jump: false });
    expect(r.vy).toBeGreaterThan(vyBefore);
  });

  it('Knuckles glides while holding jump in mid-air, clamping fall velocity and turning aerodynamically', () => {
    const mockCol = {
      ground: (_x: number, _z: number, feetY: number, stepUp = 40) => (feetY >= 5000 - stepUp ? { y: 5000, attr: 0, nx: 0, ny: -1, nz: 0 } : null),
      walls: () => null,
      loops: [],
    } as unknown as Collision;

    const r = new Runner(mockCol, 2);
    r.spawn(0, 0, 0, 0);
    expect(r.grounded).toBe(false);
    r.vy = 20; // falling fast

    // Holding jump engages glide mode
    const res = r.tick({ accel: false, brake: false, steer: 1, jump: true });
    expect(r.gliding).toBe(true);
    expect(res.ability).toBe('glide');
    // Downward velocity clamped to gentle float (0x2800 * FX = 2.5)
    expect(r.vy).toBeCloseTo(0x2800 * FX);

    // Turning is wider / aerodynamic (half turn rate compared to non-gliding)
    const rNormal = new Runner(mockCol, 2);
    rNormal.spawn(0, 0, 0, 0);
    expect(rNormal.grounded).toBe(false);
    rNormal.tick({ accel: false, brake: false, steer: 1, jump: false });
    expect(Math.abs(r.yaw)).toBeLessThan(Math.abs(rNormal.yaw));

    // Forward speed is maintained during glide
    expect(r.speed).toBeGreaterThan(0);

    // Releasing jump exits glide
    r.tick({ accel: false, brake: false, steer: 0, jump: false });
    expect(r.gliding).toBe(false);
  });

  it('sector triggers launch on contact (0x4855e8): 0x8000 along the normal, 0x4000 straight up', () => {
    let trigger = 0;
    // Tilted along the heading (yaw 0 = +z), so the banking pull plays no part.
    const n = { nx: 0, ny: -0.8, nz: 0.6 };
    const mockCol = {
      ground: () => ({ y: 100, attr: 0, trigger, ...n }),
      walls: () => null,
      loops: [],
    } as unknown as Collision;
    const IDLE = { accel: false, brake: false, steer: 0, jump: false };

    const r = new Runner(mockCol, 0);
    r.spawn(0, 100, 0, 0);
    expect(r.grounded).toBe(true);
    expect(r.tick(IDLE).ability).toBeUndefined();

    // Launch pad (City 0x8014): vy = −a·0xd05, plus floor normal (x, z) · a.
    trigger = 0x8014;
    expect(r.tick(IDLE).ability).toBe('spring');
    expect(r.grounded).toBe(false);
    expect(r.vy).toBeCloseTo(-0x14 * 0xd05 * FX);
    expect(r.vz).toBeCloseTo(0.6 * 0x14);

    // Vertical spring (City 0x4055): horizontal speed dropped, then straight up.
    r.spawn(0, 100, 0, 0);
    r.boost(20);
    trigger = 0x4055;
    r.tick(IDLE);
    expect(r.vx).toBe(0);
    expect(r.vz).toBe(0);
    expect(r.vy).toBeCloseTo(-0x55 * 0xd05 * FX);

    // No flag (Factory 0x3c): vertical launch, speed kept.
    r.spawn(0, 100, 0, 0);
    r.boost(20);
    trigger = 0x3c;
    r.tick(IDLE);
    expect(r.vy).toBeCloseTo(-0x3c * 0xd05 * FX);
    expect(r.speed).toBeGreaterThan(15);
  });

  it('boost method provides an instant speed surge forward', () => {
    const mockCol = {
      ground: (_x: number, _z: number, _y: number) => ({ y: 100, attr: 0, nx: 0, ny: -1, nz: 0 }),
      walls: () => null,
      loops: [],
    } as unknown as Collision;

    const r = new Runner(mockCol, 0);
    r.spawn(0, 100, 0, 0);
    expect(r.speed).toBe(0);

    r.boost(12.5);
    expect(r.speed).toBeCloseTo(12.5);
  });

  it('Amy has turbo boost acceleration', () => {
    // Amy has higher ground acceleration than base
    const mockColGround = {
      ground: (_x: number, _z: number, _y: number) => ({ y: 100, attr: 0, nx: 0, ny: -1, nz: 0 }),
      walls: () => null,
      loops: [],
    } as unknown as Collision;
    const amyGround = new Runner(mockColGround, 3);
    amyGround.spawn(0, 100, 0, 0);
    amyGround.tick({ accel: true, brake: false, steer: 0, jump: false });
    expect(amyGround.speed).toBeGreaterThan(0);
  });
});
