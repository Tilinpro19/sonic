import { OrigRacer, OrigTerrain, newRacer, physicsTick, collide, springs, updateWater, sinLut, PHYS_TABLE } from './original';
/**
 * One racer's movement at the original fixed 30 Hz tick (plan A.4, physics 0x485768).
 * Units: `.ter` space (runner pos >> 12, Y down); velocities in units/tick, so the 20.12 table
 * values are divided by 4096. What is [C] in the plan is followed; the rest ([?] fields, steering
 * rate, slopes 0x4853a8, step height) is approximated until M3's traces exist.
 */
import * as THREE from 'three';
import { Collision, STEP, type Ground } from './collision';
import { WORLD_SCALE } from './trackScene';
import { ENTRY_RADIUS, LEAD_IN, ridePath, rideAt, type RidePath } from './loops';

export const TICK = 1 / 30;
const FX = 1 / 4096;

/**
 * Physics table 0x5016b4 (stride 0x28), same order as CHARACTERS. Fields used: +00 vmax, +04 accel,
 * +08 turn, +0C grip, +10 drag. In 0x485768 the heading moves by `t08 + (k · t08) >> 10` a tick; the
 * golden recording shows Sonic at full lock turning 37/tick (t08 = 35) and losing exactly
 * grip/4096 ≈ 1.12 units/tick of sideways speed, so the slides are the original's.
 */
const TABLE: [number, number, number, number, number][] = [
  [208896, 3584, 35, 4608, 1024], // Sonic
  [184320, 4096, 45, 2048, 512], // Tails
  [208896, 4608, 35, 3584, 2048], // Knuckles
  [147456, 5120, 35, 3584, 2560], // Amy
  [172032, 3584, 40, 3072, 512], // Robotnik
  [221184, 4096, 35, 2560, 1536], // Metal Sonic
  [184320, 3072, 25, 4096, 0], // Tails Doll
  [221184, 5120, 30, 4096, 1536], // Metal Knuckles
  [184320, 5120, 35, 4608, 1536], // Egg Robo
  [245760, 5120, 40, 4608, 512], // Super Sonic
];

const GRAVITY = 0x2000 * FX, MAX_FALL = 0x25800 * FX, JUMP = 0x20000 * FX, ABS_MAX = 0x44000 * FX;
const HEIGHT = 120, RADIUS = 36;
/**
 * Floors steeper than this (|ny| below it, ~53°) are ridden as 3D surfaces: the velocity runs
 * along the floor, gravity pulls along it and leaving the lip launches the racer along its last
 * direction (Ruin's banked quarter-pipes, the ramps into Island's and Factory's loops). [P] The
 * original keeps full 3D orientation in the struct (+0c pitch, +14 roll, matrices +20c…); the
 * rule itself is not traced yet. Gentler slopes keep the tuned horizontal model.
 */
const STEEP = 0.6;
/** Strength of the banking pull, in units of gravity (see tick). */
const BANK = 3;

export interface Input { accel: boolean; brake: boolean; steer: number; jump: boolean }

export type AbilityEvent = 'doublejump' | 'fly' | 'glide' | 'spring';

export interface TickResult {
  jumped: boolean;
  ability?: AbilityEvent;
}

interface State { x: number; y: number; z: number; yaw: number }

export class Runner {
  x = 0; y = 0; z = 0;
  /** Heading, 12-bit units (4096 = one turn). Forward = (sin, cos) in ter XZ. */
  yaw = 0;
  vx = 0; vy = 0; vz = 0;
  grounded = false;
  /** Floor under the feet (last contact) and the height gained on it last tick (Y down: < 0 is up). */
  private floor: Ground = { y: 0, nx: 0, ny: -1, nz: 0, attr: 0, trigger: 0 };
  private climb = 0;
  /** Heading change per tick at full lock, 12-bit units (table +08, scaled to the measured 37 for Sonic). */
  turn: number;
  prev: State = { x: 0, y: 0, z: 0, yaw: 0 };
  private start: State = { x: 0, y: 0, z: 0, yaw: 0 };
  private jumpHeld = false;
  readonly charIndex: number;
  readonly vmax: number; readonly accel: number; readonly grip: number; readonly drag: number;

