import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OrigTerrain, sinLut, tick, updateWater, type OrigRacer } from './original';

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

  const racer = (i: number): OrigRacer => ({
    char: i16(i, 0xf2), x: i32(i, 0), y: i32(i, 4), z: i32(i, 8), yaw: i32(i, 0x10),
    px: i32(i, 0x20), py: i32(i, 0x24), pz: i32(i, 0x28), dy: 0,
    vx: i32(i, 0x2c), vy: i32(i, 0x30), vz: i32(i, 0x34), floorY: i32(i, 0x38), fwd: i32(i, 0x44), lat: i32(i, 0x48),
    water: i32(i, 0x68), drift: i16(i, 0x6c), driftDir: i16(i, 0x6e), grounded: i16(i, 0x72), jumpLock: i16(i, 0x78),
    air: i16(i, 0x96), pri: i32(i, 0xa4), sector: i32(i, 0xa8), quad: i32(i, 0xac), hasFloor: i16(i, 0xb0),
    prevHasFloor: i16(i, 0xb2),
    n: [i16(i, 0xb4), i16(i, 0xb6), i16(i, 0xb8)], hitWall: i16(i, 0xba), rings: i16(i, 0x18), camber: i16(i, 0xde),
    alt40: i16(i, 0x40), slide42: i16(i, 0x42),
  });
  const fields = (r: OrigRacer) => [r.x, r.y, r.z, r.yaw, r.vx, r.vy, r.vz, r.fwd, r.lat, r.grounded, ...r.n, r.camber];

  it('Island: ≥ 97 % of the recorded ticks match in every field', () => {
    let n = 0, ok = 0;
    for (let i = 0; i + 1 < N; i++) {
      const consecutive = i32(i + 1, 0x20) === i32(i, 0) && i32(i + 1, 0x24) === i32(i, 4) && i32(i + 1, 0x28) === i32(i, 8);
      if (!consecutive || buf.subarray(i * REC, i * REC + 0x71c).equals(buf.subarray((i + 1) * REC, (i + 1) * REC + 0x71c))) continue;
      // Not ported: loop rides (+a0), spin dash (+86), jumps (jump pressed on the ground).
      const inp = dv.getUint16((i + 1) * REC + 0x71c, true);
      if (i16(i, 0xa0) || i16(i + 1, 0xa0) || i16(i, 0x86)) continue;
      const r = racer(i), after = racer(i + 1);
      tick(ter, r, inp);
      n++;
      if (fields(r).every((v, k) => v === fields(after)[k])) ok++;
    }
    expect(n).toBeGreaterThan(1700);
    console.log('Matched:', ok, '/', n, (100 * ok / n).toFixed(2) + '%'); expect(ok / n).toBeGreaterThanOrEqual(0.97); // 1726 / 1777 on 21-10-2026
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
    // 21-10-2026: 1073 of 1094 ticks, longest unbroken stretch 385 ticks (12.8 s).
    expect(exact / ticks).toBeGreaterThan(0.97);
    expect(longest).toBeGreaterThanOrEqual(385);
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
