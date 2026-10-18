// public/r3d/lot-kit.js — the building kit of Loop City's lots and landmarks, in metres (lane B).
//
//   * Shared uniforms come from the world bus (§17.2): uCityTime (flags wave, marquees chase), uLights (lit
//     windows, neon, crowns), uSnow (white roofs), uMapMode (dim + desaturate in map view).
//   * facadeMaterial: every building body is ONE instance of a unit box; the shader tiles a 1024 × 256 atlas
//     cell per storey (metres: residential 3.2, retail ground floor 4.2, office 3.6) and per bay, so windows
//     keep their size however tall a body grows; the ground floor gets doors / shopfronts; a mask tints only the
//     wall (not glass or doors) with the instance colour; windows light at dusk in a per-instance random
//     pattern; per-instance desaturation (mortgaged), owner-colour window flash (rent) and a dithered fade.
//   * partsMaterial: vertex-coloured parts with per-vertex masks (aPx: owner tint, glow / marquee chase, flag
//     wave, variant id). A VARIANT mesh is one InstancedMesh whose geometry holds many part shapes; each
//     instance shows one of them (aLook.x) and the vertex shader collapses the others — so a whole family of
//     roofs, porches, kits or hotel crowns costs ONE draw call. A matching depth material keeps shadows right.
//   * emblemMaterial (flags, roundels, pennants with the token silhouette), signMaterial (address posts,
//     hoardings, billboards composed from the sign atlas + per-instance numbers), groundMaterial (lot grounds:
//     gravel, lawn, cobbles, paving, plaza; owner tint in map view), nettingMaterial (alphaHash debris net).
//   * Pool: a packed InstancedMesh allocator (swap-remove), so meshes draw only the instances in use.
//
// No per-frame allocation: patterns live in the shaders (instance / local space, mediump-safe), and instance
// buffers are rewritten only when a lot changes or a ritual animates it.

import * as THREE from './three.js';
import { FACADE } from './lot-styles.js';
import { signAtlas, silhouetteAtlas, glyphStrip, wordRect, WORDS } from './signage.js';

// ---- shared uniforms ----------------------------------------------------------------------------------

/** The bus uniforms (§17.2) or private stand-ins; every lane-B material references these objects. */
export function cityUniforms(bus) {
  const u = bus?.uniforms ?? {};
  const pick = (name, v) => (u[name] && typeof u[name] === 'object' && 'value' in u[name] ? u[name] : { value: v });
  return {
    uCityTime: pick('uCityTime', 0),
    uLights: pick('uLights', 0),
    uDay: pick('uDay', 0.35),
    uSnow: pick('uSnow', 0),
    uWet: pick('uWet', 0),
    uMapMode: pick('uMapMode', 0),
  };
}

const GLSL_HASH = /* glsl */ `
  float lkHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float lkBayer(vec2 p) {
    vec2 q = mod(floor(p), 4.0);
    float b = mod(q.x + q.y * 2.0, 4.0) * 4.0 + mod(q.x * 3.0 + q.y, 4.0);
    return (b + 0.5) / 16.0;
  }
  float lkNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(lkHash(i), lkHash(i + vec2(1.0, 0.0)), f.x), mix(lkHash(i + vec2(0.0, 1.0)), lkHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }`;

// ---- part builder ---------------------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _n3 = new THREE.Matrix3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const _v = new THREE.Vector3();

/**
 * Collects primitive parts (transformed, coloured, with masks) into one non-indexed geometry.
 * Attributes: position, normal, color, aPx = (tint 0..1, glow 0 | 1 | 2 + chase phase, wave 0..1, variant id).
 */
export class PB {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.px = [];
  }

  /** Adds a geometry (consumed). t: { x, y, z, rx, ry, rz, sx, sy, sz, s, color, tint, glow, wave, matrix }. */
  add(geo, t = {}) {
    if (t.matrix) _m4.copy(t.matrix);
    else {
      _pos.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
      _quat.setFromEuler(_euler.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, t.order ?? 'XYZ'));
      const s = t.s ?? 1;
      _scl.set((t.sx ?? 1) * s, (t.sy ?? 1) * s, (t.sz ?? 1) * s);
      _m4.compose(_pos, _quat, _scl);
    }
    _n3.getNormalMatrix(_m4);
    _col.set(t.color ?? '#ffffff');
    const tint = t.tint ?? 0;
    const glow = t.glow ?? 0;
    const wave = t.wave ?? 0;
    const P = geo.attributes.position.array;
    const N = geo.attributes.normal?.array ?? null;
    const idx = geo.index ? geo.index.array : null;
    const n = idx ? idx.length : P.length / 3;
    const e = _m4.elements;
    const ne = _n3.elements;
    const pos = this.pos;
    const nor = this.nor;
    const col = this.col;
    const px = this.px;
    const r = _col.r;
    const g = _col.g;
    const b = _col.b;
    for (let k = 0; k < n; k++) {
      const j = (idx ? idx[k] : k) * 3;
      const x = P[j];
      const y = P[j + 1];
      const z = P[j + 2];
      pos.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      if (N) {
        const a = N[j];
        const c = N[j + 1];
        const d = N[j + 2];
        let nx = ne[0] * a + ne[3] * c + ne[6] * d;
        let ny = ne[1] * a + ne[4] * c + ne[7] * d;
        let nz = ne[2] * a + ne[5] * c + ne[8] * d;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        nor.push(nx, ny, nz);
      } else nor.push(0, 1, 0);
      col.push(r, g, b);
      px.push(tint, glow, wave, 0);
    }
    geo.dispose();
    return this;
  }

  box(w, h, d, t = {}) {
    return this.add(new THREE.BoxGeometry(w, h, d), t);
  }
  /** Box standing on y (t.y = its base). */
  block(w, h, d, t = {}) {
    return this.add(new THREE.BoxGeometry(w, h, d), { ...t, y: (t.y ?? 0) + h / 2 });
  }
  cyl(rTop, rBot, h, seg, t = {}) {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false), t);
  }
  /** Cylinder standing on y. */
  post(r, h, t = {}, seg = 8) {
    return this.add(new THREE.CylinderGeometry(r, r, h, seg), { ...t, y: (t.y ?? 0) + h / 2 });
  }
  sphere(r, t = {}, ws = 10, hs = 6) {
    return this.add(new THREE.SphereGeometry(r, ws, hs), t);
  }
  cone(r, h, seg, t = {}) {
    return this.add(new THREE.ConeGeometry(r, h, seg), t);
  }
  /** A tiny octahedron (flowers, bulbs, fruit): 8 triangles. */
  dot(r, t = {}) {
    return this.add(new THREE.OctahedronGeometry(r, 0), t);
  }
  /** A beam from a to b ([x,y,z]) with a square section. */
  beam(a, b, size, t = {}) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1e-3;
    const g = new THREE.BoxGeometry(size, len, size);
    _v.set(dx / len, dy / len, dz / len);
    _quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v);
    _pos.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    _m4.compose(_pos, _quat, _scl.set(1, 1, 1));
    return this.add(g, { ...t, matrix: _m4.clone() });
  }
  /** Extruded 2D shape (x, y) with depth along z, centred in z. */
  extrude(points, depth, t = {}) {
    const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, -depth / 2);
    return this.add(g, t);
  }
  lathe(profile, seg, t = {}) {
    return this.add(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), seg), t);
  }

  get count() {
    return this.pos.length / 3;
  }

  /** Builds the BufferGeometry (aPx.w = variant). */
  build(variant = 0) {
    const n = this.count;
    const px = new Float32Array(this.px);
    for (let k = 0; k < n; k++) px[k * 4 + 3] = variant;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPx', new THREE.BufferAttribute(px, 4));
    g.computeBoundingSphere();
    return g;
  }
}