  /** Scripted loop ride (engine/loops.ts): the path (never mutated), distance along it, speed. */
  ride: RidePath | null = null;
  rideS = 0;
  rideSpeed = 0;

  doubleJumped = false;
  flying = false;
  flyTicks = 0;
  gliding = false;

  constructor(readonly col: Collision, charIndex = 0) {
    this.charIndex = charIndex;
    const [vmax, accel, turn, grip, drag] = TABLE[charIndex] ?? TABLE[0];
    this.vmax = vmax * FX; this.accel = accel * FX; this.grip = grip * FX; this.drag = drag * FX;
    this.turn = (turn * 37) / 35;
  }

  spawn(x: number, y: number, z: number, yaw: number) {
    this.start = { x, y, z, yaw };
    this.reset();
  }

  reset() {
    Object.assign(this, this.start);
    this.vx = this.vy = this.vz = 0;
    this.doubleJumped = false;
    this.flying = false;
    this.flyTicks = 0;
    this.gliding = false;
    this.ride = null;
    // Floor nearest under the spawn point (not a bridge far above it).
    const g = this.col.ground(this.x, this.z, this.y + 400, 700);
    if (g) { this.y = g.y; this.floor = g; }
    this.grounded = !!g;
    this.climb = 0;
    this.prev = { ...this.start, y: this.y };
  }

  /** Instant speed surge forward. */
  boost(impulse = 0x6000 * FX) {
    const a = this.yaw * (Math.PI / 2048);
    this.vx += impulse * Math.sin(a);
    this.vz += impulse * Math.cos(a);
  }

  /** Forward speed, units/tick. */
  get speed() {
    const a = this.yaw * (Math.PI / 2048);
    return this.vx * Math.sin(a) + this.vz * Math.cos(a);
  }

  /** One 30 Hz step. Returns what happened this tick (for sound). */
  tick(inp: Input): TickResult {
    let jumped = false;
    let ability: AbilityEvent | undefined;
    this.prev = { x: this.x, y: this.y, z: this.z, yaw: this.yaw };
    if (this.ride || this.enterLoop()) {
      this.jumpHeld = inp.jump;
      return this.rideTick();
    }
    const steep = this.grounded && this.floor.ny > -STEEP;

    // Jump (edge-triggered) and character special abilities
    if (this.grounded) {
      if (inp.jump && !this.jumpHeld) {
        // Off a steep bank the jump pushes away from it, along the floor normal.
        if (steep) { this.vx += this.floor.nx * JUMP; this.vy += this.floor.ny * JUMP; this.vz += this.floor.nz * JUMP; }
        else this.vy = -JUMP;
        this.grounded = false;
        jumped = true;
        // Amy: turbo boost on ground jump
        if (this.charIndex === 3) {
          this.boost(0x4000 * FX);
        }
      }
    } else {
      // Airborne abilities
      if (this.charIndex === 0 || this.charIndex === 9) {
        // Sonic & Super Sonic: Double Jump (edge-triggered)
        if (inp.jump && !this.jumpHeld && !this.doubleJumped) {
          this.vy = -0x22000 * FX;
          this.doubleJumped = true;
          jumped = true;
          ability = 'doublejump';
        }
      } else if (this.charIndex === 1) {
        // Tails: Flying (pressing / holding jump engages flight up to 120 ticks)
        if (inp.jump && this.flyTicks < 120) {
          this.flying = true;
        }
        if (this.flying) {
          if (++this.flyTicks >= 120) {
            this.flying = false;
          } else {
            this.vy = -0x4000 * FX;
            ability = 'fly';
          }
        }
      } else if (this.charIndex === 2 || this.charIndex === 7) {
        // Knuckles: Gliding (holding jump)
        if (inp.jump) {
          this.gliding = true;
          this.vy = Math.min(this.vy, 0x2800 * FX);
          ability = 'glide';
        } else {
          this.gliding = false;
        }
      }
    }
    this.jumpHeld = inp.jump;

    // Steering (full lock at speed, softer when nearly stopped).
    // Knuckles turns wider / more aerodynamically while gliding
    const turnRate = this.gliding ? this.turn * 0.5 : this.turn;
    const sp = Math.abs(this.speed);
    this.yaw = (this.yaw + inp.steer * turnRate * Math.min(1, 0.4 + sp / (this.vmax * 0.5)) + 4096) % 4096;

    if (steep && this.grounded) {
      this.surfaceTick(inp);
      return { jumped, ability };
    }

    // World → local frame, then forward/lateral rules, then back (0x485768).
    const a = this.yaw * (Math.PI / 2048), s = Math.sin(a), c = Math.cos(a);
    let lat0 = this.vx * c - this.vz * s;
    // Banked floors: the sideways part of the pull along the floor turns the racer into the bend
    // (the forward part, up and down hills, is left to the tuned rules). [P] 0x4853a8 is not
    // traced; BANK is tuned on the bots (rescues over 5 tracks × 10 racers: 63 at 0 → 41 at 3).
    if (this.grounded) {
      const f = this.floor;
      lat0 += GRAVITY * BANK * -f.ny * (f.nx * c - f.nz * s);
    }
    const [fwd, lat] = this.speedRules(inp, this.vx * s + this.vz * c, lat0);
    this.vx = fwd * s + lat * c;
    this.vz = fwd * c - lat * s;

    // Downward gravity: countered while flying; clamped while gliding
    if (!this.flying) {
      this.vy = Math.min(this.vy + GRAVITY, MAX_FALL);
      if (this.gliding) {
        this.vy = Math.min(this.vy, 0x2800 * FX);
      }
    }
    return this.move(jumped, ability);
  }

