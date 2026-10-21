/**
 * Fixed 30 Hz simulation clock under a variable render rate (M5).
 * Time is counted in integer microseconds so 30, 60, 144 or 240 Hz frames
 * add up to exactly the same number of ticks — no float drift at tick edges.
 */
// One tick = 100000/3 µs, so tick edges are tested as us·3 against multiples of 100000.
const MAX_US = 250_000; // after a long stall, drop time instead of fast-forwarding

export class FixedStep {
  private us = 0;
  private done = 0;

  /** Adds a frame of `dt` seconds; returns how many ticks to run now. */
  advance(dt: number): number {
    this.us += Math.round(dt * 1e6);
    let n = Math.floor((this.us * 3) / 100_000) - this.done; // = us / TICK_US, exact in integers
    const cap = Math.floor((MAX_US * 3) / 100_000);
    if (n > cap) {
      // Skip the excess, keeping the phase so alpha stays continuous.
      this.done += n - cap;
      n = cap;
    }
    this.done += n;
    return n;
  }

  /** Fraction of the way to the next tick, for interpolating poses: [0, 1). */
  get alpha(): number {
    return (this.us * 3 - this.done * 100_000) / 100_000;
  }

  reset() { this.us = this.done = 0; }
}