/** Concatenates PB-built geometries into one variant geometry (variant k = list index). */
export function mergeVariants(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const px = new Float32Array(n * 4);
  let at = 0;
  list.forEach((g, k) => {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, at * 3);
    nor.set(g.attributes.normal.array, at * 3);
    col.set(g.attributes.color.array, at * 3);
    const src = g.attributes.aPx.array;
    for (let j = 0; j < c; j++) {
      px[(at + j) * 4] = src[j * 4];
      px[(at + j) * 4 + 1] = src[j * 4 + 1];
      px[(at + j) * 4 + 2] = src[j * 4 + 2];
      px[(at + j) * 4 + 3] = k;
    }
    at += c;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aPx', new THREE.BufferAttribute(px, 4));
  out.computeBoundingSphere();
  return out;
}

/** A variant set: { names: [...], index: Map(name → id), geometry } built from { name: (pb) => void }. */
export function variantSet(builders) {
  const names = Object.keys(builders);
  const geos = names.map((name) => {
    const pb = new PB();
    builders[name](pb);
    if (!pb.count) pb.box(0.001, 0.001, 0.001);
    return pb.build(0);
  });
  return { names, index: new Map(names.map((n, k) => [n, k])), geometry: mergeVariants(geos) };
}

// ---- facade atlas ------------------------------------------------------------------------------------

const CELL = 64;
const ATLAS_W = 16 * CELL;
const ATLAS_H = 4 * CELL;
let facadeCache = null;

/** Draws the facade atlas + its mask (R = lit window, G = wall tint). 16 columns × (upper, ground) × 2 pairs. */
function drawFacadeAtlas() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W;
  cv.height = ATLAS_H;
  const mk = document.createElement('canvas');
  mk.width = ATLAS_W;
  mk.height = ATLAS_H;
  const g = cv.getContext('2d');
  const m = mk.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  m.fillStyle = '#000';
  m.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const GLASS = '#33465a';
  const WALL = '#ffffff';
  // Every helper draws into the colour canvas and the mask (R lit, G wall).
  const cell = (id, ground, fn) => {
    const col = id % 16;
    const row = Math.floor(id / 16) * 2 + (ground ? 1 : 0);
    g.save();
    m.save();
    g.translate(col * CELL, row * CELL);
    m.translate(col * CELL, row * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    m.beginPath();
    m.rect(0, 0, CELL, CELL);
    m.clip();
    fn();
    g.restore();
    m.restore();
  };
  const wall = (shade = WALL) => {
    g.fillStyle = shade;
    g.fillRect(0, 0, CELL, CELL);
    m.fillStyle = '#00ff00';
    m.fillRect(0, 0, CELL, CELL);
  };
  const fixed = (x, y, w, h, color) => {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
    m.fillStyle = '#000';
    m.fillRect(x, y, w, h);
  };
  const wallTone = (x, y, w, h, color) => {
    // A tinted wall detail (it keeps the wall mask): shading lines, coursing, rustication.
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  };
  const pane = (x, y, w, h, { frame = '#f6f3ec', lw = 3, glass = GLASS, lit = true, bars = 1 } = {}) => {
    fixed(x - lw, y - lw, w + 2 * lw, h + 2 * lw, frame);
    fixed(x, y, w, h, glass);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(x, y, w * 0.38, h);
    if (lit) {
      m.fillStyle = '#ff0000';
      m.fillRect(x, y, w, h);
    }
    if (bars > 0) {
      g.fillStyle = frame;
      g.fillRect(x + w / 2 - 1, y, 2, h);
      if (h > w) g.fillRect(x, y + h / 2 - 1, w, 2);
    }
  };
  const door = (x, w, h, color, frame = '#f6f3ec', yb = CELL) => {
    fixed(x - 3, yb - h - 3, w + 6, h + 3, frame);
    fixed(x, yb - h, w, h, color);
    fixed(x + w - 5, yb - h / 2, 3, 3, '#d8b25a');
  };
  const sill = (y, color = 'rgba(0,0,0,0.10)') => wallTone(0, y, CELL, 3, color);
  const arch = (x, y, w, h, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y + h);
    g.lineTo(x, y + w / 2);
    g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
    g.lineTo(x + w, y + h);
    g.fill();
    m.fillStyle = '#000';
    m.beginPath();
    m.moveTo(x, y + h);
    m.lineTo(x, y + w / 2);
    m.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
    m.lineTo(x + w, y + h);
    m.fill();
  };
  const litArch = (x, y, w, h, glass = GLASS, frame = '#f3ede0') => {
    arch(x - 3, y - 3, w + 6, h + 3, frame);
    arch(x, y, w, h, glass);
    m.fillStyle = '#ff0000';
    m.fillRect(x, y + w / 2, w, h - w / 2);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fillRect(x, y + w / 2, w * 0.4, h - w / 2);
  };
  const brick = () => {
    for (let y = 2; y < CELL; y += 6) wallTone(0, y, CELL, 1, 'rgba(0,0,0,0.07)');
    for (let y = 2, r = 0; y < CELL; y += 6, r++) for (let x = r % 2 ? 0 : 8; x < CELL; x += 16) wallTone(x, y, 1, 6, 'rgba(0,0,0,0.05)');
  };

  // COTTAGE: brick/clapboard, white sash window with shutters; ground: door + window.
  cell(FACADE.COTTAGE, false, () => {
    wall();
    brick();
    fixed(12, 16, 6, 30, '#56606a');
    fixed(46, 16, 6, 30, '#56606a');
    pane(20, 16, 24, 30);
    sill(48, 'rgba(255,255,255,0.6)');
  });
  cell(FACADE.COTTAGE, true, () => {
    wall();
    brick();
    door(8, 16, 38, '#2f5d4e');
    pane(34, 22, 22, 24);
  });
  // TOWN: Old Town pastel house: tall window, flower box; ground: door with fanlight.
  cell(FACADE.TOWN, false, () => {
    wall();
    pane(20, 10, 24, 36, { bars: 1 });
    fixed(16, 47, 32, 6, '#7a5236');
    fixed(18, 43, 4, 4, '#e0567a');
    fixed(26, 42, 4, 5, '#f2c14e');
    fixed(34, 43, 4, 4, '#e0567a');
    fixed(42, 42, 4, 5, '#6bb36a');
    sill(60);
  });
  cell(FACADE.TOWN, true, () => {
    wall();
    door(22, 20, 40, '#3a5f8a');
    litArch(22, 12, 20, 10);
    wallTone(0, 0, CELL, 4, 'rgba(0,0,0,0.08)');
  });
  // SHOP: Market Lanes shop-house: sash windows; ground: lit shopfront.
  cell(FACADE.SHOP, false, () => {
    wall();
    pane(10, 14, 16, 30);
    pane(38, 14, 16, 30);
    wallTone(0, 52, CELL, 4, 'rgba(0,0,0,0.12)');
  });
  cell(FACADE.SHOP, true, () => {
    wall();
    fixed(0, 6, CELL, 6, '#2f4f44');
    pane(4, 18, 36, 40, { glass: '#46606e', lw: 2, bars: 0 });
    door(46, 14, 44, '#2f4f44');
  });
  // BROWNSTONE: tall windows with heavy lintels; ground: raised door (stoop) + window.
  cell(FACADE.BROWNSTONE, false, () => {
    wall();
    wallTone(14, 8, 36, 5, 'rgba(0,0,0,0.18)');
    pane(18, 14, 28, 38, { frame: '#e9dcc6' });
    wallTone(14, 55, 36, 3, 'rgba(0,0,0,0.15)');
  });
  cell(FACADE.BROWNSTONE, true, () => {
    wall();
    for (let y = 4; y < CELL; y += 8) wallTone(0, y, CELL, 2, 'rgba(0,0,0,0.12)');
    door(8, 18, 34, '#3b2418', '#e9dcc6', 40);
    pane(38, 10, 18, 30, { frame: '#e9dcc6' });
  });
  // DECO: piers and recessed windows; ground: lobby + poster frame.
  cell(FACADE.DECO, false, () => {
    wall();
    pane(6, 10, 20, 42, { frame: '#d8b25a', lw: 2 });
    pane(38, 10, 20, 42, { frame: '#d8b25a', lw: 2 });
    wallTone(29, 0, 6, CELL, 'rgba(0,0,0,0.10)');
  });
  cell(FACADE.DECO, true, () => {
    wall();
    pane(4, 14, 34, 50, { glass: '#2a3542', frame: '#d8b25a', lw: 2, bars: 0 });
    fixed(44, 18, 16, 26, '#f2e6d0');
    fixed(46, 20, 12, 22, '#c23b2e');
  });
  // GLASS: curtain wall; ground: glass lobby.
  const curtain = () => {
    g.fillStyle = '#7a98b2';
    g.fillRect(0, 0, CELL, CELL);
    m.fillStyle = '#000';
    m.fillRect(0, 0, CELL, CELL);
    m.fillStyle = '#bf0000';
    m.fillRect(6, 14, CELL - 12, CELL - 26);
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.fillRect(0, 0, CELL * 0.42, CELL);
    for (let x = 0; x < CELL; x += 16) fixed(x, 0, 2, CELL, '#e9eef2');
    fixed(0, CELL - 7, CELL, 7, '#eef2f5');
    m.fillStyle = '#00ff00';
    m.fillRect(0, CELL - 7, CELL, 7);
  };
  cell(FACADE.GLASS, false, curtain);
  cell(FACADE.GLASS, true, () => {
    curtain();
    fixed(0, 0, CELL, 8, '#3a4550');
  });
  // VILLA: white band + wide glass; ground: sliding glass doors.
  cell(FACADE.VILLA, false, () => {
    wall();
    pane(4, 12, 56, 34, { frame: '#e8e8e4', lw: 2, glass: '#3f5f78', bars: 0 });
    fixed(4, 44, 56, 2, '#9aa0a4');
  });
  cell(FACADE.VILLA, true, () => {
    wall();
    pane(4, 10, 56, 54, { frame: '#d9d9d4', lw: 2, glass: '#36566e', bars: 1 });
  });
  // HOTEL: balconies; ground: grand entrance.
  cell(FACADE.HOTEL, false, () => {
    wall();
    pane(10, 12, 16, 30, { glass: '#3b3f55' });
    pane(38, 12, 16, 30, { glass: '#3b3f55' });
    fixed(6, 44, 24, 4, '#6d5a45');
    fixed(34, 44, 24, 4, '#6d5a45');
  });
  cell(FACADE.HOTEL, true, () => {
    wall();
    pane(14, 20, 36, 44, { glass: '#2e2f40', frame: '#d8b25a', lw: 4 });
    fixed(10, 12, 44, 8, '#b3272d');
  });
  // VACANT: grey, dusty; ground: roller shutter.
  cell(FACADE.VACANT, false, () => {
    wall('#d6d6d0');
    pane(12, 16, 16, 22, { glass: '#565b5e', frame: '#b5b5ae', lit: false });
    pane(36, 16, 16, 22, { glass: '#4d5255', frame: '#b5b5ae', lit: false });
    wallTone(14, 38, 3, 14, 'rgba(0,0,0,0.12)');
  });
  cell(FACADE.VACANT, true, () => {
    wall('#d2d2cc');
    fixed(8, 16, 48, 48, '#9ea2a3');
    for (let y = 18; y < CELL; y += 5) fixed(8, y, 48, 1.5, '#7f8486');
  });
  // BOARDED: planks over the windows (mortgaged).
  const planks = (x, y, w, h) => {
    fixed(x, y, w, h, '#3f4246');
    g.save();
    g.beginPath();
    g.rect(x - 2, y - 2, w + 4, h + 4);
    g.clip();
    g.translate(x + w / 2, y + h / 2);
    g.fillStyle = '#b08a5c';
    g.rotate(-0.45);
    g.fillRect(-w, -4, w * 2, 7);
    g.rotate(0.9);
    g.fillRect(-w, -4, w * 2, 7);
    g.restore();
  };
  cell(FACADE.BOARDED, false, () => {
    wall('#e2ded6');
    planks(12, 16, 16, 26);
    planks(36, 16, 16, 26);
  });
  cell(FACADE.BOARDED, true, () => {
    wall('#dcd8cf');
    planks(10, 20, 44, 44);
  });
  // ROOF cap (gravel).
  cell(FACADE.ROOF, false, () => {
    fixed(0, 0, CELL, CELL, '#a9a69f');
    for (let k = 0; k < 160; k++) {
      g.fillStyle = k % 2 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)';
      g.fillRect((k * 37) % CELL, (k * 53) % CELL, 2, 2);
    }
  });
  cell(FACADE.ROOF, true, () => fixed(0, 0, CELL, CELL, '#a9a69f'));
  // CIVIC: stone with tall arched windows; ground: arched door.
  cell(FACADE.CIVIC, false, () => {
    wall();
    litArch(22, 8, 20, 44);
    wallTone(0, 58, CELL, 3, 'rgba(90,70,40,0.15)');
  });
  cell(FACADE.CIVIC, true, () => {
    wall();
    for (let y = 6; y < CELL; y += 10) wallTone(0, y, CELL, 2, 'rgba(0,0,0,0.08)');
    arch(17, 14, 30, 50, '#f6efe2');
    arch(20, 17, 24, 47, '#5b3a26');
  });
  // STATION: brick, arched windows; ground: big arched entrance.
  cell(FACADE.STATION, false, () => {
    wall();
    brick();
    litArch(20, 10, 24, 40, GLASS, '#e6dccb');
  });
  cell(FACADE.STATION, true, () => {
    wall();
    brick();
    arch(10, 8, 44, 56, '#e6dccb');
    arch(14, 12, 36, 52, '#2c3540');
    m.fillStyle = '#ff0000';
    m.fillRect(14, 30, 36, 34);
  });
  // STONE: Portland stone grid + glass; ground: bronze doors.
  cell(FACADE.STONE, false, () => {
    wall();
    pane(10, 10, 44, 40, { frame: '#efe8da', lw: 2, glass: '#3e5568', bars: 1 });
    wallTone(0, 56, CELL, 4, 'rgba(0,0,0,0.08)');
  });
  cell(FACADE.STONE, true, () => {
    wall();
    pane(6, 10, 52, 54, { frame: '#8a6a3a', lw: 3, glass: '#2d3b46', bars: 1 });
  });
  // INDUSTRIAL: brick with tall multi-pane windows; ground: big door.
  cell(FACADE.INDUSTRIAL, false, () => {
    wall();
    brick();
    litArch(14, 4, 36, 54, '#3f5262', '#e3d6bd');
    for (let y = 22; y < 58; y += 9) fixed(14, y, 36, 1.5, '#e3d6bd');
    fixed(31, 6, 2, 52, '#e3d6bd');
  });
  cell(FACADE.INDUSTRIAL, true, () => {
    wall();
    brick();
    fixed(10, 10, 44, 54, '#e3d6bd');
    fixed(13, 13, 38, 51, '#3d4448');
    for (let y = 16; y < CELL; y += 6) fixed(13, y, 38, 1, '#2d3236');
  });
  // BRICK (Electric Company HQ): windows with white frames; ground: door.
  cell(FACADE.BRICK, false, () => {
    wall();
    brick();
    pane(12, 14, 40, 32, { frame: '#efe6d6' });
  });
  cell(FACADE.BRICK, true, () => {
    wall();
    brick();
    door(24, 16, 42, '#24323f', '#efe6d6');
    pane(4, 22, 12, 24, { frame: '#efe6d6' });
    pane(48, 22, 12, 24, { frame: '#efe6d6' });
  });
  // DECOHOTEL: vertical gold strips.
  cell(FACADE.DECOHOTEL, false, () => {
    wall();
    pane(8, 8, 18, 48, { glass: '#2f3a48', frame: '#e9dcc0', lw: 2 });
    pane(38, 8, 18, 48, { glass: '#2f3a48', frame: '#e9dcc0', lw: 2 });
    fixed(30, 0, 4, CELL, '#d8b25a');
  });
  cell(FACADE.DECOHOTEL, true, () => {
    wall();
    pane(6, 14, 52, 50, { glass: '#232b36', frame: '#d8b25a', lw: 3, bars: 1 });
  });
  // GLASSHOTEL: blue glass ribbons with mullions.
  cell(FACADE.GLASSHOTEL, false, () => {
    g.fillStyle = '#5f86a8';
    g.fillRect(0, 0, CELL, CELL);
    m.fillStyle = '#000';
    m.fillRect(0, 0, CELL, CELL);
    m.fillStyle = '#d00000';
    m.fillRect(2, 8, CELL - 4, CELL - 18);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, 0, CELL * 0.5, CELL);
    fixed(0, CELL - 10, CELL, 10, '#e9eef2');
    m.fillStyle = '#00ff00';
    m.fillRect(0, CELL - 10, CELL, 10);
    for (let x = 0; x < CELL; x += 21) fixed(x, 0, 2, CELL - 10, '#cfd8df');
  });
  cell(FACADE.GLASSHOTEL, true, () => {
    fixed(0, 0, CELL, CELL, '#2c3e50');
    pane(2, 12, 60, 52, { glass: '#22313f', frame: '#c9d2d8', lw: 2, bars: 1 });
    fixed(0, 0, CELL, 10, '#d8b25a');
  });
  // STONEHOTEL: Beaux-Arts windows with balconettes.
  cell(FACADE.STONEHOTEL, false, () => {
    wall();
    pane(18, 10, 28, 40, { frame: '#f3ede0' });
    wallTone(14, 6, 36, 4, 'rgba(0,0,0,0.12)');
    fixed(14, 50, 36, 5, '#4b4f53');
  });
  cell(FACADE.STONEHOTEL, true, () => {
    wall();
    for (let y = 6; y < CELL; y += 9) wallTone(0, y, CELL, 2, 'rgba(0,0,0,0.10)');
    arch(14, 10, 36, 54, '#f3ede0');
    arch(18, 14, 28, 50, '#2e2f40');
    m.fillStyle = '#ff0000';
    m.fillRect(18, 30, 28, 34);
  });
  // INN: brick, white trim; ground: pub frontage.
  cell(FACADE.INN, false, () => {
    wall();
    brick();
    pane(18, 12, 28, 36, { frame: '#f4ecdc' });
  });
  cell(FACADE.INN, true, () => {
    wall();
    fixed(0, 4, CELL, CELL - 4, '#1f4a3a');
    pane(6, 16, 28, 30, { glass: '#c08a3a', frame: '#d8b25a', lw: 2 });
    fixed(40, 18, 16, 46, '#14332a');
    fixed(0, 4, CELL, 6, '#d8b25a');
  });
  // STORE: department-store display windows.
  cell(FACADE.STORE, false, () => {
    wall();
    pane(8, 12, 48, 34, { lw: 2 });
    fixed(0, 0, 5, CELL, '#f2ece0');
    fixed(CELL - 5, 0, 5, CELL, '#f2ece0');
  });
  cell(FACADE.STORE, true, () => {
    wall();
    pane(5, 12, 54, 52, { lw: 2, glass: '#3a4a55', bars: 0 });
    fixed(0, 0, CELL, 9, '#1f3d36');
  });
  // PAVILION: glass with thin frames.
  cell(FACADE.PAVILION, false, () => {
    fixed(0, 0, CELL, CELL, '#8fb7c6');
    m.fillStyle = '#d00000';
    m.fillRect(4, 4, CELL - 8, CELL - 8);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, 0, CELL * 0.45, CELL);
    for (let x = 0; x <= CELL; x += 32) fixed(x - 1, 0, 3, CELL, '#3d4a52');
    fixed(0, CELL - 3, CELL, 3, '#3d4a52');
  });
  cell(FACADE.PAVILION, true, () => {
    fixed(0, 0, CELL, CELL, '#86aebd');
    m.fillStyle = '#d00000';
    m.fillRect(4, 4, CELL - 8, CELL - 8);
    for (let x = 0; x <= CELL; x += 32) fixed(x - 1, 0, 3, CELL, '#3d4a52');
    fixed(20, 14, 24, 50, '#5d7d89');
  });
  // POLICE: brick + white bands; ground: blue door.
  cell(FACADE.POLICE, false, () => {
    wall();
    brick();
    pane(16, 14, 32, 32, { frame: '#f1ede4' });
    wallTone(0, 54, CELL, 5, 'rgba(255,255,255,0.55)');
  });
  cell(FACADE.POLICE, true, () => {
    wall();
    brick();
    door(22, 20, 44, '#1f3d7a', '#f1ede4');
  });
  // BANK: granite with tall windows; ground: bronze doors.
  cell(FACADE.BANK, false, () => {
    wall();
    pane(20, 6, 24, 50, { frame: '#f4efe4', glass: '#2f3e4b' });
  });
  cell(FACADE.BANK, true, () => {
    wall();
    for (let y = 4; y < CELL; y += 8) wallTone(0, y, CELL, 2, 'rgba(0,0,0,0.10)');
    fixed(18, 10, 28, 54, '#f4efe4');
    fixed(21, 13, 22, 51, '#8a6a3a');
    fixed(31, 13, 2, 51, '#5a4426');
  });
  return { cv, mk };
}

const ROOF_CELL = FACADE.ROOF;

/** Facade material + uniforms. Instances carry aFac, aFac2, aOwn, aFade and an instance colour (wall tint). */
export function facadeMaterial(renderer, U, { name = 'lot-facade' } = {}) {
  if (!facadeCache) facadeCache = drawFacadeAtlas();
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
  let map = null;
  let mask = null;
  if (facadeCache) {
    map = new THREE.CanvasTexture(facadeCache.cv);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = aniso;
    mask = new THREE.CanvasTexture(facadeCache.mk);
    mask.anisotropy = aniso;
  }
  const uniforms = { uMask: { value: mask }, uWindowColor: { value: new THREE.Color('#ffbf6b').multiplyScalar(1.6) } };
  const material = new THREE.MeshStandardMaterial({ name, map, roughness: 0.84, metalness: 0 });
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, { uLights: U.uLights, uSnow: U.uSnow, uMapMode: U.uMapMode });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFace;
        #ifdef USE_INSTANCING
          attribute vec4 aFac;
          attribute vec4 aFac2;
          attribute vec3 aOwn;
          attribute float aFade;
        #endif
        varying vec2 vFac;
        varying vec4 vFacA;
        varying vec4 vFacB;
        varying vec3 vOwn;
        varying float vCap;
        varying float vFade;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_INSTANCING
          float fW = length(instanceMatrix[0].xyz);
          float fH = length(instanceMatrix[1].xyz);
          float fD = length(instanceMatrix[2].xyz);
          vFacA = aFac; vFacB = aFac2; vOwn = aOwn; vFade = aFade;
        #else
          float fW = 1.0; float fH = 1.0; float fD = 1.0;
          vFacA = vec4(0.0, 0.0, 0.0, 3.2); vFacB = vec4(3.2, 3.0, 0.0, 0.0); vOwn = vec3(0.0); vFade = 1.0;
        #endif
        float fSpan = aFace < 0.5 ? fD : fW;
        float fBays = max(1.0, floor(fSpan / max(0.8, vFacB.y) + 0.5));
        float fY = uv.y * fH;
        float fG = max(0.5, vFacB.x);
        vFac = vec2(uv.x * fBays, fY < fG ? fY / fG : 1.0 + (fY - fG) / max(0.5, vFacA.w));
        vCap = step(1.5, aFace);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMask;
        uniform float uLights;
        uniform float uSnow;
        uniform float uMapMode;
        uniform vec3 uWindowColor;
        varying vec2 vFac;
        varying vec4 vFacA;
        varying vec4 vFacB;
        varying vec3 vOwn;
        varying float vCap;
        varying float vFade;
        ${GLSL_HASH}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vFade < 0.999 && vFade < lkBayer(gl_FragCoord.xy)) discard;`)
      .replace('#include <map_fragment>', `
        float litMask = 0.0;
        #ifdef USE_MAP
          float fId = floor(vFacA.x + 0.5);
          float fCol = mod(fId, 16.0);
          float fPair = floor(fId / 16.0);
          vec2 fCell = fract(vFac);
          float fRow = fPair * 2.0 + (vFac.y < 1.0 ? 1.0 : 0.0);
          vec2 fUv = vec2((fCol + 0.03 + 0.94 * fCell.x) / 16.0, 1.0 - (fRow + 1.0) / 4.0 + (0.03 + 0.94 * fCell.y) / 4.0);
          vec2 fScale = vec2(0.94 / 16.0, 0.94 / 4.0);
          vec2 fDx = dFdx(vFac) * fScale;
          vec2 fDy = dFdy(vFac) * fScale;
          if (vCap > 0.5) {
            fUv = vec2((${ROOF_CELL.toFixed(1)} + 0.5) / 16.0, 0.875);
            fDx = vec2(0.0);
            fDy = vec2(0.0);
          }
          vec4 fTex = textureGrad(map, fUv, fDx, fDy);
          vec4 fMsk = textureGrad(uMask, fUv, fDx, fDy);
          litMask = vCap > 0.5 ? 0.0 : fMsk.r;
          vec3 fTint = vec3(1.0);
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            fTint = vColor.rgb;
          #endif
          diffuseColor.rgb *= mix(fTex.rgb, fTex.rgb * fTint, fMsk.g * (1.0 - vCap));
        #endif
        {
          float fL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(fL), 0.75 * vFacB.z) * (1.0 - 0.3 * vFacB.z);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(fL), 0.35 * uMapMode) * (1.0 - 0.3 * uMapMode);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), uSnow * vCap);
        }`)
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.22, litMask);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec2 fIdv = floor(vFac) + vec2(vFacA.y * 17.0, vFacA.y * 29.0);
          float fOn = step(lkHash(fIdv), vFacA.z * uLights) * (1.0 - vCap) * (1.0 - vFacB.z);
          vec3 fWin = uWindowColor * fOn * (0.75 + 0.5 * lkHash(fIdv + 3.1));
          fWin = mix(fWin, vOwn * 2.2, clamp(vFacB.w, 0.0, 1.0));
          totalEmissiveRadiance += fWin * litMask;
        }`);
  };
  material.customProgramCacheKey = () => 'lot-facade-v2';
  return { material, uniforms, textures: [map, mask].filter(Boolean) };
}

