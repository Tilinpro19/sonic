import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IN, OrigTerrain, collideRacers, hitRadius, newRacer, racerCollision, ringDashFor, sinLut, tick, updateWater, PHYS_TABLE, physicsTick, type OrigRacer } from './original';
import { parseTrack } from '../formats/track';

const ROOT = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');
const GOLDEN = resolve(ROOT, '../../tools/golden');

describe.skipIf(!existsSync(join(GOLDEN, 'trig_0x92568c_32k.bin')))('sine LUT', () => {
  it('matches the table dumped from the running game', () => {
    const dump = new Int32Array(readFileSync(join(GOLDEN, 'trig_0x92568c_32k.bin')).buffer.slice(0, 5120 * 4));
    expect(Array.from(sinLut)).toEqual(Array.from(dump));
  });
});

const recFile = existsSync(GOLDEN) ? readdirSync(GOLDEN).find((f) => f.startsWith('p1_struct_')) : undefined;

/**
 * Golden recording: samples of the player-1 struct (0x71c B) + 8 B of input words, taken at ~30 Hz
 * but not in step with the tick. Consecutive ticks are the pairs where sample i+1's previous
 * position (+20…+28) equals sample i's position; the input stored with sample i+1 is the one that
 * tick used. Water level (+68) is set before physics by 0x481a2c, so it is taken from i+1 too.
 */
