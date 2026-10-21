import { describe, expect, it } from 'vitest';
import { tessellate, type Soup } from './tessellate';

/** Closed hexagonal bipyramid: gentle dihedrals inside each fan, a crease at the equator. */
function bipyramid(): Soup {
  const s: Soup = { pos: [], uv: [], col: [], group: [] };
  const ring = Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3) * 100, 0, Math.sin((i * Math.PI) / 3) * 100]);
  const tri = (a: number[], b: number[], c: number[]) => {
    s.pos.push(...a, ...b, ...c);
    s.uv.push(0, 0, 1, 0, 0, 1);
    s.col.push(1, 1, 1, 1, 1, 1, 1, 1, 1);
    s.group.push(0);
  };
  for (let i = 0; i < 6; i++) {
    const a = ring[i], b = ring[(i + 1) % 6];
    tri([0, 30, 0], b, a);
    tri([0, -30, 0], a, b);
  }
  return s;
}

describe('tessellate', () => {
  for (const level of [1, 2, 3, 4]) {
    it(`is watertight at level ${level}`, () => {
      const o = tessellate(bipyramid(), level).get(0)!;
      const key = (i: number) => `${o.pos[i * 3]},${o.pos[i * 3 + 1]},${o.pos[i * 3 + 2]}`;
      const edges = new Map<string, number>();
      for (let t = 0; t < o.pos.length / 9; t++)
        for (let c = 0; c < 3; c++) {
          const a = key(t * 3 + c), b = key(t * 3 + ((c + 1) % 3));
          const k = a < b ? `${a}|${b}` : `${b}|${a}`;
          edges.set(k, (edges.get(k) ?? 0) + 1);
        }
      expect([...edges.values()].every((n) => n === 2)).toBe(true);
      expect(o.pos.length / 9).toBe(12 * level * level);
    });
  }

  it('rounds smooth surfaces but keeps flat ones flat', () => {
    const o = tessellate(bipyramid(), 3).get(0)!;
    const maxY = Math.max(...o.pos.filter((_, i) => i % 3 === 1));
    expect(maxY).toBeCloseTo(30, 5); // apex unchanged
    const plane: Soup = { pos: [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0, 10], uv: Array(12).fill(0), col: Array(18).fill(1), group: [0, 0] };
    const p = tessellate(plane, 3).get(0)!;
    expect(p.pos.length / 9).toBe(2); // flat → not subdivided
  });
});
