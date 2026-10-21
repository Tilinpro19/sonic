import { describe, expect, it, vi } from 'vitest';
import {
  computeJoystickInput,
  isTouchDevice,
  createTouchControls,
} from './touch';

describe('isTouchDevice()', () => {
  it('returns false in non-browser/node environment when window is undefined', () => {
    expect(isTouchDevice(undefined)).toBe(false);
  });

  it('returns true when ontouchstart exists on window', () => {
    const mockWin = { ontouchstart: null };
    expect(isTouchDevice(mockWin)).toBe(true);
  });

  it('returns true when navigator.maxTouchPoints > 0', () => {
    const mockWin = {};
    const mockNav = { maxTouchPoints: 5 };
    expect(isTouchDevice(mockWin, mockNav)).toBe(true);
  });

  it('returns true when CSS pointer: coarse media query matches', () => {
    const mockWin = {
      matchMedia: (query: string) => ({
        matches: query === '(pointer: coarse)',
      }),
    };
    const mockNav = { maxTouchPoints: 0 };
    expect(isTouchDevice(mockWin, mockNav)).toBe(true);
  });

  it('returns false on standard desktop without touch support', () => {
    const mockWin = {
      matchMedia: () => ({ matches: false }),
    };
    const mockNav = { maxTouchPoints: 0 };
    expect(isTouchDevice(mockWin, mockNav)).toBe(false);
  });
});

describe('computeJoystickInput()', () => {
  const maxRadius = 50;
  const deadzone = 0.12; // 6px
  const verticalThreshold = 0.35; // 17.5px

  it('returns neutral values at (0, 0)', () => {
    const res = computeJoystickInput(0, 0, maxRadius, deadzone, verticalThreshold);
    expect(res.steer).toBe(0);
    expect(res.accel).toBe(false);
    expect(res.brake).toBe(false);
    expect(res.clampedX).toBe(0);
    expect(res.clampedY).toBe(0);
    expect(res.rawDistance).toBe(0);
  });

  it('applies deadzone to horizontal steering', () => {
    // 3px offset is well below the 12% deadzone (6px)
    const rightDead = computeJoystickInput(3, 0, maxRadius, deadzone, verticalThreshold);
    expect(rightDead.steer).toBe(0);

    const leftDead = computeJoystickInput(-4, 0, maxRadius, deadzone, verticalThreshold);
    expect(leftDead.steer).toBe(0);

    // Exact deadzone boundary: 6px
    const boundary = computeJoystickInput(6, 0, maxRadius, deadzone, verticalThreshold);
    expect(boundary.steer).toBe(0);
  });

  it('scales steering smoothly once past deadzone', () => {
    // 28px offset -> normX = 0.56, past deadzone of 0.12
    const right = computeJoystickInput(28, 0, maxRadius, deadzone, verticalThreshold);
    expect(right.steer).toBeGreaterThan(0);
    expect(right.steer).toBeLessThan(1);

    const left = computeJoystickInput(-28, 0, maxRadius, deadzone, verticalThreshold);
    expect(left.steer).toBeLessThan(0);
    expect(left.steer).toBeGreaterThan(-1);

    // Symmetry check
    expect(right.steer).toBeCloseTo(-left.steer, 5);
  });

  it('clamps steering strictly to +1.0 and -1.0', () => {
    // At maximum radius
    const fullRight = computeJoystickInput(50, 0, maxRadius, deadzone, verticalThreshold);
    expect(fullRight.steer).toBe(1);

    const fullLeft = computeJoystickInput(-50, 0, maxRadius, deadzone, verticalThreshold);
    expect(fullLeft.steer).toBe(-1);

    // Far beyond maxRadius
    const extremeRight = computeJoystickInput(250, 0, maxRadius, deadzone, verticalThreshold);
    expect(extremeRight.steer).toBe(1);
    expect(extremeRight.clampedX).toBe(50);

    const extremeLeft = computeJoystickInput(-300, 0, maxRadius, deadzone, verticalThreshold);
    expect(extremeLeft.steer).toBe(-1);
    expect(extremeLeft.clampedX).toBe(-50);
  });

  it('restricts displacement to a circular radius', () => {
    // Diagonal deflection: dx = 50, dy = 50 (raw distance ≈ 70.71)
    const diagonal = computeJoystickInput(50, 50, maxRadius, deadzone, verticalThreshold);
    expect(diagonal.rawDistance).toBeCloseTo(Math.hypot(50, 50), 2);

    const clampedDist = Math.hypot(diagonal.clampedX, diagonal.clampedY);
    expect(clampedDist).toBeCloseTo(maxRadius, 2);
    expect(diagonal.clampedX).toBeCloseTo(50 / Math.SQRT2, 2);
    expect(diagonal.clampedY).toBeCloseTo(50 / Math.SQRT2, 2);
  });

  it('detects forward/reverse vertical deflection (accel/brake)', () => {
    // Dragging UP is negative Y in screen coordinates -> accel
    const upDeflection = computeJoystickInput(0, -30, maxRadius, deadzone, verticalThreshold);
    expect(upDeflection.accel).toBe(true);
    expect(upDeflection.brake).toBe(false);

    // Dragging DOWN is positive Y in screen coordinates -> brake
    const downDeflection = computeJoystickInput(0, 30, maxRadius, deadzone, verticalThreshold);
    expect(downDeflection.accel).toBe(false);
    expect(downDeflection.brake).toBe(true);

    // Vertical deflection within threshold -> neither
    const smallDeflection = computeJoystickInput(0, -10, maxRadius, deadzone, verticalThreshold);
    expect(smallDeflection.accel).toBe(false);
    expect(smallDeflection.brake).toBe(false);
  });

  it('combines steering and vertical drive inputs simultaneously', () => {
    const steerAndGas = computeJoystickInput(40, -40, maxRadius, deadzone, verticalThreshold);
    expect(steerAndGas.steer).toBeGreaterThan(0.5);
    expect(steerAndGas.accel).toBe(true);
    expect(steerAndGas.brake).toBe(false);
  });
});