/** Unit box (base at y = 0, no bottom face) with the aFace attribute the facade needs. */
export function bodyGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // Face order: +x, −x, +y, −y, +z, −z (4 vertices, 6 indices each). Drop −y (index range 18..23).
  const idx = Array.from(geo.index.array);
  idx.splice(18, 6);
  geo.setIndex(idx);
  const face = new Float32Array(24);
  for (let k = 0; k < 24; k++) face[k] = k < 8 ? 0 : k < 16 ? 2 : 1;
  geo.setAttribute('aFace', new THREE.BufferAttribute(face, 1));
  return geo;
}

// ---- parts material -----------------------------------------------------------------------------------

const PARTS_VERTEX_DECL = /* glsl */ `
  attribute vec4 aPx;
  #ifdef USE_INSTANCING
    attribute vec4 aLook;
    attribute float aFade;
  #endif
  uniform float uCityTime;
  varying vec3 vPx;
  varying vec3 vLook;
  varying float vFade;`;

const PARTS_BEGIN = /* glsl */ `
  #include <begin_vertex>
  {
    #ifdef USE_INSTANCING
      vec4 lk = aLook;
      if (abs(aPx.w - lk.x) > 0.5) transformed *= 0.0;
      float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
    #else
      vec4 lk = vec4(0.0, 0.0, 0.0, 1.0);
      float ph = position.x * 0.05 + position.z * 0.07;
    #endif
    if (aPx.z > 0.0) {
      float wv = sin(uCityTime * 4.2 + ph - position.x * 1.7);
      transformed.z += aPx.z * wv * 0.28;
      transformed.y += aPx.z * sin(uCityTime * 3.3 + ph * 1.3 - position.x * 2.3) * 0.05;
    }
  }`;

/**
 * Vertex-coloured parts with aPx masks; instanced meshes add aLook (variant, desat, glow boost, tint wipe) and
 * aFade. tint: vertex colour → instance colour; glow: 1 steady, 2 + phase chasing (marquee bulbs).
 */
export function partsMaterial(U, { name = 'lot-parts', roughness = 0.72, metalness = 0, side = THREE.FrontSide, flat = false } = {}) {
  const material = new THREE.MeshStandardMaterial({ name, vertexColors: true, roughness, metalness, side, flatShading: flat });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uCityTime = U.uCityTime;
    sh.uniforms.uLights = U.uLights;
    sh.uniforms.uSnow = U.uSnow;
    sh.uniforms.uMapMode = U.uMapMode;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${PARTS_VERTEX_DECL}`)
      .replace('#include <color_vertex>', `
        vColor = vec4(1.0);
        #ifdef USE_COLOR
          vColor.rgb = color;
        #endif
        {
          #ifdef USE_INSTANCING
            vec4 lk0 = aLook;
            float wipeX = lk0.w >= 0.999 ? 1e5 : mix(-14.0, 14.0, lk0.w);
            vLook = lk0.yzw;
            vFade = aFade;
          #else
            float wipeX = 1e5;
            vLook = vec3(0.0, 0.0, 1.0);
            vFade = 1.0;
          #endif
          float tintK = aPx.x * step(position.x, wipeX);
          #ifdef USE_INSTANCING_COLOR
            // Tinted parts take the instance colour, shaded by their own grey level (white = full colour).
            vColor.rgb = mix(vColor.rgb, instanceColor.rgb * max(vColor.r, max(vColor.g, vColor.b)), tintK);
          #endif
          vPx = vec3(aPx.y, tintK, 0.0);
        }`)
      .replace('#include <begin_vertex>', PARTS_BEGIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uCityTime;
        uniform float uLights;
        uniform float uSnow;
        uniform float uMapMode;
        varying vec3 vPx;
        varying vec3 vLook;
        varying float vFade;
        ${GLSL_HASH}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vFade < 0.999 && vFade < lkBayer(gl_FragCoord.xy)) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 lkBase = diffuseColor.rgb;
        {
          float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l), 0.75 * vLook.x) * (1.0 - 0.3 * vLook.x);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l), 0.35 * uMapMode) * (1.0 - 0.3 * uMapMode);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), uSnow * smoothstep(0.55, 0.85, wn.y) * (1.0 - step(0.5, vPx.x)));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float g = vPx.x;
          if (g > 0.5) {
            float on = g < 1.5 ? 1.0 : 0.25 + 0.75 * step(0.5, fract(uCityTime * 1.6 - (g - 2.0) * 3.0));
            totalEmissiveRadiance += lkBase * on * (0.35 + 1.9 * uLights + vLook.y) * (1.0 - 0.85 * vLook.x);
          } else if (vLook.y > 0.0) {
            totalEmissiveRadiance += lkBase * 0.6 * vLook.y;
          }
        }`);
  };
  material.customProgramCacheKey = () => `lot-parts-v2|${name}`;
  return material;
}

/** Depth material for variant meshes (the shadow pass collapses hidden variants and waves flags too). */
export function partsDepthMaterial(U) {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uCityTime = U.uCityTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aPx;
        #ifdef USE_INSTANCING
          attribute vec4 aLook;
        #endif
        uniform float uCityTime;`)
      .replace('#include <begin_vertex>', PARTS_BEGIN);
  };
  material.customProgramCacheKey = () => 'lot-parts-depth-v2';
  return material;
}

// ---- emblems (flags, roundels, pennants, plates) -------------------------------------------------------

let silTexCache = new WeakMap();
function silTexture(renderer) {
  const key = renderer ?? silTexCache;
  if (silTexCache.has(key)) return silTexCache.get(key);
  const cv = silhouetteAtlas();
  const tex = cv ? new THREE.CanvasTexture(cv) : null;
  if (tex) tex.anisotropy = 4;
  silTexCache.set(key, tex);
  return tex;
}

/**
 * Emblem material: a 1 × 1 plane (x 0..1 from the pole, y 0..1) per instance. aEm = (shape 0 flag | 1 roundel |
 * 2 pennant | 3 plate, silhouette index or −1, wave, mortgaged 0..1); instance colour = owner colour.
 */
export function emblemMaterial(renderer, U) {
  const sil = silTexture(renderer);
  const material = new THREE.MeshStandardMaterial({ name: 'lot-emblems', roughness: 0.75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uSil = { value: sil };
    sh.uniforms.uCityTime = U.uCityTime;
    sh.uniforms.uLights = U.uLights;
    sh.uniforms.uMapMode = U.uMapMode;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aEm;
        uniform float uCityTime;
        varying vec4 vEm;
        varying vec2 vEUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vEm = aEm;
        vEUv = uv;
        #ifdef USE_INSTANCING
          float eph = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.17;
        #else
          float eph = 0.0;
        #endif
        transformed.z += aEm.z * uv.x * sin(uCityTime * 5.0 + eph - uv.x * 4.5) * 0.12;
        transformed.y += aEm.z * uv.x * sin(uCityTime * 3.7 + eph) * 0.03;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uSil;
        uniform float uLights;
        uniform float uMapMode;
        varying vec4 vEm;
        varying vec2 vEUv;`)
      .replace('#include <color_fragment>', `
        {
          vec2 uv = vEUv;
          vec3 own = vec3(1.0);
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            own = vColor.rgb;
          #endif
          vec3 col = own;
          float shape = vEm.x;
          vec2 su = vec2(-1.0);
          if (shape > 0.5 && shape < 1.5) {
            vec2 c = uv - 0.5;
            float r = length(c) * 2.0;
            if (r > 1.0) discard;
            float ring = smoothstep(0.78, 0.8, r) * (1.0 - smoothstep(0.88, 0.9, r));
            col = mix(own * 0.92, vec3(1.0), ring);
            su = c / 0.56 + 0.5;
          } else if (shape > 1.5 && shape < 2.5) {
            if (abs(uv.y - 0.5) > 0.5 * (1.0 - uv.x)) discard;
            su = (uv - vec2(0.3, 0.5)) / vec2(0.42, 0.6) + 0.5;
          } else if (shape > 2.5) {
            su = (uv - 0.5) / vec2(0.5, 0.82) + 0.5;
          } else {
            su = (uv - vec2(0.48, 0.5)) / vec2(0.5, 0.76) + 0.5;
            col = mix(col, col * 0.8, step(0.94, uv.x));
          }
          if (vEm.y >= 0.0 && su.x >= 0.0 && su.x <= 1.0 && su.y >= 0.0 && su.y <= 1.0) {
            float s = texture2D(uSil, vec2((vEm.y + su.x) / 8.0, su.y)).a;
            col = mix(col, vec3(1.0), s);
          }
          if (vEm.w > 0.01) {
            float l = dot(col, vec3(0.299, 0.587, 0.114));
            vec3 g = vec3(l) * 0.72;
            float hatch = step(0.55, fract((uv.x + uv.y) * 7.0));
            g = mix(g, vec3(0.78, 0.12, 0.12), hatch * 0.6);
            col = mix(col, g, vEm.w);
          }
          float l2 = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, vec3(l2), 0.2 * uMapMode);
          diffuseColor.rgb = col;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * (0.06 + 0.3 * uLights) * (1.0 - 0.8 * vEm.w);`);
  };
  material.customProgramCacheKey = () => 'lot-emblems-v2';
  return material;
}

/** Emblem plane: x 0..1 (pole side at 0), y 0..1, facing +z, subdivided for the wave. */
export function emblemGeometry() {
  return new THREE.PlaneGeometry(1, 1, 8, 3).translate(0.5, 0.5, 0);
}

// ---- signs -------------------------------------------------------------------------------------------

let signTexCache = new WeakMap();
function signTexture(renderer, board) {
  const key = renderer ?? signTexCache;
  if (signTexCache.has(key)) return signTexCache.get(key);
  const cv = signAtlas(board);
  let tex = null;
  if (cv) {
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
  }
  signTexCache.set(key, tex);
  return tex;
}

/**
 * Sign material on a 1 × 1 plane per instance (facing +z). aRect = uv rect of the main cell; aMode = (mode,
 * pips, mortgaged, pip style); aVal = (label word, number, full-line word, strip word); aOwnS = (owner rgb,
 * silhouette or −1). Modes: 0 plain cell × instance colour · 1 address post · 2 for-sale hoarding panel.
 */
export function signMaterial(renderer, U, board) {
  const tex = signTexture(renderer, board);
  const sil = silTexture(renderer);
  const words = WORDS.map((w) => new THREE.Vector4(...wordRect(w)));
  const material = new THREE.MeshStandardMaterial({ name: 'lot-signs', roughness: 0.6, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uSign = { value: tex };
    sh.uniforms.uSil = { value: sil };
    sh.uniforms.uGlyph = { value: new THREE.Vector4(...glyphStrip()) };
    sh.uniforms.uWords = { value: words };
    sh.uniforms.uLights = U.uLights;
    sh.uniforms.uMapMode = U.uMapMode;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        #ifdef USE_INSTANCING
          attribute vec4 aRect;
          attribute vec4 aMode;
          attribute vec4 aVal;
          attribute vec4 aOwnS;
        #endif
        varying vec4 vRect;
        varying vec4 vMode;
        varying vec4 vVal;
        varying vec4 vOwnS;
        varying vec2 vSUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSUv = uv;
        #ifdef USE_INSTANCING
          vRect = aRect; vMode = aMode; vVal = aVal; vOwnS = aOwnS;
        #else
          vRect = vec4(0.0, 0.0, 1.0, 1.0); vMode = vec4(0.0); vVal = vec4(-1.0); vOwnS = vec4(0.0, 0.0, 0.0, -1.0);
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uSign;
        uniform sampler2D uSil;
        uniform vec4 uGlyph;
        uniform vec4 uWords[${WORDS.length}];
        uniform float uLights;
        uniform float uMapMode;
        varying vec4 vRect;
        varying vec4 vMode;
        varying vec4 vVal;
        varying vec4 vOwnS;
        varying vec2 vSUv;
        const vec3 PAPER = vec3(0.984, 0.98, 0.965);
        vec3 lkRect(vec4 r, vec2 t) { return texture2D(uSign, mix(r.xy, r.zw, clamp(t, 0.002, 0.998))).rgb; }
        vec3 lkWord(float k, vec2 t) {
          int i = int(k + 0.5);
          vec4 r = vec4(0.0);
          for (int j = 0; j < ${WORDS.length}; j++) { if (j == i) r = uWords[j]; }
          return lkRect(r, t);
        }
        vec3 lkDigits(float num, vec2 t, float slots) {
          num = floor(num + 0.5);
          float nd = num < 10.0 ? 1.0 : num < 100.0 ? 2.0 : num < 1000.0 ? 3.0 : 4.0;
          float x = (1.0 - t.x) * slots;
          float j = floor(x);
          float lx = fract(x);
          float gi = -1.0;
          float p = j < 0.5 ? 1.0 : j < 1.5 ? 10.0 : j < 2.5 ? 100.0 : 1000.0;
          if (j < nd) gi = 1.0 + mod(floor(num / p + 0.001), 10.0);
          else if (j < nd + 0.5) gi = 0.0;
          if (gi < 0.0 || t.y < 0.0 || t.y > 1.0) return PAPER;
          return texture2D(uSign, vec2(uGlyph.x + (gi + 1.0 - lx) * uGlyph.z, uGlyph.y + clamp(t.y, 0.02, 0.98) * uGlyph.w)).rgb;
        }
        float lkBox(vec2 p, vec2 a, vec2 b) { return step(a.x, p.x) * step(p.x, b.x) * step(a.y, p.y) * step(p.y, b.y); }`)
      .replace('#include <color_fragment>', `
        {
          vec2 uv = vSUv;
          float mode = vMode.x;
          vec3 col = PAPER;
          if (mode < 0.5) {
            col = lkRect(vRect, uv);
            #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
              col *= vColor.rgb;
            #endif
          } else if (mode < 1.5) {
            // Address post: name cell · value line · owner strip.
            if (uv.y >= 0.52) col = lkRect(vRect, vec2(uv.x, (uv.y - 0.52) / 0.48));
            else if (uv.y >= 0.30) {
              vec2 t = vec2(uv.x, (uv.y - 0.30) / 0.22);
              if (vVal.z >= 0.0) col = lkWord(vVal.z, vec2((uv.x - 0.06) / 0.88, t.y));
              else if (uv.x < 0.48) col = vVal.x >= 0.0 ? lkWord(vVal.x, vec2((uv.x - 0.03) / 0.44, t.y)) : PAPER;
              else col = lkDigits(vVal.y, vec2((uv.x - 0.5) / 0.47, t.y), 5.0);
            } else {
              vec2 t = vec2(uv.x, uv.y / 0.30);
              if (vOwnS.w < -0.5) {
                col = vVal.w >= 0.0 ? lkWord(vVal.w, vec2((uv.x - 0.1) / 0.8, (t.y - 0.12) / 0.76)) : PAPER;
                if (vVal.w >= 0.0 && (uv.x < 0.1 || uv.x > 0.9 || t.y < 0.12 || t.y > 0.88)) col = PAPER;
              } else {
                // Owner plate (colour + token silhouette).
                if (uv.x < 0.42) {
                  vec2 p = vec2((uv.x - 0.04) / 0.36, (t.y - 0.1) / 0.8);
                  if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0) {
                    col = vOwnS.rgb;
                    vec2 su = (p - 0.5) * vec2(1.25, 1.0) + 0.5;
                    if (vOwnS.w >= 0.0 && su.x >= 0.0 && su.x <= 1.0) col = mix(col, vec3(1.0), texture2D(uSil, vec2((vOwnS.w + su.x) / 8.0, su.y)).a);
                  }
                } else {
                  vec2 q = vec2((uv.x - 0.45) / 0.52, t.y);
                  if (vMode.z > 0.5) col = lkWord(${WORDS.indexOf('MORTGAGED')}.0, vec2(q.x, (q.y - 0.12) / 0.76));
                  else if (vMode.y > 4.5) col = lkWord(${WORDS.indexOf('HOTEL')}.0, vec2(q.x, (q.y - 0.12) / 0.76));
                  else if (vMode.y > 0.5) {
                    float k = floor(q.x * 4.0);
                    vec2 c = vec2(fract(q.x * 4.0), q.y);
                    float house = lkBox(c, vec2(0.2, 0.15), vec2(0.8, 0.55)) + step(abs(c.x - 0.5) * 0.9 + 0.55, 1.0 - (c.y - 0.55)) * step(0.55, c.y) * step(c.y, 0.85);
                    vec3 pip = vMode.w > 0.5 ? vec3(0.22, 0.27, 0.31) : vec3(0.13, 0.55, 0.25);
                    if (k < vMode.y && house > 0.5) col = pip;
                  }
                }
              }
            }
            // Frame.
            float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
            col = mix(vec3(0.16, 0.17, 0.19), col, step(0.015, e));
          } else {
            // For-sale hoarding panel: FOR SALE · name · $price.
            if (uv.x < 0.27) col = lkWord(${WORDS.indexOf('FOR SALE')}.0, vec2((uv.x - 0.01) / 0.25, (uv.y - 0.12) / 0.76));
            else if (uv.x < 0.75) col = lkRect(vRect, vec2((uv.x - 0.28) / 0.46, (uv.y - 0.04) / 0.92));
            else col = lkDigits(vVal.y, vec2((uv.x - 0.76) / 0.22, (uv.y - 0.2) / 0.6), 4.0);
            if (uv.x < 0.27 && (uv.y < 0.12 || uv.y > 0.88)) col = vec3(0.84, 0.17, 0.17);
          }
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, vec3(l), 0.25 * uMapMode);
          diffuseColor.rgb = col;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * (0.04 + 0.42 * uLights);`);
  };
  material.customProgramCacheKey = () => 'lot-signs-v2';
  return { material, texture: tex };
}

export function signGeometry() {
  return new THREE.PlaneGeometry(1, 1);
}

// ---- lot grounds -------------------------------------------------------------------------------------

/** Ground kinds for groundMaterial (aGround.x / .y). */
export const GROUND = Object.freeze({ gravel: 0, lawn: 1, cobble: 2, paving: 3, plaza: 4, dirt: 5 });

/**
 * Lot grounds: one unit box per lot, scaled to the lot (w × 0.6 × d, top at the lot base). aGround = (kind A,
 * kind B, wipe 0..1: B spreads from the street side, weeds 0..1); instance colour = owner colour (map view tint).
 */
export function groundMaterial(U) {
  const material = new THREE.MeshStandardMaterial({ name: 'lot-ground', roughness: 0.95 });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = U.uSnow;
    sh.uniforms.uMapMode = U.uMapMode;
    sh.uniforms.uWet = U.uWet;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        #ifdef USE_INSTANCING
          attribute vec4 aGround;
        #endif
        varying vec4 vGround;
        varying vec3 vLocal;
        varying float vTop;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vGround = aGround;
          vLocal = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
          vGround = vec4(1.0, 1.0, 1.0, 0.0);
          vLocal = position;
        #endif
        vTop = step(0.5, normal.y);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSnow;
        uniform float uMapMode;
        uniform float uWet;
        varying vec4 vGround;
        varying vec3 vLocal;
        varying float vTop;
        ${GLSL_HASH}
        vec3 lkGround(float k, vec2 p, float zs) {
          float n = lkNoise(p * 0.9);
          float n2 = lkNoise(p * 3.7);
          if (k < 0.5) {            // gravel
            return mix(vec3(0.52, 0.49, 0.44), vec3(0.64, 0.61, 0.56), n2) * (0.9 + 0.2 * n);
          } else if (k < 1.5) {     // lawn with mowing stripes and a path to the door
            vec3 g = mix(vec3(0.27, 0.45, 0.2), vec3(0.34, 0.54, 0.24), step(0.5, fract(p.x / 3.0)));
            g *= 0.88 + 0.22 * n;
            float path = step(abs(p.x), 1.2) * step(9.0, zs);
            return mix(g, vec3(0.74, 0.71, 0.66) * (0.92 + 0.1 * n2), path);
          } else if (k < 2.5) {     // cobbles
            vec2 q = p / vec2(0.55, 0.42);
            q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
            vec2 f = fract(q) - 0.5;
            float stone = smoothstep(0.5, 0.36, max(abs(f.x), abs(f.y)));
            vec3 c = mix(vec3(0.42, 0.4, 0.38), vec3(0.62, 0.58, 0.53), lkHash(floor(q)));
            return mix(vec3(0.3, 0.29, 0.27), c, stone);
          } else if (k < 3.5) {     // paving slabs
            vec2 f = fract(p / 1.2);
            float joint = step(0.04, f.x) * step(0.04, f.y);
            vec3 c = mix(vec3(0.7, 0.68, 0.64), vec3(0.78, 0.76, 0.72), lkHash(floor(p / 1.2)));
            return mix(vec3(0.5, 0.49, 0.47), c, joint);
          } else if (k < 4.5) {     // plaza: big polished slabs
            vec2 f = fract(p / 3.0);
            float joint = step(0.015, f.x) * step(0.015, f.y);
            vec3 c = mix(vec3(0.82, 0.8, 0.77), vec3(0.88, 0.86, 0.83), lkHash(floor(p / 3.0)));
            return mix(vec3(0.62, 0.6, 0.58), c, joint);
          }
          return mix(vec3(0.45, 0.35, 0.26), vec3(0.55, 0.43, 0.32), n2);   // dirt
        }`)
      .replace('#include <color_fragment>', `
        {
          vec2 p = vLocal.xz;
          float zs = vLocal.z;                                   // + toward the street
          float span = 34.0;
          float wipe = clamp(vGround.z, 0.0, 1.0);
          float front = (zs + span * 0.5) / span;                // 0 back … 1 street
          float useB = step(1.0 - wipe, front);
          vec3 c = mix(lkGround(vGround.x, p, zs), lkGround(vGround.y, p, zs), useB);
          float weeds = vGround.w * smoothstep(0.55, 0.75, lkNoise(p * 0.45 + 7.0));
          c = mix(c, vec3(0.33, 0.4, 0.2) * (0.8 + 0.3 * lkNoise(p * 4.0)), weeds * 0.8);
          c = mix(c * 0.8, c, vTop);
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            c = mix(c, vColor.rgb, 0.35 * uMapMode);
          #endif
          c = mix(c, vec3(0.93, 0.95, 0.98), uSnow * vTop * 0.9);
          c *= 1.0 - 0.25 * uWet * vTop;
          diffuseColor.rgb = c;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.4, uWet * vTop);`);
  };
  material.customProgramCacheKey = () => 'lot-ground-v2';
  return material;
}

