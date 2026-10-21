/**
 * Bit-exact port of one racer's 30 Hz tick from sonicr.exe (M3/M4, plan A.11): the running physics
 * of 0x485768 and the terrain collision of 0x4d8ab8 (walls 0x4d848c/0x4d7f2c/0x4d8178, floor search
 * 0x4d75f0 with point-in-quad 0x4d67d8 and height 0x4d6c1c, ground/normal 0x4d793c, slope rescale
 * 0x4d6b00, snap 0x4d6bf8 and the camber yaw drift of 0x4d5220). All integer: positions and speeds
 * in 20.12 like the original struct, angles in 12 bits, and every division truncates like `idiv`.
 *
 * Checked against the golden recording (`work/tools/golden/p1_struct_*.rec`, Sonic on Island):
 * see original.test.ts. Not ported yet: jumps (0x4853a8), spin dash and character abilities
 * (the 0x485a85 switch), springs (0x4855e8), loop rides (0x4d59f8), racer-vs-racer (0x4201a0)
 * and the water level, which the caller supplies (`water`, from 0x4819b0/0x481a2c).
 */

// ---------- sine LUT 0x92568c (2^14 scale; cos = sin + 1024) ----------
const SIN = new Int32Array(5120);
for (let i = 0; i < 5120; i++) SIN[i] = Math.max(-16383, Math.min(16383, Math.trunc(16384 * Math.sin((i * 2 * Math.PI) / 4096))));
// x87 rounding in the original's generator (dumped at run time, plan A.2).
SIN[2004] = 1104; SIN[4052] = -1104; SIN[4414] = 7679;
export const sinLut = SIN;
const sin4 = (a: number) => SIN[a & 0xfff] >> 2;
const cos4 = (a: number) => SIN[(a & 0xfff) + 1024] >> 2;

/** `idiv`: truncating division (exact while |a| < 2^53). */
const tdiv = (a: number, b: number) => Math.trunc(a / b);
/** The `sar edx,31 / shl / sbb / sar n` idiom: signed shift that truncates towards zero. */
const tsar = (a: number, n: number) => Math.trunc(a / (1 << n));
/** 32-bit wrap of an exact integer product sum. */
const w32 = (a: number) => a | 0;
/** fsqrt + __CHP (0x4e08ca, truncate) + fistp, then `shl 8 / sar 8`. */
const isqrt24 = (v: number) => (Math.trunc(Math.sqrt(v)) << 8) >> 8;
/** atan2 · 4096/2π, truncated, sign-extended from 28 bits (the `shl 4 / sar 4` after fistp). */
const atan12 = (y: number, x: number) => (Math.trunc(Math.atan2(y, x) * 4096 * 0.15915494327375637) << 4) >> 4;

/** Physics table 0x5016b4 (10 × i32 per character, same order as CHARACTERS). */
export const PHYS_TABLE = [
  [208896, 3584, 35, 4608, 1024, 49, 0, 221184, 98304, 147456], // Sonic
  [184320, 4096, 45, 2048, 512, 56, 147456, 196608, 98304, 110592], // Tails
  [208896, 4608, 35, 3584, 2048, 56, 196608, 196608, 98304, 122880], // Knuckles
  [147456, 5120, 35, 3584, 2560, 0, 221184, 0, 0, 135168], // Amy
  [172032, 3584, 40, 3072, 512, 0, 0, 0, 0, 172032], // Robotnik
  [221184, 4096, 35, 2560, 1536, 70, 0, 0, 122880, 0], // Metal Sonic
  [184320, 3072, 25, 4096, 0, 0, 0, 0, 0, 147456], // Tails Doll
  [221184, 5120, 30, 4096, 1536, 70, 208896, 0, 110592, 0], // Metal Knuckles
  [184320, 5120, 35, 4608, 1536, 0, 0, 0, 98304, 0], // Egg Robo
  [245760, 5120, 40, 4608, 512, 56, 0, 245760, 98304, 172032], // Super Sonic
];

/** Input word `[0x9020c8 + 2n]`: low byte / high byte bits as 0x485768 tests them. */
export const IN = {
  ACCEL: 0x1000, // high 0x10 (0x01 also counts)
  LEFT: 0x4000, // high 0x40: yaw −
  RIGHT: 0x8000, // high 0x80: yaw +
  /** Low 0x08 and 0x80 together brake; alone they widen / tighten the turn by ±0x200/1024. */
  SHARP: 0x0008,
  SOFT: 0x0080,
} as const;