describe.skipIf(!recFile || !existsSync(join(ROOT, 'bin/extras/island.ter')))('bit-exact tick vs the golden recording', () => {
  if (!recFile || !existsSync(join(ROOT, 'bin/extras/island.ter'))) return;
  const buf = readFileSync(join(GOLDEN, recFile!));
  const REC = 0x71c + 8, N = Math.floor(buf.length / REC);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const i32 = (i: number, o: number) => dv.getInt32(i * REC + o, true);
  const i16 = (i: number, o: number) => dv.getInt16(i * REC + o, true);
  const ter = new OrigTerrain(readFileSync(join(ROOT, 'bin/extras/island.ter')), 1);
  const mapPath = join(ROOT, 'island/island.map');
  const plyPath = join(ROOT, 'island/island.ply');
  if (existsSync(mapPath) && existsSync(plyPath)) {
    ter.playfieldWater = {
      map: readFileSync(mapPath),
      ply: readFileSync(plyPath),
      bounds: { x0: -476.80249, z0: 543.5865, x1: 631.40845, z1: -564.6245, s: 25 },
    };
  }
  const track = parseTrack(readFileSync(join(ROOT, 'island/island_e.bin')));
  ter.ringDash = ringDashFor(1, track.meshes, track.p6);

  const racer = (i: number): OrigRacer => ({
    char: i16(i, 0xf2), x: i32(i, 0), y: i32(i, 4), z: i32(i, 8), yaw: i32(i, 0x10),
    px: i32(i, 0x20), py: i32(i, 0x24), pz: i32(i, 0x28), dy: 0,
    vx: i32(i, 0x2c), vy: i32(i, 0x30), vz: i32(i, 0x34), floorY: i32(i, 0x38), fwd: i32(i, 0x44), lat: i32(i, 0x48),
    water: i32(i, 0x68), drift: i16(i, 0x6c), driftDir: i16(i, 0x6e), grounded: i16(i, 0x72), dash: i16(i, 0x78), dashEnd: i16(i, 0x7c),
    air: i16(i, 0x96), pri: i32(i, 0xa4), sector: i32(i, 0xa8), quad: i32(i, 0xac), hasFloor: i16(i, 0xb0),
    prevHasFloor: i16(i, 0xb2),
    n: [i16(i, 0xb4), i16(i, 0xb6), i16(i, 0xb8)], hitWall: i16(i, 0xba), rings: i16(i, 0x18), camber: i16(i, 0xde),
    alt40: i16(i, 0x40), slide42: i16(i, 0x42), jumpState: i16(i, 0x74), hasJumped: i16(i, 0x76), spin: i16(i, 0x86), special: i16(i, 0xfe),
    boostTimer: i16(i, 0x7e),
  });
  /**
   * The ring dash runs in the object pass 0x47f76c, once per rendered frame: when the game fits two
   * physics ticks in one frame, one of them leaves +78 unchanged (1116 and 1125). A fixed 30 Hz port
   * steps it every tick, so those two ticks are not comparable.
   */
  const dashStalled = (i: number) => i16(i, 0x78) !== 0 && i16(i, 0x78) === i16(i + 1, 0x78);
  const fields = (r: OrigRacer) => [r.x, r.y, r.z, r.yaw, r.vx, r.vy, r.vz, r.fwd, r.lat, r.grounded, ...r.n, r.camber];
  const same = (a: OrigRacer, b: OrigRacer) => fields(a).every((v, k) => v === fields(b)[k]);
  /**
   * The recording holds only player 1, so a racer-vs-racer hit (0x4201a0, run after everyone's
   * physics) shows up as a tick where only vx/vz are off. The push P1 takes is −(c·20) >> 3 per axis
   * (k = 20 at racing speed) with c = separation/8: when the residual left after the 14/16 damping
   * can be written that way, a rival moving alongside at separation 8c is rebuilt and the ported
   * collision must reproduce the recorded tick exactly, with the contact inside the hit radius of
   * a size-44 rival (Amy or Robotnik: 17 + 38).
   */
  const rivalHit = (r: OrigRacer, after: OrigRacer) => {
    const sep = (v: number, rec: number) => {
      const p = -(rec - Math.trunc((v * 14) / 16));
      const c = Math.ceil(p / 2.5);
      return Math.floor(2.5 * c) === p ? c * 8 : undefined;
    };
    const dx = sep(r.vx, after.vx), dz = sep(r.vz, after.vz);
    if (dx === undefined || dz === undefined) return false;
    const a = { ...r, n: [...r.n] as OrigRacer['n'] };
    const b = { ...r, n: [...r.n] as OrigRacer['n'], char: 3, x: r.x + dx, px: r.px + dx, z: r.z + dz, pz: r.pz + dz };
    return racerCollision(a, b) && same(a, after);
  };

  it('Island: ≥ 97 % of the recorded ticks match in every field', () => {
    let n = 0, ok = 0, hits = 0;
    for (let i = 0; i + 1 < N; i++) {
      const consecutive = i32(i + 1, 0x20) === i32(i, 0) && i32(i + 1, 0x24) === i32(i, 4) && i32(i + 1, 0x28) === i32(i, 8);
      if (!consecutive || buf.subarray(i * REC, i * REC + 0x71c).equals(buf.subarray((i + 1) * REC, (i + 1) * REC + 0x71c))) continue;
      // Not ported: loop rides (+a0), spin dash (+86), jumps (jump pressed on the ground).
      const inp = dv.getUint16((i + 1) * REC + 0x71c, true);
      if (i16(i, 0xa0) || i16(i + 1, 0xa0) || i16(i, 0x86)) continue;
      if (dashStalled(i)) continue;
      const r = racer(i), after = racer(i + 1);
      tick(ter, r, inp);
      n++;
      if (same(r, after)) ok++;
      else if (rivalHit(r, after)) { ok++; hits++; }
    }
    expect(n).toBeGreaterThan(1700);
    // 1726 / 1777 on 21-10-2026; 1764 / 1777 with the ring dash (0x47f1fc) and the jump
    // fields (+76, +fe, +7e). Jumps (7 ticks) all match. Racer-vs-racer: ticks 734, 1018 and
    // 1019 (only vx/vz off) → 1767. The 10 left move the position, which 0x4201a0 never does.
    expect(hits).toBe(3);
    expect(ok).toBeGreaterThanOrEqual(1767);
  });

  it('Island: the ring dash pad triggers and pays 50 rings exactly as recorded', () => {
    // Samples 1081 → 1083 skip one tick (its input is not stored; the next one, 0x9000, fits).
    const r = racer(1081);
    expect(r.rings).toBe(59);
    tick(ter, r, 0x9000);
    tick(ter, r, dv.getUint16(1083 * REC + 0x71c, true));
    expect([...fields(r), r.dash, r.dashEnd, r.rings]).toEqual([...fields(racer(1083)), 6, 150, 9]);
  });

  it('Island: free-running from the recording stays exact for whole stretches', () => {
    // Runs of consecutive samples: start from the first and feed only the recorded inputs.
    let ticks = 0, exact = 0, longest = 0;
    for (let i = 0; i + 1 < N; ) {
      let j = i;
      while (j + 1 < N && i32(j + 1, 0x20) === i32(j, 0) && i32(j + 1, 0x28) === i32(j, 8) && !i16(j, 0xa0) && !i16(j + 1, 0xa0) && !i16(j, 0x86)) j++;
      const r = racer(i);
      let run = 0;
      for (let k = i; k < j; k++) {
        if (buf.subarray(k * REC, k * REC + 0x71c).equals(buf.subarray((k + 1) * REC, (k + 1) * REC + 0x71c))) continue;
        tick(ter, r, dv.getUint16((k + 1) * REC + 0x71c, true));
        ticks++;
        if (fields(r).every((v, q) => v === fields(racer(k + 1))[q])) { exact++; run++; } else break;
      }
      longest = Math.max(longest, run);
      i = Math.max(j, i + 1);
    }
    // 21-10-2026: 1073 of 1094 ticks, longest unbroken stretch 385 ticks (12.8 s); with the ring dash
    // 1163 of 1180, longest 433 ticks (14.4 s).
    expect(exact / ticks).toBeGreaterThan(0.98);
    expect(longest).toBeGreaterThanOrEqual(433);
  });

  it('Island: autonomous water detection (0x4819b0 + 0x481a2c) matches 100% of recorded water values', () => {
    let checked = 0;
    let ok = 0;
    for (let i = 0; i + 1 < N; i++) {
      const consecutive = i32(i + 1, 0x20) === i32(i, 0) && i32(i + 1, 0x24) === i32(i, 4) && i32(i + 1, 0x28) === i32(i, 8);
      if (!consecutive || buf.subarray(i * REC, i * REC + 0x71c).equals(buf.subarray((i + 1) * REC, (i + 1) * REC + 0x71c))) continue;
      if (i16(i, 0xa0) || i16(i + 1, 0xa0) || i16(i, 0x86)) continue;
      const r = racer(i);
      updateWater(r, ter.playfieldWater);
      const recWater = i32(i + 1, 0x68);
      if (r.water === recWater) ok++;
      checked++;
    }
    expect(checked).toBe(1779);
    expect(ok).toBe(1779);
  });
});

