// public/r3d/city-lots.js — the 28 ownable lots of Loop City (lane B). SKELETON (M0): full §17.6 API with
// safe no-op bodies; the real implementation replaces this file.
const NONE = Object.freeze({ duration: 0, cues: [] });
export class CityLots {
  constructor(scene, BOARD, { renderer = null, animator = null, markShadows = null, fx = null, bus = null } = {}) {
    this.scene = scene;
    this.board = BOARD;
    this.animator = animator;
    this.debug = { setLevel() {}, ritual() { return NONE; } };
  }
  sync() { return false; }
  ritual() { return { duration: 0, cues: [] }; }
  celebrate() { return { duration: 0, cues: [] }; }
  signBounce() { return 0; }
  setPending() {}
  setAuction() {}
  anchor() { return null; }
  boxes() { return []; }
  setFade() {}
  inspect() { return null; }
  pick() { return null; }
  ambient() { return false; }
  reset() {}
  dispose() {}
}