/** The racer struct fields the ported code reads and writes (struct offset in the comments). */
export interface OrigRacer {
  char: number; // +f2
  x: number; y: number; z: number; // +00 +04 +08
  yaw: number; // +10
  px: number; py: number; pz: number; // +20 +24 +28, previous tick
  dy: number; // +e4 last tick's rise (the vertical speed kept when the floor drops away)
  vx: number; vy: number; vz: number; // +2c +30 +34
  floorY: number; // +38
  fwd: number; lat: number; // +44 +48 local speeds
  water: number; // +68 sink level (0x10000 per step, 0x60000 = deep)
  drift: number; // +6c skid counter
  driftDir: number; // +6e
  grounded: number; // +72
  jumpLock: number; // +78
  air: number; // +96
  pri: number; // +a4 floor layer
  sector: number; quad: number; // +a8 +ac floor face
  hasFloor: number; // +b0
  prevHasFloor?: number; // +b2
  n: [number, number, number]; // +b4 +b6 +b8 floor normal (4096 = 1)
  hitWall: number; // +ba
  rings: number; // +18 (vmax += vmax·rings/1000)
  camber: number; // +de yaw drift while grounded
  alt40: number; // +40 (1 → vmax = table +24)
  slide42: number; // +42
  hasJumped?: number; // +76 (jump initiated from ground)
  special?: number; // +fe (character ability: 1 Tails fly, 3 Amy boost, 4 Knuckles glide)
  boostTimer?: number; // +7e (Amy boost charge timer)
}

export function newRacer(char: number, x: number, y: number, z: number, yaw: number): OrigRacer {
  return {
    char, x, y, z, yaw, px: x, py: y, pz: z, dy: 0, vx: 0, vy: 0, vz: 0, floorY: y, fwd: 0, lat: 0, water: 0,
    drift: 0, driftDir: 0, grounded: 1, jumpLock: 0, air: 0, pri: 0, sector: 0, quad: 0, hasFloor: 0,
    prevHasFloor: 0,
    n: [0, -4096, 0], hitWall: 0, rings: 0, camber: 0, alt40: 0, slide42: 0,
    hasJumped: 0, special: 0, boostTimer: 0,
  };
}

/**
 * 0x4853a8: jump impulse projected onto surface normal and previous horizontal displacement.
 */
export function jump(r: OrigRacer, jumpImpulse: number): number {
  const ret_y = -(jumpImpulse << 12);
  const vx12 = r.vx >> 12, vz12 = r.vz >> 12;
  const [nx, ny, nz] = r.n;
  if ((vx12 === 0 && vz12 === 0) || (nx === 0 && nz === 0)) return ret_y;

  const ny5 = ny * 5;
  const len1 = isqrt24(nx * nx + ny5 * ny5 + nz * nz);
  const imp_x = tdiv((nx << 12) * jumpImpulse, len1);
  const imp_y = tdiv((ny5 << 12) * jumpImpulse, len1);
  const imp_z = tdiv((nz << 12) * jumpImpulse, len1);

  const dx = r.x - r.px, dy = r.y - r.py, dz = r.z - r.pz;
  const ecx = (-dx) >> 12, ebx = (-dz) >> 12;
  if (ecx === 0 && ebx === 0) {
    r.vx = imp_x;
    r.vy = imp_y;
    r.vz = imp_z;
    return imp_y;
  }
  const len2 = isqrt24(ecx * ecx + ebx * ebx);
  const dir_x = tdiv(ecx << 12, len2);
  const dir_z = tdiv(ebx << 12, len2);
  const dot = tsar(nx * dir_x + nz * dir_z, 12);
  if (dot <= 0) {
    r.vx = dx + imp_x;
    r.vy = dy + imp_y;
    r.vz = dz + imp_z;
    return imp_y;
  } else {
    const cx = tsar(nx * dot, 11) - dir_x;
    const cz = tsar(nz * dot, 11) - dir_z;
    r.vx = len2 * cx;
    r.vz = len2 * cz;
    r.vy = -(jumpImpulse << 12);
    return imp_y;
  }
}

/**
 * 0x4855e8: sector launchers and springs.
 */
