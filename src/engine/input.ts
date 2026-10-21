/**
 * Driving input, sampled once per 30 Hz tick.
 * Keyboard: ↑/W accelerate, ↓/S brake, ←→/AD steer, Space jump.
 * Gamepad (standard mapping): left stick steer, A or RT accelerate, LT brake, B/X jump.
 */
import type { Input } from './runner';

const keys = new Set<string>();
/** Pressed since the last tick: a tap shorter than one tick (33 ms) still counts. */
const tapped = new Set<string>();
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
  tapped.add(e.code);
  if (driving && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); tapped.clear(); });

let driving = false;
export function setDriving(on: boolean) { driving = on; tapped.clear(); }

let touchSampler: (() => Input) | null = null;
export function registerTouchInput(sampler: (() => Input) | null) {
  touchSampler = sampler;
}

export function readInput(): Input {
  const k = (...c: string[]) => c.some((x) => keys.has(x) || tapped.has(x));
  let steer = (k('ArrowRight', 'KeyD') ? 1 : 0) - (k('ArrowLeft', 'KeyA') ? 1 : 0);
  let accel = k('ArrowUp', 'KeyW'), brake = k('ArrowDown', 'KeyS'), jump = k('Space');
  const pad = navigator.getGamepads?.().find((p) => p);
  tapped.clear();
  if (pad) {
    const x = pad.axes[0] ?? 0;
    if (Math.abs(x) > 0.15) steer = x;
    const b = (i: number) => (pad.buttons[i]?.value ?? 0) > 0.3;
    accel ||= b(0) || b(7) || (pad.axes[1] ?? 0) < -0.5;
    brake ||= b(6) || (pad.axes[1] ?? 0) > 0.5;
    jump ||= b(1) || b(2);
  }
  if (touchSampler) {
    const t = touchSampler();
    if (Math.abs(t.steer) > 0.001) steer = t.steer;
    accel ||= t.accel;
    brake ||= t.brake;
    jump ||= t.jump;
  }
  return { accel, brake, steer: Math.max(-1, Math.min(1, steer)), jump };
}
