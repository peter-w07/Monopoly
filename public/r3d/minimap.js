// public/r3d/minimap.js — the always-on minimap (city design §11.3). SKELETON (M0): safe no-ops; the
// real canvas lands in M1. Used by overlay.setMinimap.

export class Minimap {
  constructor(parent, { onTap } = {}) {
    this.parent = parent;
    this.onTap = onTap;
    this.node = null;
  }

  set() {}

  setVisible() {}

  dispose() {}
}
