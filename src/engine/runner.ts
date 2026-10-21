import { OrigRacer, OrigTerrain, newRacer, physicsTick, collide, collideRacers, springs, updateWater, ringDash, sinLut, PHYS_TABLE } from './original';
/**
 * One racer's movement at the original fixed 30 Hz tick: a wrapper over the disassembled physics
 * in `original.ts` (0x485768). Units: `.ter` space (runner pos >> 12, Y down); velocities in
 * units/tick, so the 20.12 table values are divided by 4096.
 */
import * as THREE from 'three';
import type { Collision } from './collision';
import { WORLD_SCALE } from './trackScene';
import { ENTRY_RADIUS, LEAD_IN, ridePath, rideAt, type RidePath } from './loops';

export const TICK = 1 / 30;
const FX = 1 / 4096;

/** `spin` holds the spin dash (Sonic, Tails, Knuckles); pressing `accel` while charging revs it. */
export interface Input { accel: boolean; brake: boolean; steer: number; jump: boolean; spin?: boolean }

export type AbilityEvent = 'doublejump' | 'fly' | 'glide' | 'spring' | 'boost' | 'roll' | 'rev' | 'spindash';

export interface TickResult {
  jumped: boolean;
  ability?: AbilityEvent;
}

interface State { x: number; y: number; z: number; yaw: number }

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
  private start: State & { pri: number } = { x: 0, y: 0, z: 0, yaw: 0, pri: 0 };
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

  /** `pri`: starting floor layer (+a4), see startSlot. */
  spawn(x: number, y: number, z: number, yaw: number, pri = 0) {
    this.start = { x, y, z, yaw, pri };
    this.reset();
  }

  reset() {
    this.orig = newRacer(this.charIndex, Math.trunc(this.start.x * 4096), Math.trunc(this.start.y * 4096), Math.trunc(this.start.z * 4096), this.start.yaw);
    this.orig.pri = this.start.pri;
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
    if (inp.spin) inputWord |= inp.accel ? 0x2100 : 0x2000;

    const wasBoost = this.orig.special === 3;
    this.orig.anim = 0;
    if (this.ter?.playfieldWater) {
      updateWater(this.orig, this.ter.playfieldWater);
    }
    physicsTick(this.orig, inputWord);
    // Animation requests of 0x485768 (+ea) and the 0x485a85 abilities.
    const anim = this.orig.anim;
    jumped = anim === 7;
    if (anim === 0xd) ability = 'doublejump';
    else if (anim === 8) ability = 'rev';
    else if (anim === 9) ability = 'spindash';
    else if (anim === 0xa) ability = 'roll';
    else if (this.orig.special === 1) ability = 'fly';
    else if (this.orig.special === 4) ability = 'glide';
    else if (this.orig.special === 3 && !wasBoost) ability = 'boost';
    if (this.ter) {
      if (springs(this.ter, this.orig)) {
        ability = 'spring';
      }
      collide(this.ter, this.orig);
      ringDash(this.ter, this.orig);
    }

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

/**
 * Racer-vs-racer pass (0x4c9044): call once per tick after every runner has ticked, in slot order
 * (player first). Runners on a loop ride are left out (their velocity belongs to the ride).
 * Returns the runners that were hit, e.g. for a bump sound.
 */
export function collideRunners(runners: readonly OriginalRunner[]): OriginalRunner[] {
  const free = runners.filter((r) => !r.ride);
  const hit = collideRacers(free.map((r) => r.orig));
  return free.filter((_, i) => hit[i]);
}
