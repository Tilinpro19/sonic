import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrack } from './track';
import { parseModel, parseAnim } from './model';
import { parseTerrain } from './terrain';
import { TRACKS } from './tracks';
import { CHARACTERS, CHARACTER_PAGES } from './characters';
import { Race, mainLoop } from '../engine/race';
import { OrigTerrain } from '../engine/original';

// Golden counts from SONIC_R_REA_PLAN.md A.3.1 (validated with sr_track.py).
const GAME = resolve(process.env.SONICR_DIR ?? '../work/sonicr/app');
const golden: Record<string, [number, number, number, number, number, number, number]> = {
  //         cells  nA   nB  vertsA quadsA trisB quadsB
  island:  [543, 390, 218, 8538, 3879, 747, 6976],
  city:    [570, 692, 324, 13604, 6110, 90, 8182],
  ruin:    [1210, 660, 347, 10926, 4803, 198, 8277],
  factory: [688, 635, 352, 13344, 6037, 139, 8190],
  emerald: [359, 811, 81, 19558, 8968, 978, 3839],
};
const has = existsSync(GAME);

describe.skipIf(!has)('track .bin', () => {
  for (const tr of TRACKS) {
    it(tr.name, () => {
      const t = parseTrack(readFileSync(join(GAME, tr.bin)));
      const A = t.meshes.filter((m) => m.kind === 'A');
      const B = t.meshes.filter((m) => m.kind === 'B');
      const bf = B.flatMap((m) => m.faces);
      expect([
        t.pvs.length, A.length, B.length,
        A.reduce((s, m) => s + m.pos.length, 0),
        A.reduce((s, m) => s + m.faces.length, 0),
        bf.filter((f) => f.idx.length === 3).length,
        bf.filter((f) => f.idx.length === 4).length,
      ]).toEqual(golden[tr.key]);
      expect(t.consumed).toBe(t.size);
      for (const m of t.meshes) {
        if (m.kind === 'A') expect(m.faces.length).toBe(m.pos.length / 2 - 1);
        for (const f of m.faces) for (const i of f.idx) expect(i).toBeLessThan(m.pos.length);
      }
      for (const f of tr.pages) expect(existsSync(join(GAME, f)), f).toBe(true);
      expect(Math.max(...t.meshes.flatMap((m) => m.faces.map((f) => f.tpage)))).toBeLessThan(tr.pages.length);
    });
  }
});

describe.skipIf(!has)('character models', () => {
  const root = join(GAME, 'bin/objects');
  const expectedParts: Record<string, number> = {
    sonic: 11, tails: 16, knuckles: 11, amy: 12, robotnik: 7, msonic: 10, dtails: 18, mknuck: 10, mrobot: 9, ssonic: 11,
  };
  for (const [ch, nParts] of Object.entries(expectedParts)) {
    it(ch, () => {
      const files = readdirSync(join(root, ch));
      const mesh = files.find((f) => /(_h\d*|z)\.bin$/.test(f))!;
      const m = parseModel(readFileSync(join(root, ch, mesh)));
      expect(m.consumed).toBe(m.size);
      expect(m.parts.length).toBe(nParts);
      for (const f of files.filter((f) => f.endsWith('.bin') && f !== mesh)) {
        const a = parseAnim(readFileSync(join(root, ch, f)));
        expect(a.nParts).toBe(nParts);
        expect(a.remainder).toBe(0);
      }
    });
  }
});

describe.skipIf(!has)('character manifest', () => {
  for (const c of CHARACTERS) {
    it(c.name, () => {
      const m = parseModel(readFileSync(join(GAME, c.mesh)));
      const nVerts = m.parts.reduce((n, p) => n + p.pos.length, 0);
      // .grd = 32 headings × nVerts × RGB8 (0x430638 indexes it by heading >> 7).
      expect(readFileSync(join(GAME, c.grd)).length).toBe(32 * nVerts * 3);
      for (const a of c.anims) expect(parseAnim(readFileSync(join(GAME, a))).nParts, a).toBe(m.parts.length);
      for (const f of m.parts.flatMap((p) => p.faces)) expect(f.tpage).toBeLessThan(CHARACTER_PAGES.length);
    });
  }
});

