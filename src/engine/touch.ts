/**
 * Touch Controls and Mobile Virtual Gamepad for Sonic R Web.
 *
 * Implements:
 * 1. Virtual Joystick on the bottom-left:
 *    - Dynamic (re-centers on touch) or fixed touch zone.
 *    - Steering (-1 to +1) based on horizontal deflection with configurable deadzone & clamp.
 *    - Optional forward/reverse (accel/brake) from vertical deflection.
 * 2. Action Buttons on the bottom-right:
 *    - Accelerate: A button (neon emerald green)
 *    - Brake / Reverse: B button (neon ruby red)
 *    - Jump: Space button (neon azure cyan)
 * 3. Semi-transparent arcade neon styling:
 *    - High responsiveness, multi-touch enabled, non-blocking visual feedback, touch-action: none.
 */
import type { Input } from './runner';

export interface TouchControlsOptions {
  /** If true, the joystick base re-centers where the finger first touches. Default: true */
  dynamic?: boolean;
  /** Deadzone fraction of maxRadius (0..1) below which steer is 0. Default: 0.12 */
  deadzone?: number;
  /** Maximum pixel deflection radius for joystick. Default: 50 */
  maxRadius?: number;
  /** Vertical deflection threshold fraction (0..1) to trigger accel (up) or brake (down). Default: 0.35 */
  verticalThreshold?: number;
}

export interface JoystickResult {
  steer: number;
  accel: boolean;
  brake: boolean;
  clampedX: number;
  clampedY: number;
  rawDistance: number;
  normalizedX: number;
  normalizedY: number;
}

export interface TouchControlsElements {
  overlay: HTMLElement | null;
  zone: HTMLElement | null;
  base: HTMLElement | null;
  knob: HTMLElement | null;
  btnA: HTMLButtonElement | HTMLElement | null;
  btnB: HTMLButtonElement | HTMLElement | null;
  btnJump: HTMLButtonElement | HTMLElement | null;
}

export interface TouchControls {
  attach(container: HTMLElement): void;
  detach(): void;
  sample(): Input;
  setVisible(visible: boolean): void;
  setButtonState(button: 'accel' | 'brake' | 'jump', pressed: boolean): void;
  setJoystickOffset(dx: number, dy: number): void;
  reset(): void;
  readonly isVisible: boolean;
  readonly isAttached: boolean;
  readonly elements: TouchControlsElements;
}

/**
 * Calculates joystick response from horizontal & vertical pixel offsets.
 * Pure function suitable for direct unit testing.
 */
export function computeJoystickInput(
  dx: number,
  dy: number,
  maxRadius = 50,
  deadzone = 0.12,
  verticalThreshold = 0.35,
): JoystickResult {
  const dist = Math.hypot(dx, dy);
  let clampedX = dx;
  let clampedY = dy;

  if (dist > maxRadius && dist > 0 && maxRadius > 0) {
    const scale = maxRadius / dist;
    clampedX = dx * scale;
    clampedY = dy * scale;
  }

  const normX = maxRadius > 0 ? clampedX / maxRadius : 0;
  const normY = maxRadius > 0 ? clampedY / maxRadius : 0;

  // Steering calculation with smooth deadzone mapping
  const absX = Math.abs(normX);
  let steer = 0;
  if (absX > deadzone && deadzone < 1) {
    const scaled = (absX - deadzone) / (1 - deadzone);
    steer = Math.sign(normX) * Math.min(1, Math.max(0, scaled));
  }
  steer = Math.max(-1, Math.min(1, steer));

  // Vertical deflection: negative Y is UP (accel), positive Y is DOWN (brake)
  const accel = normY < -verticalThreshold;
  const brake = normY > verticalThreshold;

  return {
    steer,
    accel,
    brake,
    clampedX,
    clampedY,
    rawDistance: dist,
    normalizedX: normX,
    normalizedY: normY,
  };
}

