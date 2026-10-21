import { describe, expect, it } from 'vitest';
import { stageTrack } from './audio';

describe('CD track per stage (table 0x4fbed8, +6 instrumental, 0x4fbef0 Super Sonic)', () => {
  it('maps the five stages', () => {
    expect([1, 2, 3, 4, 5].map((id) => stageTrack(id, 'vocal'))).toEqual([6, 7, 9, 8, 10]);
    expect([1, 2, 3, 4, 5].map((id) => stageTrack(id, 'instrumental'))).toEqual([12, 13, 15, 14, 16]);
  });
  it('uses the Super Sonic track only on Radical Emerald', () => {
    expect(stageTrack(5, 'vocal', true)).toBe(11);
    expect(stageTrack(5, 'instrumental', true)).toBe(17);
    expect(stageTrack(1, 'vocal', true)).toBe(6);
  });
});