/** Owner-colour debris netting (alphaHash; instance colour = owner). */
export function nettingMaterial() {
  return new THREE.MeshStandardMaterial({ name: 'lot-netting', color: '#ffffff', roughness: 0.9, alphaHash: true, opacity: 0.62, side: THREE.DoubleSide });
}

// ---- the packed instance pool ------------------------------------------------------------------------

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * A packed allocator over an InstancedMesh: alloc() → handle { i }, free(handle) swap-removes; mesh.count is the
 * number of live instances (the mesh hides itself when empty). Extra per-instance attributes are copied on swap.
 */
export class Pool {
  constructor(mesh, attrs = []) {
    this.mesh = mesh;
    this.cap = mesh.instanceMatrix.count;
    this.attrs = attrs;
    this.handles = new Array(this.cap).fill(null);
    this.n = 0;
    mesh.count = 0;
    mesh.visible = false;
  }

  alloc() {
    if (this.n >= this.cap) return null;
    const h = { i: this.n, pool: this, alive: true };
    this.handles[this.n++] = h;
    this.mesh.count = this.n;
    this.mesh.visible = true;
    this.mesh.setMatrixAt(h.i, ZERO);
    return h;
  }

  free(h) {
    if (!h || !h.alive || h.pool !== this) return;
    const last = this.n - 1;
    const moved = this.handles[last];
    if (moved !== h) {
      const m = this.mesh;
      copyItem(m.instanceMatrix, last, h.i);
      if (m.instanceColor) copyItem(m.instanceColor, last, h.i);
      for (const a of this.attrs) copyItem(a, last, h.i);
      moved.i = h.i;
      this.handles[h.i] = moved;
    }
    this.handles[last] = null;
    this.n--;
    h.alive = false;
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    this.dirty();
  }

  dirty() {
    const m = this.mesh;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    for (const a of this.attrs) a.needsUpdate = true;
  }

  clear() {
    for (let k = 0; k < this.n; k++) if (this.handles[k]) this.handles[k].alive = false;
    this.handles.fill(null);
    this.n = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}

function copyItem(attr, from, to) {
  const s = attr.itemSize;
  const a = attr.array;
  for (let k = 0; k < s; k++) a[to * s + k] = a[from * s + k];
}

/** An InstancedMesh with an instance colour and extra InstancedBufferAttributes ({ name: itemSize }). */
export function instanced(name, geometry, material, cap, attrs = {}, { cast = false, receive = true } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.frustumCulled = false;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  const list = [];
  for (const [k, size] of Object.entries(attrs)) {
    const arr = new Float32Array(cap * size);
    if (k === 'aFade') arr.fill(1);
    if (k === 'aLook') for (let j = 0; j < cap; j++) arr[j * 4 + 3] = 1;
    if (k === 'aOwnS') for (let j = 0; j < cap; j++) arr[j * 4 + 3] = -1;
    const a = new THREE.InstancedBufferAttribute(arr, size);
    a.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(k, a);
    list.push(a);
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return { mesh, attrs: list, pool: new Pool(mesh, [...list]) };
}

// ---- geometry: roofs (unit-sized: footprint 1 × 1 centred, height 1 from y = 0) -------------------------

const CREAM = '#efe8da';
const SLATE = '#ffffff';

export const ROOF_BUILDERS = {
  gable(pb) {
    // Ridge along x; slopes face ±z; gable ends in cream; ridge cap.
    pb.extrude([[-0.54, 0], [0.54, 0], [0, 1]], 1.04, { ry: Math.PI / 2, color: SLATE, tint: 1 });
    pb.extrude([[-0.5, 0], [0.5, 0], [0, 0.93]], 1.0, { ry: Math.PI / 2, color: CREAM, sx: 1.003 });
    pb.box(1.06, 0.06, 0.06, { y: 1.0, color: '#3a3d42' });
  },
  frontGable(pb) {
    // Ridge along z: the gable end faces the street, with a white bargeboard.
    pb.extrude([[-0.54, 0], [0.54, 0], [0, 1]], 1.04, { color: SLATE, tint: 1 });
    pb.extrude([[-0.5, 0], [0.5, 0], [0, 0.93]], 1.0, { color: CREAM, sz: 1.003 });
    pb.extrude([[-0.56, -0.02], [0.56, -0.02], [0, 1.04], [-0.56, -0.02]], 0.03, { z: 0.52, color: '#ffffff' });
    pb.box(0.24, 0.32, 0.03, { y: 0.36, z: 0.505, color: '#33465a' });
  },
  mansard(pb) {
    // Steep slate sides, flat top, two dormers on the street face.
    const g = new THREE.CylinderGeometry(0.64 / Math.SQRT2, 1.04 / Math.SQRT2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    pb.add(g.toNonIndexed(), { color: SLATE, tint: 1 });
    g.dispose();
    for (const x of [-0.22, 0.22]) {
      pb.box(0.16, 0.42, 0.24, { x, y: 0.4, z: 0.38, color: CREAM });
      pb.box(0.1, 0.24, 0.02, { x, y: 0.38, z: 0.505, color: '#33465a' });
      pb.extrude([[-0.1, 0], [0.1, 0], [0, 0.12]], 0.26, { x, y: 0.61, z: 0.38, color: '#5a5e63' });
    }
  },
  mansardFlat(pb) {
    const g = new THREE.CylinderGeometry(0.86 / Math.SQRT2, 1.03 / Math.SQRT2, 0.85, 4, 1).rotateY(Math.PI / 4).translate(0, 0.425, 0);
    pb.add(g.toNonIndexed(), { color: SLATE, tint: 1 });
    g.dispose();
    pb.box(0.86, 0.1, 0.86, { y: 0.9, color: '#c9c4b8' });
    for (const x of [-0.3, -0.1, 0.1, 0.3]) pb.box(0.06, 0.32, 0.06, { x, y: 0.4, z: 0.47, color: CREAM });
  },
  flat(pb) {
    // Parapet ring (coping tinted to the trim) + a roof hatch.
    const t = 0.03;
    pb.box(1.0, 1, t, { y: 0.5, z: 0.5 - t / 2, color: '#e6e1d6', tint: 1 });
    pb.box(1.0, 1, t, { y: 0.5, z: -0.5 + t / 2, color: '#e6e1d6', tint: 1 });
    pb.box(t, 1, 1, { x: 0.5 - t / 2, y: 0.5, color: '#e6e1d6', tint: 1 });
    pb.box(t, 1, 1, { x: -0.5 + t / 2, y: 0.5, color: '#e6e1d6', tint: 1 });
    pb.box(0.08, 0.6, 0.06, { x: -0.25, y: 0.3, z: -0.2, color: '#9da1a4' });
  },
  cornice(pb) {
    // Brownstone: heavy dark cornice band with brackets, overhanging the facade.
    pb.box(1.06, 0.36, 1.03, { y: 0.82, color: '#3a2d26', tint: 0 });
    for (let k = 0; k < 7; k++) pb.box(0.04, 0.3, 0.06, { x: -0.45 + k * 0.15, y: 0.5, z: 0.51, color: '#2c221d' });
    pb.box(1.0, 0.6, 0.98, { y: 0.3, color: '#4a3a31' });
  },
  villaTerrace(pb) {
    // Roof terrace: glass balustrade, timber pergola over half, a planter.
    const t = 0.02;
    pb.box(1.0, 0.9, t, { y: 0.45, z: 0.49, color: '#a9c4cf' });
    pb.box(t, 0.9, 1.0, { x: 0.49, y: 0.45, color: '#a9c4cf' });
    pb.box(t, 0.9, 1.0, { x: -0.49, y: 0.45, color: '#a9c4cf' });
    pb.box(1.0, 0.9, t, { y: 0.45, z: -0.49, color: '#a9c4cf' });
    for (const x of [-0.45, -0.05]) for (const z of [-0.4, 0.1]) pb.box(0.03, 1.0, 0.03, { x, y: 0.5, z, color: '#8a6a4a' });
    for (let k = 0; k < 6; k++) pb.box(0.42, 0.03, 0.03, { x: -0.25, y: 1.0, z: -0.4 + k * 0.1, color: '#8a6a4a' });
    pb.box(0.3, 0.25, 0.12, { x: 0.25, y: 0.13, z: -0.35, color: '#6b8f4e' });
  },
  hip(pb) {
    const g = new THREE.CylinderGeometry(0.02, 1.08 / Math.SQRT2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    pb.add(g.toNonIndexed(), { color: SLATE, tint: 1, sx: 1, sz: 1 });
    g.dispose();
  },
  balustrade(pb) {
    pb.box(1.0, 0.18, 1.0, { y: 0.09, color: '#e8e0cf' });
    const n = 14;
    for (let k = 0; k <= n; k++) {
      const u = -0.5 + k / n;
      pb.box(0.012, 0.6, 0.012, { x: u, y: 0.48, z: 0.49, color: '#efe8da' });
      pb.box(0.012, 0.6, 0.012, { x: u, y: 0.48, z: -0.49, color: '#efe8da' });
      pb.box(0.012, 0.6, 0.012, { x: 0.49, y: 0.48, z: u, color: '#efe8da' });
      pb.box(0.012, 0.6, 0.012, { x: -0.49, y: 0.48, z: u, color: '#efe8da' });
    }
    pb.box(1.0, 0.1, 0.03, { y: 0.84, z: 0.49, color: '#efe8da' });
    pb.box(1.0, 0.1, 0.03, { y: 0.84, z: -0.49, color: '#efe8da' });
    pb.box(0.03, 0.1, 1.0, { x: 0.49, y: 0.84, color: '#efe8da' });
    pb.box(0.03, 0.1, 1.0, { x: -0.49, y: 0.84, color: '#efe8da' });
  },
  // The canopy over a station / utility entrance (owner colour), unit-scaled (w × 1 × depth; y = thickness).
  canopy(pb) {
    pb.box(1.0, 0.6, 1.0, { y: 0.3, color: '#ffffff', tint: 1 });
    pb.box(1.0, 1.0, 0.03, { y: -0.2, z: 0.5, color: '#ffffff', tint: 1 });
    pb.box(1.0, 0.25, 1.0, { y: 0.72, color: '#d8d4cb' });
  },
  // Unit cube of scaffolding (poles + planks), scaled to a building shell.
  scaffold(pb) {
    const c = '#d9a93a';
    for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) pb.box(0.012, 1, 0.012, { x, y: 0.5, z, color: c });
    for (let k = 1; k <= 8; k++) {
      const y = k / 8;
      pb.box(1.0, 0.006, 0.02, { y, z: 0.5, color: '#b88a32' });
      pb.box(1.0, 0.006, 0.02, { y, z: -0.5, color: '#b88a32' });
      pb.box(0.02, 0.006, 1.0, { x: 0.5, y, color: '#b88a32' });
      pb.box(0.02, 0.006, 1.0, { x: -0.5, y, color: '#b88a32' });
    }
    for (const z of [-0.5, 0.5]) for (let k = 0; k < 4; k++) pb.beam([-0.5 + k * 0.25, k % 2 ? 0 : 1, z], [-0.25 + k * 0.25, k % 2 ? 1 : 0, z], 0.008, { color: c });
  },
};

// ---- small reusable props (metres) -------------------------------------------------------------------

const HALF_PI = Math.PI / 2;
export function tree(pb, x, z, s = 1, { y = 0, crown = '#4f8a3c', crown2 = '#62a04a' } = {}) {
  pb.post(0.14 * s, 2.2 * s, { x, y, z, color: '#6b4a2b' }, 6);
  pb.sphere(1.4 * s, { x, y: y + 2.9 * s, z, sy: 1.1, color: crown }, 8, 6);
  pb.sphere(0.95 * s, { x: x + 0.5 * s, y: y + 3.5 * s, z: z + 0.3 * s, color: crown2 }, 8, 5);
}
export function palm(pb, x, z, h = 7, lean = 0.25) {
  const seg = 6;
  let px = x;
  let py = 0;
  for (let k = 0; k < seg; k++) {
    const nx = px + (lean * h) / seg / 2;
    const ny = py + h / seg;
    pb.beam([px, py, z], [nx, ny, z], 0.32 - k * 0.025, { color: k % 2 ? '#8a6d4a' : '#7a5f40' });
    px = nx;
    py = ny;
  }
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    pb.beam([px, py, z], [px + Math.cos(a) * 2.6, py - 0.9, z + Math.sin(a) * 2.6], 0.28, { color: k % 2 ? '#3f8a3a' : '#4f9a44' });
  }
}
export function bench(pb, x, z, ry = 0) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const at = (lx, lz) => ({ x: x + lx * c + lz * s, z: z - lx * s + lz * c });
  pb.box(1.8, 0.06, 0.45, { ...at(0, 0), y: 0.45, ry, color: '#8a5a32' });
  pb.box(1.8, 0.4, 0.05, { ...at(0, -0.22), y: 0.75, ry, color: '#8a5a32' });
  for (const lx of [-0.8, 0.8]) pb.box(0.06, 0.45, 0.45, { ...at(lx, 0), y: 0.22, ry, color: '#2f3336' });
}
export function planter(pb, x, z, { w = 1.2, d = 1.2, h = 0.6, flowers = '#e0567a', y = 0 } = {}) {
  pb.block(w, h, d, { x, y, z, color: '#9d9488' });
  pb.block(w * 0.9, 0.2, d * 0.9, { x, y: y + h, z, color: '#4f7a3a' });
  for (let k = 0; k < 5; k++) pb.sphere(0.12, { x: x + (k - 2) * w * 0.17, y: y + h + 0.25, z: z + (((k * 7) % 3) - 1) * d * 0.2, color: k % 2 ? flowers : '#f2c14e' }, 5, 4);
}
export function stripedCanopy(pb, x, y, z, w, d, slope, n, colorB = '#ffffff', { tintA = 1, colorA = '#ffffff', ry = 0 } = {}) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  for (let k = 0; k < n; k++) {
    const lx = -w / 2 + (k + 0.5) * (w / n);
    pb.box(w / n, 0.05, d, { x: x + lx * c, y, z: z - lx * s, rx: slope, ry, color: k % 2 ? colorB : colorA, tint: k % 2 ? 0 : tintA });
  }
}
export function wheelAt(pb, x, y, z, r, w = 0.3, ry = 0) {
  pb.cyl(r, r, w, 10, { x, y, z, rz: HALF_PI, ry, order: 'YXZ', color: '#1d1f22' });
  pb.cyl(r * 0.5, r * 0.5, w + 0.02, 8, { x, y, z, rz: HALF_PI, ry, order: 'YXZ', color: '#b8bcc0' });
}
export function vanBody(pb, x, z, ry, { len = 6, w = 2.4, h = 3.0, color = '#f2f0ea', tint = 0, y = 0 } = {}) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const at = (lx, lz) => ({ x: x + lx * c + lz * s, z: z - lx * s + lz * c });
  pb.box(w, h - 0.6, len * 0.75, { ...at(0, -len * 0.12), y: y + 0.6 + (h - 0.6) / 2, ry, color, tint });
  pb.box(w, (h - 0.6) * 0.72, len * 0.25, { ...at(0, len * 0.37), y: y + 0.6 + (h - 0.6) * 0.36, ry, color, tint });
  pb.box(w * 0.92, 0.6, 0.06, { ...at(0, len * 0.5), y: y + 0.6 + (h - 0.6) * 0.5, ry, color: '#2a3540' });
  for (const lz of [-len * 0.32, len * 0.3]) for (const lx of [-w / 2, w / 2]) {
    const p = at(lx, lz);
    wheelAt(pb, p.x, y + 0.42, p.z, 0.42, 0.3, ry);
  }
}
export function person(pb, x, z, { coat = '#2e4057', tint = 0, legs = '#22262b', skin = '#e2b48c', hat = null, hatTint = 0, ry = 0, scale = 1, vest = null, y = 0 } = {}) {
  const s = scale;
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  const at = (lx, lz) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
  for (const lx of [-0.11, 0.11]) pb.box(0.15 * s, 0.82 * s, 0.18 * s, { ...at(lx * s, 0), y: y + 0.41 * s, ry, color: legs });
  pb.box(0.48 * s, 0.68 * s, 0.28 * s, { ...at(0, 0), y: y + 1.16 * s, ry, color: coat, tint });
  if (vest) pb.box(0.5 * s, 0.4 * s, 0.3 * s, { ...at(0, 0), y: y + 1.22 * s, ry, color: vest });
  for (const lx of [-0.3, 0.3]) pb.box(0.12 * s, 0.62 * s, 0.14 * s, { ...at(lx * s, 0), y: y + 1.15 * s, ry, color: coat, tint });
  pb.sphere(0.13 * s, { ...at(0, 0), y: y + 1.66 * s, color: skin }, 8, 6);
  if (hat === 'cap') {
    pb.cyl(0.15 * s, 0.15 * s, 0.1 * s, 10, { ...at(0, 0), y: y + 1.8 * s, color: hatTint ? '#ffffff' : '#1f2a3a', tint: hatTint });
    pb.box(0.2 * s, 0.025 * s, 0.12 * s, { ...at(0, 0.12 * s), y: y + 1.75 * s, ry, color: '#111111' });
  } else if (hat === 'hard') {
    pb.sphere(0.16 * s, { ...at(0, 0), y: y + 1.76 * s, sy: 0.7, color: '#f2c230' }, 8, 4);
  } else if (hat === 'top') {
    pb.cyl(0.12 * s, 0.12 * s, 0.26 * s, 10, { ...at(0, 0), y: y + 1.9 * s, color: '#1a1a1a' });
    pb.cyl(0.2 * s, 0.2 * s, 0.02 * s, 12, { ...at(0, 0), y: y + 1.78 * s, color: '#1a1a1a' });
  } else if (hat === 'police') {
    pb.cyl(0.16 * s, 0.15 * s, 0.12 * s, 10, { ...at(0, 0), y: y + 1.81 * s, color: '#14213d' });
    pb.box(0.22 * s, 0.025 * s, 0.13 * s, { ...at(0, 0.12 * s), y: y + 1.76 * s, ry, color: '#111111' });
  }
}

