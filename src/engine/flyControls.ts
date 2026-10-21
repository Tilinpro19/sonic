/** Free-fly viewer camera: drag to look, WASD/QE to move, Shift = fast. Gamepad: sticks + triggers. */
import * as THREE from 'three';

export class FlyControls {
  yaw = 0;
  pitch = -0.3;
  speed = 12;
  enabled = true;
  private keys = new Set<string>();
  private dragging = false;

  constructor(readonly camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    dom.addEventListener('pointerdown', (e) => { this.dragging = true; dom.setPointerCapture(e.pointerId); });
    dom.addEventListener('pointerup', (e) => { this.dragging = false; dom.releasePointerCapture(e.pointerId); });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return;
      this.yaw -= e.movementX * 0.0035;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0035, -1.5, 1.5);
    });
    dom.addEventListener('wheel', (e) => { this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.15 : 0.87), 1, 200); }, { passive: true });
    addEventListener('keydown', (e) => { if (!(e.target instanceof HTMLInputElement)) this.keys.add(e.code); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  lookAt(target: THREE.Vector3) {
    const d = target.clone().sub(this.camera.position).normalize();
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.asin(d.y);
  }

  update(dt: number) {
    if (!this.enabled) return;
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    let fwd = k('KeyW') - k('KeyS'), side = k('KeyD') - k('KeyA'), up = k('KeyE') - k('KeyQ');
    let boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    const pad = navigator.getGamepads?.().find((p) => p);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      side += dz(pad.axes[0]); fwd -= dz(pad.axes[1]);
      this.yaw -= dz(pad.axes[2]) * dt * 2.2;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dz(pad.axes[3]) * dt * 2.2, -1.5, 1.5);
      up += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
      if (pad.buttons[0]?.pressed) boost = 4;
    }
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.quaternion.copy(q);
    const v = new THREE.Vector3(side, 0, -fwd).applyQuaternion(q);
    v.y += up;
    this.camera.position.addScaledVector(v, this.speed * boost * dt);
  }
}
