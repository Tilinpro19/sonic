import { describe, expect, it } from 'vitest';
import { fmt, showHud, updateHud, type StandingSummary } from './hud';
import { Race } from './engine/race';

describe('HUD format helper (fmt)', () => {
  it('formats 0 seconds correctly as 0\'00"00', () => {
    expect(fmt(0)).toBe('0\'00"00');
  });

  it('formats fractional seconds correctly', () => {
    expect(fmt(5.25)).toBe('0\'05"25');
    expect(fmt(59.99)).toBe('0\'59"99');
  });

  it('formats minutes and seconds correctly (e.g. 1\'23"45)', () => {
    expect(fmt(83.45)).toBe('1\'23"45');
    expect(fmt(125.02)).toBe('2\'05"02');
  });
});

describe('HUD functions in non-DOM environment', () => {
  it('showHud runs safely when document elements are absent', () => {
    expect(() => showHud(true)).not.toThrow();
    expect(() => showHud(false)).not.toThrow();
  });

  it('updateHud runs safely when document elements are absent', () => {
    const p0: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [20, 0, 0], [0, 0, 0]];
    const race = new Race(p0, []);
    const standings: StandingSummary[] = [
      { name: 'Sonic', rank: 1, finishTime: 75.2, isPlayer: true },
      { name: 'Tails', rank: 2, finishTime: 78.5, isPlayer: false },
    ];

    expect(() => updateHud(race, 0, 120, 1, standings)).not.toThrow();
    race.finished = true;
    expect(() => updateHud(race, 0, 0, 1, standings)).not.toThrow();
  });
});