// ---- unit decor (origin: a unit's street face, centred, at the lot base; +z toward the street) ---------

export const DECOR_BUILDERS = {
  cottage(pb) {
    // Porch with an owner-colour roof over the left door, a step, flower beds; the chimney on the roof.
    pb.block(2.4, 0.3, 1.4, { x: -2.2, z: 0.7, color: '#b9a58a' });
    for (const x of [-3.3, -1.1]) pb.post(0.07, 2.4, { x, y: 0.3, z: 1.3, color: '#f4ecdc' }, 6);
    pb.box(2.7, 0.12, 1.6, { x: -2.2, y: 2.85, z: 0.75, rx: 0.22, color: '#ffffff', tint: 1 });
    pb.block(1.2, 0.15, 0.4, { x: -2.2, z: 1.6, color: '#a99a84' });
    pb.block(2.4, 0.3, 0.5, { x: 1.4, z: 0.25, color: '#6b4a2b' });
    for (let k = 0; k < 5; k++) pb.sphere(0.16, { x: 0.5 + k * 0.45, y: 0.42, z: 0.28, color: k % 2 ? '#e0567a' : '#f2c14e' }, 5, 4);
    pb.block(0.8, 2.75, 0.8, { x: 1.6, y: 4.6, z: -5.6, color: '#8f4a37' });
    pb.block(0.95, 0.15, 0.95, { x: 1.6, y: 7.2, z: -5.6, color: '#5d3226' });
    for (const x of [0.25, 1.85]) pb.box(0.32, 1.0, 0.05, { x, y: 2.3, z: 0.03, color: '#ffffff', tint: 1 });
  },
  oldTown(pb) {
    // Owner-colour door canopies, a lantern, a planter, window boxes on the upper floors.
    for (const x of [-1.5, 1.5]) {
      pb.box(1.6, 0.1, 0.6, { x, y: 2.3, z: 0.3, rx: 0.18, color: '#ffffff', tint: 1 });
      pb.box(0.05, 0.4, 0.05, { x: x + 0.7, y: 2.1, z: 0.55, color: '#2b2f33' });
    }
    pb.box(0.18, 0.3, 0.18, { x: 0, y: 2.4, z: 0.2, color: '#ffd98a', glow: 1 });
    planter(pb, -2.6, 0.45, { w: 0.6, d: 0.6, h: 0.5 });
    for (const x of [-1.5, 1.5]) for (const y of [4.25, 7.45]) {
      pb.block(1.4, 0.22, 0.3, { x, y, z: 0.15, color: '#7a5236' });
      for (let k = 0; k < 4; k++) pb.sphere(0.12, { x: x - 0.5 + k * 0.33, y: y + 0.3, z: 0.18, color: k % 2 ? '#e0567a' : '#f5e17a' }, 5, 4);
    }
  },
  shopHouse(pb) {
    // Striped owner-colour awning across the shopfront, fascia, hanging sign, crates of produce.
    stripedCanopy(pb, 0, 3.15, 0.9, 6.0, 1.9, 0.32, 8, '#ffffff');
    pb.box(6.0, 0.25, 0.05, { y: 2.84, z: 1.78, color: '#ffffff', tint: 1 });
    pb.box(5.6, 0.4, 0.08, { y: 3.85, z: 0.04, color: '#2f4f44' });
    pb.box(0.05, 0.05, 0.9, { x: 2.6, y: 4.6, z: 0.45, color: '#2b2f33' });
    pb.box(0.7, 0.5, 0.05, { x: 2.6, y: 4.25, z: 0.8, color: '#ffffff', tint: 1 });
    for (let k = 0; k < 3; k++) {
      pb.block(0.6, 0.4, 0.45, { x: -2.2 + k * 0.7, z: 1.3, color: '#a0794d' });
      for (let j = 0; j < 4; j++) pb.sphere(0.11, { x: -2.4 + k * 0.7 + (j % 2) * 0.25, y: 0.48, z: 1.2 + Math.floor(j / 2) * 0.2, color: ['#e2512c', '#7ab648', '#f2c14e'][k] }, 5, 4);
    }
  },
  brownstone(pb) {
    // Two stoops with iron railings rising to the raised doors; owner-colour door canopies.
    for (const x of [-2.2, 0.8]) {
      for (let k = 0; k < 6; k++) pb.block(1.5, 0.2 * (k + 1), 0.32, { x, z: 1.84 - k * 0.32, color: '#7d5b4a' });
      for (const side of [-0.78, 0.78]) {
        pb.beam([x + side, 0.9, 2.0], [x + side, 2.1, 0.05], 0.04, { color: '#151515' });
        for (let k = 0; k < 5; k++) pb.box(0.025, 0.85, 0.025, { x: x + side, y: 0.6 + k * 0.24, z: 1.7 - k * 0.38, color: '#151515' });
      }
      pb.box(1.5, 0.08, 0.5, { x, y: 3.05, z: 0.25, color: '#ffffff', tint: 1 });
    }
    planter(pb, 2.5, 1.2, { w: 0.6, d: 0.6, h: 0.5, flowers: '#d9643a' });
  },
  theatre(pb) {
    // Marquee canopy with chasing bulbs and an owner-colour sign band; poster cases; the vertical neon blade.
    pb.box(5.6, 1.0, 2.2, { y: 4.35, z: 1.1, color: '#2a2a2e' });
    pb.box(5.7, 1.2, 0.12, { y: 5.4, z: 2.2, color: '#ffffff', tint: 1 });
    pb.box(0.12, 1.2, 2.2, { x: -2.85, y: 5.4, z: 1.1, color: '#ffffff', tint: 1 });
    pb.box(0.12, 1.2, 2.2, { x: 2.85, y: 5.4, z: 1.1, color: '#ffffff', tint: 1 });
    for (let k = 0; k < 22; k++) {
      const u = -2.75 + (k / 21) * 5.5;
      for (const y of [4.85, 6.05]) pb.sphere(0.07, { x: u, y, z: 2.28, color: '#ffe7a3', glow: 2 + (k % 4) / 4 }, 4, 3);
    }
    for (let k = 0; k < 8; k++) for (const x of [-2.92, 2.92]) pb.sphere(0.07, { x, y: 4.85 + k * 0.17, z: 2.28, color: '#ffe7a3', glow: 2 + (k % 4) / 4 }, 4, 3);
    pb.box(5.4, 0.08, 2.1, { y: 3.82, z: 1.1, color: '#fff3d0', glow: 1 });
    for (const x of [-2.2, 2.2]) {
      pb.box(1.0, 1.6, 0.1, { x, y: 1.6, z: 0.06, color: '#d8b25a' });
      pb.box(0.84, 1.42, 0.11, { x, y: 1.6, z: 0.07, color: '#c23b2e', glow: 1 });
    }
    pb.box(0.45, 11.5, 1.3, { x: 2.6, y: 12.25, z: 0.75, color: '#2a2a2e' });
    for (let k = 0; k < 9; k++) pb.box(0.48, 0.9, 1.0, { x: 2.6, y: 7.2 + k * 1.2, z: 0.8, color: k % 2 ? '#ff5a5a' : '#ffd36b', glow: 2 + (k % 3) / 3 });
  },
  villa(pb) {
    // A slim owner-colour sun awning over the glass, planters; the pool and loungers in the back garden.
    pb.box(6.0, 0.12, 0.42, { y: 3.5, z: 0.21, color: '#ffffff', tint: 1 });
    planter(pb, -2.4, 0.3, { w: 1.0, d: 0.5, h: 0.45, flowers: '#7ab648' });
    planter(pb, 2.4, 0.3, { w: 1.0, d: 0.5, h: 0.45, flowers: '#7ab648' });
    pb.block(5.0, 0.06, 6.2, { z: -15.3, color: '#e9e4d8' });
    pb.block(4.4, 0.08, 5.6, { z: -15.3, color: '#4fc3e6' });
    for (const x of [-1.4, 0.2]) {
      pb.box(0.7, 0.12, 1.8, { x, y: 0.35, z: -11.3, color: '#f7f7f5' });
      pb.box(0.7, 0.5, 0.1, { x, y: 0.55, z: -12.15, rx: -0.6, color: '#f7f7f5' });
    }
  },
  downtownPodium(pb) {
    // Owner-colour entrance canopy on two fins, a revolving door, bollards and planters.
    pb.box(14, 0.5, 2.4, { y: 4.65, z: 1.2, color: '#ffffff', tint: 1 });
    pb.box(14, 0.12, 2.2, { y: 4.36, z: 1.1, color: '#fff6dc', glow: 1 });
    for (const x of [-6.6, 6.6]) pb.box(0.25, 4.4, 2.4, { x, y: 2.2, z: 1.2, color: '#b9c2c9' });
    pb.post(1.2, 2.6, { z: 0.2, color: '#9cc7e8' }, 12);
    pb.cyl(1.25, 1.25, 0.2, 12, { y: 2.7, z: 0.2, color: '#c9cdd1' });
    for (let k = 0; k < 5; k++) pb.post(0.12, 0.9, { x: -4 + k * 2, z: 2.3, color: '#3a3f44' }, 6);
    planter(pb, -5.2, 1.8, { w: 1.6, d: 0.8, h: 0.5, flowers: '#7ab648' });
    planter(pb, 5.2, 1.8, { w: 1.6, d: 0.8, h: 0.5, flowers: '#7ab648' });
  },
  bankPodium(pb) {
    // Granite steps, bronze doors, owner-colour banners on the podium face, two lanterns.
    for (let k = 0; k < 3; k++) pb.block(12 - k * 0.6, 0.18 * (k + 1), 2.4 - k * 0.8, { z: 1.2 - k * 0.4, color: '#bdb5a5' });
    pb.box(4.2, 4.0, 0.15, { y: 2.4, z: 0.08, color: '#8a6a3a' });
    pb.box(3.6, 3.4, 0.16, { y: 2.3, z: 0.09, color: '#5a4426' });
    for (const x of [-5, 5]) {
      pb.box(1.4, 4.6, 0.06, { x, y: 7.6, z: 0.12, color: '#ffffff', tint: 1 });
      pb.box(1.6, 0.1, 0.25, { x, y: 9.95, z: 0.12, color: '#d8b25a' });
      pb.post(0.08, 3.2, { x: x * 0.62, z: 2.2, color: '#2b2f33' }, 6);
      pb.box(0.35, 0.5, 0.35, { x: x * 0.62, y: 3.3, z: 2.2, color: '#ffe3a0', glow: 1 });
    }
  },
};