  /** Forward/lateral speed rules of 0x485768 (grip, accel, drag, caps), in the racer's frame. */
  private speedRules(inp: Input, fwd: number, lat: number): [number, number] {
    // Amy special traction on ground / water
    const grip = this.charIndex === 3 ? this.grip * 1.5 : this.grip;
    lat = lat > 0 ? Math.max(0, lat - grip) : Math.min(0, lat + grip);
    lat = Math.max(-this.vmax, Math.min(this.vmax, lat));

    // The forward rules run in the air too: 0x485768's speed block (0x48653c…) has no floor test,
    // which is how a vertical spring (0x4000 kills the run-up) still carries racers onto the ledge.
    {
      // Amy turbo boost acceleration
      const accelRate = (this.charIndex === 3 ? 2.2 : 1.5) * this.accel;
      if (inp.accel && fwd < this.vmax) fwd = Math.min(this.vmax, fwd + accelRate);
      else if (inp.brake) fwd = Math.max(-this.vmax / 4, fwd - 3 * this.accel);
      else fwd = fwd > 0 ? Math.max(0, fwd - 2 * this.drag) : Math.min(0, fwd + 2 * this.drag);
      if (fwd > this.vmax && !inp.accel) fwd = Math.max(this.vmax, fwd - 2 * this.drag);
    }
    // Knuckles gliding maintains forward speed
    if (this.gliding) {
      if (fwd < this.vmax * 0.75) fwd = Math.min(this.vmax * 0.75, fwd + this.accel);
    }

    return [Math.max(-ABS_MAX, Math.min(ABS_MAX, fwd)), lat];
  }