export function springs(t: OrigTerrain, r: OrigRacer): boolean {
  const sec = t.sector(r.sector);
  const attr = sec.spring;
  if (!attr) return false;
  if (r.hasFloor !== 1 || !r.grounded) return false;

  if (attr & 0x8000) {
    const mag = attr & 0xfff;
    r.vx += r.n[0] * mag;
    r.vz += r.n[2] * mag;
  } else if (attr & 0x4000) {
    r.vx = 0;
    r.vz = 0;
  }
  const mag = attr & 0xfff;
  r.vy = -mag * 0xd05;
  r.air = 1;
  r.grounded = 0;
  return true;
}


/**
 * Running physics of 0x485768 (state +0x86 < 2, no jump): slope push, steering, local-frame grip,
 * drag, acceleration and caps, then x/z += velocity and gravity on y.
 */
export function physicsTick(r: OrigRacer, input: number) {
  const T = PHYS_TABLE[r.char];
  const lo = input & 0xff, hi = (input >> 8) & 0xff;
  let vmax = T[0], accel = tdiv(T[1] * 3, 2), turn = T[2], grip = T[3];
  const drag = T[4];
  r.dy = r.y - r.py;
  r.px = r.x; r.py = r.y; r.pz = r.z;
  const grounded = r.grounded !== 0;

  // Floors steeper than ny = −3784 push down the slope (half as hard while accelerating).
  if (grounded && r.n[1] > -3784 && r.slide42 === 0) {
    const k = hi & 0x11 && !(lo & 8 && lo & 0x80);
    r.vx += k ? r.n[0] >> 1 : r.n[0] * 2;
    r.vz += k ? r.n[2] >> 1 : r.n[2] * 2;
  }

  // Jump and gravity (0x4853a8 / 0x486106..0x48629a)
  const jumpImpulse = T[5] >> 1;
  const jumpPressed = (input & 0x620) !== 0;

  if (jumpPressed && r.water === 0 && r.jumpLock === 0 && grounded && jumpImpulse > 0) {
    r.hasJumped = 1;
    r.grounded = 0;
    r.air = 2;
    const ret = jump(r, jumpImpulse);
    r.vy = ret + 0x2000;
    if (r.vy > 0x25800) r.vy = 0x25800;
  } else if (!jumpPressed && r.hasJumped) {
    r.hasJumped = 0;
    if (r.vy < 0) {
      let v = r.vy;
      if (v < -0xc800) v += 0x6000;
      r.vy = tsar(v, 1);
    }
    if (grounded) r.vy = 0;
    else r.air = (r.air || 0) + 1;
  } else if (!grounded) {
    // Airborne abilities (0x485a85)
    if (r.char === 0 || r.char === 9) {
      if (r.air === 10 && jumpPressed && !r.hasJumped) {
        r.vy = -0x20000;
        r.air = 1;
      }
    } else if (r.char === 1) {
      if (jumpPressed && (r.air || 0) >= 2 && (!r.special || r.special === 1) && (r.air || 0) <= 60) {
        r.special = 1;
        r.vy = 0;
      } else {
        r.special = 0;
      }
    } else if (r.char === 2 || r.char === 7) {
      if (jumpPressed && (!r.special || r.special === 4)) {
        r.special = 4;
        r.vy = 0x6000;
        r.air = 3;
      } else {
        r.special = 0;
      }
    }
    if (r.special !== 1 && r.special !== 4) {
      r.vy = Math.min(r.vy + 0x2000, 0x25800);
    }
    r.air = (r.air || 0) + 1;
  } else {
    r.vy = 0;
  }
  r.y += r.vy;

  // Effective top speed: rings bonus, water, abilities.
  if (r.char === 3) {
    if (jumpPressed && r.special !== 2) {
      if (!r.boostTimer) r.boostTimer = 0x186;
    }
    if (r.boostTimer && r.boostTimer > 0) {
      if (r.boostTimer > 0x12c) {
        r.special = 3;
        r.slide42 = 2;
        vmax *= 2;
      } else {
        if (r.special === 3) r.special = 0;
        r.slide42 = 0;
      }
      r.boostTimer--;
    }
  }

  vmax += tdiv(r.rings * vmax, 1000);
  const inWater = r.water !== 0;
  if (inWater) vmax = r.water === 0x60000 ? T[8] : tdiv(T[8], 2);
  else if (r.alt40 === 1) vmax = T[9];

  let k = 0;
  if (!inWater) k = ((lo & 8 ? 0x200 : 0) - (lo & 0x80 ? 0x200 : 0)) << 16 >> 16;
  if (r.char === 0 && !grounded) { k >>= 1; turn >>= 1; }
  if (r.fwd === 0 && r.lat === 0) { turn = tdiv(turn, 2); k = tdiv(k, 2); }
  if (r.driftDir) { grip = tdiv(grip, 2); accel *= 2; }

  // Steering.
  if (!(lo & 8 && lo & 0x80 && r.fwd !== 0)) {
    const e = tsar(k * turn, 10);
    if (hi & 0x40) {
      if (k) {
        turn += e;
        if (r.fwd < r.lat && r.fwd > 0x8000) r.driftDir = 1;
      }
      r.yaw -= turn;
    } else if (hi & 0x80) {
      if (k) {
        turn -= e;
        if (-r.fwd > r.lat && -r.fwd < -0x8000) r.driftDir = -1;
      }
      r.yaw += turn;
    } else r.yaw -= k >> 5;
  }
  if (r.driftDir === 1 && r.lat <= r.fwd) r.driftDir = 0;
  if (r.driftDir === -1 && -r.fwd <= r.lat) r.driftDir = 0;
  if (grounded) r.yaw += r.camber;
  r.yaw &= 0xfff;

  // World → local (yaw negated), forward/lateral rules, back to world.
  const a = (0x1000 - r.yaw) & 0xfff, s = sin4(a), c = cos4(a);
  let lat = tsar(w32(r.vx * c + r.vz * s), 12), fwd = tsar(w32(r.vz * c - r.vx * s), 12);
  const g = (grip * k) >> 10;
  if (lat < 0) { lat += grip - g; if (lat > 0) lat = 0; }
  else if (lat > 0) { lat -= g + grip; if (lat < 0) lat = 0; }
  if (fwd < 0) { fwd += drag * 2; if (fwd > 0) fwd = 0; }
  else if (fwd > 0) { fwd -= drag * 2; if (fwd < 0) fwd = 0; }
  if (lo & 8 && lo & 0x80 && grounded) {
    if (fwd > 0) {
      r.drift = Math.abs(r.lat) < Math.abs(r.fwd) && r.fwd > 0x1000 ? r.drift + 1 : 0;
      fwd -= accel;
      if (fwd < 0) fwd = 0;
    } else r.drift = 0;
  } else if (hi & 0x11) {
    r.drift = -1;
    if (fwd < vmax) fwd += accel;
  } else r.drift = 0;
  lat = Math.max(-vmax, Math.min(vmax, lat));
  if (inWater && fwd > vmax) fwd -= 0x1000;
  if (fwd < -vmax) fwd += 0x4000;
  fwd = Math.max(-0x44000, Math.min(0x44000, fwd));
  r.lat = lat; r.fwd = fwd;
  const s2 = sin4(r.yaw), c2 = cos4(r.yaw);
  r.vx = tsar(w32(fwd * s2 + lat * c2), 12);
  r.vz = tsar(w32(fwd * c2 - lat * s2), 12);
  r.x += r.vx; r.z += r.vz;
}