// ---- L0 kits and lot dressing (origin: the lot centre at its base; +z toward the street, front edge z = 17) --

function picketFence(pb, x0, x1, z, { gap = null, h = 1.0, color = '#f6f3ec', step = 0.32 } = {}) {
  pb.box(Math.abs(x1 - x0), 0.08, 0.05, { x: (x0 + x1) / 2, y: h * 0.75, z, color });
  pb.box(Math.abs(x1 - x0), 0.08, 0.05, { x: (x0 + x1) / 2, y: h * 0.3, z, color });
  for (let x = x0; x <= x1 + 1e-6; x += step) {
    if (gap && x > gap[0] && x < gap[1]) continue;
    pb.box(0.09, h, 0.04, { x, y: h / 2, z: z + 0.04, color });
  }
}
function sideRail(pb, x, z0, z1, { h = 1.0, color = '#f6f3ec' } = {}) {
  pb.box(0.05, 0.08, Math.abs(z1 - z0), { x, y: h * 0.75, z: (z0 + z1) / 2, color });
  pb.box(0.05, 0.08, Math.abs(z1 - z0), { x, y: h * 0.3, z: (z0 + z1) / 2, color });
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1) + 1e-6; z += 2.4) pb.box(0.1, h, 0.1, { x, y: h / 2, z, color });
}
function tent(pb, x, z, { w = 3.2, h = 2.5, top = 3.4, a = '#d9643a', b = '#f6efe2', tint = 0 } = {}) {
  for (const dx of [-w / 2, w / 2]) for (const dz of [-w / 2, w / 2]) pb.box(0.06, h, 0.06, { x: x + dx, y: h / 2, z: z + dz, color: '#d8d4cb' });
  const g = new THREE.ConeGeometry((w / 2) * Math.SQRT2 * 1.05, top - h, 4, 1).rotateY(Math.PI / 4).toNonIndexed();
  g.computeVertexNormals();
  pb.add(g, { x, y: h + (top - h) / 2, z, color: a, tint });
  for (const s of [-1, 1]) pb.box(w, 0.35, 0.03, { x, y: h - 0.15, z: z + (s * w) / 2, color: s > 0 ? b : a });
  pb.block(w * 0.8, 0.9, w * 0.4, { x, z: z + w * 0.15, color: '#a0794d' });
  for (let k = 0; k < 6; k++) pb.sphere(0.13, { x: x - w * 0.3 + k * w * 0.12, y: 1.0, z: z + w * 0.15, color: ['#e2512c', '#7ab648', '#f2c14e', '#e0567a'][k % 4] }, 5, 4);
}
function festoon(pb, a, b, sag = 0.6, n = 14, colors = ['#ffe7a3']) {
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    const y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t);
    pb.sphere(0.09, { x, y, z, color: colors[k % colors.length], glow: 1 }, 4, 3);
    if (k < n) {
      const t2 = (k + 1) / n;
      pb.beam([x, y + 0.05, z], [a[0] + (b[0] - a[0]) * t2, a[1] + (b[1] - a[1]) * t2 - sag * 4 * t2 * (1 - t2) + 0.05, a[2] + (b[2] - a[2]) * t2], 0.02, { color: '#2b2f33' });
    }
  }
}

export const KIT_BUILDERS = {
  cottageGarden(pb) {
    picketFence(pb, -12.6, 12.6, 16.3, { gap: [-1.25, 1.25] });
    sideRail(pb, -12.6, -16.4, 16.3);
    sideRail(pb, 12.6, -16.4, 16.3);
    pb.post(0.06, 1.1, { x: 1.9, z: 16.0, color: '#3b3f42' }, 6);
    pb.box(0.32, 0.26, 0.5, { x: 1.9, y: 1.2, z: 16.0, color: '#ffffff', tint: 1 });
    // Shed with a gable roof.
    pb.block(3, 2.1, 2.4, { x: -8.5, z: -9.5, color: '#7d5a3c' });
    pb.extrude([[-1.7, 0], [1.7, 0], [0, 0.65]], 2.7, { x: -8.5, y: 2.1, z: -9.5, color: '#4a4f57' });
    pb.box(0.8, 1.7, 0.05, { x: -8.5, y: 0.85, z: -8.27, color: '#5d4430' });
    // Barbecue, table, chairs.
    pb.sphere(0.45, { x: 8, y: 0.95, z: -8, sy: 0.7, color: '#1d1f22' }, 10, 6);
    for (let k = 0; k < 3; k++) pb.beam([8, 0.7, -8], [8 + Math.cos(k * 2.1) * 0.4, 0, -8 + Math.sin(k * 2.1) * 0.4], 0.04, { color: '#2b2f33' });
    pb.block(1.6, 0.75, 0.9, { x: 5.5, z: -10, color: '#8a5a32' });
    for (const x of [4.6, 6.4]) pb.block(0.45, 0.45, 0.45, { x, z: -11, color: '#c8a165' });
    // Washing line that flutters.
    for (const x of [-5, 3]) pb.post(0.05, 2.0, { x, z: -14, color: '#8a8f93' }, 5);
    pb.box(8, 0.02, 0.02, { x: -1, y: 1.95, z: -14, color: '#d8d8d8' });
    ['#e74c3c', '#f6f3ec', '#3498db', '#f1c40f', '#f6f3ec'].forEach((c, k) => pb.box(0.8, 0.7, 0.02, { x: -4 + k * 1.5, y: 1.55, z: -14, color: c, wave: 0.45 }));
    // Flower beds along the fence and two garden trees.
    for (const x of [-7, 7]) {
      pb.block(9, 0.25, 0.9, { x, z: 15.4, color: '#5c3d24' });
      for (let k = 0; k < 9; k++) pb.sphere(0.2, { x: x - 4 + k, y: 0.4, z: 15.4, color: ['#e0567a', '#f2c14e', '#ffffff', '#b46ad6'][k % 4] }, 5, 4);
    }
    tree(pb, -10, 8, 0.9);
    tree(pb, 10, 7, 1.0);
  },
  pocketSquare(pb) {
    // Cast-iron hand pump, a market stall, benches, planters and a lantern post.
    pb.post(0.12, 1.3, { z: 10, color: '#24343a' }, 8);
    pb.box(0.7, 0.08, 0.08, { x: 0.3, y: 1.25, z: 10, rz: -0.3, color: '#24343a' });
    pb.box(0.12, 0.1, 0.35, { y: 0.9, z: 10.25, color: '#24343a' });
    pb.post(0.6, 0.35, { z: 10.6, color: '#8f8a80' }, 12);
    pb.block(3, 0.9, 1.2, { x: -8, z: 10, color: '#a0794d' });
    for (const dx of [-1.5, 1.5]) for (const dz of [-0.6, 0.6]) pb.box(0.06, 2.6, 0.06, { x: -8 + dx, y: 1.3, z: 10 + dz, color: '#5d4430' });
    stripedCanopy(pb, -8, 2.7, 10, 3.4, 1.8, 0.18, 6, '#ffffff', { tintA: 0, colorA: '#d94a4a' });
    for (let k = 0; k < 8; k++) pb.sphere(0.13, { x: -9.2 + k * 0.33, y: 1.0, z: 10.1, color: ['#e2512c', '#7ab648', '#f2c14e'][k % 3] }, 5, 4);
    bench(pb, -6, -8, Math.PI);
    bench(pb, 6, -8, Math.PI);
    planter(pb, 8, 10, { w: 1.4, d: 1.4, h: 0.7, flowers: '#e0567a' });
    planter(pb, -10.5, -12, { w: 1.4, d: 1.4, h: 0.7 });
    planter(pb, 10.5, -12, { w: 1.4, d: 1.4, h: 0.7 });
    pb.post(0.07, 3.6, { x: 11, z: 14, color: '#24343a' }, 6);
    pb.box(0.4, 0.5, 0.4, { x: 11, y: 3.7, z: 14, color: '#ffe3a0', glow: 1 });
  },
  marketTents(pb) {
    tent(pb, -7.5, 9, { a: '#d9643a' });
    tent(pb, 7.5, 9, { a: '#9bb08a' });
    tent(pb, -7.5, -9, { a: '#e9c46a' });
    tent(pb, 7.5, -9, { a: '#d9643a' });
    for (const [x, z] of [[-12, 14], [12, 14], [-12, -14], [12, -14]]) pb.post(0.06, 4.0, { x, z, color: '#3b3f42' }, 5);
    festoon(pb, [-12, 3.9, 14], [12, 3.9, 14], 0.7, 20, ['#ffe7a3', '#ffc6a0']);
    festoon(pb, [-12, 3.9, -14], [12, 3.9, -14], 0.7, 20, ['#ffe7a3', '#ffc6a0']);
    festoon(pb, [-12, 3.9, 14], [-12, 3.9, -14], 0.7, 20);
    festoon(pb, [12, 3.9, 14], [12, 3.9, -14], 0.7, 20);
    for (let k = 0; k < 4; k++) pb.block(0.6, 0.45, 0.45, { x: -1.5 + k, z: 13.5, color: '#a0794d' });
  },
  cafeGarden(pb) {
    // Pergola with vines, café tables with umbrellas, topiary, hedges and a tree.
    for (const x of [-3.5, 3.5]) for (const z of [-11, -7]) pb.post(0.12, 3.0, { x, z, color: '#6b4a2b' }, 6);
    for (let k = 0; k < 9; k++) pb.box(0.12, 0.18, 4.6, { x: -3.6 + k * 0.9, y: 3.05, z: -9, color: '#7a5636' });
    for (let k = 0; k < 10; k++) pb.sphere(0.55, { x: -3.6 + k * 0.8, y: 3.2, z: -9 + ((k * 5) % 3) - 1, sy: 0.6, color: k % 2 ? '#4f8a3c' : '#62a04a' }, 6, 4);
    for (const x of [-2, 2]) {
      pb.post(0.45, 0.75, { x, z: -9, color: '#e9dcc6' }, 10);
      for (const s of [-1, 1]) pb.block(0.42, 0.45, 0.42, { x: x + s * 0.8, z: -9, color: '#1f1f1f' });
    }
    for (const [x, z] of [[-7, 8], [7, 8], [-8, 13], [8, 13]]) {
      pb.post(0.04, 2.4, { x, z, color: '#d8d4cb' }, 5);
      pb.cone(1.3, 0.6, 8, { x, y: 2.5, z, color: z > 10 ? '#7b4a36' : '#e7c15a' });
      pb.post(0.4, 0.75, { x, z, color: '#f4ecdc' }, 10);
    }
    for (const [x, z] of [[-11, 15], [11, 15], [-11, -15], [11, -15]]) {
      pb.block(0.8, 0.6, 0.8, { x, z, color: '#9d9488' });
      pb.sphere(0.65, { x, y: 1.3, z, color: '#3f7a35' }, 8, 6);
    }
    pb.block(0.8, 1.2, 26, { x: -12.4, z: 0, color: '#3f6f33' });
    pb.block(0.8, 1.2, 26, { x: 12.4, z: 0, color: '#3f6f33' });
    tree(pb, 9.5, -12, 1.0);
  },
  foodTrucks(pb) {
    vanBody(pb, -7.5, 9.5, HALF_PI, { len: 6, color: '#f2c14e' });
    pb.box(0.06, 1.0, 2.6, { x: -6.25, y: 1.9, z: 9.5, color: '#2a3540' });
    stripedCanopy(pb, -5.9, 2.85, 9.5, 2.8, 1.2, 0.3, 6, '#ffffff', { tintA: 0, colorA: '#c23b2e', ry: HALF_PI });
    vanBody(pb, 7.5, -9, -HALF_PI, { len: 6, color: '#5fb3c7' });
    pb.box(0.06, 1.0, 2.6, { x: 6.25, y: 1.9, z: -9, color: '#2a3540' });
    for (const [x, z] of [[-11, 2], [11, 2]]) {
      pb.post(0.55, 3.2, { x, z, color: '#efe3c9' }, 12);
      pb.cyl(0.62, 0.62, 0.3, 12, { x, y: 3.35, z, color: '#2b5a3a' });
      pb.cone(0.62, 0.5, 12, { x, y: 3.75, z, color: '#2b5a3a' });
      for (let k = 0; k < 3; k++) pb.box(0.7, 0.9, 0.02, { x: x + 0.1, y: 1.4 + k * 0.6, z: z + 0.56, color: ['#c23b2e', '#e9c46a', '#3d5a80'][k], glow: 0 });
    }
    for (const [x, z] of [[-12, 15], [12, 15], [-12, -15], [12, -15]]) pb.post(0.06, 4.5, { x, z, color: '#2b2f33' }, 5);
    festoon(pb, [-12, 4.4, 15], [12, 4.4, -15], 1.0, 26, ['#ffe7a3', '#ff8a8a', '#a0e0ff']);
    festoon(pb, [12, 4.4, 15], [-12, 4.4, -15], 1.0, 26, ['#ffe7a3', '#ff8a8a', '#a0e0ff']);
    for (const [x, z] of [[0, 12.5], [-1.5, -13], [4, 11]]) {
      pb.block(1.8, 0.75, 0.8, { x, z, color: '#8a5a32' });
      pb.block(1.8, 0.45, 0.3, { x, z: z + 0.6, color: '#8a5a32' });
      pb.block(1.8, 0.45, 0.3, { x, z: z - 0.6, color: '#8a5a32' });
    }
  },
  popUpPavilion(pb) {
    // Glass pop-up pavilion, a lounge pergola with sofas, and the LED billboard frame.
    pb.block(5, 0.2, 4, { x: -7, z: 9.5, color: '#d8dde2' });
    for (const dx of [-2.5, 2.5]) for (const dz of [-2, 2]) pb.box(0.12, 3.4, 0.12, { x: -7 + dx, y: 1.9, z: 9.5 + dz, color: '#3a3f44' });
    pb.box(5.2, 0.2, 4.2, { x: -7, y: 3.6, z: 9.5, color: '#ffffff', tint: 1 });
    for (const [w, d, x, z] of [[5, 0.05, -7, 11.5], [5, 0.05, -7, 7.5], [0.05, 4, -9.5, 9.5], [0.05, 4, -4.5, 9.5]]) pb.box(w, 3.2, d, { x, y: 1.8, z, color: '#bfdcec' });
    pb.block(3, 0.9, 1, { x: -7, y: 0.2, z: 10, color: '#f7f7f5' });
    for (const x of [4.5, 9.5]) for (const z of [-11, -7]) pb.post(0.1, 3.0, { x, z, color: '#f7f7f5' }, 6);
    for (let k = 0; k < 7; k++) pb.box(0.1, 0.12, 4.4, { x: 4.4 + k * 0.85, y: 3.05, z: -9, color: '#f7f7f5' });
    pb.block(3.6, 0.45, 0.9, { x: 7, z: -10.4, color: '#3d4a52' });
    pb.block(3.6, 0.8, 0.25, { x: 7, z: -10.85, color: '#3d4a52' });
    pb.block(1.2, 0.4, 1.2, { x: 7, z: -8.5, color: '#d8b25a' });
    for (const x of [-4, 4]) pb.box(0.35, 6.0, 0.35, { x, y: 3.0, z: -15.2, color: '#4a4f54' });
    pb.box(8.6, 4.6, 0.3, { y: 3.65, z: -15.2, color: '#22262b' });
    pb.box(8.2, 4.2, 0.05, { y: 3.65, z: -15.03, color: '#7ec3ff', glow: 1 });
    pb.box(8.2, 0.9, 0.06, { y: 2.15, z: -15.0, color: '#ffffff', tint: 1, glow: 1 });
  },
  sculpturePlaza(pb) {
    pb.block(2.4, 1.0, 2.4, { z: 10.5, color: '#bdb5a5' });
    pb.add(new THREE.TorusGeometry(1.4, 0.22, 8, 24, Math.PI * 1.3), { y: 2.5, z: 10.5, ry: 0.4, color: '#8a6a3a' });
    pb.add(new THREE.TorusGeometry(0.9, 0.18, 8, 20, Math.PI * 1.5), { y: 3.4, z: 10.5, ry: -0.8, rx: 0.5, color: '#a47c3e' });
    for (const [x, z, w, d] of [[-9, 12, 6, 1], [9, 12, 6, 1], [-9, -12, 6, 1], [9, -12, 6, 1], [-12, 0, 1, 10], [12, 0, 1, 10]]) pb.block(w, 1.1, d, { x, z, color: '#356a2f' });
    bench(pb, -4.5, 13.5);
    bench(pb, 4.5, 13.5);
    for (const x of [-8, 8]) {
      pb.block(1.6, 0.7, 1.6, { x, z: -6, color: '#9d9488' });
      tree(pb, x, -6, 0.8, { y: 0.7 });
    }
  },
  poolGarden(pb) {
    pb.block(10, 0.3, 5, { z: -10, color: '#e9e4d8' });
    pb.block(9.2, 0.32, 4.2, { z: -10, color: '#4fc3e6' });
    pb.block(10, 0.1, 0.3, { y: 0.3, z: -7.4, color: '#f7f7f5' });
    palm(pb, -9.5, 8.5, 7, 0.3);
    palm(pb, 9.5, 7.5, 6.5, -0.25);
    palm(pb, 9.8, -14, 7, 0.2);
    for (const x of [-3, -1, 1, 3]) {
      pb.box(0.75, 0.12, 1.9, { x, y: 0.35, z: -5.6, color: '#f7f7f5' });
      pb.box(0.75, 0.55, 0.1, { x, y: 0.6, z: -6.5, rx: -0.6, color: '#f7f7f5' });
    }
    pb.post(0.04, 2.4, { x: 6, z: -5.5, color: '#d8d4cb' }, 5);
    pb.cone(1.6, 0.6, 8, { x: 6, y: 2.5, z: -5.5, color: '#ffffff', tint: 1 });
    for (const x of [-11, 11]) planter(pb, x, 14.5, { w: 1.2, d: 1.2, h: 0.5, flowers: '#7ab648' });
  },
  hoarding(pb) {
    // 2.4 m plywood round the site (panels in 1.2 m segments so the owner-colour wipe sweeps across), posts,
    // gravel heaps, a yellow skip.
    const H = 2.4;
    const ply = '#c9a46a';
    for (let x = -12.6; x < 12.6 - 1e-6; x += 1.26) {
      pb.box(1.24, H, 0.06, { x: x + 0.63, y: H / 2, z: 16.6, color: ply, tint: 1 });
      pb.box(1.24, H, 0.06, { x: x + 0.63, y: H / 2, z: -16.6, color: ply, tint: 1 });
    }
    for (let z = -16.6; z < 16.6 - 1e-6; z += 1.66) for (const x of [-12.6, 12.6]) pb.box(0.06, H, 1.64, { x, y: H / 2, z: z + 0.83, color: ply, tint: 1 });
    for (let x = -12.6; x <= 12.61; x += 2.52) pb.box(0.12, H + 0.1, 0.12, { x, y: (H + 0.1) / 2, z: 16.66, color: '#7d6040' });
    pb.box(25.2, 0.12, 0.08, { y: H + 0.04, z: 16.65, color: '#f6f3ec' });
    for (const [x, z, r] of [[-6, -6, 2.4], [5, -9, 1.8], [8, 4, 1.5]]) pb.cone(r, r * 0.7, 9, { x, y: r * 0.35, z, color: '#8f877a' });
    pb.block(4, 1.4, 2, { x: -8, z: 8, color: '#e8b830' });
    pb.block(4.2, 0.12, 2.2, { x: -8, y: 1.4, z: 8, color: '#c9981e' });
  },
  agentSign(pb) {
    pb.box(0.12, 3.0, 0.12, { y: 1.5, color: '#f6f3ec' });
    pb.box(1.6, 0.1, 0.1, { x: 0.7, y: 2.95, color: '#f6f3ec' });
    pb.box(1.42, 0.92, 0.05, { x: 0.75, y: 2.4, z: -0.04, color: '#ffffff' });
    for (const x of [0.15, 1.35]) pb.box(0.02, 0.1, 0.02, { x, y: 2.88, color: '#3b3f42' });
  },
  bankOwned(pb) {
    // Two posts with the BANK OWNED banner frame between them, a chain across the path with a padlock.
    for (const x of [-2.6, 2.6]) pb.box(0.14, 2.6, 0.14, { x, y: 1.3, z: 16.0, color: '#3b3f42' });
    pb.box(5.4, 0.08, 0.08, { y: 2.55, z: 16.0, color: '#3b3f42' });
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      const x = -2.5 + 5 * t;
      pb.add(new THREE.TorusGeometry(0.09, 0.025, 4, 8), { x, y: 0.95 - 0.35 * 4 * t * (1 - t), z: 16.08, ry: k % 2 ? HALF_PI : 0, color: '#9aa0a5' });
    }
    pb.box(0.26, 0.3, 0.12, { y: 0.55, z: 16.1, color: '#d8b25a' });
    pb.add(new THREE.TorusGeometry(0.09, 0.03, 4, 10, Math.PI), { y: 0.72, z: 16.1, color: '#9aa0a5' });
  },
  bunting(pb) {
    // A 26 m string of pennants across the lot frontage at the lamp line (owner colour / white), sagging.
    const z = 20.8;
    const n = 30;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const x = -13 + 26 * t;
      const y = 5.8 - 1.1 * 4 * t * (1 - t);
      pb.extrude([[-0.28, 0], [0.28, 0], [0, -0.55]], 0.01, { x, y, z, color: '#ffffff', tint: k % 2 ? 0 : 1, wave: 0.2 });
    }
    for (let k = 0; k < 12; k++) {
      const t0 = k / 12;
      const t1 = (k + 1) / 12;
      pb.beam([-13 + 26 * t0, 5.82 - 4.4 * t0 * (1 - t0), z], [-13 + 26 * t1, 5.82 - 4.4 * t1 * (1 - t1), z], 0.025, { color: '#2b2f33' });
    }
  },
  repairs(pb) {
    for (const [x, z] of [[-3, 15.6], [-1.2, 15.9], [3.2, 15.4]]) {
      pb.cone(0.22, 0.7, 10, { x, y: 0.4, z, color: '#ff7a1a' });
      pb.cyl(0.13, 0.17, 0.12, 10, { x, y: 0.42, z, color: '#ffffff' });
      pb.block(0.5, 0.05, 0.5, { x, z, color: '#1d1f22' });
    }
    for (const x of [0.4, 2.2]) {
      pb.beam([x, 0, 15.2], [x, 1.0, 15.6], 0.06, { color: '#d8d4cb' });
      pb.beam([x, 0, 16.0], [x, 1.0, 15.6], 0.06, { color: '#d8d4cb' });
    }
    for (let k = 0; k < 4; k++) pb.box(0.45, 0.22, 0.05, { x: 0.65 + k * 0.45, y: 0.95, z: 15.62, color: k % 2 ? '#ffffff' : '#d62b2b' });
    for (const x of [0.8, 1.8]) pb.sphere(0.17, { x, y: 1.15, z: 15.6, sy: 0.7, color: '#f2c230' }, 8, 4);
  },
  balloons(pb) {
    // Clusters of balloons on strings (Old Town flourish): rises with the instance.
    const cols = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#e84393', '#ffffff'];
    for (let c = 0; c < 4; c++) {
      const x0 = -9 + c * 6;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const bx = x0 + Math.cos(a) * 0.5;
        const bz = 14 + Math.sin(a) * 0.5;
        pb.sphere(0.32, { x: bx, y: 3.6 + (k % 2) * 0.4, z: bz, sy: 1.2, color: cols[(k + c) % cols.length] }, 8, 6);
        pb.beam([x0, 1.2, 14], [bx, 3.2 + (k % 2) * 0.4, bz], 0.01, { color: '#eeeeee' });
      }
    }
  },
  lanterns(pb) {
    // Paper lanterns strung across the forecourt (Midtown street party).
    for (const x of [-12, 12]) pb.post(0.06, 4.2, { x, z: 15, color: '#2b2f33' }, 5);
    for (let k = 0; k < 12; k++) {
      const t = (k + 0.5) / 12;
      pb.sphere(0.32, { x: -12 + 24 * t, y: 4.0 - 0.8 * 4 * t * (1 - t) - 0.3, z: 15, sy: 1.25, color: ['#ff6b35', '#ffd23f', '#ee4266', '#ffffff'][k % 4], glow: 1 }, 8, 6);
    }
    for (const x of [-6, 0, 6]) {
      pb.block(2.4, 0.75, 0.9, { x, z: 12, color: '#f4ecdc' });
      for (const s of [-1, 1]) pb.block(0.45, 0.45, 0.45, { x: x + s * 0.8, z: 12 + s * 0.8, color: '#7b4a36' });
    }
  },
  searchlights(pb) {
    for (const x of [-10, 10]) {
      pb.block(1.6, 0.8, 1.6, { x, z: 14.5, color: '#2b2f33' });
      pb.cyl(0.7, 0.8, 1.4, 12, { x, y: 1.6, z: 14.5, rx: -0.5, color: '#3a3f44' });
      pb.cyl(0.62, 0.62, 0.05, 12, { x, y: 2.2, z: 14.85, rx: -0.5, color: '#fff6dc', glow: 1 });
    }
  },
};