  /** Moves by the velocity and resolves walls and floors (gentle floors and the air). */
  private move(jumped: boolean, ability: AbilityEvent | undefined): TickResult {
    // On the ground the speed runs along the floor: up or down a slope only its horizontal part
    // moves x/z, so steep ramps slow the run and the rise per tick never exceeds the speed.
    let k = 1;
    if (this.grounded && this.floor.ny < 0) {
      const grade = (this.floor.nx * this.vx + this.floor.nz * this.vz) / this.floor.ny;
      const h = Math.hypot(this.vx, this.vz);
      if (h > 0) k = 1 / Math.hypot(1, grade / h);
    }
    this.x += this.vx * k; this.z += this.vz * k; this.y += this.vy;

    // Walls: push out and drop the velocity going into them.
    const w = this.col.walls(this.x, this.z, this.y, HEIGHT, RADIUS);
    if (w) {
      this.x += w.dx; this.z += w.dz;
      const into = this.vx * w.nx + this.vz * w.nz;
      if (into < 0) { this.vx -= w.nx * into; this.vz -= w.nz * into; }
    }

    // Floor: land, follow it downhill while grounded, or fall.
    // While grounded, follow slopes both ways: a full-speed tick up a steep ramp rises more than
    // STEP, so the reach scales with the distance run (up to the 60° floor limit, tan ≈ 1.73).
    const run = Math.hypot(this.vx, this.vz);
    const wasGrounded = this.grounded;
    const snapDown = this.grounded ? 8 + run : 0;
    const g = this.col.ground(this.x, this.z, this.y, this.grounded ? STEP + run : STEP);
    if (g && this.vy >= 0 && this.y >= g.y - snapDown) {
      this.climb = g.y - this.prev.y;
      this.floor = g;
      this.y = g.y;
      // Onto a steep bank the velocity turns along it (running in from the floor keeps its speed).
      if (g.ny > -STEEP) this.alongFloor(g, wasGrounded ? Math.hypot(this.vx, this.vz) : 0);
      else this.vy = 0;
      this.grounded = true;
      this.doubleJumped = false;
      this.flying = false;
      this.flyTicks = 0;
      this.gliding = false;
      // Springs and launch pads (0x4855e8): any trigger launches; 0x8000 pushes along the floor
      // normal, 0x4000 kills the horizontal speed first (vertical springs).
      const t = g.trigger;
      if (t) {
        const a = t & 0xfff;
        if (t & 0x8000) { this.vx += g.nx * a; this.vz += g.nz * a; }
        else if (t & 0x4000) this.vx = this.vz = 0;
        this.vy = -a * 0xd05 * FX;
        this.grounded = false;
        ability = 'spring';
      }
    } else {
      // Running off a crest or up over a ramp's lip keeps the vertical speed it had on the slope.
      if (wasGrounded && !jumped) this.vy = Math.min(this.vy, this.climb);
      this.grounded = false;
    }

    if (!g && this.y > 3000) this.reset(); // fell out of the world
    return { jumped, ability };
  }

  /** Removes the velocity into/out of floor `g`; `keep` > 0 rescales what is left to that speed. */
  private alongFloor(g: Ground, keep = 0) {
    const vn = this.vx * g.nx + this.vy * g.ny + this.vz * g.nz;
    this.vx -= vn * g.nx; this.vy -= vn * g.ny; this.vz -= vn * g.nz;
    const l = Math.hypot(this.vx, this.vy, this.vz);
    if (keep > 0 && l > 1e-6) { const k = keep / l; this.vx *= k; this.vy *= k; this.vz *= k; }
  }

