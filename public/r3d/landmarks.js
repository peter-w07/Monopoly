// public/r3d/landmarks.js — the 4 corner landmarks, the 8 special lots, the power station and the station
// platforms (lane B). SKELETON (M0): full §17.6 API with safe no-op bodies.
const none = () => ({ duration: 0, cues: [] });
export class Landmarks {
  constructor(scene, BOARD, { renderer = null, animator = null, markShadows = null, fx = null, bus = null } = {}) {
    this.scene = scene;
    this.board = BOARD;
    this.debug = { play() { return none(); } };
  }
  sync() { return false; }
  anchor() { return null; }
  goBurst() { return none(); }
  jailGate() { return none(); }
  gtjBarrier() { return none(); }
  fpBarrier() { return none(); }
  fpWheel() { return none(); }
  potBurst() { return none(); }
  kiosk() { return { duration: 0, cues: [], cardPose: null }; }
  taxSlot() { return none(); }
  boxes() { return []; }
  pick() { return null; }
  ambient() { return false; }
  reset() {}
  dispose() {}
}