export interface PlayfieldWater {
  map: Uint8Array;
  ply?: Uint8Array;
  bounds: { x0: number; z0: number; x1: number; z1: number; s: number };
}

// ---------- collision mesh, read as the original does (raw .ter bytes) ----------
export class OrigTerrain {
  private v: DataView;
  private off: number[];
  readonly x0: number; readonly z0: number; readonly cx: number; readonly cz: number;
  playfieldWater?: PlayfieldWater;
  constructor(buf: ArrayBuffer | Uint8Array, readonly track = 1) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.off = Array.from({ length: 10 }, (_, i) => this.v.getUint32(i * 4, true));
    [this.x0, this.z0, this.cx, this.cz] = [9, 10, 11, 12].map((i) => this.v.getInt32(40 + i * 4, true));
  }
  h(a: number) { return this.v.getInt16(a, true); }
  private vert(o: number): [number, number, number] { const a = this.off[0] + o; return [this.h(a), this.h(a + 2), this.h(a + 4)]; }
  quadVerts(q: number) { const a = this.off[1] + q * 14; return [0, 2, 4, 6].map((k) => this.vert(this.v.getUint16(a + k, true))); }
  quadNormal(q: number): [number, number, number] { const a = this.off[1] + q * 14; return [this.h(a + 8), this.h(a + 10), this.h(a + 12)]; }
  sector(i: number) {
    const a = this.off[2] + i * 16;
    return { first: this.h(a), n: this.h(a + 2), cx: this.h(a + 4), cz: this.h(a + 6), r2: this.v.getInt32(a + 8, true), spring: this.h(a + 12), pri: this.h(a + 14) };
  }

  wall(i: number) {
    const a = this.off[3] + i * 16, b = (k: number) => this.v.getUint8(a + k);
    return { first: this.h(a), n: b(2), kind: b(3), brk: b(4), chk: b(5), mask: this.v.getUint16(a + 6, true), cx: this.h(a + 8), cz: this.h(a + 10), r2: this.v.getInt32(a + 12, true) };
  }
  wallPoint(k: number): [number, number, number] { const a = this.off[4] + k * 6; return [this.h(a), this.h(a + 2), this.h(a + 4)]; }
  /** Grid cell list (off[7] → off[8]) for a 20.12 position: entries until one with bit 15. */
  *cell(x: number, z: number) {
    const cell = tdiv((z >> 12) - this.z0, this.cz) * 32 + tdiv((x >> 12) - this.x0, this.cx);
    let a = this.off[8] + 2 * this.h(this.off[7] + 2 * cell);
    for (;;) {
      const e = this.h(a); a += 2;
      yield e;
      if (e & 0x8000) return;
    }
  }
}