/**
 * Detects whether the current device/browser supports touch input.
 * Supports optional parameter injection for testing without mutating global getters.
 */
export function isTouchDevice(
  win: any = typeof window !== 'undefined' ? window : undefined,
  nav: any = typeof navigator !== 'undefined' ? navigator : undefined,
): boolean {
  if (!win) return false;
  const hasTouchStart = 'ontouchstart' in win;
  const maxTouchPoints = nav && typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
  const coarsePointer = Boolean(
    typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)')?.matches,
  );
  return hasTouchStart || maxTouchPoints > 0 || coarsePointer;
}

export const TOUCH_STYLES = `
/* Sonic R Touch Controls - Arcade Neon Virtual Gamepad */
.sonic-touch-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 99;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  transition: opacity 0.2s ease;
}
.sonic-touch-overlay.hidden {
  display: none !important;
}
.sonic-touch-joystick-zone {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 50%;
  height: 65%;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.sonic-touch-joystick-base {
  position: absolute;
  width: 130px;
  height: 130px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  background: radial-gradient(circle, rgba(0, 229, 255, 0.08) 0%, rgba(8, 16, 40, 0.6) 70%, rgba(5, 10, 26, 0.8) 100%);
  border: 2px solid rgba(0, 229, 255, 0.4);
  box-shadow: 0 0 15px rgba(0, 229, 255, 0.2), inset 0 0 15px rgba(0, 229, 255, 0.15);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.sonic-touch-joystick-base.active {
  border-color: rgba(0, 229, 255, 0.85);
  box-shadow: 0 0 24px rgba(0, 229, 255, 0.45), inset 0 0 20px rgba(0, 229, 255, 0.3);
}
.sonic-touch-joystick-base::after {
  content: '';
  position: absolute;
  inset: 18px;
  border-radius: 50%;
  border: 1px dashed rgba(0, 229, 255, 0.25);
  pointer-events: none;
}
.sonic-touch-joystick-knob {
  position: absolute;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle at 35% 35%, #00e5ff 0%, #0077ff 65%, #051433 100%);
  border: 2px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 14px rgba(0, 229, 255, 0.7), inset 0 2px 4px rgba(255, 255, 255, 0.5);
  pointer-events: none;
  will-change: transform;
}
.sonic-touch-buttons-cluster {
  position: absolute;
  right: 20px;
  bottom: 20px;
  width: 190px;
  height: 190px;
  pointer-events: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.sonic-touch-btn {
  position: absolute;
  border-radius: 50%;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-style: italic;
  font-weight: 800;
  cursor: pointer;
  box-sizing: border-box;
  transition: transform 0.08s ease, filter 0.08s ease, box-shadow 0.08s ease, border-color 0.08s ease;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.sonic-touch-btn:active,
.sonic-touch-btn.active {
  transform: scale(0.92) !important;
}
.sonic-touch-btn-title {
  font-size: 20px;
  line-height: 1;
  pointer-events: none;
}
.sonic-touch-btn-sub {
  font-size: 9px;
  font-style: normal;
  font-weight: 700;
  letter-spacing: 0.5px;
  margin-top: 2px;
  opacity: 0.85;
  pointer-events: none;
}
.sonic-touch-btn-a {
  right: 6px;
  bottom: 10px;
  width: 72px;
  height: 72px;
  background: radial-gradient(circle at 35% 35%, rgba(0, 255, 136, 0.3) 0%, rgba(5, 30, 18, 0.6) 80%);
  border: 2px solid rgba(0, 255, 136, 0.6);
  color: #00ff88;
  text-shadow: 0 0 8px rgba(0, 255, 136, 0.8);
  box-shadow: 0 0 16px rgba(0, 255, 136, 0.3), inset 0 0 12px rgba(0, 255, 136, 0.15);
}
.sonic-touch-btn-a:active,
.sonic-touch-btn-a.active {
  background: radial-gradient(circle at 35% 35%, rgba(0, 255, 136, 0.65) 0%, rgba(0, 255, 136, 0.35) 80%);
  border-color: #00ff88;
  box-shadow: 0 0 26px rgba(0, 255, 136, 0.85), inset 0 0 16px rgba(0, 255, 136, 0.5);
}
.sonic-touch-btn-b {
  left: 10px;
  bottom: 20px;
  width: 62px;
  height: 62px;
  background: radial-gradient(circle at 35% 35%, rgba(255, 50, 80, 0.3) 0%, rgba(35, 5, 12, 0.6) 80%);
  border: 2px solid rgba(255, 50, 80, 0.6);
  color: #ff3366;
  text-shadow: 0 0 8px rgba(255, 50, 80, 0.8);
  box-shadow: 0 0 16px rgba(255, 50, 80, 0.3), inset 0 0 12px rgba(255, 50, 80, 0.15);
}
.sonic-touch-btn-b:active,
.sonic-touch-btn-b.active {
  background: radial-gradient(circle at 35% 35%, rgba(255, 50, 80, 0.65) 0%, rgba(255, 50, 80, 0.35) 80%);
  border-color: #ff3366;
  box-shadow: 0 0 26px rgba(255, 50, 80, 0.85), inset 0 0 16px rgba(255, 50, 80, 0.5);
}
.sonic-touch-btn-jump {
  left: 60px;
  top: 8px;
  width: 66px;
  height: 66px;
  background: radial-gradient(circle at 35% 35%, rgba(0, 180, 255, 0.3) 0%, rgba(8, 20, 45, 0.6) 80%);
  border: 2px solid rgba(0, 180, 255, 0.6);
  color: #38bdf8;
  text-shadow: 0 0 8px rgba(0, 180, 255, 0.8);
  box-shadow: 0 0 16px rgba(0, 180, 255, 0.3), inset 0 0 12px rgba(0, 180, 255, 0.15);
}
.sonic-touch-btn-jump:active,
.sonic-touch-btn-jump.active {
  background: radial-gradient(circle at 35% 35%, rgba(0, 180, 255, 0.65) 0%, rgba(0, 180, 255, 0.35) 80%);
  border-color: #38bdf8;
  box-shadow: 0 0 26px rgba(0, 180, 255, 0.85), inset 0 0 16px rgba(0, 180, 255, 0.5);
}
@media (max-width: 480px), (max-height: 480px) {
  .sonic-touch-joystick-base {
    width: 110px;
    height: 110px;
  }
  .sonic-touch-joystick-knob {
    width: 46px;
    height: 46px;
  }
  .sonic-touch-buttons-cluster {
    width: 165px;
    height: 165px;
    right: 10px;
    bottom: 10px;
  }
  .sonic-touch-btn-a {
    width: 60px;
    height: 60px;
    right: 4px;
    bottom: 6px;
  }
  .sonic-touch-btn-b {
    width: 52px;
    height: 52px;
    left: 6px;
    bottom: 14px;
  }
  .sonic-touch-btn-jump {
    width: 56px;
    height: 56px;
    left: 52px;
    top: 6px;
  }
  .sonic-touch-btn-title {
    font-size: 16px;
  }
  .sonic-touch-btn-sub {
    font-size: 8px;
  }
}
`;

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('sonic-touch-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'sonic-touch-styles';
    styleEl.textContent = TOUCH_STYLES;
    document.head.appendChild(styleEl);
  }
}

