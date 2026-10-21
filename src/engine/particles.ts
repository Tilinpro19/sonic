/**
 * Particle system and visual effects manager for Sonic R Web.
 *
 * Implements high-performance, retro-faithful visual feedback for racing:
 * 1. Foot dust puffs when running on track ground.
 * 2. Skid sparks and tire smoke when braking or drifting at speed.
 * 3. Ring collection sparkle bursts when gold rings are picked up.
 * 4. Speed trail / motion streaks when travelling at high speed.
 * 5. Water splash droplets and mist when running or landing in water.
 *
 * Architectural highlights:
 * - Pre-allocated fixed pools using THREE.InstancedMesh for zero runtime GC allocations.
 * - Separate normal-blended (dust/smoke/water) and additive-blended (sparks/sparkles/trails) meshes.
 * - Dynamic procedural billboard textures with graceful fallback in headless/test environments.
 * - Camera alignment support with billboard rotation and 3D tumbling fallback.
 */

import * as THREE from 'three';

export enum ParticleType {
  Dust,
  SkidSmoke,
  SkidSpark,
  RingSparkle,
  SpeedTrail,
  Splash,
  SplashMist,
}

export interface ParticleState {
  active: boolean;
  type: ParticleType;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  baseR: number;
  baseG: number;
  baseB: number;
  size: number;
  baseSize: number;
  rot: number;
  rotSpeed: number;
  life: number;
  maxLife: number;
  gravity: number;
  drag: number;
}

export interface ParticleManagerOptions {
  /** Maximum number of normal-blended particles (dust, smoke, splash). Default: 512 */
  maxNormal?: number;
  /** Maximum number of additive-blended particles (sparks, sparkles, trails). Default: 512 */
  maxAdditive?: number;
  /** Optional camera reference for billboarding. */
  camera?: THREE.Camera;
}

// Module-level preallocated scratch variables to guarantee zero allocations during update/emit
const _scratchPos = new THREE.Vector3();
const _scratchScale = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _scratchRotQuat = new THREE.Quaternion();
const _scratchMat = new THREE.Matrix4();
const _scratchColor = new THREE.Color();
const _axisZ = new THREE.Vector3(0, 0, 1);

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Creates a soft radial puff texture on an offscreen canvas.
 * Returns null in headless/server environments where document is not defined.
 */
function createPuffTexture(): THREE.Texture | null {
  if (typeof document === 'undefined' || !document.createElement) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.85)');
    grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.35)');
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  } catch {
    return null;
  }
}

/**
 * Creates a 4-point star sparkle texture on an offscreen canvas.
 * Returns null in headless/server environments.
 */
function createSparkleTexture(): THREE.Texture | null {
  if (typeof document === 'undefined' || !document.createElement) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Soft center circular glow
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 28);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.2, 'rgba(255, 255, 255, 0.7)');
    grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.15)');
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    // Cross flare horizontal & vertical rays
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(32, 4);
    ctx.lineTo(32, 60);
    ctx.moveTo(4, 32);
    ctx.lineTo(60, 32);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(32, 1);
    ctx.lineTo(32, 63);
    ctx.moveTo(1, 32);
    ctx.lineTo(63, 32);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  } catch {
    return null;
  }
}

class ParticleSubPool {
  readonly particles: ParticleState[];
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  private nextIndex = 0;
  activeCount = 0;
  private hasDirtyInstances = false;

  constructor(
    capacity: number,
    material: THREE.Material,
    geometry: THREE.BufferGeometry,
  ) {
    this.capacity = capacity;
    this.particles = new Array<ParticleState>(capacity);

    for (let i = 0; i < capacity; i++) {
      this.particles[i] = {
        active: false,
        type: ParticleType.Dust,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        r: 1,
        g: 1,
        b: 1,
        baseR: 1,
        baseG: 1,
        baseB: 1,
        size: 0,
        baseSize: 0,
        rot: 0,
        rotSpeed: 0,
        life: 0,
        maxLife: 1,
        gravity: 0,
        drag: 0,
      };
    }

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;

    // Initialize all instance matrices to scale 0
    _scratchMat.makeScale(0, 0, 0);
    _scratchMat.setPosition(0, -9999, 0);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, _scratchMat);
      this.mesh.setColorAt(i, _scratchColor.setRGB(1, 1, 1));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  alloc(
    type: ParticleType,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    size: number,
    rot: number,
    rotSpeed: number,
    maxLife: number,
    gravity: number,
    drag: number,
  ) {
    const idx = this.nextIndex;
    const p = this.particles[idx];

    if (!p.active) {
      this.activeCount++;
    }

    p.active = true;
    p.type = type;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.r = r;
    p.g = g;
    p.b = b;
    p.baseR = r;
    p.baseG = g;
    p.baseB = b;
    p.size = size;
    p.baseSize = size;
    p.rot = rot;
    p.rotSpeed = rotSpeed;
    p.life = 0;
    p.maxLife = Math.max(0.01, maxLife);
    p.gravity = gravity;
    p.drag = drag;

    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.hasDirtyInstances = true;
  }