describe.skipIf(!has)('collision .ter', () => {
  for (const tr of TRACKS) {
    it(tr.name, () => {
      const t = parseTerrain(readFileSync(join(GAME, tr.ter)));
      const nV = t.verts.length / 3, nQ = t.quads.length / 4;
      expect(Math.max(...t.quads)).toBeLessThan(nV);
      // Sectors tile the quad array exactly, and every grid list points at real sectors.
      expect(t.sectors.reduce((s, x) => s + x.count, 0)).toBe(nQ);
      expect(Math.max(...t.sectors.map((s) => s.first + s.count))).toBe(nQ);
      expect(t.cells.every((c) => c.every((s) => s < t.sectors.length))).toBe(true);
      // Normals are unit length; most quads are floors (Y down → ny < 0).
      for (let q = 0; q < nQ; q++) expect(Math.hypot(t.normals[q * 3], t.normals[q * 3 + 1], t.normals[q * 3 + 2])).toBeCloseTo(1, 1);
      let floors = 0;
      for (let q = 0; q < nQ; q++) if (t.normals[q * 3 + 1] < -0.5) floors++;
      expect(floors / nQ).toBeGreaterThan(0.5);
      // Launcher sectors (trigger at +0x0C, 0x4855e8): City's pads and vertical springs, Ruin's
      // springs, Factory's jump ramps.
      const launchers = { island: 0, city: 49, ruin: 6, factory: 4, emerald: 0 }[tr.key];
      expect(t.sectors.filter((s) => s.trigger).length).toBe(launchers);
    });
  }
});

describe.skipIf(!has)('race loop (C6)', () => {
  const loopOf = (tr: (typeof TRACKS)[number]) => new Race(parseTrack(readFileSync(join(GAME, tr.bin))).lists.P0, [], undefined, tr.route).loop;

  // Emerald's P0[0..180) hops between branches (p99→p100, p149→p150, p179→p0); there are no
  // teleporters, so its loop is the route through the branches.
  it('has no step longer than 900 on any track', () => {
    for (const tr of TRACKS) {
      const loop = loopOf(tr);
      const steps = loop.map((p, i) => { const q = loop[(i + 1) % loop.length]; return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); });
      expect(Math.max(...steps), tr.key).toBeLessThan(900);
    }
  });

  it('Radical Emerald: the loop stays clear of the three ring-gate bars', () => {
    const tr = TRACKS.find((t) => t.key === 'emerald')!;
    const ter = new OrigTerrain(readFileSync(join(GAME, tr.ter)), tr.id), loop = loopOf(tr);
    const cross = (a: number[], b: number[], c: number[], d: number[]) => {
      const s = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0]));
      return s(a, b, c) * s(a, b, d) < 0 && s(c, d, a) * s(c, d, b) < 0;
    };
    // Closed 5-point rectangles across the road (the rest of the walls are road edges, some on other floor layers).
    const bars = [105, 108, 111].map((i) => ter.wall(i));
    for (const w of bars) expect(ter.wallPoint(w.first + 4)).toEqual(ter.wallPoint(w.first));
    const hits = (line: number[][]) => line.flatMap((a, i) => {
      const b = line[(i + 1) % line.length];
      return bars.some((w) => [0, 1, 2, 3].some((j) => cross(a, b, ter.wallPoint(w.first + j), ter.wallPoint(w.first + j + 1)))) ? [i] : [];
    });
    expect(hits(loop)).toEqual([]);
    // Following P0[0..k] runs into the gates at p32 and p96 (and its hops are not roads).
    const naive = mainLoop(parseTrack(readFileSync(join(GAME, tr.bin))).lists.P0);
    expect(hits(naive).filter((i) => ![99, 149, 179].includes(i))).toEqual([31, 95, 96]); // p96 is inside bar #105
  });
});