/** The hotel forecourt plaza (one per group: depth from the property line to the hotel front). */
export function podiumBuilder(frontFace) {
  return (pb) => {
    const z0 = 16.9;
    const z1 = 156 - frontFace;
    const d = Math.max(1, z0 - z1);
    pb.block(25, 0.45, d, { z: (z0 + z1) / 2, color: '#d7d1c6' });
    for (let k = 0; k < 2; k++) pb.block(25, 0.15 * (k + 1), 0.45, { z: z0 + 0.25 - k * 0.45, color: '#c9c2b5' });
    for (const x of [-10, 10]) {
      planter(pb, x, (z0 + z1) / 2, { w: 2.2, d: 1.4, h: 0.5, y: 0.45, flowers: '#7ab648' });
      pb.post(0.06, 7.5, { x: x * 1.05, y: 0.45, z: z0 - 1, color: '#d8d4cb' }, 6);
    }
    if (d > 7) {
      pb.post(2.2, 0.5, { y: 0.45, z: (z0 + z1) / 2, color: '#bdb5a5' }, 20);
      pb.post(1.9, 0.52, { y: 0.45, z: (z0 + z1) / 2, color: '#6fb8d8' }, 20);
      pb.post(0.25, 1.4, { y: 0.45, z: (z0 + z1) / 2, color: '#e9e4d8' }, 8);
    }
    pb.box(6, 0.2, 2.2, { y: 3.6, z: z1 + 1.1, color: '#ffffff', tint: 1 });
    for (const x of [-2.9, 2.9]) pb.post(0.06, 3.5, { x, y: 0.45, z: z1 + 2.1, color: '#d8b25a' }, 6);
  };
}

// ---- hotel tops, station and utility tops (origin: the part's base centre; +z toward the street) ----------

function dutchGable(pb, w, h, depth, color, trim, { z = 0 } = {}) {
  const hw = w / 2;
  const pts = [[-hw, 0], [hw, 0], [hw, h * 0.3], [hw * 0.74, h * 0.3], [hw * 0.74, h * 0.6], [hw * 0.46, h * 0.6], [hw * 0.34, h * 0.88], [0, h], [-hw * 0.34, h * 0.88], [-hw * 0.46, h * 0.6], [-hw * 0.74, h * 0.6], [-hw * 0.74, h * 0.3], [-hw, h * 0.3]];
  pb.extrude(pts, depth, { z, color });
  for (const [x, y] of [[hw * 0.87, h * 0.3], [-hw * 0.87, h * 0.3], [hw * 0.6, h * 0.6], [-hw * 0.6, h * 0.6]]) pb.block(0.5, 0.35, depth + 0.1, { x, y, z, color: trim });
  pb.sphere(0.22, { y: h + 0.1, z: z + depth / 2 - 0.2, color: trim }, 6, 4);
}
function clockFace(pb, x, y, z, r, { ry = 0 } = {}) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  pb.cyl(r + 0.08, r + 0.08, 0.1, 18, { x, y, z, rx: HALF_PI, ry, order: 'YXZ', color: '#d8b25a' });
  pb.cyl(r, r, 0.12, 18, { x: x + s * 0.02, y, z: z + c * 0.02, rx: HALF_PI, ry, order: 'YXZ', color: '#fbf8ef', glow: 1 });
  pb.box(0.08, r * 0.6, 0.05, { x: x + s * 0.09, y: y + r * 0.28, z: z + c * 0.09, ry, color: '#1d1f22' });
  pb.box(r * 0.75, 0.08, 0.05, { x: x + c * r * 0.3 + s * 0.09, y, z: z - s * r * 0.3 + c * 0.09, ry, color: '#1d1f22' });
}
function glowBand(pb, w, d, y, h = 0.5) {
  pb.box(w + 0.1, h, d + 0.1, { y: y + h / 2, color: '#ffffff', tint: 1, glow: 1 });
}

