import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ParticleManager, ParticleSystem, ParticleType } from './particles';

describe('ParticleManager', () => {
  describe('creation and pool initialization', () => {
    it('initializes with default options and pre-allocated pools', () => {
      const pm = new ParticleManager();

      expect(pm.group).toBeInstanceOf(THREE.Group);
      expect(pm.group.name).toBe('particles');
      expect(pm.group.children.length).toBe(2);

      const [normalMesh, additiveMesh] = pm.group.children as THREE.InstancedMesh[];
      expect(normalMesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(additiveMesh).toBeInstanceOf(THREE.InstancedMesh);

      expect(normalMesh.count).toBe(0);
      expect(additiveMesh.count).toBe(0);

      expect(pm.activeCount).toBe(0);
      expect(pm.normalActiveCount).toBe(0);
      expect(pm.additiveActiveCount).toBe(0);
      expect(pm.totalCapacity).toBe(1024); // 512 normal + 512 additive

      pm.dispose();
    });

    it('exports ParticleSystem alias', () => {
      expect(ParticleSystem).toBe(ParticleManager);
    });

    it('exports ParticleType enum with all expected categories', () => {
      expect(ParticleType.Dust).toBeDefined();
      expect(ParticleType.SkidSmoke).toBeDefined();
      expect(ParticleType.SkidSpark).toBeDefined();
      expect(ParticleType.RingSparkle).toBeDefined();
      expect(ParticleType.SpeedTrail).toBeDefined();
      expect(ParticleType.Splash).toBeDefined();
      expect(ParticleType.SplashMist).toBeDefined();
    });

    it('supports custom capacity and camera options', () => {
      const cam = new THREE.PerspectiveCamera();
      const pm = new ParticleManager({
        maxNormal: 64,
        maxAdditive: 128,
        camera: cam,
      });

      expect(pm.totalCapacity).toBe(192);
      expect(pm.normalActiveCount).toBe(0);
      expect(pm.additiveActiveCount).toBe(0);
      expect(pm.camera).toBe(cam);

      pm.dispose();
    });
  });

  describe('particle emissions', () => {
    it('emits foot dust particles into normal pool', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(10, 0, 20);
      const dir = new THREE.Vector3(0, 0, 1);

      pm.emitDust(pos, dir);

      expect(pm.normalActiveCount).toBe(3);
      expect(pm.additiveActiveCount).toBe(0);
      expect(pm.activeCount).toBe(3);

      pm.dispose();
    });

    it('handles zero-length direction vector safely in emitDust', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(0, 0, 0);
      const zeroDir = new THREE.Vector3(0, 0, 0);

      expect(() => pm.emitDust(pos, zeroDir)).not.toThrow();
      expect(pm.normalActiveCount).toBe(3);

      pm.dispose();
    });

    it('emits skid smoke into normal pool and sparks into additive pool', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(5, 0.1, -15);
      const dir = new THREE.Vector3(1, 0, 0);

      pm.emitSkid(pos, dir);

      expect(pm.normalActiveCount).toBe(2); // smoke puffs
      expect(pm.additiveActiveCount).toBe(4); // friction sparks
      expect(pm.activeCount).toBe(6);

      pm.dispose();
    });

    it('emits ring sparkle burst with default and custom count', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(0, 5, 0);

      pm.emitRingSparkle(pos); // default count 16
      expect(pm.additiveActiveCount).toBe(16);
      expect(pm.normalActiveCount).toBe(0);

      pm.emitRingSparkle(pos, 24); // custom count 24
      expect(pm.additiveActiveCount).toBe(40);

      pm.dispose();
    });

    it('emits speed trail motion streak into additive pool', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(0, 1, 0);
      const dir = new THREE.Vector3(0, 0, 1);

      pm.emitSpeedTrail(pos, dir, 0xff0000); // Red trail

      expect(pm.additiveActiveCount).toBe(1);
      expect(pm.normalActiveCount).toBe(0);

      pm.dispose();
    });

    it('emits splash droplets and mist into normal pool', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(0, 0, 0);

      pm.emitSplash(pos);

      expect(pm.normalActiveCount).toBe(16); // 14 droplets + 2 foam mist
      expect(pm.additiveActiveCount).toBe(0);

      pm.dispose();
    });
  });

  describe('aging, expiration, and update loop', () => {
    it('advances particle life and updates transforms', () => {
      const pm = new ParticleManager();
      const pos = new THREE.Vector3(0, 0, 0);
      const dir = new THREE.Vector3(0, 0, 1);

      pm.emitDust(pos, dir);
      expect(pm.activeCount).toBe(3);

      // Advance by a small delta (e.g. 1/60s)
      pm.update(1 / 60);

      expect(pm.activeCount).toBe(3);

      const [normalMesh] = pm.group.children as THREE.InstancedMesh[];
      expect(normalMesh.count).toBeGreaterThan(0);

      pm.dispose();
    });

    it('expires particles after their maximum lifespan', () => {
      const pm = new ParticleManager();
      pm.emitDust(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
      pm.emitRingSparkle(new THREE.Vector3(0, 0, 0), 10);

      expect(pm.activeCount).toBe(13);

      // Dust and sparkles have max lifespan around 0.5 - 0.7s.
      // Advancing simulation by 1.2s in multiple steps:
      for (let i = 0; i < 15; i++) {
        pm.update(0.1);
      }

      expect(pm.activeCount).toBe(0);
      expect(pm.normalActiveCount).toBe(0);
      expect(pm.additiveActiveCount).toBe(0);

      const [normalMesh, additiveMesh] = pm.group.children as THREE.InstancedMesh[];
      expect(normalMesh.count).toBe(0);
      expect(additiveMesh.count).toBe(0);

      pm.dispose();
    });

    it('gracefully wraps around when exceeding pool capacity without throwing', () => {
      const pm = new ParticleManager({ maxNormal: 10, maxAdditive: 10 });
      const pos = new THREE.Vector3(0, 0, 0);
      const dir = new THREE.Vector3(0, 0, 1);

      // Emit more than capacity
      for (let i = 0; i < 10; i++) {
        pm.emitDust(pos, dir); // 3 per emit -> 30 particles requested for capacity 10
      }

      // Active count is capped at pool capacity
      expect(pm.normalActiveCount).toBe(10);
      expect(() => pm.update(0.016)).not.toThrow();

      pm.dispose();
    });

    it('safely handles non-positive or very large dt', () => {
      const pm = new ParticleManager();
      pm.emitRingSparkle(new THREE.Vector3(0, 0, 0), 5);

      expect(() => pm.update(0)).not.toThrow();
      expect(() => pm.update(-1)).not.toThrow();
      expect(pm.activeCount).toBe(5);

      // Large dt is clamped internally to avoid simulation instability
      expect(() => pm.update(100.0)).not.toThrow();

      pm.dispose();
    });

    it('supports billboarding to camera quaternion', () => {
      const cam = new THREE.PerspectiveCamera();
      cam.quaternion.set(0.1, 0.2, 0.3, 0.9).normalize();

      const pm = new ParticleManager({ camera: cam });
      pm.emitDust(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));

      expect(() => pm.update(0.016)).not.toThrow();

      // Override camera in update call
      const cam2 = new THREE.PerspectiveCamera();
      expect(() => pm.update(0.016, cam2)).not.toThrow();

      pm.dispose();
    });
  });

  describe('cleanup and reset', () => {
    it('immediately clears all particles on clear()', () => {
      const pm = new ParticleManager();
      pm.emitDust(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
      pm.emitSkid(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
      pm.emitRingSparkle(new THREE.Vector3(0, 0, 0), 16);

      expect(pm.activeCount).toBeGreaterThan(0);

      pm.clear();

      expect(pm.activeCount).toBe(0);
      expect(pm.normalActiveCount).toBe(0);
      expect(pm.additiveActiveCount).toBe(0);

      pm.dispose();
    });

    it('disposes resources and clears group on dispose()', () => {
      const pm = new ParticleManager();
      pm.emitDust(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
      pm.emitRingSparkle(new THREE.Vector3(0, 0, 0), 10);

      pm.dispose();

      expect(pm.group.children.length).toBe(0);
      expect(pm.activeCount).toBe(0);

      // Calling dispose multiple times should be safe
      expect(() => pm.dispose()).not.toThrow();
    });
  });
});