  /** One grounded tick on a steep floor (see STEEP): 3D velocity along the surface. */
  private surfaceTick(inp: Input) {
    const n = this.floor, a = this.yaw * (Math.PI / 2048);
    // Heading projected onto the floor; facing straight into a wall, run up its slope instead.
    const hn = Math.sin(a) * n.nx + Math.cos(a) * n.nz;
    let fx = Math.sin(a) - hn * n.nx, fy = -hn * n.ny, fz = Math.cos(a) - hn * n.nz;
    let fl = Math.hypot(fx, fy, fz);
    if (fl < 0.2) { fx = n.ny * n.nx; fy = n.ny * n.ny - 1; fz = n.ny * n.nz; fl = Math.hypot(fx, fy, fz); }
    fx /= fl; fy /= fl; fz /= fl;
    const lx = n.ny * fz - n.nz * fy, ly = n.nz * fx - n.nx * fz, lz = n.nx * fy - n.ny * fx;
    const [fwd, lat] = this.speedRules(inp, this.vx * fx + this.vy * fy + this.vz * fz, this.vx * lx + this.vy * ly + this.vz * lz);
    this.vx = fwd * fx + lat * lx; this.vy = fwd * fy + lat * ly; this.vz = fwd * fz + lat * lz;
    // Gravity's pull along the floor (its part into the floor is held by the floor).
    this.vx -= GRAVITY * n.ny * n.nx; this.vy += GRAVITY * (1 - n.ny * n.ny); this.vz -= GRAVITY * n.ny * n.nz;
    this.x += this.vx; this.y += this.vy; this.z += this.vz;

    // Stay on the surface: look for it back along the normal, from a step "above" it.
    const sp = Math.hypot(this.vx, this.vy, this.vz);
    const hit = this.col.surface(
      [this.x + n.nx * STEP, this.y + n.ny * STEP, this.z + n.nz * STEP], [-n.nx, -n.ny, -n.nz], STEP + 8 + sp * 0.5, [n.nx, n.ny, n.nz]);
    let g: Ground | null = hit;
    if (hit) { this.x = hit.x; this.z = hit.z; }
    else {
      // Over the top onto a flat ledge.
      const f = this.col.ground(this.x, this.z, this.y, STEP);
      if (f && Math.abs(f.y - this.y) < 24) g = f;
    }
    if (g) {
      const away = this.vx * g.nx + this.vy * g.ny + this.vz * g.nz;
      // Faster than the floor curves away (a lip), or too slow to cling to a near-vertical wall.
      if (away > 6 || (g.ny > -0.35 && sp < 12)) g = null;
      else {
        this.y = g.y;
        this.floor = g;
        if (g.ny > -STEEP) this.alongFloor(g);
        else {
          // Back on a gentle floor: hand over to the horizontal model at the same speed.
          const k = sp / (Math.hypot(this.vx, this.vz) || 1);
          this.vx *= k; this.vz *= k; this.vy = 0;
        }
      }
    }
    if (!g) { this.grounded = false; this.climb = 0; }

    const w = this.col.walls(this.x, this.z, this.y, HEIGHT, RADIUS, [n.nx, n.ny, n.nz]);
    if (w) {
      this.x += w.dx; this.z += w.dz;
      const into = this.vx * w.nx + this.vz * w.nz;
      if (into < 0) { this.vx -= w.nx * into; this.vz -= w.nz * into; }
    }
  }