describe('racer-vs-racer (0x4201a0 + 0x41ffd0)', () => {
  const at = (char: number, x: number, z: number, vx: number, vz: number) => {
    const r = newRacer(char, x << 12, 0, z << 12, 0);
    r.px = r.x - vx; r.pz = r.z - vz; r.vx = vx; r.vz = vz;
    return r;
  };

  it('hit radius = size table 0x4fa260 · 7/8', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hitRadius(c))).toEqual([17, 17, 24, 38, 38, 17, 17, 19, 35, 17]);
    expect(hitRadius(0, true)).toBe(22);
  });

  it('head-on: both keep 14/16 and get equal, opposite pushes along the separation', () => {
    const a = at(0, 0, 0, 0x20000, 0), b = at(0, 30, 0, -0x20000, 0);
    expect(racerCollision(a, b)).toBe(true);
    expect(a.vx + b.vx).toBe(0);
    expect(a.vx).toBeLessThan(0x20000 * 14 / 16);
    expect([a.vz, b.vz]).toEqual([0, 0]);
  });

  it('no contact beyond ra + rb, none during the ring dash', () => {
    expect(racerCollision(at(0, 0, 0, 0x1000, 0), at(0, 40, 0, 0x1000, 0))).toBe(false);
    const a = at(0, 0, 0, 0x20000, 0), b = at(0, 30, 0, -0x20000, 0);
    a.dash = 3;
    expect(racerCollision(a, b)).toBe(false);
    expect(a.vx).toBe(0x20000);
  });

  it('collideRacers runs every pair once and reports who was hit', () => {
    const rs = [at(0, 0, 0, 0x20000, 0), at(0, 30, 0, -0x20000, 0), at(0, 1000, 1000, 0x1000, 0)];
    expect(collideRacers(rs)).toEqual([true, true, false]);
  });
});