type V3 = [number, number, number];
/** Which side of A→B the point (px, pz) lies on, in 20.12 with A, B in mesh units (64-bit sign). */
function side(px: number, pz: number, A: V3, B: V3) {
  const ax = BigInt(A[0]) << 12n, az = BigInt(A[2]) << 12n;
  return (BigInt(px) - ax) * ((BigInt(B[2]) << 12n) - az) - (BigInt(pz) - az) * ((BigInt(B[0]) << 12n) - ax) >= 0n;
}
const side2 = (P: [number, number], A: [number, number], B: [number, number]) =>
  (BigInt(P[0]) - BigInt(A[0])) * (BigInt(B[1]) - BigInt(A[1])) - (BigInt(P[1]) - BigInt(A[1])) * (BigInt(B[0]) - BigInt(A[0])) >= 0n;

/** 0x4d67d8: which quad of sector `si` contains (x, z) — binary search along the ribbon. */
function inQuad(t: OrigTerrain, x: number, z: number, si: number) {
  const sec = t.sector(si), f = sec.first, n = sec.n;
  const q0 = t.quadVerts(f);
  if (!side(x, z, q0[0], q0[1])) return -1;
  const ql = t.quadVerts(f + n - 1);
  if (!side(x, z, ql[2], ql[3])) return -1;
  let lo = 0, hi = n;
  if (n > 1) while (hi - lo > 1) {
    const mid = lo + tdiv(hi - lo, 2), V = t.quadVerts(f + mid);
    if (side(x, z, V[0], V[1])) lo = mid; else hi = mid;
  }
  const V = t.quadVerts(f + lo);
  return side(x, z, V[1], V[2]) && side(x, z, V[3], V[0]) ? lo : -1;
}

/** 0x4d6c1c: floor height (20.12) of quad `qi` of sector `si` at (x, z). */
function height(t: OrigTerrain, x: number, z: number, si: number, qi: number) {
  const V = t.quadVerts(t.sector(si).first + qi), X = x >> 12, Z = z >> 12;
  let a = V[0], b = V[2], c = V[3];
  if (!side(x, z, V[0], V[2])) { b = V[1]; c = V[2]; }
  if (b[2] < a[2]) [a, b] = [b, a];
  if (c[2] < b[2]) [b, c] = [c, b];
  if (b[2] < a[2]) [a, b] = [b, a];
  let P: V3, Q: V3, R: V3;
  if (b[2] > Z || c[2] === b[2]) { P = a; R = c; Q = b; } else { Q = a; P = c; R = b; }
  const dz = Math.abs(Z - P[2]);
  let x1 = P[0] << 12, x2 = x1, y1 = P[1] << 12, y2 = y1;
  if (dz) {
    const d = Math.abs(Q[2] - P[2]);
    if (d) { x1 = x2 + tdiv((Q[0] << 12) - x2, d) * dz; y1 = y2 + tdiv((Q[1] << 12) - y2, d) * dz; }
    const e = Math.abs(R[2] - P[2]);
    if (e) { const px = x2; x2 = px + tdiv((R[0] << 12) - px, e) * dz; y2 = y2 + tdiv((R[1] << 12) - y2, e) * dz; }
  }
  x1 >>= 12; x2 >>= 12;
  if (x1 === x2) return tdiv(y1 + y2, 2);
  if (x1 < x2) { const dx = Math.abs(X - x1); return dx ? y1 + tdiv(y2 - y1, x2 - x1) * dx : y1; }
  const dx = Math.abs(X - x2);
  return dx ? y2 + tdiv(y1 - y2, x1 - x2) * dx : y2;
}

