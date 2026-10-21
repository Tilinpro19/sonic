import { describe, expect, it } from 'vitest';
import { calculateGridSlot, createBot, updateBotInput, calculateStandings, type V3 } from './ai';
import type { Collision } from './collision';

// Mock collision that provides a flat ground at y = 100
const mockCol = {
  ground: (_x: number, _z: number, _y: number, _step: number) => ({ y: 100, attr: 0, nx: 0, ny: -4096, nz: 0 }),
  walls: () => null,
} as unknown as Collision;

// Simple rectangular loop of 100 waypoints (perimeter ~ 4000)
const N = 100;
const loop: V3[] = Array.from({ length: N }, (_, i) => {
  const t = (i / N) * 2 * Math.PI;
  return [Math.cos(t) * 1000, 100, Math.sin(t) * 1000] as V3;
});

describe('AI bot navigation and standings', () => {
  it('calculates staggered grid slots for 4 racers', () => {
    const s0 = calculateGridSlot(loop, 0);
    const s1 = calculateGridSlot(loop, 1);
    const s2 = calculateGridSlot(loop, 2);
    const s3 = calculateGridSlot(loop, 3);

    expect(s0).toBeDefined();
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s3).toBeDefined();

    // Slots 0 & 1 are in front row, Slots 2 & 3 in back row
    const distFrontBack = Math.hypot(s2.x - s0.x, s2.z - s0.z);
    expect(distFrontBack).toBeGreaterThan(30);

    // Lateral separation between left and right slots
    const distSide = Math.hypot(s1.x - s0.x, s1.z - s0.z);
    expect(distSide).toBeGreaterThan(30);
  });

  it('steers toward the racing line waypoints', () => {
    const bot = createBot(mockCol, 1, 'tails', 'Tails', 0, 1.0);
    bot.runner.spawn(loop[0][0], loop[0][1], loop[0][2], 0);

    const input = updateBotInput(bot, loop, 0);
    expect(input.accel).toBe(true);
    expect(typeof input.steer).toBe('number');
  });

  it('detects quarters and advances laps upon completing a circuit', () => {
    const bot = createBot(mockCol, 2, 'knuckles', 'Knuckles', 0, 1.0);
    bot.runner.spawn(loop[0][0], loop[0][1], loop[0][2], 0);

    // Simulate traversing the 4 quarters of the track
    bot.runner.x = loop[10][0]; bot.runner.z = loop[10][2];
    updateBotInput(bot, loop, 1);
    expect(bot.quarter).toBe(0);

    bot.runner.x = loop[30][0]; bot.runner.z = loop[30][2];
    updateBotInput(bot, loop, 2);
    expect(bot.quarter).toBe(1);

    bot.runner.x = loop[60][0]; bot.runner.z = loop[60][2];
    updateBotInput(bot, loop, 3);
    expect(bot.quarter).toBe(2);

    bot.runner.x = loop[85][0]; bot.runner.z = loop[85][2];
    updateBotInput(bot, loop, 4);
    expect(bot.quarter).toBe(3);

    // Crossing start/finish line from quarter 3 to 0
    bot.runner.x = loop[2][0]; bot.runner.z = loop[2][2];
    updateBotInput(bot, loop, 5);
    expect(bot.quarter).toBe(0);
    expect(bot.lap).toBe(2);
  });

  it('triggers jump/recovery when stuck against a barrier', () => {
    const bot = createBot(mockCol, 3, 'amy', 'Amy', 0, 1.0);
    bot.runner.spawn(loop[0][0], loop[0][1], loop[0][2], 0);
    bot.runner.grounded = true;
    bot.runner.vx = bot.runner.vz = 0; // Stopped

    // Tick multiple times with zero speed
    let jumped = false;
    for (let i = 0; i < 20; i++) {
      const inp = updateBotInput(bot, loop, i * 0.033);
      if (inp.jump) jumped = true;
    }
    expect(jumped).toBe(true);
  });

  it('calculates real-time standings accurately', () => {
    const bot1 = createBot(mockCol, 1, 'tails', 'Tails', 0);
    bot1.lap = 2;
    bot1.progress = 50;

    const bot2 = createBot(mockCol, 2, 'knuckles', 'Knuckles', 0);
    bot2.lap = 1;
    bot2.progress = 90;

    const player = {
      name: 'Sonic',
      lap: 2,
      progress: 60,
      finished: false,
      finishTime: 0,
    };

    const standings = calculateStandings(player, [bot1, bot2], N);

    expect(standings[0].name).toBe('Sonic');
    expect(standings[0].rank).toBe(1);
    expect(standings[0].isPlayer).toBe(true);

    expect(standings[1].name).toBe('Tails');
    expect(standings[1].rank).toBe(2);

    expect(standings[2].name).toBe('Knuckles');
    expect(standings[2].rank).toBe(3);
  });

  it('ranks finished racers ahead of active racers based on finish time', () => {
    const bot1 = createBot(mockCol, 1, 'tails', 'Tails', 0);
    bot1.lap = 3;
    bot1.finished = true;
    bot1.finishTime = 65.5; // Finished at 65.5s

    const bot2 = createBot(mockCol, 2, 'knuckles', 'Knuckles', 0);
    bot2.lap = 3;
    bot2.finished = true;
    bot2.finishTime = 62.1; // Finished at 62.1s (faster!)

    const player = {
      name: 'Sonic',
      lap: 3,
      progress: 95,
      finished: false,
      finishTime: 0,
    };

    const standings = calculateStandings(player, [bot1, bot2], N);

    expect(standings[0].name).toBe('Knuckles');
    expect(standings[0].rank).toBe(1);

    expect(standings[1].name).toBe('Tails');
    expect(standings[1].rank).toBe(2);

    expect(standings[2].name).toBe('Sonic');
    expect(standings[2].rank).toBe(3);
  });
});
