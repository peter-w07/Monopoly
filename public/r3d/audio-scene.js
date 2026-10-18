// public/r3d/audio-scene.js — AudioScene: the spatial city soundscape (design §14.4, lane D). SKELETON
// (M0): the full §17.8 API with safe no-op bodies; the real mixer lands in M1.
const INERT = Object.freeze({ set() {}, stop() {} });

export class AudioScene {
  constructor(sfx = null, { bus = null, clock = null } = {}) {
    this.sfx = sfx;
    this.bus = bus;
    this.clock = clock;
  }

  update() {}
  engine() { return INERT; }
  footstep() {}
  site() {}
  setAmbience() {}
  duck() {}
  jcut() {}
  dispose() {}
}
