// public/r3d/tween.js — a tiny, dependency-free animation scheduler.
//
// Everything that moves in the 3D board is an item on one Animator: `add({ delay, duration, update })`
// schedules update(p) for eased p in [0, 1] starting `delay` seconds from now. A whole event batch
// (dice → walk → landing → settle) is laid out up-front as items with delays, which keeps it
// synchronous and cancellable:
//   * finishAll() runs every pending item to its end, in schedule order, right now ("skip").
//   * A timer backstop finishes everything if frames stop arriving (hidden tab, occluded webview),
//     so the board can never get stuck mid-animation.
//   * `rate` scales animation time against real time (the "fast" speed setting, and catching up
//     when newer states queue behind the running batch). Delays and durations stay in animation
//     seconds; real seconds = animation seconds / rate.

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBounce: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

const BACKSTOP_SLACK_MS = 600;
const FRAME_ALIVE_MS = 300; // frames arrived this recently → the loop is alive, don't force-finish

export class Animator {
  /**
   * @param {object} hooks
   * @param {() => void} [hooks.onActive]   called when items are added (wake the render loop)
   * @param {() => void} [hooks.onBackstop] called after the backstop force-finished items (render once)
   */
  constructor({ onActive, onBackstop } = {}) {
    this.items = [];
    this.time = 0;
    this.onActive = onActive;
    this.onBackstop = onBackstop;
    this.lastStepAt = 0;
    this.backstop = null;
    this.finishing = false;
    this._rate = 1;
  }

  get busy() {
    return this.items.length > 0;
  }

  /** Animation seconds per real second (1 = normal). */
  get rate() {
    return this._rate;
  }

  set rate(r) {
    const next = Number.isFinite(r) && r > 0 ? r : 1;
    if (next === this._rate) return;
    this._rate = next;
    if (this.items.length && !this.finishing) this.armBackstop(); // its deadline is in real time
  }

  /** Animation seconds until the last scheduled item ends (real seconds: divide by `rate`). */
  get remaining() {
    let end = 0;
    for (const it of this.items) end = Math.max(end, it.at + it.duration - this.time);
    return Math.max(0, end);
  }

  /**
   * Schedules an item. All callbacks are optional.
   *   start()     once, when it begins        update(p) every frame, p eased in [0, 1]
   *   end()       once, after update(1)       easing    default linear
   * Items added while finishAll() runs are finished too (so chains complete).
   */
  add({ delay = 0, duration = 0, easing = ease.linear, start, update, end } = {}) {
    const it = { at: this.time + Math.max(0, delay), duration: Math.max(0, duration), easing, start, update, end, started: false, done: false };
    // Keep items sorted by start time (stable), so overlapping items on one object run in order.
    let k = this.items.length;
    while (k > 0 && this.items[k - 1].at > it.at) k--;
    this.items.splice(k, 0, it);
    if (!this.finishing) {
      this.onActive?.();
      this.armBackstop();
    }
    return it;
  }

  /** Shorthand: run `fn` after `delay` seconds. */
  at(delay, fn) {
    return this.add({ delay, start: fn });
  }

  /** Advances time by dt real seconds (× rate). Returns true while items remain. */
  step(dt) {
    this.lastStepAt = performance.now();
    this.time += dt * this._rate;
    const list = this.items.slice();
    for (const it of list) this.advance(it, this.time);
    this.items = this.items.filter((it) => !it.done);
    if (!this.items.length) this.disarm();
    return this.items.length > 0;
  }

  advance(it, t) {
    if (it.done || t < it.at) return;
    try {
      if (!it.started) {
        it.started = true;
        it.start?.();
      }
      const p = it.duration > 0 ? Math.min(1, (t - it.at) / it.duration) : 1;
      it.update?.(it.easing(p));
      if (p >= 1) {
        it.done = true;
        it.end?.();
      }
    } catch (err) {
      it.done = true; // a broken item must not wedge the queue
      console.error('[renderer3d] animation step failed:', err);
    }
  }

  /** Runs every pending item to completion right now, in schedule order. */
  finishAll() {
    if (!this.items.length) return false;
    this.finishing = true;
    for (let guard = 0; guard < 32 && this.items.length; guard++) {
      const list = this.items;
      this.items = [];
      for (const it of list) this.advance(it, Infinity);
    }
    this.items = [];
    this.finishing = false;
    this.disarm();
    return true;
  }

  /** Animation seconds until `item` starts (0 if it already ran or is unknown). */
  until(item) {
    return item && !item.done && this.items.includes(item) ? Math.max(0, item.at - this.time) : 0;
  }

  /** Drops everything without running it (used on reset / dispose). */
  clear() {
    this.items = [];
    this.disarm();
  }

  armBackstop() {
    this.disarm();
    const ms = (this.remaining / this._rate) * 1000 + BACKSTOP_SLACK_MS;
    this.backstop = setTimeout(() => {
      this.backstop = null;
      if (!this.items.length) return;
      if (performance.now() - this.lastStepAt < FRAME_ALIVE_MS) {
        this.armBackstop(); // frames are flowing (maybe slowly): let the animation finish naturally
        return;
      }
      this.finishAll();
      this.onBackstop?.();
    }, ms);
  }

  disarm() {
    if (this.backstop) clearTimeout(this.backstop);
    this.backstop = null;
  }
}