  update(dt: number, cam: THREE.Camera | null) {
    if (this.activeCount === 0 && !this.hasDirtyInstances) {
      return;
    }

    let highestActiveIndex = -1;
    let anyActive = false;

    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        this.activeCount = Math.max(0, this.activeCount - 1);
        _scratchMat.makeScale(0, 0, 0);
        _scratchMat.setPosition(0, -9999, 0);
        this.mesh.setMatrixAt(i, _scratchMat);
        continue;
      }

      anyActive = true;
      if (i > highestActiveIndex) highestActiveIndex = i;

      const progress = p.life / p.maxLife; // 0..1

      // Physics integration
      if (p.drag > 0) {
        const damp = Math.max(0, 1 - p.drag * dt);
        p.vx *= damp;
        p.vz *= damp;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.rotSpeed * dt;

      // Type-specific sizing and color fading
      let currentScale = p.baseSize;

      switch (p.type) {
        case ParticleType.Dust: {
          // Dust puffs out quickly, then gently drifts and shrinks
          const curve = Math.sin(progress * Math.PI);
          currentScale = p.baseSize * (0.6 + 0.8 * curve) * (1 - progress * 0.7);
          break;
        }

        case ParticleType.SkidSmoke: {
          // Smoke billows and expands outwards, fading out
          currentScale = p.baseSize * (0.8 + 1.2 * progress) * (1 - progress * 0.6);
          break;
        }

        case ParticleType.SkidSpark: {
          // Sparks shrink fast as they cool down
          const sparkFade = 1 - progress * progress;
          currentScale = p.baseSize * sparkFade;
          p.r = p.baseR * sparkFade;
          p.g = p.baseG * (1 - progress * 0.9);
          p.b = p.baseB * (1 - progress);
          break;
        }

        case ParticleType.RingSparkle: {
          // Twinkle effect: pulsating size combined with steady shrink
          const twinkle = 0.8 + 0.35 * Math.sin(p.life * 28 + p.rot);
          const fade = 1 - progress;
          currentScale = p.baseSize * twinkle * fade;
          // In additive blending, color intensity drives brightness & opacity
          p.r = p.baseR * fade;
          p.g = p.baseG * fade;
          p.b = p.baseB * fade;
          break;
        }

        case ParticleType.SpeedTrail: {
          // Motion streaks leave a short afterimage fading in place
          const fade = 1 - progress;
          currentScale = p.baseSize * fade;
          p.r = p.baseR * fade;
          p.g = p.baseG * fade;
          p.b = p.baseB * fade;
          break;
        }

        case ParticleType.Splash: {
          // Water droplets arc and shrink as they disperse
          currentScale = p.baseSize * (1 - progress * 0.6);
          break;
        }

        case ParticleType.SplashMist: {
          // Soft foam / mist expands slightly and fades
          currentScale = p.baseSize * (1 + 0.6 * progress) * (1 - progress);
          break;
        }
      }

      // Matrix composition
      _scratchPos.set(p.x, p.y, p.z);
      _scratchScale.set(currentScale, currentScale, currentScale);

      if (cam) {
        _scratchQuat.copy(cam.quaternion);
        if (p.rot !== 0) {
          _scratchRotQuat.setFromAxisAngle(_axisZ, p.rot);
          _scratchQuat.multiply(_scratchRotQuat);
        }
      } else {
        _scratchQuat.setFromAxisAngle(_axisZ, p.rot);
      }

      _scratchMat.compose(_scratchPos, _scratchQuat, _scratchScale);
      this.mesh.setMatrixAt(i, _scratchMat);

      _scratchColor.setRGB(
        Math.max(0, Math.min(1, p.r)),
        Math.max(0, Math.min(1, p.g)),
        Math.max(0, Math.min(1, p.b)),
      );
      this.mesh.setColorAt(i, _scratchColor);
    }