  /** Starts a loop ride when running into a loop's entry along the line (see engine/loops.ts). */
  private enterLoop(): boolean {
    for (const lp of this.col.loops) {
      // Anywhere on the lead-in (up the ramp or bank), moving along the line in 3D.
      const j = lp.pts.slice(0, LEAD_IN).findIndex((p, k) => {
        const q = lp.pts[k + 1], l = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) || 1;
        return Math.hypot(this.x - p[0], this.z - p[2]) < ENTRY_RADIUS && Math.abs(this.y - p[1]) < 300 &&
          (this.vx * (q[0] - p[0]) + this.vy * (q[1] - p[1]) + this.vz * (q[2] - p[2])) / l > 20;
      });
      if (j < 0) {
        // Dropped into the middle (the tube is enclosed in the original; here it has no walls):
        // join the ride at the nearest point of its unsupported stretch.
        const m = lp.pts.findIndex((p, k) => k >= LEAD_IN && k < lp.pts.length - LEAD_IN &&
          Math.hypot(this.x - p[0], this.y - (p[1] + 100), this.z - p[2]) < 180);
        if (m < 0) continue;
        const rest = { ...lp, pts: lp.pts.slice(m) };
        const last = rest.pts[rest.pts.length - 1];
        const exit = this.col.ground(last[0], last[2], last[1] + 400, 500);
        this.ride = ridePath(rest, this.x, this.y, this.z, exit ? exit.y : last[1] + 100);
        this.rideS = 0;
        this.rideSpeed = Math.max(30, Math.hypot(this.vx, this.vy, this.vz));
        return true;
      }
      const last = lp.pts[lp.pts.length - 1];
      const exit = this.col.ground(last[0], last[2], last[1] + 400, 500);
      this.ride = ridePath(lp, this.x, this.y, this.z, exit ? exit.y : last[1] + 100);
      this.rideS = 0;
      this.rideSpeed = Math.hypot(this.vx, this.vz);
      return true;
    }
    return false;
  }

  /** One tick of a loop ride: velocity and heading stay frozen (as recorded), gravity is off. */
  private rideTick(): TickResult {
    const ride = this.ride!;
    this.rideS += this.rideSpeed;
    const p = rideAt(ride, this.rideS, [0, 0, 0]);
    this.x = p[0]; this.y = p[1]; this.z = p[2];
    this.vy = 0;
    this.grounded = false;
    if (this.rideS >= ride.length) {
      this.ride = null;
      // Leave along the line (on Island's loop that is the entry heading, as recorded).
      const sp = this.rideSpeed;
      this.vx = ride.ex * sp; this.vz = ride.ez * sp;
      this.yaw = ((Math.atan2(ride.ex, ride.ez) * 2048) / Math.PI + 4096) % 4096;
      // (Only a floor right there: ground() also returns the playfield plane far below.)
      const g = this.col.ground(this.x, this.z, this.y, STEP);
      if (g && g.y <= this.y + STEP) { this.y = g.y; this.floor = g; this.grounded = true; }
    }
    return { jumped: false };
  }

  /** World-space "up" for drawing the racer: the floor normal, or towards the loop's centre. */
  up(out: THREE.Vector3) {
    if (this.ride) {
      const r = this.ride;
      out.set(r.cx - this.x, this.y - r.cy, r.cz - this.z);
      return out.lengthSq() > 1e-6 ? out.normalize() : out.set(0, 1, 0);
    }
    return this.grounded ? out.set(this.floor.nx, -this.floor.ny, this.floor.nz).normalize() : out.set(0, 1, 0);
  }

  /** Interpolated world-space position (feet) and forward direction for rendering. */
  pose(alpha: number, pos: THREE.Vector3, dir: THREE.Vector3) {
    const p = this.prev;
    let dy = this.yaw - p.yaw;
    if (dy > 2048) dy -= 4096; else if (dy < -2048) dy += 4096;
    const yaw = (p.yaw + dy * alpha) * (Math.PI / 2048);
    terToWorld(p.x + (this.x - p.x) * alpha, p.y + (this.y - p.y) * alpha, p.z + (this.z - p.z) * alpha, pos);
    return terDirToWorld(Math.sin(yaw), Math.cos(yaw), dir);
  }
}

/**
 * `.ter` space → Three.js world: only Y flips (its Z already matches loader space; checked by
 * raycasting the render mesh at floor-quad centres: mean error 4 units).
 */
export function terToWorld(x: number, y: number, z: number, out = new THREE.Vector3()) {
  return out.set(x, -y, z).multiplyScalar(WORLD_SCALE);
}
export function worldToTer(p: THREE.Vector3) {
  return { x: p.x / WORLD_SCALE, y: -p.y / WORLD_SCALE, z: p.z / WORLD_SCALE };
}
export function terDirToWorld(dx: number, dz: number, out = new THREE.Vector3()) {
  return out.set(dx, 0, dz);
}

export class OriginalRunner {
  orig: OrigRacer;
  readonly ter?: OrigTerrain;
  readonly charIndex: number;
  readonly vmax: number; readonly accel: number; readonly grip: number; readonly drag: number;
  turn: number;
  prev: State = { x: 0, y: 0, z: 0, yaw: 0 };
  private start: State = { x: 0, y: 0, z: 0, yaw: 0 };
  private jumpHeld = false;

  ride: RidePath | null = null;
  rideS = 0;
  rideSpeed = 0;

  doubleJumped = false;
  flying = false;
  flyTicks = 0;
  gliding = false;

  constructor(readonly col: Collision, charIndex = 0, origTerrain?: OrigTerrain) {
    this.charIndex = charIndex;
    this.ter = origTerrain ?? col.origTerrain;
    const T = PHYS_TABLE[charIndex] ?? PHYS_TABLE[0];
    this.vmax = T[0] * FX;
    this.accel = Math.trunc(T[1] * 3 / 2) * FX;
    this.turn = (T[2] * 37) / 35;
    this.grip = T[3] * FX;
    this.drag = T[4] * FX;
    this.orig = newRacer(charIndex, 0, 0, 0, 0);
  }

