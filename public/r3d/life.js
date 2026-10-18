// public/r3d/life.js — CityLife: the ambient life of Loop City (design §12, lane D). SKELETON (M0):
// the full §17.8 API with safe no-op bodies; the real systems land in M1.
export class CityLife {
  constructor(scene, { renderer = null, bus = null, clock = null, BOARD = null, animator = null } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.bus = bus;
    this.clock = clock;
    this.BOARD = BOARD;
    this.animator = animator;
    this.crowd = {
      rush: () => 0,
      cheerAll: () => {},
      scatter: () => {},
    };
    this.debug = { counts: () => ({}) };
  }

  setTier() {}
  setWeather() {}
  setLivery() {}
  ambient() { return false; }
  reset() {}
  dispose() {}
}
