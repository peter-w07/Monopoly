// public/r3d/token-models.js — the eight classic tokens, built from primitives (no model files).
//
// Each model is built from parts standing on y = 0, about 0.36 units across (tokens.js scales it
// up), facing +X (its direction of travel), then merged into ONE mesh (one draw call per token).
// They share one polished-metal material; the player's colour is on the base disc that tokens.js
// puts under them. Simple on purpose: easy to swap for glTF models later.

import * as THREE from './three.js';

/** @returns {THREE.Mesh} the token as a single mesh (parts merged) */
export function buildTokenModel(tokenId, metal) {
  const g = new THREE.Group();
  const add = (geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };
  const build = BUILDERS[tokenId] ?? BUILDERS.pawn;
  build(add);
  const mesh = new THREE.Mesh(mergeParts(g), metal);
  mesh.name = `token-${tokenId}`;
  mesh.castShadow = true;
  return mesh;
}

/** Bakes every child mesh's transform into one non-indexed geometry (position + normal). */
export function mergeParts(group) {
  const parts = [];
  let count = 0;
  for (const m of group.children) {
    m.updateMatrix();
    const src = m.geometry;
    const geo = src.index ? src.toNonIndexed() : src.clone();
    src.dispose();
    geo.applyMatrix4(m.matrix);
    parts.push(geo);
    count += geo.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let at = 0;
  for (const geo of parts) {
    pos.set(geo.attributes.position.array, at * 3);
    if (geo.attributes.normal) nor.set(geo.attributes.normal.array, at * 3);
    at += geo.attributes.position.count;
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

const R = (w, h, d, r = 0.02, seg = 2) => new THREE.RoundedBoxGeometry(w, h, d, seg, r);
const CYL = (rt, rb, h, s = 20) => new THREE.CylinderGeometry(rt, rb, h, s);
const SPH = (r, ws = 18, hs = 12) => new THREE.SphereGeometry(r, ws, hs);
const HALF_PI = Math.PI / 2;

const BUILDERS = {
  car(add) {
    add(R(0.4, 0.085, 0.19, 0.035), 0, 0.1, 0); // chassis
    add(R(0.15, 0.075, 0.16, 0.03), -0.05, 0.17, 0); // cockpit
    add(R(0.1, 0.03, 0.2, 0.012), -0.19, 0.155, 0); // rear spoiler
    add(CYL(0.018, 0.018, 0.06, 8), -0.19, 0.13, 0, 0, 0, 0); // spoiler post
    for (const [x, z] of [[0.13, 0.1], [0.13, -0.1], [-0.12, 0.1], [-0.12, -0.1]]) {
      add(CYL(0.056, 0.056, 0.045, 18), x, 0.056, z, HALF_PI); // wheels (axis Z)
    }
  },

  hat(add) {
    add(CYL(0.2, 0.2, 0.022, 32), 0, 0.03, 0); // brim
    add(CYL(0.126, 0.118, 0.26, 28), 0, 0.17, 0); // crown
    add(CYL(0.122, 0.122, 0.05, 28), 0, 0.07, 0); // band (reads as a ridge)
    add(CYL(0.13, 0.126, 0.02, 28), 0, 0.3, 0); // top lip
  },

  ship(add) {
    const hull = new THREE.Shape();
    hull.moveTo(-0.2, -0.085);
    hull.lineTo(0.1, -0.085);
    hull.quadraticCurveTo(0.2, -0.06, 0.24, 0);
    hull.quadraticCurveTo(0.2, 0.06, 0.1, 0.085);
    hull.lineTo(-0.2, 0.085);
    hull.quadraticCurveTo(-0.23, 0, -0.2, -0.085);
    const hullGeo = new THREE.ExtrudeGeometry(hull, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 });
    hullGeo.rotateX(-HALF_PI); // extrude upward
    add(hullGeo, 0, 0.015, 0);
    add(R(0.22, 0.06, 0.12, 0.015), -0.02, 0.15, 0); // deck house
    add(R(0.1, 0.05, 0.09, 0.012), -0.04, 0.2, 0); // bridge
    add(CYL(0.032, 0.036, 0.12, 14), 0.05, 0.24, 0, 0, 0, -0.18); // funnels, raked back
    add(CYL(0.032, 0.036, 0.12, 14), -0.08, 0.24, 0, 0, 0, -0.18);
  },

  boot(add) {
    add(R(0.13, 0.26, 0.14, 0.03), -0.07, 0.19, 0); // shaft
    add(R(0.3, 0.1, 0.14, 0.04), 0.02, 0.07, 0); // foot
    add(R(0.08, 0.04, 0.14, 0.01), -0.08, 0.02, 0); // heel
    add(R(0.14, 0.03, 0.15, 0.01), -0.07, 0.31, 0); // cuff
    add(SPH(0.07), 0.12, 0.07, 0); // toe cap
  },

  dog(add) {
    const body = add(new THREE.CapsuleGeometry(0.075, 0.16, 6, 14), 0, 0.17, 0, 0, 0, HALF_PI);
    body.scale.set(1, 1, 0.9);
    add(SPH(0.075), 0.15, 0.27, 0); // head
    add(R(0.09, 0.055, 0.07, 0.02), 0.22, 0.25, 0); // snout
    add(new THREE.ConeGeometry(0.03, 0.08, 10), 0.13, 0.35, 0.04, 0, 0, 0.2); // ears
    add(new THREE.ConeGeometry(0.03, 0.08, 10), 0.13, 0.35, -0.04, 0, 0, 0.2);
    for (const [x, z] of [[0.08, 0.05], [0.08, -0.05], [-0.08, 0.05], [-0.08, -0.05]]) {
      add(CYL(0.024, 0.02, 0.12, 10), x, 0.06, z); // legs
    }
    add(new THREE.ConeGeometry(0.022, 0.12, 10), -0.17, 0.26, 0, 0, 0, 0.5); // tail
  },

  cat(add) {
    const body = add(SPH(0.1), 0, 0.13, 0);
    body.scale.set(1.05, 1.25, 0.9);
    add(SPH(0.075), 0.03, 0.3, 0); // head
    add(new THREE.ConeGeometry(0.028, 0.07, 10), 0.03, 0.39, 0.04, 0.25); // ears
    add(new THREE.ConeGeometry(0.028, 0.07, 10), 0.03, 0.39, -0.04, -0.25);
    add(new THREE.TorusGeometry(0.1, 0.018, 8, 20, Math.PI * 1.1), -0.02, 0.03, 0, HALF_PI, 0, 0.3); // tail curl
    add(CYL(0.022, 0.02, 0.1, 10), 0.07, 0.05, 0.04); // front paws
    add(CYL(0.022, 0.02, 0.1, 10), 0.07, 0.05, -0.04);
  },

  thimble(add) {
    const pts = [
      [0, 0.34], [0.05, 0.338], [0.085, 0.325], [0.1, 0.3], [0.108, 0.25], [0.118, 0.1],
      [0.125, 0.03], [0.14, 0.02], [0.14, 0], [0, 0],
    ].map(([x, y]) => new THREE.Vector2(x, y)).reverse();
    add(new THREE.LatheGeometry(pts, 32));
    add(new THREE.TorusGeometry(0.117, 0.01, 8, 32), 0, 0.12, 0, HALF_PI); // decorative rings
    add(new THREE.TorusGeometry(0.112, 0.008, 8, 32), 0, 0.2, 0, HALF_PI);
  },

  wheelbarrow(add) {
    const tray = add(CYL(0.13, 0.08, 0.1, 4), -0.01, 0.17, 0, 0, Math.PI / 4); // flared 4-sided tray
    tray.scale.set(1.35, 1, 0.85);
    add(CYL(0.065, 0.065, 0.04, 18), 0.17, 0.065, 0, HALF_PI); // wheel
    add(CYL(0.012, 0.012, 0.26, 8), -0.13, 0.15, 0.06, 0, 0, 1.25); // handles
    add(CYL(0.012, 0.012, 0.26, 8), -0.13, 0.15, -0.06, 0, 0, 1.25);
    add(CYL(0.012, 0.012, 0.1, 8), -0.08, 0.06, 0.06); // legs
    add(CYL(0.012, 0.012, 0.1, 8), -0.08, 0.06, -0.06);
  },

  /** Fallback for unknown token ids. */
  pawn(add) {
    const pts = [[0, 0], [0.14, 0], [0.13, 0.04], [0.06, 0.08], [0.05, 0.22], [0.09, 0.25], [0.05, 0.28], [0.08, 0.34], [0, 0.42]]
      .map(([x, y]) => new THREE.Vector2(x, y));
    add(new THREE.LatheGeometry(pts, 24));
  },
};
