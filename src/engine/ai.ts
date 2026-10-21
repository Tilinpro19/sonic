/**
 * AI navigation and race logic for CPU rivals in Sonic R Web.
 *
 * Rivals follow the track's main loop (P0 in .ter space), with:
 * - Pure-pursuit steering towards a point a speed-dependent distance down the line.
 * - Dynamic lateral lane offsets so bots do not travel in single file.
 * - Throttle chosen by simulating the real runner a second ahead (accelerate / coast / brake):
 *   grip only bleeds ~1 unit/tick of sideways speed, so corners need lifting early, and the
 *   look-ahead also sees ledges, ramps and springs. The original AI (0x4d8ab8 + aistuff) is not
 *   decoded yet.
 * - Unstuck routines (hop/jump or reverse if blocked by a wall or obstacle).
 * - Multi-racer start grid positions and real-time standing/ranking calculation.
 */
import { Runner, OriginalRunner, type Input } from './runner';
import type { Collision } from './collision';
import { applyWarp } from './warps';
import { loopsOf } from './loops';

export type V3 = [number, number, number];
export type AnyRunner = Runner | OriginalRunner;

export interface BotState {
  name: string;
  charKey: string;
  charIndex: number;
  runner: AnyRunner;
  laneOffset: number;
  skill: number;
  /** Pursuit distance in ticks of travel at the current speed (plus a fixed 120 units). */
  lookAhead: number;
  stuckTicks: number;
  reverseTicks: number;
  progress: number;
  lap: number;
  quarter: number;
  /** Quarters of the lap passed in order (bit per quarter); a lap needs all four. */
  checkpoints: number;
  finished: boolean;
  finishTime: number;
  /** Throttle plan (index into PLANS) and ticks until it is re-planned. */
  plan: number;
  planTicks: number;
  sim?: AnyRunner;
  /** Furthest arc length reached this lap, ticks since it last grew, ticks spent fallen off. */
  best: number;
  stall: number;
  fallen: number;
  /** Rescues in a row at about the same spot (each one drops the bot further ahead). */
  rescues: number;
}

/**
 * Calculates start grid slot coordinates in .ter space.
 * Slot 0 is front-left (Player), Slot 1 front-right, Slot 2 second row left, etc.
 */
export function calculateGridSlot(
  loop: readonly V3[],
  slotIndex: number,
): { x: number; y: number; z: number; yaw: number } {
  if (!loop.length) return { x: 0, y: 0, z: 0, yaw: 0 };
  const p0 = loop[0];
  const p1 = loop[1] ?? loop[0];

  // Track tangent vector along start line
  let tx = p1[0] - p0[0];
  let tz = p1[2] - p0[2];
  const tLen = Math.hypot(tx, tz) || 1;
  tx /= tLen;
  tz /= tLen;

  // Normal vector (right side of track)
  const rx = -tz;
  const rz = tx;

  // Staggered grid formation:
  // Row = floor(slotIndex / 2), Column = slotIndex % 2 (0 = left, 1 = right)
  const row = Math.floor(slotIndex / 2);
  const col = slotIndex % 2;

  const backOffset = -(row * 45); // Stagger rows backwards behind start line
  const sideOffset = col === 0 ? -22 : 22; // Left vs right lane

  const x = p0[0] + tx * backOffset + rx * sideOffset;
  const y = p0[1];
  const z = p0[2] + tz * backOffset + rz * sideOffset;

  // Heading facing down the track
  const yaw = Math.round(((Math.atan2(tx, tz) * 2048) / Math.PI + 4096) % 4096);

  return { x, y, z, yaw };
}

/**
 * Creates a new CPU bot rival.
 */
export function createBot(
  col: Collision,
  charIndex: number,
  charKey: string,
  name: string,
  laneOffset: number,
  skill = 0.95,
  useOriginal = false,
): BotState {
  return {
    name,
    charKey,
    charIndex,
    runner: useOriginal && col.origTerrain ? new OriginalRunner(col, charIndex) : new Runner(col, charIndex),
    laneOffset,
    skill,
    lookAhead: 8,
    stuckTicks: 0,
    reverseTicks: 0,
    progress: 0,
    lap: 1,
    quarter: 0,
    checkpoints: 1,
    finished: false,
    finishTime: 0,
    plan: 0,
    planTicks: 0,
    best: 0,
    stall: 0,
    fallen: 0,
    rescues: 0,
  };
}