describe('createTouchControls()', () => {
  it('initializes with default idle inputs', () => {
    const controls = createTouchControls();
    const input = controls.sample();

    expect(input.accel).toBe(false);
    expect(input.brake).toBe(false);
    expect(input.steer).toBe(0);
    expect(input.jump).toBe(false);
    expect(controls.isVisible).toBe(false);
    expect(controls.isAttached).toBe(false);
  });

  it('samples button press states correctly', () => {
    const controls = createTouchControls();

    // Accelerate (A button)
    controls.setButtonState('accel', true);
    expect(controls.sample().accel).toBe(true);
    expect(controls.sample().brake).toBe(false);
    expect(controls.sample().jump).toBe(false);

    // Brake (B button)
    controls.setButtonState('accel', false);
    controls.setButtonState('brake', true);
    expect(controls.sample().accel).toBe(false);
    expect(controls.sample().brake).toBe(true);
    expect(controls.sample().jump).toBe(false);

    // Jump (Space button)
    controls.setButtonState('brake', false);
    controls.setButtonState('jump', true);
    expect(controls.sample().jump).toBe(true);

    // Multiple buttons pressed together (e.g. Accel + Jump)
    controls.setButtonState('accel', true);
    controls.setButtonState('jump', true);
    const multi = controls.sample();
    expect(multi.accel).toBe(true);
    expect(multi.jump).toBe(true);
    expect(multi.brake).toBe(false);
  });

  it('samples joystick deflection and combines with buttons', () => {
    const controls = createTouchControls({ maxRadius: 50, deadzone: 0.1 });

    // Steer right
    controls.setJoystickOffset(50, 0);
    let inp = controls.sample();
    expect(inp.steer).toBe(1);
    expect(inp.accel).toBe(false);

    // Steer left + Button A pressed
    controls.setJoystickOffset(-50, 0);
    controls.setButtonState('accel', true);
    inp = controls.sample();
    expect(inp.steer).toBe(-1);
    expect(inp.accel).toBe(true);

    // Stick vertical accel acts as gas
    controls.setButtonState('accel', false);
    controls.setJoystickOffset(0, -35); // Pushed UP
    inp = controls.sample();
    expect(inp.accel).toBe(true);

    // Stick vertical brake acts as brake
    controls.setJoystickOffset(0, 35); // Pulled DOWN
    inp = controls.sample();
    expect(inp.brake).toBe(true);
  });

  it('resets inputs on reset()', () => {
    const controls = createTouchControls();
    controls.setButtonState('accel', true);
    controls.setButtonState('jump', true);
    controls.setJoystickOffset(40, -40);

    expect(controls.sample().accel).toBe(true);
    expect(controls.sample().jump).toBe(true);
    expect(controls.sample().steer).toBeGreaterThan(0);

    controls.reset();
    const resetInput = controls.sample();
    expect(resetInput.accel).toBe(false);
    expect(resetInput.brake).toBe(false);
    expect(resetInput.jump).toBe(false);
    expect(resetInput.steer).toBe(0);
  });

  it('resets all active inputs when setVisible(false) is called', () => {
    const controls = createTouchControls();
    controls.setVisible(true);
    expect(controls.isVisible).toBe(true);

    controls.setButtonState('accel', true);
    controls.setJoystickOffset(50, 0);
    expect(controls.sample().accel).toBe(true);
    expect(controls.sample().steer).toBe(1);

    controls.setVisible(false);
    expect(controls.isVisible).toBe(false);
    expect(controls.sample().accel).toBe(false);
    expect(controls.sample().steer).toBe(0);
  });

  it('handles attach and detach lifecycle cleanly', () => {
    const controls = createTouchControls();

    const mockContainer = {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
      contains: vi.fn().mockReturnValue(true),
    } as unknown as HTMLElement;

    controls.attach(mockContainer);
    expect(controls.isAttached).toBe(true);

    controls.detach();
    expect(controls.isAttached).toBe(false);
    expect(controls.sample().accel).toBe(false);
  });
});
