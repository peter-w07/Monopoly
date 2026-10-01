// public/r3d/world-geo.js — small geometry / texture helpers shared by the world modules
// (world-env.js, city.js, city-kit.js, board.js). No state, no DOM except canvases.
//
// The world is built from primitives and then MERGED: many static parts with per-vertex colours
// become one BufferGeometry, so a whole shelf of props costs one draw call (see Kit).

import * as THREE from './three.js';

/** Deterministic PRNG (Park–Miller). rng(seed)() → [0, 1). Same seed → same world on every client. */
export function rng(seed = 1) {
  let s = Math.max(1, Math.floor(seed) % 2147483647);
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const tmpColor = new THREE.Color();

/**
 * Merges geometries into one non-indexed geometry with position, normal, uv and colour.
 * Parts without uv get (0, 0); parts without a colour attribute get their `color` (default white).
 * @param {{ geo: THREE.BufferGeometry, color?: THREE.ColorRepresentation }[]} parts (already transformed)
 */
export function mergeColored(parts) {
  const prepared = parts.map(({ geo, color }) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    return { g, color, own: g !== geo };
  });
  let count = 0;
  for (const p of prepared) count += p.g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const col = new Float32Array(count * 3);
  let at = 0;
  for (const { g, color } of prepared) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, at * 3);
    if (!g.attributes.normal) g.computeVertexNormals();
    nor.set(g.attributes.normal.array, at * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, at * 2);
    if (g.attributes.color && g.attributes.color.itemSize === 3 && color === undefined) {
      col.set(g.attributes.color.array, at * 3);
    } else {
      tmpColor.set(color ?? '#ffffff');
      for (let k = 0; k < n; k++) {
        col[(at + k) * 3] = tmpColor.r;
        col[(at + k) * 3 + 1] = tmpColor.g;
        col[(at + k) * 3 + 2] = tmpColor.b;
      }
    }
    at += n;
  }
  for (const p of prepared) {
    if (p.own) p.g.dispose();
  }
  for (const { geo } of parts) geo.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

const tmpObj = new THREE.Object3D();

/**
 * Collects primitive parts (with a transform and a colour) and merges them into one geometry.
 *   const kit = new Kit();
 *   kit.add(new THREE.BoxGeometry(1, 1, 1), { x: 0, y: 0.5, color: '#c33' });
 *   const mesh = new THREE.Mesh(kit.build(), material); // material.vertexColors = true
 */
export class Kit {
  constructor() {
    this.parts = [];
  }

  /**
   * @param {THREE.BufferGeometry} geo  consumed (disposed by build)
   * @param {object} t { x, y, z, rx, ry, rz, sx, sy, sz, s, color, matrix }
   */
  add(geo, t = {}) {
    if (t.matrix) {
      geo.applyMatrix4(t.matrix);
    } else {
      tmpObj.position.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
      tmpObj.rotation.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, t.order ?? 'XYZ');
      const s = t.s ?? 1;
      tmpObj.scale.set((t.sx ?? 1) * s, (t.sy ?? 1) * s, (t.sz ?? 1) * s);
      tmpObj.updateMatrix();
      geo.applyMatrix4(tmpObj.matrix);
    }
    this.parts.push({ geo, color: t.color });
    return this;
  }

  /** Adds every part of another kit, transformed by `t` (same keys as add). */
  addKit(kit, t = {}) {
    tmpObj.position.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
    tmpObj.rotation.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0);
    tmpObj.scale.setScalar(t.s ?? 1);
    tmpObj.updateMatrix();
    const m = tmpObj.matrix.clone();
    for (const p of kit.parts) {
      const g = p.geo.clone();
      g.applyMatrix4(m);
      this.parts.push({ geo: g, color: p.color });
    }
    return this;
  }

  get empty() {
    return this.parts.length === 0;
  }

  build() {
    const geo = mergeColored(this.parts);
    this.parts = [];
    return geo;
  }
}

/** A rounded rectangle Shape centred on the origin (w along x, h along y). */
export function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * A closed rounded-square loop on the XZ plane, driven clockwise seen from above (the way tokens
 * travel: +Z row goes toward -X first). at(s) → { x, z, heading } for arc length s (wraps).
 * heading: rotation about +Y that turns a model facing +X into the direction of travel.
 */
