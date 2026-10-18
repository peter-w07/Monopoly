// public/r3d/hud-dice.js — the dice "on the glass" (city design §10, §17.5). SKELETON (M0): the full
// API with safe no-op bodies; the real HUD dice land in M1.

export class HudDice {
  constructor(stage, animator) {
    this.stage = stage;
    this.animator = animator;
    this._values = [5, 2];
  }

  schedule(values, seed, delay = 0, opts = {}) {
    if (Array.isArray(values) && values.length === 2) this._values = values.slice();
    return { duration: 0, restAt: 0, bounces: [] };
  }

  rest(values) {
    if (Array.isArray(values) && values.length === 2) this._values = values.slice();
  }

  hide() {}

  celebrate() { return 0; }

  dispose() {}

  get values() { return this._values.slice(); }
}