const PLANS = [
  { accel: true, brake: false, jump: false },
  { accel: false, brake: false, jump: false },
  { accel: false, brake: true, jump: false },
  // Held jump: a jump, Tails' flight or Knuckles' glide; re-chosen in the air after a release it
  // is Sonic's double jump. P0 itself flies over Ruin's gaps, so the original AI jumps too.
  { accel: true, brake: false, jump: true },
];
/** Progress (units) a jump must gain over staying on the ground, so bots don't hop for nothing. */
const JUMP_COST = 60;
/** Re-plan every PLAN_EVERY ticks, simulating HORIZON ticks (the plan holds for the first HOLD). */
const PLAN_EVERY = 5, HORIZON = 30, HOLD = 10;

/** Nearest loop point to the runner, searched a little behind and ahead of `from`. */
function nearestPoint(loop: readonly V3[], r: AnyRunner, from: number, back: number, ahead: number) {
  const N = loop.length;
  let best = Infinity, nearest = from;
  for (let o = -back; o <= ahead; o++) {
    const i = (from + o + N) % N, p = loop[i];
    const dx = p[0] - r.x, dy = (p[1] - r.y) * 2, dz = p[2] - r.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; nearest = i; }
  }
  return nearest;
}

/** Steering towards the pursuit point; `delta` is the heading error (12-bit units). */
function pursue(bot: BotState, r: AnyRunner, loop: readonly V3[], near: number) {
  // P0 points are 150–400 units apart, so a fixed index look-ahead would cut corners off ledges.
  // Sliding wide (grip is weak), aim closer so the bot heads back to the line.
  const p = loop[near], off = Math.hypot(r.x - p[0], r.z - p[2]);
  const reach = Math.max(150, 120 + Math.abs(r.speed) * bot.lookAhead - off * 0.8);
  const ahead = pointAhead(loop, r.x, r.z, near, reach);
  const tx = ahead.x + ahead.nx * bot.laneOffset, tz = ahead.z + ahead.nz * bot.laneOffset;
  const want = (Math.atan2(tx - r.x, tz - r.z) * 2048) / Math.PI;
  const delta = ((((want - r.yaw) % 4096) + 6144) % 4096) - 2048;
  return { steer: Math.max(-1, Math.min(1, delta / 120)), delta };
}

/** Arc length of every loop point from P0[0], plus the loop's total, cached per loop. */
const ARCS = new WeakMap<readonly V3[], Float64Array>();
function arcs(loop: readonly V3[]) {
  let a = ARCS.get(loop);
  if (!a) {
    a = new Float64Array(loop.length + 1);
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      a[i + 1] = a[i] + Math.hypot(q[0] - p[0], q[2] - p[2]);
    }
    ARCS.set(loop, a);
  }
  return a;
}

/**
 * Per line point: the road's extent across the line [left, right] (signed offsets along the
 * line's left normal), before the floor drops more than 150 below the line's (or ends): edges to fall off. Over a gap
 * (no floor under the line) it is unbounded. Cached per line.
 */
const EDGES = new WeakMap<readonly V3[], [number, number][]>();
function edgesOf(loop: readonly V3[], col: Runner['col']) {
  let E = EDGES.get(loop);
  if (!E) {
    const N = loop.length;
    E = loop.map((a, i) => {
      const b = loop[(i + 1) % N], l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      const nx = -(b[2] - a[2]) / l, nz = (b[0] - a[0]) / l;
      const at = (o: number) => { const g = col.ground(a[0] + nx * o, a[2] + nz * o, a[1] + 300, 300); return g && g.y <= a[1] + 300 ? g.y : null; };
      const y0 = at(0);
      if (y0 === null) return [-Infinity, Infinity] as [number, number];
      const reach = (sgn: number) => {
        let o = 0;
        for (let k = 25; k <= 800; k += 25) { const y = at(sgn * k); if (y === null || y - y0 > 150) break; o = k; }
        return o >= 800 ? Infinity : o;
      };
      return [-reach(-1), reach(1)] as [number, number];
    });
    EDGES.set(loop, E);
  }
  return E;
}