/** 0x4d75f0: highest floor under (x, z) within the step limit; ground flags. */
function findFloor(t: OrigTerrain, r: OrigRacer) {
  r.hasFloor = 0;
  let best = 0, pri = 0;
  if (t.x0 << 12 > r.x) { r.vx = 0; r.x = t.x0 << 12; }
  if (t.z0 << 12 > r.z) { r.vz = 0; r.z = t.z0 << 12; }
  let m = (t.cx * 32 + t.x0 - 1) << 12;
  if (m < r.x) { r.vx = 0; r.x = m; }
  m = (t.cz * 32 + t.z0 - 1) << 12;
  if (m < r.z) { r.vz = 0; r.z = m; }
  const X = r.x >> 12, Z = r.z >> 12;
  for (const e of t.cell(r.x, r.z)) {
    if (e & 0x4000) continue;
    const si = e & 0xfff, sec = t.sector(si);
    if ((X - sec.cx) ** 2 + (Z - sec.cz) ** 2 >= sec.r2) continue;
    const qi = inQuad(t, r.x, r.z, si);
    if (qi < 0) continue;
    const h = height(t, r.x, r.z, si, qi);
    let take = false;
    if (sec.pri > r.pri) {
      if (r.air && h < r.y && r.y - h < 0x80000 && r.vy < 0) r.vy = 0;
      else if (t.track === 2 && si >= 0x1f5 && si <= 0x1f8) { /* City: skipped */ }
      else if (r.y - h < 0x40000) { r.hasFloor = 1; take = h <= best; }
    } else { r.hasFloor = 1; take = h <= best; }
    if (take) { pri = sec.pri; r.sector = si; r.quad = qi; best = h; }
  }
  r.floorY = best;
  if (pri < r.pri) {
    if (r.grounded) r.vy = r.dy;
    r.grounded = 0;
    if (r.air === 0) r.air = 1;
  }
  if (best <= r.y) r.grounded = 1;
  if (r.grounded) r.air = 0;
  r.pri = pri;
}

/** 0x4d793c: floor normal and whether the racer stays on the ground over a change of slope. */
function updateNormal(t: OrigTerrain, r: OrigRacer) {
  const [nx, ny, nz] = r.hasFloor === 1 ? t.quadNormal(t.sector(r.sector).first + r.quad) : [0, -4096, 0];
  if (r.air === 0) {
    if (r.y >= r.floorY) r.grounded = 1;
    else if (ny < -4080 && r.n[1] < -4080 && r.floorY - r.y > 0x19000) { r.air = 1; r.vy = 0; r.grounded = 0; }
    else {
      let d = 0x1000;
      const [ox, oy, oz] = r.n;
      if (!(ox === nx && oy === ny && oz === nz) && !(nx === 0 && nz === 0)) {
        const ang = atan12(nx, nz) & 0xfff, a = -ang & 0xfff;
        const A = tsar(nz * sin4(a) + nx * cos4(a), 12), B = tsar(nz * cos4(a) - nx * sin4(a), 12);
        const C = tsar(-ny * sin4(ang) + A * cos4(ang), 12), D = tsar(-ny * cos4(ang) - A * sin4(ang), 12);
        d = tsar(C * ox + oy * B + oz * D, 12);
      }
      if (d > -1060) r.grounded = 1;
      else { r.grounded = 0; r.air = 1; }
    }
  }
  r.n = [nx, ny, nz];
}