export const TOP_BUILDERS = {
  railwayArms(pb) {
    // Brick Dutch gable with a clock on the street front.
    dutchGable(pb, 7, 4.05, 2.5, '#8f4a37', '#efe6d2');
    clockFace(pb, 0, 2.2, 1.27, 0.85);
    pb.box(7.2, 0.25, 2.7, { y: 0.12, color: '#efe6d2' });
    pb.box(5.0, 0.35, 0.08, { y: 0.55, z: 1.3, color: '#ffffff', tint: 1, glow: 1 });
  },
  oldTownInn(pb) {
    // Crow-stepped white gable with a clock and a weathervane.
    const steps = 5;
    for (let k = 0; k < steps; k++) pb.block(6 - k * 1.1, 4.65 / steps, 2.5, { y: (k * 4.65) / steps, color: '#f7f4ee' });
    clockFace(pb, 0, 2.0, 1.27, 0.75);
    pb.box(4.2, 0.3, 0.08, { y: 0.5, z: 1.3, color: '#ffffff', tint: 1, glow: 1 });
    pb.box(0.05, 0.9, 0.05, { y: 4.65 + 0.2, color: '#2b2f33' });
    pb.box(0.7, 0.05, 0.05, { y: 4.65 + 0.55, color: '#2b2f33' });
  },
  emporium(pb) {
    // Copper corner dome on a stone drum with an owner-colour glow ring.
    pb.post(3.2, 1.45, { color: '#e9dcc6' }, 16);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pb.box(0.6, 1.0, 0.12, { x: Math.cos(a) * 3.21, y: 0.72, z: Math.sin(a) * 3.21, ry: -a + HALF_PI, color: '#33465a' });
    }
    pb.cyl(3.3, 3.3, 0.18, 18, { y: 1.45, color: '#ffffff', tint: 1, glow: 1 });
    pb.add(new THREE.SphereGeometry(3.25, 18, 8, 0, Math.PI * 2, 0, HALF_PI), { y: 1.5, sy: 0.75, color: '#5f9e8f' });
    pb.sphere(0.3, { y: 4.05, color: '#d8b25a' }, 8, 6);
    pb.cone(0.12, 0.45, 6, { y: 4.35, color: '#d8b25a' });
  },
  rotunda(pb) {
    // Colonnaded rotunda with a dome and a lantern; owner glow on the entablature.
    pb.post(4.7, 0.6, { color: '#e9e0cf' }, 24);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pb.post(0.28, 3.0, { x: Math.cos(a) * 4.1, y: 0.6, z: Math.sin(a) * 4.1, color: '#f5efe2' }, 8);
    }
    pb.post(3.4, 3.0, { y: 0.6, color: '#d9cdb2' }, 18);
    pb.cyl(4.6, 4.6, 0.5, 24, { y: 3.85, color: '#ffffff', tint: 1, glow: 1 });
    pb.add(new THREE.SphereGeometry(4.3, 20, 8, 0, Math.PI * 2, 0, HALF_PI), { y: 4.1, sy: 0.49, color: '#7f9a8f' });
    pb.post(0.7, 0.5, { y: 6.2, color: '#f5efe2' }, 10);
    pb.sphere(0.45, { y: 6.7, sy: 0.4, color: '#d8b25a' }, 8, 5);
  },
  marqueeTower(pb) {
    // Stepped art-deco crown with gold fins, an owner-colour glowing crown band and a needle.
    pb.block(9.4, 1.6, 8.4, { color: '#f2e6d0' });
    glowBand(pb, 9.4, 8.4, 1.6, 0.35);
    pb.block(6.6, 1.6, 5.6, { y: 1.95, color: '#f2e6d0' });
    glowBand(pb, 6.6, 5.6, 3.55, 0.3);
    pb.block(3.6, 1.2, 3, { y: 3.85, color: '#d8b25a' });
    pb.cone(0.5, 0.6, 8, { y: 5.35, color: '#d8b25a' });
    for (const x of [-4.75, 4.75]) for (const z of [-3, 0, 3]) pb.box(0.14, 3.4, 0.5, { x, y: 1.7, z, color: '#d8b25a' });
  },
  marqueeBlade(pb) {
    // Vertical neon blade on the tower front: a dark frame with chasing letters.
    pb.box(1.2, 24, 1.3, { y: 12, color: '#1f1f22' });
    for (let k = 0; k < 14; k++) pb.box(1.26, 1.25, 1.0, { y: 1.4 + k * 1.6, z: 0.02, color: k % 2 ? '#ff4d4d' : '#ffd36b', glow: 2 + (k % 4) / 4 });
    pb.box(1.3, 0.25, 1.4, { y: 24, color: '#ffffff', tint: 1, glow: 1 });
  },
  helix(pb) {
    // Helipad on a drum with an owner-colour glow ring, rim lights and an antenna mast.
    pb.post(5.4, 2.0, { color: '#d9e3ea' }, 20);
    pb.cyl(5.5, 5.5, 0.3, 24, { y: 1.75, color: '#ffffff', tint: 1, glow: 1 });
    pb.post(6.5, 0.25, { y: 2.0, color: '#59626a' }, 28);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      pb.sphere(0.12, { x: Math.cos(a) * 6.45, y: 2.32, z: Math.sin(a) * 6.45, color: '#ffe7a3', glow: 2 + (k % 4) / 4 }, 4, 3);
    }
    pb.beam([4.4, 2.25, -4.4], [4.4, 6.0, -4.4], 0.15, { color: '#c9cdd1' });
    pb.sphere(0.18, { x: 4.4, y: 6.05, z: -4.4, color: '#ff3b30', glow: 1 }, 6, 4);
  },
  exchange(pb) {
    // Gilded stepped crown, a glass lantern in the owner colour and a gilded needle.
    pb.block(13.4, 3.0, 11.4, { color: '#e9e0cf' });
    for (let k = 0; k < 7; k++) pb.box(0.25, 3.0, 0.4, { x: -6 + k * 2, y: 1.5, z: 5.75, color: '#d4a93c' });
    const py = new THREE.CylinderGeometry(0.6, 9.0, 7, 4, 1).rotateY(Math.PI / 4).toNonIndexed();
    py.computeVertexNormals();
    pb.add(py, { y: 6.5, sx: 1, sz: 0.85, color: '#d4a93c' });
    pb.block(3.2, 3.2, 3.2, { y: 9.6, color: '#ffffff', tint: 1, glow: 1 });
    pb.cone(0.5, 8.8, 8, { y: 17.2, color: '#d4a93c' });
  },
  spire(pb) {
    // Glass crown in the owner colour, a ring and a 20 m spire with a beacon.
    pb.block(10.4, 3.0, 8.4, { color: '#ffffff', tint: 1, glow: 1 });
    pb.block(10.8, 0.4, 8.8, { y: 3.0, color: '#c9d2d8' });
    pb.block(6, 1.6, 5, { y: 3.4, color: '#d9e3ea' });
    pb.cone(1.0, 19.6, 8, { y: 4.8 + 9.8, color: '#dfe5ea' });
    pb.sphere(0.35, { y: 24.8, color: '#ff3b30', glow: 1 }, 8, 6);
  },
  // Stations.
  clockTower(pb) {
    pb.block(5.0, 2.6, 5.0, { color: '#a8452f' });
    for (let k = 0; k < 4; k++) {
      const ry = (k * Math.PI) / 2;
      clockFace(pb, Math.sin(ry) * 2.52, 1.35, Math.cos(ry) * 2.52, 1.0, { ry });
    }
    pb.block(5.6, 0.3, 5.6, { y: 2.6, color: '#e6dccb' });
    const roof = new THREE.CylinderGeometry(0.05, 3.9, 1.9, 4, 1).rotateY(Math.PI / 4).toNonIndexed();
    roof.computeVertexNormals();
    pb.add(roof, { y: 2.9 + 0.95, color: '#4d535a' });
    pb.post(0.06, 0.3, { y: 4.7, color: '#d8b25a' }, 6);
  },
  portico(pb) {
    pb.block(16, 0.6, 4, { color: '#ddd3c0' });
    for (let k = 0; k < 8; k++) pb.post(0.45, 10.0, { x: -7 + k * 2, y: 0.6, z: 0.9, color: '#f5efe2' }, 12);
    pb.block(16, 1.2, 4, { y: 10.6, color: '#e9e0cf' });
    pb.extrude([[-8, 0], [8, 0], [0, 2.05]], 3.8, { y: 11.8, color: '#e9e0cf' });
  },
  attic(pb) {
    pb.block(10, 3.0, 10, { color: '#e9e0cf' });
    pb.post(3.5, 1.05, { y: 3.0, color: '#d9cdb2' }, 18);
    pb.add(new THREE.SphereGeometry(3.6, 18, 8, 0, Math.PI * 2, 0, HALF_PI), { y: 4.05, sy: 0.5, color: '#8b9a97' });
  },
  decoFin(pb) {
    // Vertical fin with glowing letters on the tower front; stepped crown on top.
    pb.box(1.2, 11.85, 0.8, { y: 5.93, z: 2.9, color: '#b68a3e' });
    for (let k = 0; k < 6; k++) pb.box(1.24, 1.3, 0.84, { y: 1.2 + k * 1.75, z: 2.9, color: '#fff3d0', glow: 2 + (k % 3) / 3 });
    pb.block(8.4, 1.2, 6.6, { y: 8.85, color: '#d9cdb2' });
    pb.block(5.6, 1.0, 4.4, { y: 10.05, color: '#d9cdb2' });
    pb.block(2.4, 0.8, 2.0, { y: 11.05, color: '#b68a3e' });
  },
  metroRoof(pb) {
    pb.block(21, 0.5, 13.8, { color: '#3d4a52' });
    pb.box(21.1, 0.4, 0.1, { y: 0.25, z: 6.92, color: '#ffffff', tint: 1 });
    pb.block(20.6, 0.3, 13.4, { y: 0.5, color: '#9ab7c4' });
  },
  // Utilities.
  bulbSign(pb) {
    for (const x of [-4, 4]) pb.box(0.3, 3.2, 0.3, { x, y: 1.6, color: '#3b3f42' });
    pb.box(8.4, 0.3, 0.3, { y: 3.1, color: '#3b3f42' });
    pb.post(1.0, 1.0, { y: 3.2, color: '#b08a3a' }, 12);
    for (let k = 0; k < 4; k++) pb.cyl(1.08, 1.08, 0.12, 12, { y: 3.35 + k * 0.22, color: '#d4a93c' });
    pb.cyl(1.25, 0.95, 0.9, 14, { y: 4.65, color: '#fff3c4', tint: 1, glow: 1 });
    pb.sphere(2.4, { y: 6.0, color: '#fff3c4', tint: 1, glow: 1 }, 16, 12);
  },
  waterTower(pb) {
    const legs = [[-3.6, -3.6], [3.6, -3.6], [3.6, 3.6], [-3.6, 3.6]];
    for (const [x, z] of legs) pb.beam([x, 0, z], [x * 0.85, 26, z * 0.85], 0.45, { color: '#5b6f7c' });
    for (const y of [8, 16, 24]) {
      const s = 1 - (y / 26) * 0.15;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = legs[k];
        const [bx, bz] = legs[(k + 1) % 4];
        pb.beam([ax * s, y, az * s], [bx * s, y, bz * s], 0.2, { color: '#5b6f7c' });
        pb.beam([ax * s, y - 8, az * s], [bx * s, y, bz * s], 0.12, { color: '#6d8190' });
      }
    }
    pb.post(4.9, 0.3, { y: 25.7, color: '#4f5f6a' }, 20);
    pb.post(4.5, 7.0, { y: 26.0, color: '#7f9db3' }, 22);
    for (const y of [27.5, 30, 32.5]) pb.cyl(4.55, 4.55, 0.2, 22, { y, color: '#5b7a8f' });
    pb.cyl(4.62, 4.62, 0.5, 22, { y: 29.0, color: '#ffffff', tint: 1, glow: 1 });
    pb.cone(4.7, 1.85, 22, { y: 33.92, color: '#56788f' });
    pb.sphere(0.25, { y: 34.85, color: '#d8b25a' }, 6, 4);
    pb.beam([4.6, 0, 0.8], [4.6, 26, 0.8], 0.12, { color: '#3b3f42' });
  },
  fountain(pb) {
    pb.post(3.0, 0.55, { color: '#d8d0c0' }, 24);
    pb.post(2.7, 0.57, { color: '#6fb8d8' }, 24);
    pb.post(0.45, 0.9, { y: 0.4, color: '#d8d0c0' }, 10);
    pb.cyl(0.18, 0.28, 0.9, 10, { y: 1.25, color: '#ffffff', tint: 1, glow: 1 });
  },
};

// ---- construction plant (origin at its base; +z forward) ----------------------------------------------

const CRANE_YELLOW = '#f2b632';
export const CONSTRUCTION_BUILDERS = {
  mastSeg(pb) {
    // A 2 × 2 × 6 m lattice mast section.
    for (const x of [-1, 1]) for (const z of [-1, 1]) pb.box(0.16, 6, 0.16, { x, y: 3, z, color: CRANE_YELLOW });
    for (let k = 0; k < 3; k++) {
      const y0 = k * 2;
      for (const z of [-1, 1]) pb.beam([-1, y0, z], [1, y0 + 2, z], 0.08, { color: CRANE_YELLOW });
      for (const x of [-1, 1]) pb.beam([x, y0, -1], [x, y0 + 2, 1], 0.08, { color: CRANE_YELLOW });
    }
  },
  craneTop(pb) {
    // Cab, 40 m jib (+x), 12 m counter-jib with ballast, A-frame and tie bars, trolley and hook.
    pb.block(2.4, 0.6, 2.4, { color: '#d9a02a' });
    pb.block(1.6, 2.0, 1.8, { x: 1.4, y: 0.6, z: 0.9, color: '#e8e4dc' });
    pb.box(1.2, 0.8, 0.05, { x: 1.4, y: 1.8, z: 1.82, color: '#33465a' });
    for (const z of [-0.6, 0.6]) pb.box(40, 0.14, 0.14, { x: 20, y: 0.7, z, color: CRANE_YELLOW });
    pb.box(40, 0.14, 0.14, { x: 20, y: 1.9, color: CRANE_YELLOW });
    for (let k = 0; k < 20; k++) {
      pb.beam([k * 2, 0.7, -0.6], [k * 2 + 1, 1.9, 0], 0.07, { color: CRANE_YELLOW });
      pb.beam([k * 2 + 2, 0.7, 0.6], [k * 2 + 1, 1.9, 0], 0.07, { color: CRANE_YELLOW });
    }
    pb.box(12, 0.5, 1.6, { x: -6, y: 0.85, color: '#c9921f' });
    for (let k = 0; k < 3; k++) pb.block(1.4, 2.2, 1.8, { x: -10.5 + k * 1.5, y: -1.6, color: '#9d9d98' });
    pb.beam([-0.8, 0.6, 0], [0, 7, 0], 0.18, { color: CRANE_YELLOW });
    pb.beam([0.8, 0.6, 0], [0, 7, 0], 0.18, { color: CRANE_YELLOW });
    pb.beam([0, 7, 0], [30, 1.9, 0], 0.05, { color: '#8a8f93' });
    pb.beam([0, 7, 0], [-11.5, 1.1, 0], 0.05, { color: '#8a8f93' });
    pb.block(1.2, 0.4, 1.4, { x: 24, y: 0.3, color: '#d9a02a' });
    pb.beam([24, 0.3, 0], [24, -14, 0], 0.04, { color: '#2b2f33' });
    pb.block(0.8, 0.9, 0.5, { x: 24, y: -15, color: '#ff7a1a' });
    pb.sphere(0.25, { x: 40, y: 2.0, color: '#ff3b30', glow: 1 }, 6, 4);
  },
  mobileCrane(pb) {
    vanBody(pb, 0, 0, 0, { len: 10, w: 2.6, h: 3.0, color: '#e8b830' });
    for (const s of [-1, 1]) for (const z of [-3.5, 3]) pb.box(2.2, 0.25, 0.3, { x: s * 2.2, y: 0.4, z, color: '#2b2f33' });
    pb.block(2.2, 1.6, 2.6, { y: 3.0, z: -2, color: '#e8b830' });
    pb.beam([0, 4.2, -2.5], [0, 20, 10], 0.9, { color: '#f2c230' });
    pb.beam([0, 20, 10], [0, 9, 10.6], 0.04, { color: '#2b2f33' });
    pb.block(0.6, 0.8, 0.4, { y: 8.2, z: 10.6, color: '#ff7a1a' });
  },
  mixer(pb) {
    vanBody(pb, 0, 0, 0, { len: 8, w: 2.5, h: 3.0, color: '#f6f3ec' });
    pb.cyl(1.0, 1.4, 4.2, 12, { y: 3.4, z: -1.3, rx: 1.35, color: '#e05a2a' });
    pb.cone(1.0, 1.2, 12, { y: 3.95, z: -3.9, rx: -1.79, color: '#f2c230' });
  },
  excavator(pb) {
    for (const x of [-1.2, 1.2]) pb.block(0.7, 0.9, 4.0, { x, color: '#2b2f33' });
    pb.block(2.6, 1.2, 3.0, { y: 0.9, z: -0.3, color: '#f2b632' });
    pb.block(1.2, 1.5, 1.4, { x: -0.6, y: 2.1, z: 0.4, color: '#f2b632' });
    pb.box(1.0, 1.0, 0.05, { x: -0.6, y: 2.9, z: 1.12, color: '#33465a' });
    pb.beam([0.6, 1.9, 0.8], [0.6, 4.6, 3.6], 0.45, { color: '#f2b632' });
    pb.beam([0.6, 4.6, 3.6], [0.6, 1.4, 5.8], 0.35, { color: '#f2b632' });
    pb.block(1.0, 0.8, 0.8, { x: 0.6, y: 0.8, z: 5.9, color: '#3b3f42' });
  },
};

// ---- figures (origin at the feet, facing +z; ~1.8 m) ----------------------------------------------------

export const FIGURE_BUILDERS = {
  doorman(pb) {
    person(pb, 0, 0, { coat: '#ffffff', tint: 1, hat: 'cap', hatTint: 1, legs: '#1d1f22' });
    for (let k = 0; k < 3; k++) pb.sphere(0.03, { x: 0.08, y: 1.0 + k * 0.15, z: 0.15, color: '#d8b25a' }, 4, 3);
    pb.box(0.5, 0.06, 0.29, { y: 0.84, color: '#d8b25a' });
  },
  stationMaster(pb) {
    person(pb, 0, 0, { coat: '#ffffff', tint: 1, hat: 'cap', hatTint: 1, legs: '#24262a' });
    pb.box(0.06, 0.06, 0.12, { x: 0.32, y: 0.85, z: 0.12, color: '#d8b25a' });
  },
  meterReader(pb) {
    person(pb, 0, 0, { coat: '#ffffff', tint: 1, hat: 'cap', legs: '#2f3a44' });
    pb.box(0.26, 0.34, 0.03, { x: 0.12, y: 1.1, z: 0.24, rx: -0.4, color: '#c8a165' });
    pb.box(0.2, 0.26, 0.032, { x: 0.12, y: 1.12, z: 0.25, rx: -0.4, color: '#ffffff' });
  },
  auctioneer(pb) {
    person(pb, 0, 0, { coat: '#2b2d33', legs: '#1d1f22', hat: 'top' });
    pb.box(0.12, 0.07, 0.04, { y: 1.47, z: 0.15, color: '#c0262d' });
    pb.box(0.06, 0.3, 0.06, { x: 0.33, y: 1.0, z: 0.25, rx: 0.8, color: '#6b4a2b' });
    pb.box(0.16, 0.1, 0.1, { x: 0.33, y: 1.12, z: 0.38, color: '#6b4a2b' });
  },
  lectern(pb) {
    pb.block(0.8, 1.1, 0.6, { color: '#6b4a2b' });
    pb.box(0.9, 0.06, 0.7, { y: 1.15, rx: -0.25, color: '#8a5a32' });
    pb.box(0.6, 0.3, 0.02, { y: 0.7, z: 0.31, color: '#d8b25a' });
  },
  worker(pb) {
    person(pb, 0, 0, { coat: '#3d5a80', legs: '#2f3a44', hat: 'hard', vest: '#ff9f1c' });
  },
  clerk(pb) {
    person(pb, 0, 0, { coat: '#5a6168', legs: '#2b2d33' });
    pb.box(0.05, 0.36, 0.05, { x: 0.34, y: 1.2, z: 0.2, rx: 0.9, color: '#6b4a2b' });
    pb.box(0.2, 0.08, 0.08, { x: 0.34, y: 1.36, z: 0.36, color: '#8a8f93' });
  },
  officer(pb) {
    person(pb, 0, 0, { coat: '#14213d', legs: '#14213d', hat: 'police' });
    pb.box(0.5, 0.12, 0.3, { y: 1.0, color: '#f2f2f2' });
  },
};

// ---- the kit, shared by city-lots.js and landmarks.js ---------------------------------------------------

let setCache = null;

/** Every variant set (geometries cached per page; each view wraps them in its own meshes). */
export function lotSets() {
  if (setCache) return setCache;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const podiums = {};
  for (const [g, f] of Object.entries({ brown: 145, lightblue: 147, pink: 153, orange: 156, red: 153, yellow: 153, green: 153, darkblue: 153 })) podiums[`podium:${g}`] = podiumBuilder(f);
  setCache = {
    roofs: variantSet(ROOF_BUILDERS),
    decor: variantSet(DECOR_BUILDERS),
    kits: variantSet({ ...KIT_BUILDERS, ...podiums }),
    tops: variantSet(TOP_BUILDERS),
    cons: variantSet(CONSTRUCTION_BUILDERS),
    figures: variantSet(FIGURE_BUILDERS),
    ms: 0,
  };
  setCache.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return setCache;
}