/** Per line point: a launcher (sector trigger) on the road under it, within 250 either side. */
const PADS = new WeakMap<readonly V3[], boolean[]>();
function padsOf(loop: readonly V3[], col: Runner['col']) {
  let p = PADS.get(loop);
  if (!p) {
    const N = loop.length;
    p = loop.map((a, i) => {
      const b = loop[(i + 1) % N], l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
      const nx = -(b[2] - a[2]) / l, nz = (b[0] - a[0]) / l;
      for (let o = -250; o <= 250; o += 50) {
        const g = col.ground(a[0] + nx * o, a[2] + nz * o, a[1] + 300, 300);
        if (g && g.trigger && g.y <= a[1] + 300) return true;
      }
      return false;
    });
    PADS.set(loop, p);
  }
  return p;
}


/** Off-road penalty per unit past the edge (rescues, 5 tracks × 10 racers: 30 at 0 → 24 at 3, +2% time). */
const EDGE_WEIGHT = 3;

/**
 * Picks the throttle plan whose simulated outcome gets furthest down the line without leaving it:
 * falling well below the line, or straying far from it, is penalised.
 */
function choosePlan(bot: BotState, loop: readonly V3[]): number {
  const r = bot.runner, N = loop.length, arc = arcs(loop), total = arc[N];
  const sim = (bot.sim ??= r instanceof OriginalRunner ? new OriginalRunner(r.col, r.charIndex) : new Runner(r.col, r.charIndex));
  const s0 = arc[bot.progress];
  let best = 0, bestScore = -Infinity, accelFatal = false;
  // A launch pad just ahead does the jumping: hopping now would sail over it (Factory p45).
  const pads = padsOf(loop, r.col);
  const edges = edgesOf(loop, r.col);
  let padAhead = false;
  for (let o = 0; o <= 4 && !padAhead; o++) padAhead = pads[(bot.progress + o) % N];
  for (let k = 0; k < PLANS.length; k++) {
    if (PLANS[k].jump && padAhead && r.grounded) continue;
    if (r instanceof OriginalRunner && sim instanceof OriginalRunner) {
      sim.copyFrom(r);
    } else {
      Object.assign(sim, r);
    }
    let near = bot.progress, worst = 0;
    for (let t = 0; t < HORIZON; t++) {
      near = nearestPoint(loop, sim, near, 2, 6);
      const p = PLANS[t < HOLD ? k : 0];
      sim.tick({ accel: p.accel, brake: p.brake, steer: pursue(bot, sim, loop, near).steer, jump: p.jump });
      // After a teleport, measure against the line where it landed, not where it left.
      if (applyWarp(sim, loop)) near = nearestPoint(loop, sim, near, 2, 6);
      const q = loop[near];
      const off = Math.hypot(sim.x - q[0], sim.z - q[2]);
      // Y down: the line runs ~100 above the floor, so a runner 400 under it has fallen off.
      const drop = sim.y - q[1] - 400;
      worst = Math.max(worst, drop > 0 ? 1e4 + drop : 0, off - 260);
      // Past the road's edge (narrow roads with a drop, e.g. Ruin p215–236: 260 off the line is
      // already over it). Weighted by EDGE_WEIGHT, tuned like BANK.
      const e = edges[near], q2 = loop[(near + 1) % N], sl = Math.hypot(q2[0] - q[0], q2[2] - q[2]) || 1;
      const lat = ((sim.x - q[0]) * -(q2[2] - q[2]) + (sim.z - q[2]) * (q2[0] - q[0])) / sl;
      worst = Math.max(worst, Math.max(0, lat - e[1], e[0] - lat) * EDGE_WEIGHT);
    }
    let ds = (arc[near] - s0 + total) % total;
    if (ds > total / 2) ds -= total;
    const score = ds - worst * 4 - (PLANS[k].jump ? JUMP_COST : 0);
    if (k === 0) accelFatal = worst >= 1e4;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  // Nearly stopped, coasting or braking always looks better (the simulated run-up accelerates
  // after the held part anyway, with less speed to run wide) — and re-planning would keep the
  // bot waiting forever (Ruin's spiral stairs). Go, unless going is fatal.
  if ((best === 1 || best === 2) && r.speed < r.vmax * 0.35 && !accelFatal) best = 0;
  return best;
}

/** Respawns the bot on the line ahead of where it got stuck, at the first point with a floor. */
function rescue(bot: BotState, loop: readonly V3[]) {
  const r = bot.runner, N = loop.length;
  bot.rescues++;
  for (let k = 1 + 2 * bot.rescues; k < N; k++) {
    const i = (bot.progress + k) % N, p = loop[i], q = loop[(i + 1) % N];
    // Y down: a floor within 300 under the line (not a gap or a jump arc).
    const g = r.col.ground(p[0], p[2], p[1] + 300, 400);
    // (ground() also returns the playfield plane far below a pit: not a floor under the line.)
    if (!g || g.y < p[1] || g.y > p[1] + 300) continue;
    const yaw = ((Math.atan2(q[0] - p[0], q[2] - p[2]) * 2048) / Math.PI + 4096) % 4096;
    r.spawn(p[0], p[1], p[2], yaw);
    const a = (yaw * Math.PI) / 2048;
    r.vx = Math.sin(a) * r.vmax * 0.5;
    r.vz = Math.cos(a) * r.vmax * 0.5;
    bot.progress = i; // the quarter is left alone, so a rescue across the line still counts the lap
    break;
  }
  bot.stall = bot.fallen = bot.stuckTicks = bot.reverseTicks = 0;
  bot.planTicks = 0;
}

/**
 * Updates bot navigation for one 30 Hz tick and returns the driving inputs.
 */
export function updateBotInput(
  bot: BotState,
  loop: readonly V3[],
  raceClockSeconds = 0,
): Input {
  if (bot.finished) {
    return { accel: false, brake: true, steer: 0, jump: false };
  }

  const { runner, skill } = bot;
  const N = loop.length;
  if (N < 2) return { accel: true, brake: false, steer: 0, jump: false };
  applyWarp(runner, loop); // teleporters (the bot owns its runner; see warps.ts)
  runner.col.loops = loopsOf(loop, runner.col); // cached per line

  // 1. Locate nearest waypoint along main loop
  const nearest = nearestPoint(loop, runner, bot.progress, 8, Math.min(30, Math.floor(N / 4)));
  bot.progress = nearest;

  // Checkpoints & laps: crossing quarter 3 → 0 counts only after passing all four quarters, so a
  // bot starting behind the line does not get a free lap.
  const q = Math.floor((nearest / N) * 4);
  const prevQ = bot.quarter;
  bot.quarter = q;
  if (q === ((prevQ + 1) & 3)) bot.checkpoints |= 1 << q;
  if (prevQ === 3 && q === 0) {
    if (bot.checkpoints === 0b1111) bot.lap++;
    bot.checkpoints = 1;
    if (bot.lap > 3) {
      bot.finished = true;
      bot.finishTime = raceClockSeconds;
      return { accel: false, brake: true, steer: 0, jump: false };
    }
  }

  // Rescue: some track features (Island's quarter-pipe, …) still defeat the approximated physics,
  // so a bot that stops making progress or falls off the line is put back on it a little further.
  const arc = arcs(loop), total = arc[N];
  const gain = (arc[nearest] - bot.best + total) % total;
  if (gain > 0 && gain < total / 2) { bot.best = arc[nearest]; bot.stall = 0; }
  // A loop ride always comes out the far side (its line folds back, so "progress" stalls).
  else if (runner.ride) bot.stall = 0;
  else bot.stall++;
  bot.fallen = runner.y - loop[nearest][1] > 600 ? bot.fallen + 1 : 0;
  if (bot.stall > 75 || bot.fallen > 8) {
    rescue(bot, loop);
    return { accel: true, brake: false, steer: 0, jump: false };
  }
  if (bot.stall === 0 && gain > 2000) bot.rescues = 0;

  // 2. Steering
  const { steer, delta } = pursue(bot, runner, loop, nearest);

  // 3. Reverse / Recovery state
  if (bot.reverseTicks > 0) {
    bot.reverseTicks--;
    return {
      accel: false,
      brake: true,
      steer: -steer,
      jump: bot.reverseTicks % 15 === 0,
    };
  }

  // 4. Throttle from the look-ahead plan, capped at the bot's skill speed.
  const sp = runner.speed;
  if (--bot.planTicks <= 0) {
    bot.plan = choosePlan(bot, loop);
    bot.planTicks = PLAN_EVERY;
  }
  let { accel, brake, jump } = PLANS[bot.plan];
  if (Math.abs(delta) > 1300 && sp > runner.vmax * 0.3) { accel = false; brake = true; } // facing the wrong way
  if (accel && sp >= runner.vmax * skill) accel = false;

  // 5. Stuck detection: if speed is nearly 0 while grounded
  if (runner.grounded && Math.abs(sp) < 3.5) {
    bot.stuckTicks++;
    if (bot.stuckTicks > 12 && bot.stuckTicks % 16 === 0) {
      jump = true; // Attempt to hop over curb or small obstacle
    }
    if (bot.stuckTicks > 40) {
      // Begin reversing out
      bot.stuckTicks = 0;
      bot.reverseTicks = 25;
      return { accel: false, brake: true, steer: -steer, jump: false };
    }
  } else {
    bot.stuckTicks = 0;
  }

  return { accel, brake, steer, jump };
}

/**
 * Projects (x, z) onto the loop near point `near`, then walks `dist` units forward along it.
 * Returns that point and the unit normal to the right of the line there.
 */
export function pointAhead(loop: readonly V3[], x: number, z: number, near: number, dist: number) {
  const N = loop.length;
  // Projection on the segment before or after the nearest point, whichever is closer.
  let seg = near, t = 0, best = Infinity;
  for (const s of [(near - 1 + N) % N, near]) {
    const a = loop[s], b = loop[(s + 1) % N];
    const dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
    const d = Math.hypot(a[0] + dx * u - x, a[2] + dz * u - z);
    if (d < best) { best = d; seg = s; t = u; }
  }
  for (let i = 0; i < N; i++) {
    const a = loop[seg], b = loop[(seg + 1) % N];
    const dx = b[0] - a[0], dz = b[2] - a[2], len = Math.hypot(dx, dz) || 1;
    const left = (1 - t) * len;
    if (dist <= left) {
      const u = t + dist / len;
      return { x: a[0] + dx * u, z: a[2] + dz * u, nx: -dz / len, nz: dx / len };
    }
    dist -= left; t = 0; seg = (seg + 1) % N;
  }
  const p = loop[near];
  return { x: p[0], z: p[2], nx: 0, nz: 0 };
}

export interface StandingEntry {
  id: string;
  name: string;
  isPlayer: boolean;
  lap: number;
  progress: number;
  finished: boolean;
  finishTime: number;
  rank: number;
}

/**
 * Calculates standings/rankings for all participants (Player + Bots).
 * Returns array sorted from 1st place to last place.
 */
export function calculateStandings(
  player: { name: string; lap: number; progress: number; finished: boolean; finishTime: number },
  bots: readonly BotState[],
  loopLength: number,
): StandingEntry[] {
  const all: (StandingEntry & { score: number })[] = [
    {
      id: 'player',
      name: player.name,
      isPlayer: true,
      lap: player.lap,
      progress: player.progress,
      finished: player.finished,
      finishTime: player.finishTime,
      rank: 1,
      score: calcScore(player.lap, player.progress, player.finished, player.finishTime, loopLength),
    },
    ...bots.map((b) => ({
      id: b.charKey,
      name: b.name,
      isPlayer: false,
      lap: b.lap,
      progress: b.progress,
      finished: b.finished,
      finishTime: b.finishTime,
      rank: 1,
      score: calcScore(b.lap, b.progress, b.finished, b.finishTime, loopLength),
    })),
  ];

  all.sort((a, b) => b.score - a.score);

  return all.map((entry, idx) => ({
    id: entry.id,
    name: entry.name,
    isPlayer: entry.isPlayer,
    lap: entry.lap,
    progress: entry.progress,
    finished: entry.finished,
    finishTime: entry.finishTime,
    rank: idx + 1,
  }));
}

function calcScore(lap: number, progress: number, finished: boolean, finishTime: number, loopLength: number): number {
  if (finished) {
    // Finished racers are ahead of everyone else, ordered by faster finish time
    return 10_000_000 - Math.min(finishTime * 100, 9_000_000);
  }
  return (lap - 1) * loopLength + progress;
}