export function loopPath(half, corner) {
  const R = half;
  const rc = Math.min(corner, half);
  const L = 2 * (R - rc);
  const arc = (Math.PI / 2) * rc;
  const seg = L + arc;
  const sides = [
    { sx: R - rc, sz: R, dx: -1, dz: 0 },
    { sx: -R, sz: R - rc, dx: 0, dz: -1 },
    { sx: -R + rc, sz: -R, dx: 1, dz: 0 },
    { sx: R, sz: -R + rc, dx: 0, dz: 1 },
  ];
  const out = { x: 0, z: 0, heading: 0 };
  return {
    length: 4 * seg,
    /** Arc length of the middle of side k (0 = +Z row, 1 = -X, 2 = -Z, 3 = +X). */
    sideMiddle: (k) => k * seg + L / 2,
    at(s, into = out) {
      const total = 4 * seg;
      s = ((s % total) + total) % total;
      const k = Math.floor(s / seg) % 4;
      const u = s - k * seg;
      const side = sides[k];
      if (u <= L) {
        into.x = side.sx + side.dx * u;
        into.z = side.sz + side.dz * u;
        into.heading = Math.atan2(-side.dz, side.dx);
        return into;
      }
      const next = sides[(k + 1) % 4];
      const ex = side.sx + side.dx * L;
      const ez = side.sz + side.dz * L;
      const cx = ex + next.dx * rc;
      const cz = ez + next.dz * rc;
      const a = ((u - L) / Math.max(1e-6, arc)) * (Math.PI / 2);
      const vx = ex - cx;
      const vz = ez - cz;
      const turn = side.dx * next.dz - side.dz * next.dx;
      const ca = Math.cos(a * turn);
      const sa = Math.sin(a * turn);
      into.x = cx + vx * ca - vz * sa;
      into.z = cz + vx * sa + vz * ca;
      const dirx = side.dx * Math.cos(a) + next.dx * Math.sin(a);
      const dirz = side.dz * Math.cos(a) + next.dz * Math.sin(a);
      into.heading = Math.atan2(-dirz, dirx);
      return into;
    },
  };
}

/**
 * Sweeps a rectangle (width w across the path, height h) along a closed loop → a ribbon/rail
 * geometry. `offset` shifts it sideways (+ = outward), `y` lifts it. `step` = sampling distance.
 */
export function sweepLoop(path, { w, h, offset = 0, y = 0, step = 0.15 }) {
  const n = Math.max(8, Math.ceil(path.length / step));
  const pos = [];
  const nor = [];
  const p = { x: 0, z: 0, heading: 0 };
  const ring = [];
  for (let k = 0; k < n; k++) {
    path.at((k / n) * path.length, p);
    const dx = Math.cos(p.heading);
    const dz = -Math.sin(p.heading);
    // Left of travel (clockwise loop → left is outward).
    const nx = dz;
    const nz = -dx;
    const cx = p.x + nx * offset;
    const cz = p.z + nz * offset;
    ring.push({ cx, cz, nx, nz });
  }
  const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]; // (across, up)
  const faceN = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // outward normals of the 4 faces (across, up)
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    for (let f = 0; f < 4; f++) {
      const c0 = corners[f];
      const c1 = corners[(f + 1) % 4];
      const [fa, fu] = faceN[f];
      const v = (r, c) => [r.cx + r.nx * c[0] * w, y + c[1] * h, r.cz + r.nz * c[0] * w];
      const n0 = [a.nx * fa, fu, a.nz * fa];
      const n1 = [b.nx * fa, fu, b.nz * fa];
      const A = v(a, c0);
      const B = v(a, c1);
      const C = v(b, c1);
      const D = v(b, c0);
      pos.push(...A, ...D, ...C, ...A, ...C, ...B);
      nor.push(...n0, ...n1, ...n1, ...n0, ...n1, ...n0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** A canvas of the given size and its 2D context. */
export function canvas(w, h = w) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return { cv, g: cv.getContext('2d') };
}

/** Wraps a canvas in a colour texture (sRGB, mipmapped). */
export function canvasTexture(cv, { repeat = null, aniso = 1, srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(cv);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

/** A soft round blob (white centre → transparent edge), for contact shadows, glows and smoke. */
export function softDotTexture(size = 128, falloff = 1.6) {
  const { cv, g } = canvas(size);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    grad.addColorStop(t, `rgba(255,255,255,${(1 - t) ** falloff})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Linear interpolation between two THREE.Colors into `out`. */
export function mixColor(out, a, b, t) {
  return out.copy(a).lerp(b, t);
}

export const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Screen-door fade for things that may end up right in front of the camera (table props, the
 * stations, the train): fragments closer than `near` world units vanish, fully visible beyond
 * `far`, dithered in between (stays opaque: no sorting, no extra pass). Patches a built-in lit
 * material (it must declare vViewPosition, as MeshStandardMaterial does).
 */
export function nearFade(material, near = 1.1, far = 2.4) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', `
      float nfBayer(vec2 p) {
        vec2 q = mod(floor(p), 4.0);
        float b = mod(q.x + q.y * 2.0, 4.0) * 4.0 + mod(q.x * 3.0 + q.y, 4.0);
        return (b + 0.5) / 16.0;
      }
      void main() {
        if (smoothstep(${near.toFixed(3)}, ${far.toFixed(3)}, length(vViewPosition)) < nfBayer(gl_FragCoord.xy)) discard;`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|nearfade-${near}-${far}`;
  return material;
}