/** Wall segments of the cell whose layer mask has the racer's floor layer and in reach. */
function* wallSegments(t: OrigTerrain, r: OrigRacer) {
  const X = r.x >> 12, Z = r.z >> 12, bit = (1 << (r.pri & 0xff)) & 0xffff;
  for (const e of t.cell(r.x, r.z)) {
    if (!(e & 0x4000) || e === -1) continue;
    const w = t.wall(e & 0xfff);
    if (!(bit & w.mask) || (X - w.cx) ** 2 + (Z - w.cz) ** 2 > w.r2) continue;
    for (let k = 0; k < w.n - 1; k++) yield { w, P1: t.wallPoint(w.first + k), P2: t.wallPoint(w.first + k + 1) };
  }
}
/** Did this tick's move cross segment P1→P2 (with the original's 1/4096 widening)? */
function crosses(r: OrigRacer, P1: V3, P2: V3) {
  const dz = P2[2] - P1[2], dx = P2[0] - P1[0];
  const A: [number, number] = [(P1[0] << 12) - dx, (P1[2] << 12) - dz], B: [number, number] = [(P2[0] << 12) + dx, (P2[2] << 12) + dz];
  const cur: [number, number] = [r.x + dz, r.z - dx], prv: [number, number] = [r.px - dz, r.pz + dx];
  return side2(cur, A, B) && side2(prv, B, A) && side2(cur, A, prv) && side2(cur, prv, B);
}
/** 0x4d6184: wall top (20.12) at the move's midpoint. */
function wallTop(r: OrigRacer, P1: V3, P2: V3) {
  const dxw = P2[0] - P1[0], dzw = P2[2] - P1[2], a = -atan12(dxw, dzw) & 0xfff;
  const s = SIN[a], c = SIN[a + 1024];
  const mx = ((r.px + r.x) >> 1) - (P1[0] << 12), mz = ((r.pz + r.z) >> 1) - (P1[2] << 12);
  const L = tdiv(-(dxw * 4096) * s + dzw * 4096 * c, 4096);
  let u = tdiv(-mx * s + mz * c, 4096);
  if (u < 0) u = 0; else if (u > L) u = L;
  return tdiv((P2[1] - P1[1]) * 4096 * tdiv(u * 4096, L), 4096) + (P1[1] << 12);
}
/** 0x4d848c → 0x4d7f2c + 0x4d8178: bounce off the first wall crossed, then undo if still through one. */
function hitWalls(t: OrigTerrain, r: OrigRacer) {
  r.hitWall = 0;
  for (const { w, P1, P2 } of wallSegments(t, r)) {
    if (!crosses(r, P1, P2)) continue;
    if (w.chk && (r.y + r.py) >> 1 < wallTop(r, P1, P2)) continue;
    r.hitWall = 1;
    if (w.brk && (r.fwd > 0x18000 || r.air)) { r.vx = tdiv(r.vx * 3, 4); r.vz = tdiv(r.vz * 3, 4); return; }
    const ang = atan12(P2[0] - P1[0], P2[2] - P1[2]) & 0xfff, a = -ang & 0xfff;
    const dxm = r.x - r.px, dzm = r.z - r.pz;
    let u = tdiv(dxm * cos4(a) + dzm * sin4(a), 4096);
    const v = tdiv(-dxm * sin4(a) + dzm * cos4(a), 4096);
    u = tdiv(-Math.max(u, 1), 3);
    if (u > -0x3000) u = -0x3000;
    const vx = tdiv(u * cos4(ang) + v * sin4(ang), 4096), vz = tdiv(-u * sin4(ang) + v * cos4(ang), 4096);
    r.vx = vx; r.vz = vz;
    if (w.kind) {
      const dx = P1[0] - P2[0], dz = P1[2] - P2[2], L = isqrt24(dz * dz + dx * dx);
      r.vx += tdiv(dz * 4096, L) * w.kind; r.vz += tdiv(-dx * 4096, L) * w.kind;
    }
    r.x = r.px + vx; r.z = r.pz + vz;
    for (const s of wallSegments(t, r)) if (crosses(r, s.P1, s.P2)) { r.x = r.px; r.z = r.pz; break; }
    return;
  }
}