  get x() { return this.orig.x * FX; }
  set x(v: number) { this.orig.x = Math.trunc(v * 4096); }
  get y() { return this.orig.y * FX; }
  set y(v: number) { this.orig.y = Math.trunc(v * 4096); }
  get z() { return this.orig.z * FX; }
  set z(v: number) { this.orig.z = Math.trunc(v * 4096); }
  get yaw() { return this.orig.yaw; }
  set yaw(v: number) { this.orig.yaw = v & 0xfff; }
  get vx() { return this.orig.vx * FX; }
  set vx(v: number) { this.orig.vx = Math.trunc(v * 4096); }
  get vy() { return this.orig.vy * FX; }
  set vy(v: number) { this.orig.vy = Math.trunc(v * 4096); }
  get vz() { return this.orig.vz * FX; }
  set vz(v: number) { this.orig.vz = Math.trunc(v * 4096); }
  get grounded() { return this.orig.grounded !== 0; }
  set grounded(v: boolean) { this.orig.grounded = v ? 1 : 0; }
  get speed() { return this.orig.fwd * FX; }

  spawn(x: number, y: number, z: number, yaw: number) {
    this.start = { x, y, z, yaw };
    this.reset();
  }

  reset() {
    this.orig = newRacer(this.charIndex, Math.trunc(this.start.x * 4096), Math.trunc(this.start.y * 4096), Math.trunc(this.start.z * 4096), this.start.yaw);
    this.doubleJumped = false;
    this.flying = false;
    this.flyTicks = 0;
    this.gliding = false;
    this.ride = null;
    if (this.ter) {
      collide(this.ter, this.orig);
    } else {
      const g = this.col.ground(this.x, this.z, this.y + 400, 700);
      if (g) { this.y = g.y; this.grounded = true; }
    }
    this.prev = { x: this.x, y: this.y, z: this.z, yaw: this.yaw };
  }

  copyFrom(src: OriginalRunner) {
    this.orig = { ...src.orig, n: [src.orig.n[0], src.orig.n[1], src.orig.n[2]] };
    this.ride = src.ride ? { ...src.ride } : null;
    this.rideS = src.rideS;
    this.rideSpeed = src.rideSpeed;
    this.prev = { ...src.prev };
    this.jumpHeld = src.jumpHeld;
    this.doubleJumped = src.doubleJumped;
    this.flying = src.flying;
    this.flyTicks = src.flyTicks;
    this.gliding = src.gliding;
  }

  boost(impulse = 0x6000 * 4096) {
    const s = sinLut[this.orig.yaw & 0xfff] >> 2;
    const c = sinLut[(this.orig.yaw & 0xfff) + 1024] >> 2;
    this.orig.vx += Math.trunc((impulse * s) / 4096);
    this.orig.vz += Math.trunc((impulse * c) / 4096);
  }