    this.mesh.count = anyActive ? highestActiveIndex + 1 : 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.hasDirtyInstances = anyActive;
  }

  clear() {
    _scratchMat.makeScale(0, 0, 0);
    _scratchMat.setPosition(0, -9999, 0);
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      p.active = false;
      this.mesh.setMatrixAt(i, _scratchMat);
    }
    this.activeCount = 0;
    this.nextIndex = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.hasDirtyInstances = false;
  }

  dispose() {
    this.clear();
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) {
      for (const m of this.mesh.material) m.dispose();
    } else {
      this.mesh.material.dispose();
    }
  }
}

export class ParticleManager {
  readonly group: THREE.Group;
  camera: THREE.Camera | null = null;

  private readonly normalPool: ParticleSubPool;
  private readonly additivePool: ParticleSubPool;

  private readonly normalMaterial: THREE.MeshBasicMaterial;
  private readonly additiveMaterial: THREE.MeshBasicMaterial;
  private readonly puffTexture: THREE.Texture | null;
  private readonly sparkleTexture: THREE.Texture | null;

  constructor(options: ParticleManagerOptions = {}) {
    const maxNormal = options.maxNormal ?? 512;
    const maxAdditive = options.maxAdditive ?? 512;
    this.camera = options.camera ?? null;

    this.group = new THREE.Group();
    this.group.name = 'particles';

    // Textures with safe headless fallback
    this.puffTexture = createPuffTexture();
    this.sparkleTexture = createSparkleTexture();

    const geometry = new THREE.PlaneGeometry(1, 1);

    this.normalMaterial = new THREE.MeshBasicMaterial({
      map: this.puffTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.additiveMaterial = new THREE.MeshBasicMaterial({
      map: this.sparkleTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.normalPool = new ParticleSubPool(maxNormal, this.normalMaterial, geometry);
    this.additivePool = new ParticleSubPool(maxAdditive, this.additiveMaterial, geometry.clone());

    this.group.add(this.normalPool.mesh);
    this.group.add(this.additivePool.mesh);
  }

  /** Total active particles across all sub-pools. */
  get activeCount(): number {
    return this.normalPool.activeCount + this.additivePool.activeCount;
  }

  /** Active particles in the normal-blended pool (dust, smoke, splash). */
  get normalActiveCount(): number {
    return this.normalPool.activeCount;
  }

  /** Active particles in the additive-blended pool (sparks, sparkles, speed trails). */
  get additiveActiveCount(): number {
    return this.additivePool.activeCount;
  }

  /** Total particle storage capacity across all sub-pools. */
  get totalCapacity(): number {
    return this.normalPool.capacity + this.additivePool.capacity;
  }

  /**
   * Sets the camera used for orienting billboard particles.
   */
  setCamera(cam: THREE.Camera | null) {
    this.camera = cam;
  }

  /**
   * Emits foot dust puffs when running on the track surface.
   * @param pos Feet world position.
   * @param dir Runner forward direction vector.
   */
  emitDust(pos: THREE.Vector3, dir: THREE.Vector3) {
    const lenSq = dir.x * dir.x + dir.z * dir.z;
    const invLen = lenSq > 0.0001 ? 1 / Math.sqrt(lenSq) : 0;
    const dx = dir.x * invLen;
    const dz = dir.z * invLen;

    // Emit 2-3 dust puff particles
    const count = 3;
    for (let i = 0; i < count; i++) {
      const kickSpeed = rand(0.5, 1.3);
      const vx = -dx * kickSpeed + rand(-0.35, 0.35);
      const vy = rand(0.25, 0.75);
      const vz = -dz * kickSpeed + rand(-0.35, 0.35);

      const px = pos.x + rand(-0.1, 0.1);
      const py = pos.y + rand(0.02, 0.08);
      const pz = pos.z + rand(-0.1, 0.1);

      // Warm earth/dust tone
      const r = 0.82 + rand(-0.06, 0.06);
      const g = 0.76 + rand(-0.06, 0.06);
      const b = 0.65 + rand(-0.06, 0.06);

      const size = rand(0.2, 0.32);
      const rot = rand(0, Math.PI * 2);
      const rotSpeed = rand(-2.5, 2.5);
      const life = rand(0.35, 0.52);

      this.normalPool.alloc(
        ParticleType.Dust,
        px, py, pz,
        vx, vy, vz,
        r, g, b,
        size,
        rot, rotSpeed,
        life,
        -0.2, // slight upward float from turbulence
        2.4,  // drag
      );
    }
  }

  /**
   * Emits skid sparks and tire smoke when braking or drifting at speed.
   * @param pos Ground contact world position.
   * @param dir Runner forward direction vector.
   */
  emitSkid(pos: THREE.Vector3, dir: THREE.Vector3) {
    const lenSq = dir.x * dir.x + dir.z * dir.z;
    const invLen = lenSq > 0.0001 ? 1 / Math.sqrt(lenSq) : 0;
    const dx = dir.x * invLen;
    const dz = dir.z * invLen;

    // 1. Tire smoke puffs (normal-blended)
    const smokeCount = 2;
    for (let i = 0; i < smokeCount; i++) {
      const vx = -dx * rand(0.8, 1.8) + rand(-0.5, 0.5);
      const vy = rand(0.3, 0.85);
      const vz = -dz * rand(0.8, 1.8) + rand(-0.5, 0.5);

      const px = pos.x + rand(-0.08, 0.08);
      const py = pos.y + rand(0.04, 0.12);
      const pz = pos.z + rand(-0.08, 0.08);

      const shade = rand(0.88, 0.96);
      const size = rand(0.25, 0.38);
      const rot = rand(0, Math.PI * 2);
      const rotSpeed = rand(-2.0, 2.0);
      const life = rand(0.45, 0.68);

      this.normalPool.alloc(
        ParticleType.SkidSmoke,
        px, py, pz,
        vx, vy, vz,
        shade, shade, shade,
        size,
        rot, rotSpeed,
        life,
        -0.3, // buoyant smoke rises
        2.2,  // drag
      );
    }

    // 2. High-speed friction sparks (additive-blended)
    const sparkCount = 4;
    for (let i = 0; i < sparkCount; i++) {
      const sparkSpeed = rand(2.8, 6.0);
      const vx = -dx * sparkSpeed + rand(-2.0, 2.0);
      const vy = rand(1.2, 3.2);
      const vz = -dz * sparkSpeed + rand(-2.0, 2.0);

      const px = pos.x + rand(-0.05, 0.05);
      const py = pos.y + 0.03;
      const pz = pos.z + rand(-0.05, 0.05);

      // Bright fiery orange / yellow / hot white spark
      const r = 1.0;
      const g = rand(0.65, 0.95);
      const b = rand(0.1, 0.4);

      const size = rand(0.09, 0.16);
      const rot = rand(0, Math.PI * 2);
      const rotSpeed = rand(-12, 12);
      const life = rand(0.18, 0.32);

      this.additivePool.alloc(
        ParticleType.SkidSpark,
        px, py, pz,
        vx, vy, vz,
        r, g, b,
        size,
        rot, rotSpeed,
        life,
        14.0, // gravity pulls sparks down to track
        1.2,  // slight drag
      );
    }
  }

  /**
   * Emits a radial burst of dazzling golden sparkles when collecting a ring.
   * @param pos Ring collection world position.
   * @param count Optional sparkle count (default: 16).
   */
  emitRingSparkle(pos: THREE.Vector3, count = 16) {
    const n = Math.max(1, count);

    for (let i = 0; i < n; i++) {
      // Uniform spherical direction with upward bias
      const phi = Math.random() * Math.PI * 2;
      const cosTheta = Math.random() * 2 - 1;
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const nx = sinTheta * Math.cos(phi);
      const ny = Math.abs(cosTheta); // upward half-sphere bias
      const nz = sinTheta * Math.sin(phi);

      const burstSpeed = rand(2.0, 4.8);
      const vx = nx * burstSpeed;
      const vy = (ny * 0.75 + 0.35) * burstSpeed;
      const vz = nz * burstSpeed;

      const px = pos.x + rand(-0.15, 0.15);
      const py = pos.y + rand(-0.15, 0.15);
      const pz = pos.z + rand(-0.15, 0.15);

      // Palette: 50% gold, 30% brilliant yellow, 20% sparkling diamond white
      const pick = Math.random();
      let r = 1.0, g = 0.84, b = 0.1;
      if (pick < 0.2) {
        r = 1.0; g = 1.0; b = 1.0;
      } else if (pick < 0.5) {
        r = 1.0; g = 0.95; b = 0.25;
      }

      const size = rand(0.18, 0.3);
      const rot = rand(0, Math.PI * 2);
      const rotSpeed = rand(-8.0, 8.0);
      const life = rand(0.45, 0.7);

      this.additivePool.alloc(
        ParticleType.RingSparkle,
        px, py, pz,
        vx, vy, vz,
        r, g, b,
        size,
        rot, rotSpeed,
        life,
        2.2, // gentle downward gravity
        1.8, // air drag decelerates expansion
      );
    }
  }

  /**
   * Emits speed trail / motion streak particles when travelling at high velocity.
   * @param pos World position of racer body.
   * @param dir Runner forward direction vector.
   * @param color Signature runner trail color in hex (default: 0x0066ff / Sonic blue).
   */
  emitSpeedTrail(pos: THREE.Vector3, dir: THREE.Vector3, color = 0x0066ff) {
    const lenSq = dir.x * dir.x + dir.z * dir.z;
    const invLen = lenSq > 0.0001 ? 1 / Math.sqrt(lenSq) : 0;
    const dx = dir.x * invLen;
    const dz = dir.z * invLen;

    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;

    // Emit 1 streak puff at current location
    const px = pos.x + rand(-0.08, 0.08);
    const py = pos.y + rand(-0.06, 0.06);
    const pz = pos.z + rand(-0.08, 0.08);

    // Leaves afterimage nearly stationary behind runner
    const vx = -dx * 0.25;
    const vy = 0.0;
    const vz = -dz * 0.25;

    const size = rand(0.45, 0.6);
    const rot = rand(0, Math.PI * 2);
    const rotSpeed = rand(-1.0, 1.0);
    const life = rand(0.24, 0.36);

    this.additivePool.alloc(
      ParticleType.SpeedTrail,
      px, py, pz,
      vx, vy, vz,
      r, g, b,
      size,
      rot, rotSpeed,
      life,
      0,   // no gravity
      4.0, // strong drag
    );
  }

  /**
   * Emits water splash spray and mist droplets when landing or running through water.
   * @param pos Water surface contact position.
   */
  emitSplash(pos: THREE.Vector3) {
    // 1. Water droplets bursting in an upward cone
    const dropletCount = 14;
    for (let i = 0; i < dropletCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radial = rand(0.8, 2.4);
      const vx = Math.cos(angle) * radial;
      const vy = rand(2.2, 4.6);
      const vz = Math.sin(angle) * radial;

      const px = pos.x + rand(-0.1, 0.1);
      const py = pos.y + 0.05;
      const pz = pos.z + rand(-0.1, 0.1);

      // Translucent cyan-white water droplet
      const r = 0.78;
      const g = 0.92;
      const b = 1.0;

      const size = rand(0.12, 0.22);
      const rot = rand(0, Math.PI * 2);
      const rotSpeed = rand(-4.0, 4.0);
      const life = rand(0.42, 0.65);

      this.normalPool.alloc(
        ParticleType.Splash,
        px, py, pz,
        vx, vy, vz,
        r, g, b,
        size,
        rot, rotSpeed,
        life,
        9.8, // water falls back down with realistic gravity
        0.7, // air drag
      );
    }

    // 2. Base foam mist puffs expanding outwards on water surface
    const mistCount = 2;
    for (let i = 0; i < mistCount; i++) {
      const px = pos.x + rand(-0.15, 0.15);
      const py = pos.y + 0.06;
      const pz = pos.z + rand(-0.15, 0.15);

      const vx = rand(-0.4, 0.4);
      const vy = rand(0.15, 0.45);
      const vz = rand(-0.4, 0.4);

      const shade = rand(0.92, 0.98);
      const size = rand(0.35, 0.5);
      const rot = rand(0, Math.PI * 2);
      const rotSpeed = rand(-1.5, 1.5);
      const life = rand(0.35, 0.55);

      this.normalPool.alloc(
        ParticleType.SplashMist,
        px, py, pz,
        vx, vy, vz,
        shade, shade, shade,
        size,
        rot, rotSpeed,
        life,
        -0.1,
        2.0,
      );
    }
  }

  /**
   * Advances simulation of all active particles.
   * @param dt Elapsed seconds since last update.
   * @param camera Optional camera override for billboard orientation.
   */
  update(dt: number, camera?: THREE.Camera | null) {
    if (dt <= 0) return;
    // Cap step duration to avoid explosive simulation jumps during lag spikes
    const safeDt = Math.min(dt, 0.1);
    const cam = camera !== undefined ? camera : this.camera;

    this.normalPool.update(safeDt, cam);
    this.additivePool.update(safeDt, cam);
  }

  /**
   * Immediately clears all active particles.
   */
  clear() {
    this.normalPool.clear();
    this.additivePool.clear();
  }

  /**
   * Disposes all GPU resources, geometries, materials, and textures.
   */
  dispose() {
    this.normalPool.dispose();
    this.additivePool.dispose();
    this.group.clear();

    if (this.puffTexture) this.puffTexture.dispose();
    if (this.sparkleTexture) this.sparkleTexture.dispose();
  }
}

// Alias for convenience
export { ParticleManager as ParticleSystem };