/**
 * Creates the virtual on-screen touch gamepad controls.
 */
export function createTouchControls(options: TouchControlsOptions = {}): TouchControls {
  const dynamic = options.dynamic ?? true;
  const deadzone = options.deadzone ?? 0.12;
  const maxRadius = options.maxRadius ?? 50;
  const verticalThreshold = options.verticalThreshold ?? 0.35;

  let attachedContainer: HTMLElement | null = null;
  let isVisible = false;

  // Input states
  let steer = 0;
  let stickAccel = false;
  let stickBrake = false;
  let btnAPressed = false;
  let btnBPressed = false;
  let btnJumpPressed = false;

  // DOM elements
  let overlayEl: HTMLElement | null = null;
  let zoneEl: HTMLElement | null = null;
  let baseEl: HTMLElement | null = null;
  let knobEl: HTMLElement | null = null;
  let btnAEl: HTMLButtonElement | null = null;
  let btnBEl: HTMLButtonElement | null = null;
  let btnJumpEl: HTMLButtonElement | null = null;

  // Touch tracking state
  let joystickPointerId: number | null = null;
  let originX = 85;
  let originY = 85;
  let cleanupListeners: (() => void) | null = null;

  function updateJoystick(dx: number, dy: number) {
    const res = computeJoystickInput(dx, dy, maxRadius, deadzone, verticalThreshold);
    steer = res.steer;
    stickAccel = res.accel;
    stickBrake = res.brake;

    if (knobEl) {
      knobEl.style.transform = `translate(calc(-50% + ${res.clampedX.toFixed(1)}px), calc(-50% + ${res.clampedY.toFixed(1)}px))`;
    }
  }

  function resetState() {
    joystickPointerId = null;
    steer = 0;
    stickAccel = false;
    stickBrake = false;
    btnAPressed = false;
    btnBPressed = false;
    btnJumpPressed = false;

    if (baseEl) {
      baseEl.classList.remove('active');
      if (dynamic) {
        baseEl.style.left = '85px';
        baseEl.style.bottom = '85px';
        baseEl.style.top = 'auto';
      }
    }
    if (knobEl) {
      knobEl.style.transform = 'translate(-50%, -50%)';
    }
    if (btnAEl) btnAEl.classList.remove('active');
    if (btnBEl) btnBEl.classList.remove('active');
    if (btnJumpEl) btnJumpEl.classList.remove('active');
  }

  function buildDom() {
    if (typeof document === 'undefined') return;

    injectStyles();

    overlayEl = document.createElement('div');
    overlayEl.className = 'sonic-touch-overlay hidden';

    zoneEl = document.createElement('div');
    zoneEl.className = 'sonic-touch-joystick-zone';

    baseEl = document.createElement('div');
    baseEl.className = 'sonic-touch-joystick-base';
    baseEl.style.left = '85px';
    baseEl.style.bottom = '85px';

    knobEl = document.createElement('div');
    knobEl.className = 'sonic-touch-joystick-knob';
    baseEl.appendChild(knobEl);
    zoneEl.appendChild(baseEl);
    overlayEl.appendChild(zoneEl);

    const cluster = document.createElement('div');
    cluster.className = 'sonic-touch-buttons-cluster';

    btnJumpEl = document.createElement('button');
    btnJumpEl.type = 'button';
    btnJumpEl.className = 'sonic-touch-btn sonic-touch-btn-jump';
    btnJumpEl.setAttribute('aria-label', 'Jump (Space)');
    btnJumpEl.innerHTML = '<span class="sonic-touch-btn-title">JUMP</span><span class="sonic-touch-btn-sub">SPACE</span>';

    btnBEl = document.createElement('button');
    btnBEl.type = 'button';
    btnBEl.className = 'sonic-touch-btn sonic-touch-btn-b';
    btnBEl.setAttribute('aria-label', 'Brake / Reverse (B)');
    btnBEl.innerHTML = '<span class="sonic-touch-btn-title">B</span><span class="sonic-touch-btn-sub">BRAKE</span>';

    btnAEl = document.createElement('button');
    btnAEl.type = 'button';
    btnAEl.className = 'sonic-touch-btn sonic-touch-btn-a';
    btnAEl.setAttribute('aria-label', 'Accelerate (A)');
    btnAEl.innerHTML = '<span class="sonic-touch-btn-title">A</span><span class="sonic-touch-btn-sub">GAS</span>';

    cluster.appendChild(btnJumpEl);
    cluster.appendChild(btnBEl);
    cluster.appendChild(btnAEl);
    overlayEl.appendChild(cluster);

    // Setup button pointer bindings
    const bindBtn = (
      btn: HTMLElement,
      press: () => void,
      release: () => void,
    ) => {
      const activePointers = new Set<number>();

      const down = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const pe = e as PointerEvent;
        if (typeof pe.pointerId === 'number') {
          activePointers.add(pe.pointerId);
          try { btn.setPointerCapture?.(pe.pointerId); } catch (_) {}
        }
        btn.classList.add('active');
        press();
      };

      const up = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const pe = e as PointerEvent;
        if (typeof pe.pointerId === 'number') {
          activePointers.delete(pe.pointerId);
          try { btn.releasePointerCapture?.(pe.pointerId); } catch (_) {}
        }
        if (activePointers.size === 0) {
          btn.classList.remove('active');
          release();
        }
      };

      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());

      return () => {
        btn.removeEventListener('pointerdown', down);
        btn.removeEventListener('pointerup', up);
        btn.removeEventListener('pointercancel', up);
        btn.removeEventListener('lostpointercapture', up);
      };
    };

    const unbindJump = bindBtn(
      btnJumpEl,
      () => { btnJumpPressed = true; },
      () => { btnJumpPressed = false; },
    );
    const unbindB = bindBtn(
      btnBEl,
      () => { btnBPressed = true; },
      () => { btnBPressed = false; },
    );
    const unbindA = bindBtn(
      btnAEl,
      () => { btnAPressed = true; },
      () => { btnAPressed = false; },
    );

    // Setup joystick zone pointer events
    const onZoneDown = (e: Event) => {
      const pe = e as PointerEvent;
      if (joystickPointerId !== null) return;
      pe.preventDefault();
      pe.stopPropagation();
      joystickPointerId = pe.pointerId;
      try { zoneEl?.setPointerCapture?.(pe.pointerId); } catch (_) {}

      const zoneRect = zoneEl?.getBoundingClientRect
        ? zoneEl.getBoundingClientRect()
        : { left: 0, top: 0, height: 300, width: 300 };

      if (dynamic && baseEl) {
        originX = pe.clientX - zoneRect.left;
        originY = pe.clientY - zoneRect.top;
        baseEl.style.left = `${originX}px`;
        baseEl.style.top = `${originY}px`;
        baseEl.style.bottom = 'auto';
      } else if (baseEl) {
        const baseRect = baseEl.getBoundingClientRect
          ? baseEl.getBoundingClientRect()
          : { left: zoneRect.left + 85, top: zoneRect.top + zoneRect.height - 85, width: 130, height: 130 };
        originX = baseRect.left + (baseRect.width ?? 130) / 2 - zoneRect.left;
        originY = baseRect.top + (baseRect.height ?? 130) / 2 - zoneRect.top;
      }

      baseEl?.classList.add('active');
      const curX = pe.clientX - zoneRect.left;
      const curY = pe.clientY - zoneRect.top;
      updateJoystick(curX - originX, curY - originY);
    };

    const onZoneMove = (e: Event) => {
      const pe = e as PointerEvent;
      if (joystickPointerId !== pe.pointerId) return;
      pe.preventDefault();
      const zoneRect = zoneEl?.getBoundingClientRect
        ? zoneEl.getBoundingClientRect()
        : { left: 0, top: 0, height: 300, width: 300 };
      const curX = pe.clientX - zoneRect.left;
      const curY = pe.clientY - zoneRect.top;
      updateJoystick(curX - originX, curY - originY);
    };

    const onZoneUp = (e: Event) => {
      const pe = e as PointerEvent;
      if (joystickPointerId !== pe.pointerId) return;
      pe.preventDefault();
      try { zoneEl?.releasePointerCapture?.(pe.pointerId); } catch (_) {}
      joystickPointerId = null;

      if (baseEl) {
        baseEl.classList.remove('active');
        if (dynamic) {
          baseEl.style.left = '85px';
          baseEl.style.bottom = '85px';
          baseEl.style.top = 'auto';
        }
      }
      if (knobEl) knobEl.style.transform = 'translate(-50%, -50%)';

      steer = 0;
      stickAccel = false;
      stickBrake = false;
    };

    zoneEl.addEventListener('pointerdown', onZoneDown);
    zoneEl.addEventListener('pointermove', onZoneMove);
    zoneEl.addEventListener('pointerup', onZoneUp);
    zoneEl.addEventListener('pointercancel', onZoneUp);
    zoneEl.addEventListener('lostpointercapture', onZoneUp);
    zoneEl.addEventListener('contextmenu', (e) => e.preventDefault());

    const onBlur = () => resetState();
    window.addEventListener('blur', onBlur);

    cleanupListeners = () => {
      unbindJump();
      unbindB();
      unbindA();
      zoneEl?.removeEventListener('pointerdown', onZoneDown);
      zoneEl?.removeEventListener('pointermove', onZoneMove);
      zoneEl?.removeEventListener('pointerup', onZoneUp);
      zoneEl?.removeEventListener('pointercancel', onZoneUp);
      zoneEl?.removeEventListener('lostpointercapture', onZoneUp);
      window.removeEventListener('blur', onBlur);
    };
  }

  // Pre-build DOM if document is present
  if (typeof document !== 'undefined') {
    buildDom();
  }

  return {
    attach(container: HTMLElement) {
      if (!overlayEl && typeof document !== 'undefined') {
        buildDom();
      }
      if (attachedContainer && overlayEl && attachedContainer.contains(overlayEl)) {
        attachedContainer.removeChild(overlayEl);
      }
      attachedContainer = container;
      if (overlayEl) {
        container.appendChild(overlayEl);
      }
    },

    detach() {
      if (attachedContainer && overlayEl && attachedContainer.contains(overlayEl)) {
        attachedContainer.removeChild(overlayEl);
      }
      attachedContainer = null;
      resetState();
      if (cleanupListeners) {
        cleanupListeners();
        cleanupListeners = null;
      }
      overlayEl = null;
      zoneEl = null;
      baseEl = null;
      knobEl = null;
      btnAEl = null;
      btnBEl = null;
      btnJumpEl = null;
    },

    sample(): Input {
      return {
        steer,
        accel: btnAPressed || stickAccel,
        brake: btnBPressed || stickBrake,
        jump: btnJumpPressed,
      };
    },

    setVisible(visible: boolean) {
      isVisible = visible;
      if (!visible) {
        resetState();
        overlayEl?.classList.add('hidden');
      } else {
        overlayEl?.classList.remove('hidden');
      }
    },

    setButtonState(button: 'accel' | 'brake' | 'jump', pressed: boolean) {
      if (button === 'accel') {
        btnAPressed = pressed;
        btnAEl?.classList.toggle('active', pressed);
      } else if (button === 'brake') {
        btnBPressed = pressed;
        btnBEl?.classList.toggle('active', pressed);
      } else if (button === 'jump') {
        btnJumpPressed = pressed;
        btnJumpEl?.classList.toggle('active', pressed);
      }
    },

    setJoystickOffset(dx: number, dy: number) {
      updateJoystick(dx, dy);
    },

    reset() {
      resetState();
    },

    get isVisible() {
      return isVisible;
    },

    get isAttached() {
      return Boolean(attachedContainer);
    },

    get elements(): TouchControlsElements {
      return {
        overlay: overlayEl,
        zone: zoneEl,
        base: baseEl,
        knob: knobEl,
        btnA: btnAEl,
        btnB: btnBEl,
        btnJump: btnJumpEl,
      };
    },
  };
}