  private enterLoop(): boolean {
    for (const lp of this.col.loops) {
      const j = lp.pts.slice(0, LEAD_IN).findIndex((p, k) => {
        const q = lp.pts[k + 1], l = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) || 1;
        return Math.hypot(this.x - p[0], this.z - p[2]) < ENTRY_RADIUS && Math.abs(this.y - p[1]) < 300 &&
          (this.vx * (q[0] - p[0]) + this.vy * (q[1] - p[1]) + this.vz * (q[2] - p[2])) / l > 20;
      });
      if (j < 0) {
        const m = lp.pts.findIndex((p, k) => k >= LEAD_IN && k < lp.pts.length - LEAD_IN &&
          Math.hypot(this.x - p[0], this.y - (p[1] + 100), this.z - p[2]) < 180);
        if (m < 0) continue;
        const rest = { ...lp, pts: lp.pts.slice(m) };
        const last = rest.pts[rest.pts.length - 1];
        const exit = this.col.ground(last[0], last[2], last[1] + 400, 500);
        this.ride = ridePath(rest, this.x, this.y, this.z, exit ? exit.y : last[1] + 100);
        this.rideS = 0;
        this.rideSpeed = Math.max(30, Math.hypot(this.vx, this.vy, this.vz));
        return true;
      }
      const last = lp.pts[lp.pts.length - 1];
      const exit = this.col.ground(last[0], last[2], last[1] + 400, 500);
      this.ride = ridePath(lp, this.x, this.y, this.z, exit ? exit.y : last[1] + 100);
      this.rideS = 0;
      this.rideSpeed = Math.hypot(this.vx, this.vz);
      return true;
    }
    return false;
  }

  private rideTick(): TickResult {
    const ride = this.ride!;
    this.orig.px = this.orig.x;
    this.orig.py = this.orig.y;
    this.orig.pz = this.orig.z;
    this.rideS += this.rideSpeed;
    const p = rideAt(ride, this.rideS, [0, 0, 0]);
    this.x = p[0]; this.y = p[1]; this.z = p[2];
    this.vy = 0;
    this.grounded = false;
    if (this.rideS >= ride.length) {
      this.ride = null;
      const sp = this.rideSpeed;
      this.vx = ride.ex * sp; this.vz = ride.ez * sp;
      this.yaw = ((Math.atan2(ride.ex, ride.ez) * 2048) / Math.PI + 4096) % 4096;
      if (this.ter) {
        this.orig.vx = Math.trunc(this.vx * 4096);
        this.orig.vz = Math.trunc(this.vz * 4096);
        this.orig.yaw = this.yaw;
        collide(this.ter, this.orig);
      }
    }
    return { jumped: false };
  }

  tick(inp: Input): TickResult {
    let jumped = false;
    let ability: AbilityEvent | undefined;
    this.prev = { x: this.x, y: this.y, z: this.z, yaw: this.yaw };

    if (this.ride || this.enterLoop()) {
      this.jumpHeld = inp.jump;
      return this.rideTick();
    }

    let inputWord = 0;
    if (inp.accel) inputWord |= 0x1000;
    if (inp.steer < -0.2) {
      inputWord |= 0x4000;
      if (inp.steer < -0.5) inputWord |= 0x0008;
    } else if (inp.steer > 0.2) {
      inputWord |= 0x8000;
      if (inp.steer > 0.5) inputWord |= 0x0080;
    }
    if (inp.brake) inputWord |= 0x0088;
    if (inp.jump) inputWord |= 0x0400;

    const wasAir = this.orig.air;
    if (this.ter?.playfieldWater) {
      updateWater(this.orig, this.ter.playfieldWater);
    }
    physicsTick(this.orig, inputWord);
    if (this.ter) {
      if (springs(this.ter, this.orig)) {
        ability = 'spring';
      }
      collide(this.ter, this.orig);
    }

    if (this.orig.hasJumped && !wasAir) {
      jumped = true;
    }
    if (this.orig.special === 1) ability = 'fly';
    else if (this.orig.special === 4) ability = 'glide';
    else if (this.orig.air === 1 && wasAir > 1) ability = 'doublejump';

    this.jumpHeld = inp.jump;
    return { jumped, ability };
  }

  up(out: THREE.Vector3) {
    if (this.ride) {
      const r = this.ride;
      out.set(r.cx - this.x, this.y - r.cy, r.cz - this.z);
      return out.lengthSq() > 1e-6 ? out.normalize() : out.set(0, 1, 0);
    }
    return this.grounded
      ? out.set(this.orig.n[0], -this.orig.n[1], this.orig.n[2]).normalize()
      : out.set(0, 1, 0);
  }

  pose(alpha: number, pos: THREE.Vector3, dir: THREE.Vector3) {
    const p = this.prev;
    let dy = this.yaw - p.yaw;
    if (dy > 2048) dy -= 4096; else if (dy < -2048) dy += 4096;
    const yaw = (p.yaw + dy * alpha) * (Math.PI / 2048);
    terToWorld(p.x + (this.x - p.x) * alpha, p.y + (this.y - p.y) * alpha, p.z + (this.z - p.z) * alpha, pos);
    return terDirToWorld(Math.sin(yaw), Math.cos(yaw), dir);
  }
}