/** 0x4d6b00: on the ground, the move keeps its horizontal length along the floor (>> 6 precision). */
function slopeRescale(r: OrigRacer) {
  if (!r.grounded || r.hitWall) return;
  const dx = (r.x - r.px) >> 6, dy = (r.floorY - r.py) >> 6, dz = (r.z - r.pz) >> 6;
  const h = isqrt24(dx * dx + dz * dz), l = isqrt24(dx * dx + dz * dz + dy * dy);
  if (h > 0 && l > 0) {
    r.x = r.px + tdiv(h * dx, l) * 64;
    r.floorY = r.py + tdiv(h * dy, l) * 64;
    r.z = r.pz + tdiv(h * dz, l) * 64;
  }
}

/** 0x4d5220 (grounded part): yaw drift from the floor's sideways tilt, growing with speed². */
function camber(r: OrigRacer) {
  if (!r.grounded) return;
  const [nx, ny0, nz] = r.n;
  const e = Math.max(0, Math.min(40, r.fwd >> 12));
  const ny = tsar(ny0 * (48 - e), 3), L = isqrt24(nx * nx + ny * ny + nz * nz);
  const Nx = tdiv(nx * 4096, L), Ny = tdiv(ny * 4096, L), Nz = tdiv(nz * 4096, L);
  const a = -r.yaw & 0xfff, A = tsar(Nx * cos4(a) + Nz * sin4(a), 12);
  r.camber = ((((atan12(A, -Ny) + 0x10) * e * e) >> 15) << 16) >> 16;
}

/** 0x4d8ab8, normal path: walls, floor, normal, slope, snap, camber. */
export function collide(t: OrigTerrain, r: OrigRacer) {
  hitWalls(t, r);
  findFloor(t, r);
  updateNormal(t, r);
  if (r.jumpLock === 0) slopeRescale(r);
  if (r.grounded) {
    r.vy = 0;
    r.y = r.floorY;
    r.hasJumped = 0;
    if (r.special === 1 || r.special === 4) r.special = 0;
  }
  if (r.y > 0) r.y = 0;
  camber(r);
}

/** 0x47b794: playfield ground lookup (0 = water / transparent hole, > 0 = solid ground). */
export function isPlayfieldWater(x: number, z: number, pf: PlayfieldWater): boolean {
  const rx = x * (1 / 4096);
  const rz = z * (1 / 4096);
  const b = pf.bounds;
  const dx = (b.x1 - b.x0) * b.s;
  const dz = (b.z0 - b.z1) * b.s;
  const valX = (rx - b.x0 * b.s) / (dx / 128.0) * 32.0;
  const valZ = (rz - b.z1 * b.s) / (dz / 128.0) * 32.0;
  const edx = Math.round(valX);
  const ebx = Math.round(valZ);
  if (edx < 0 || ebx < 0 || edx > 0xfff || ebx > 0xfff) return true;
  const row = (0xfff - ebx) >> 5;
  const col = edx >> 5;
  const tile = pf.map[row * 256 + col];
  if (tile === 0) return true;
  if (!pf.ply) return false;
  const px = edx & 0x1f;
  const py = (0xfff - ebx) & 0x1f;
  const tx = (tile % 10) * 32;
  const ty = Math.floor(tile / 10) * 32;
  const idx = ((ty + py) * 320 + (tx + px)) * 3;
  return pf.ply[idx] === 0 && pf.ply[idx + 1] === 255 && pf.ply[idx + 2] === 0;
}

/** 0x4819b0 + 0x481a2c: updates racer water depth level (+68) and alt40 surface flag. */
export function updateWater(r: OrigRacer, pf?: PlayfieldWater) {
  const tileWater = pf ? isPlayfieldWater(r.x, r.z, pf) : false;
  const prevHf = r.prevHasFloor ?? r.hasFloor;
  const inWater = r.grounded === 1 &&
    r.y > -0x30000 &&
    (r.hasFloor === 0 || prevHf === 0) &&
    tileWater;

  if (inWater) {
    r.alt40 = 1;
    r.water = Math.min(0x60000, r.water + 0x10000);
  } else {
    r.alt40 = 0;
    r.water = Math.max(0, r.water - 0x10000);
  }
  r.prevHasFloor = r.hasFloor;
}

/** One full tick: water update, physics, then collision. */
export function tick(t: OrigTerrain, r: OrigRacer, input: number) {
  if (t.playfieldWater) {
    updateWater(r, t.playfieldWater);
  }
  physicsTick(r, input);
  collide(t, r);
}