/** Spin dash and the 0x485a85 switch, on flat ground (physicsTick only: the recording has neither). */
describe('spin dash (+86) and character abilities', () => {
  const charged = (char = 0, revs = 4) => {
    const r = newRacer(char, 0, 0, 0, 0);
    physicsTick(r, IN.SPIN);
    for (let i = 0; i < revs; i++) { physicsTick(r, IN.SPIN | IN.REV); physicsTick(r, IN.SPIN); }
    return r;
  };

  it('charges from standstill: level 2, one level per rev press, latched while held, capped at 6', () => {
    const r = newRacer(0, 0, 0, 0, 0);
    physicsTick(r, IN.SPIN);
    expect(r.spin).toBe(2);
    physicsTick(r, IN.SPIN | IN.REV);
    expect([r.spin, r.anim]).toEqual([0x83, 8]);
    physicsTick(r, IN.SPIN | IN.REV); // still held: the 0x80 latch stops a second level
    expect(r.spin).toBe(0x83);
    physicsTick(r, IN.SPIN);
    expect(r.spin).toBe(3);
    for (let i = 0; i < 5; i++) { physicsTick(r, IN.SPIN | IN.REV); physicsTick(r, IN.SPIN); }
    expect(r.spin).toBe(6);
  });

  it('does not move, apply the speed rules or fall while charging', () => {
    const r = charged();
    r.vy = 0x1000;
    physicsTick(r, IN.SPIN | IN.ACCEL);
    expect([r.x, r.y, r.z, r.vx, r.vy, r.vz, r.fwd]).toEqual([0, 0, 0, 0, 0x1000, 0, 0]);
  });

  it('releases along the yaw at (level − 2)/4 of the table +1C speed, then rolls', () => {
    const r = charged();
    physicsTick(r, 0);
    // Launch vz = (sin(1024) · (0x36000 >> 12) · 4) >> 4 = 221170, then one tick of drag (−2·1024).
    expect([r.spin, r.anim]).toEqual([1, 9]);
    expect([r.fwd, r.lat, r.vx, r.vz, r.x, r.z]).toEqual([219068, 0, 0, 219014, 0, 219014]);
    // Rolling: turn / 6 (Sonic 35 → 5) and top speed from +1C.
    physicsTick(r, IN.RIGHT);
    expect([r.spin, r.yaw, r.fwd]).toEqual([1, 5, 216912]);
    const lvl3 = charged(0, 1);
    physicsTick(lvl3, 0);
    expect(lvl3.fwd).toBe(Math.trunc((((16383 * (PHYS_TABLE[0][7] >> 12)) >> 4) * 4095) / 4096) - 2048);
  });

  it('cancels when let go before the first rev, and ignores spin for Amy onwards', () => {
    const r = newRacer(0, 0, 0, 0, 0);
    physicsTick(r, IN.SPIN);
    physicsTick(r, 0);
    expect([r.spin, r.vz]).toEqual([0, 0]);
    const amy = newRacer(3, 0, 0, 0, 0);
    physicsTick(amy, IN.SPIN);
    expect(amy.spin).toBe(0);
  });

  it('rolls after 5 ticks of spin while moving, and stops rolling when it stops', () => {
    const r = newRacer(0, 0, 0, 0, 0);
    r.fwd = r.vz = 0x10000;
    for (let i = 0; i < 4; i++) physicsTick(r, IN.SPIN);
    expect(r.spin).toBe(-4);
    physicsTick(r, IN.SPIN);
    expect([r.spin, r.anim]).toEqual([1, 0xa]);
    for (let i = 0; i < 60 && r.spin; i++) physicsTick(r, 0);
    expect([r.spin, r.fwd]).toEqual([0, 0]);
  });

  it('Sonic double jumps on a second press once the air step reaches 10', () => {
    const r = newRacer(0, 0, 0, 0, 0);
    physicsTick(r, IN.JUMP);
    expect([r.jumpState, r.air, r.anim, r.grounded]).toEqual([1, 2, 7, 0]);
    physicsTick(r, 0);
    for (let i = 0; i < 7; i++) physicsTick(r, IN.JUMP);
    expect([r.jumpState, r.air]).toEqual([2, 10]);
    physicsTick(r, IN.JUMP);
    expect([r.anim, r.air, r.vy]).toEqual([0xd, 1, -0x20000 + 0x2000]);
  });

  it('Tails flies and Knuckles glides on a second press at air step 2; Amy boosts up to +18', () => {
    const tails = newRacer(1, 0, 0, 0, 0);
    tails.grounded = 0; tails.air = 2; tails.jumpState = 2;
    physicsTick(tails, IN.JUMP);
    expect([tails.special, tails.vy, tails.air]).toEqual([1, 0, 3]);
    const knux = newRacer(2, 0, 0, 0, 0);
    knux.grounded = 0; knux.air = 2; knux.jumpState = 2;
    physicsTick(knux, IN.JUMP);
    expect([knux.special, knux.vy, knux.air]).toEqual([4, 0x6000, 3]);
    physicsTick(knux, 0); // let go: +74 drops to 0 this tick, the switch sees it on the next
    expect(knux.special).toBe(4);
    physicsTick(knux, 0);
    expect(knux.special).toBe(0);
    const amy = newRacer(3, 0, 0, 0, 0);
    physicsTick(amy, IN.JUMP);
    expect([amy.special, amy.boostTimer, amy.slide42]).toEqual([3, 0x185, 2]);
    for (let i = 0; i < 80; i++) physicsTick(amy, 0); // accelerates on its own past the normal top speed
    expect(amy.fwd).toBeGreaterThan(PHYS_TABLE[3][0]);
    expect(amy.fwd).toBeLessThan(PHYS_TABLE[3][6] + 4 * ((PHYS_TABLE[3][1] * 3) >> 1)); // fwd < vmax, then += accel·4
  });
});
