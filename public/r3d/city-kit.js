// public/r3d/city-kit.js — the building kit for the city in the middle of the board (city.js).
//
//   * STYLES: one building style per colour group — cottages (brown), row houses (light blue),
//     townhouses (pink), shops with awnings (orange), offices (red), department stores (yellow),
//     glass skyscrapers (green) and luxury towers with spires (dark blue). Each lists its floors per
//     development level, its footprint, roof and extras, and its hotel "landmark" tower.
//   * The facade atlas: every building body is ONE instance of a unit box; a patched
//     MeshStandardMaterial (facadeMaterial) tiles an atlas cell over it per floor and bay, so the
//     windows keep their size however tall the building grows, the ground floor gets doors / shop
//     fronts, and lit windows glow at dusk (uLights) in a per-building random pattern.
//   * Part geometries (roofs, parapets, awnings, spires, crowns, signs, scaffolds, trees, cars,
//     people, birds) are unit-sized with vertex colours, drawn as InstancedMeshes by city.js.

import * as THREE from './three.js';
import { Kit, canvas } from './world-geo.js';

export const FLOOR_H = 0.082; // one storey
const BASE_H = 0.02; // plinth under the ground floor
export const BAY = 0.11; // one window bay
const CELL = 64; // atlas cell (px)
export const ATLAS_COLS = 16;

/** Atlas columns. */
export const FACADE = { RES: 0, TOWN: 1, SHOP: 2, OFFICE: 3, STORE: 4, GLASS: 5, LUX: 6, HOTEL: 7, VACANT: 8, BOARDED: 9, ROOF: 10, CIVIC: 11 };

/** Height of a body with n floors. */
export const floorsH = (n) => (n > 0 ? BASE_H + n * FLOOR_H : 0);

/**
 * Building styles by colour group. front/back: floors of the plot next to the tiles / next to the
 * road for levels 0 (bought) … 4 (four houses); hotel: floors of the landmark tower (level 5).
 * w/d: footprint of the front plot (the back plot is ~80%). pastel: how much the group colour is
 * lightened for the walls. roof: 'gable' | 'mansard' | 'flat'.
 */
export const STYLES = {
  brown: { name: 'cottage', facade: FACADE.RES, front: [1, 1, 2, 2, 3], back: [0, 1, 1, 2, 2], hotel: 6, w: 0.42, d: 0.36, pastel: 0.35, roof: 'gable', roofH: 0.13, chimney: true },
  lightblue: { name: 'rowhouse', facade: FACADE.RES, front: [2, 2, 3, 3, 4], back: [0, 1, 2, 2, 3], hotel: 7, w: 0.36, d: 0.36, pastel: 0.15, roof: 'gable', roofH: 0.1, chimney: true },
  pink: { name: 'townhouse', facade: FACADE.TOWN, front: [2, 3, 3, 4, 5], back: [0, 1, 2, 3, 3], hotel: 8, w: 0.4, d: 0.36, pastel: 0.45, roof: 'mansard', roofH: 0.09 },
  orange: { name: 'shop', facade: FACADE.SHOP, front: [1, 2, 2, 3, 4], back: [0, 1, 2, 2, 3], hotel: 8, w: 0.48, d: 0.36, pastel: 0.4, roof: 'flat', awning: true },
  red: { name: 'office', facade: FACADE.OFFICE, front: [3, 4, 5, 6, 7], back: [0, 2, 3, 4, 5], hotel: 11, w: 0.44, d: 0.36, pastel: 0.35, roof: 'flat', antenna: 3 },
  yellow: { name: 'store', facade: FACADE.STORE, front: [2, 3, 3, 4, 5], back: [0, 1, 2, 3, 4], hotel: 10, w: 0.58, d: 0.38, pastel: 0.2, roof: 'flat', sign: true },
  green: { name: 'skyscraper', facade: FACADE.GLASS, front: [4, 6, 8, 10, 12], back: [0, 3, 4, 6, 8], hotel: 15, w: 0.42, d: 0.36, pastel: 0.1, roof: 'flat', setback: 6, antenna: 6 },
  darkblue: { name: 'luxury', facade: FACADE.LUX, front: [5, 7, 9, 11, 13], back: [0, 3, 5, 7, 9], hotel: 16, w: 0.38, d: 0.34, pastel: 0.3, roof: 'flat', setback: 7, spire: true },
};
const FALLBACK = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue'];

/** The style of a group (unknown boards: by group order). */
export function styleOf(group, index = 0) {
  return STYLES[group] ?? STYLES[FALLBACK[index % FALLBACK.length]];
}

// ---- facade atlas ----------------------------------------------------------------------------------

/**
 * Draws the facade atlas: ATLAS_COLS cells across, two rows (top = upper floors, bottom = ground
 * floor), plus a matching mask of the window panes that can light up.
 */
function drawAtlas() {
  const W = ATLAS_COLS * CELL;
  const H = CELL * 2;
  const { cv, g } = canvas(W, H);
  const { cv: lcv, g: lg } = canvas(W, H);
  g.fillStyle = '#f3efe6';
  g.fillRect(0, 0, W, H);
  lg.fillStyle = '#000';
  lg.fillRect(0, 0, W, H);
  const GLASS = '#34475a';
  const cell = (col, row, fn) => {
    g.save();
    lg.save();
    g.translate(col * CELL, row * CELL);
    lg.translate(col * CELL, row * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    fn(g, lg);
    g.restore();
    lg.restore();
  };
  // A pane of glass (lit mask too), with a frame.
  const pane = (c, l, x, y, w, h, { frame = '#fbf8f1', lw = 3, glass = GLASS, lit = true } = {}) => {
    c.fillStyle = frame;
    c.fillRect(x - lw, y - lw, w + 2 * lw, h + 2 * lw);
    c.fillStyle = glass;
    c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(x, y, w * 0.4, h);
    if (lit && l) {
      l.fillStyle = '#fff';
      l.fillRect(x, y, w, h);
    }
  };
  const wall = (c, color = '#f3efe6') => {
    c.fillStyle = color;
    c.fillRect(0, 0, CELL, CELL);
  };
  const floorLine = (c, color = 'rgba(0,0,0,0.12)') => {
    c.fillStyle = color;
    c.fillRect(0, CELL - 4, CELL, 4);
  };
  const door = (c, x, w = 16, h = 34, color = '#7a4f35') => {
    c.fillStyle = '#fbf8f1';
    c.fillRect(x - 3, CELL - h - 3, w + 6, h + 3);
    c.fillStyle = color;
    c.fillRect(x, CELL - h, w, h);
    c.fillStyle = '#d8b25a';
    c.fillRect(x + w - 5, CELL - h / 2, 3, 3);
  };

  // RES: cottage / row house windows with shutters; ground: door + window.
  cell(FACADE.RES, 0, (c, l) => {
    wall(c);
    c.fillStyle = '#8c969e';
    c.fillRect(12, 16, 7, 28);
    c.fillRect(45, 16, 7, 28);
    pane(c, l, 21, 16, 22, 28);
    floorLine(c);
  });
  cell(FACADE.RES, 1, (c, l) => {
    wall(c);
    door(c, 10);
    pane(c, l, 36, 24, 18, 20);
  });
  // TOWN: tall arched windows; ground: door with steps.
  cell(FACADE.TOWN, 0, (c, l) => {
    wall(c);
    c.fillStyle = '#fbf8f1';
    c.beginPath();
    c.arc(32, 20, 13, Math.PI, 0);
    c.fill();
    c.fillRect(19, 20, 26, 34);
    c.fillStyle = GLASS;
    c.beginPath();
    c.arc(32, 21, 10, Math.PI, 0);
    c.fill();
    c.fillRect(22, 21, 20, 30);
    l.fillStyle = '#fff';
    l.fillRect(22, 14, 20, 37);
    c.fillStyle = '#fbf8f1';
    c.fillRect(31, 12, 2, 40);
    c.fillRect(16, 52, 32, 4);
    floorLine(c);
  });
  cell(FACADE.TOWN, 1, (c, l) => {
    wall(c);
    door(c, 24, 16, 38, '#2f4f6a');
    c.fillStyle = '#cfc8b8';
    c.fillRect(18, CELL - 5, 28, 5);
    pane(c, l, 4, 22, 12, 22);
    pane(c, l, 48, 22, 12, 22);
  });
  // SHOP: small windows above; ground: a big shop window and door.
  cell(FACADE.SHOP, 0, (c, l) => {
    wall(c);
    pane(c, l, 9, 18, 18, 24);
    pane(c, l, 37, 18, 18, 24);
    c.fillStyle = '#9aa0a4';
    c.fillRect(6, 44, 52, 4);
    floorLine(c);
  });
  cell(FACADE.SHOP, 1, (c, l) => {
    wall(c, '#e9e3d6');
    pane(c, l, 5, 18, 34, 40, { glass: '#2d3d4b', lw: 3 });
    door(c, 44, 14, 40, '#3c3c3c');
  });
  // OFFICE: ribbon windows; ground: glass lobby.
  cell(FACADE.OFFICE, 0, (c, l) => {
    wall(c);
    pane(c, l, 0, 16, CELL, 26, { lw: 0 });
    c.fillStyle = '#e6e2d8';
    for (let x = 0; x < CELL; x += 16) c.fillRect(x, 16, 3, 26);
    floorLine(c);
  });
  cell(FACADE.OFFICE, 1, (c, l) => {
    wall(c, '#dcd8ce');
    pane(c, l, 0, 12, CELL, CELL - 12, { lw: 0, glass: '#2c3e50' });
    c.fillStyle = '#c9c4b8';
    for (let x = 0; x < CELL; x += 21) c.fillRect(x, 12, 3, CELL);
  });
  // STORE: display windows between pilasters.
  cell(FACADE.STORE, 0, (c, l) => {
    wall(c);
    pane(c, l, 8, 14, 48, 30, { lw: 2 });
    c.fillStyle = '#f7f3ea';
    c.fillRect(0, 0, 6, CELL);
    c.fillRect(CELL - 6, 0, 6, CELL);
    c.fillRect(31, 14, 2, 30);
    floorLine(c);
  });
  cell(FACADE.STORE, 1, (c, l) => {
    wall(c, '#ebe5d8');
    pane(c, l, 6, 14, 52, 50, { lw: 2, glass: '#2b3a48' });
    c.fillStyle = '#f7f3ea';
    c.fillRect(0, 0, 5, CELL);
    c.fillRect(CELL - 5, 0, 5, CELL);
  });
  // GLASS: curtain wall (tinted by the instance colour).
  const curtain = (c, l) => {
    c.fillStyle = '#7f98ad';
    c.fillRect(0, 0, CELL, CELL);
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.fillRect(0, 0, CELL * 0.45, CELL);
    // Only an inner office-sized patch of each panel lights up, dimmer than a window.
    l.fillStyle = '#7a7a7a';
    l.fillRect(8, 16, CELL - 16, CELL - 30);
    c.fillStyle = '#e8edf1';
    for (let x = 0; x < CELL; x += 16) c.fillRect(x, 0, 2, CELL);
    c.fillRect(0, CELL - 5, CELL, 5);
    l.fillStyle = '#000';
    for (let x = 0; x < CELL; x += 16) l.fillRect(x, 0, 2, CELL);
  };
  cell(FACADE.GLASS, 0, curtain);
  cell(FACADE.GLASS, 1, (c, l) => {
    curtain(c, l);
    c.fillStyle = '#3a4550';
    c.fillRect(0, 0, CELL, 8);
  });
  // LUX: stone piers and tall glass.
  cell(FACADE.LUX, 0, (c, l) => {
    wall(c, '#f1ece2');
    pane(c, null, 8, 6, 20, 52, { lw: 0, glass: '#3d5670' });
    pane(c, null, 36, 6, 20, 52, { lw: 0, glass: '#3d5670' });
    l.fillStyle = '#9a9a9a';
    l.fillRect(10, 18, 16, 30);
    l.fillRect(38, 18, 16, 30);
    c.fillStyle = '#d8b25a';
    c.fillRect(0, CELL - 3, CELL, 3);
  });
  cell(FACADE.LUX, 1, (c, l) => {
    wall(c, '#e8e1d3');
    pane(c, l, 10, 16, 44, 48, { lw: 0, glass: '#2b3d52' });
    c.fillStyle = '#1f2a36';
    c.fillRect(4, 10, 56, 6);
  });
  // HOTEL: warm windows with balconies; ground: grand entrance.
  cell(FACADE.HOTEL, 0, (c, l) => {
    wall(c, '#f6f0e2');
    pane(c, l, 10, 12, 16, 30, { glass: '#3b3f55' });
    pane(c, l, 38, 12, 16, 30, { glass: '#3b3f55' });
    c.fillStyle = '#7d6a55';
    c.fillRect(6, 44, 24, 4);
    c.fillRect(34, 44, 24, 4);
    floorLine(c, 'rgba(120,90,40,0.25)');
  });
  cell(FACADE.HOTEL, 1, (c, l) => {
    wall(c, '#efe6d2');
    pane(c, l, 16, 20, 32, 44, { glass: '#2e2f40', frame: '#d8b25a', lw: 4 });
    c.fillStyle = '#b3272d';
    c.fillRect(12, 12, 40, 8);
  });
  // VACANT: grey concrete, dusty windows; ground: a roller shutter.
  cell(FACADE.VACANT, 0, (c) => {
    wall(c, '#c8c8c2');
    pane(c, null, 12, 16, 16, 22, { glass: '#565b5e', frame: '#b5b5ae', lit: false });
    pane(c, null, 36, 16, 16, 22, { glass: '#4d5255', frame: '#b5b5ae', lit: false });
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(14, 38, 3, 12);
    floorLine(c);
  });
  cell(FACADE.VACANT, 1, (c) => {
    wall(c, '#c3c3bd');
    c.fillStyle = '#9ea2a3';
    c.fillRect(8, 16, 48, 48);
    c.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 18; y < CELL; y += 5) c.fillRect(8, y, 48, 1.5);
  });
  // BOARDED: planks over the windows (mortgaged).
  const planks = (c, x, y, w, h) => {
    c.fillStyle = '#4d4f52';
    c.fillRect(x, y, w, h);
    c.fillStyle = '#b08a5c';
    c.save();
    c.beginPath();
    c.rect(x - 2, y - 2, w + 4, h + 4);
    c.clip();
    c.translate(x + w / 2, y + h / 2);
    c.rotate(-0.5);
    c.fillRect(-w, -4, w * 2, 7);
    c.rotate(1.0);
    c.fillRect(-w, -4, w * 2, 7);
    c.restore();
  };
  cell(FACADE.BOARDED, 0, (c) => {
    wall(c, '#d6d3cb');
    planks(c, 12, 16, 16, 24);
    planks(c, 36, 16, 16, 24);
    floorLine(c);
  });
  cell(FACADE.BOARDED, 1, (c) => {
    wall(c, '#cfcbc2');
    planks(c, 10, 22, 44, 42);
  });
  // ROOF: plain gravel (caps sample the middle of this cell).
  cell(FACADE.ROOF, 0, (c) => {
    wall(c, '#d8d4cb');
    for (let k = 0; k < 120; k++) {
      c.fillStyle = k % 2 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.1)';
      c.fillRect((k * 37) % CELL, (k * 53) % CELL, 2, 2);
    }
  });
  cell(FACADE.ROOF, 1, (c) => wall(c, '#d8d4cb'));
  // CIVIC: stone with tall windows (bank, stations, the power plant).
  cell(FACADE.CIVIC, 0, (c, l) => {
    wall(c, '#efe7d6');
    pane(c, l, 22, 10, 20, 40, { frame: '#fbf6ea' });
    floorLine(c, 'rgba(90,70,40,0.2)');
  });
  cell(FACADE.CIVIC, 1, (c) => {
    wall(c, '#e8dfcb');
    door(c, 22, 20, 44, '#5b3a26');
  });
  return { cv, lcv };
}

let atlasCache = null;

/**
 * The shared facade uniforms: { uLitMap, uLights (0..1), uWindowColor }. city.js sets uLights from
 * the time of day; one object is shared by every facade material of a view.
 */
export function createFacade(renderer) {
  if (!atlasCache) atlasCache = drawAtlas();
  const map = new THREE.CanvasTexture(atlasCache.cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const lit = new THREE.CanvasTexture(atlasCache.lcv);
  const uniforms = {
    uLitMap: { value: lit },
    uLights: { value: 0 },
    uWindowColor: { value: new THREE.Color('#ffb85e').multiplyScalar(1.25) },
  };
  const material = new THREE.MeshStandardMaterial({ name: 'facade', map, roughness: 0.82, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFace;
        attribute vec4 aFacade;
        varying vec2 vFac;
        varying vec3 vFacade;
        varying float vCap;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_INSTANCING
          float fW = length(instanceMatrix[0].xyz);
          float fH = length(instanceMatrix[1].xyz);
          float fD = length(instanceMatrix[2].xyz);
        #else
          float fW = 1.0; float fH = 1.0; float fD = 1.0;
        #endif
        float fSpan = aFace < 0.5 ? fD : fW;
        float fBays = max(1.0, floor(fSpan / ${BAY.toFixed(4)} + 0.5));
        vFac = vec2(uv.x * fBays, max(0.0, uv.y * fH - ${BASE_H.toFixed(4)}) / (${FLOOR_H.toFixed(4)} * max(0.2, aFacade.w)));
        vFacade = aFacade.xyz;
        vCap = step(1.5, aFace);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uLitMap;
        uniform float uLights;
        uniform vec3 uWindowColor;
        varying vec2 vFac;
        varying vec3 vFacade;
        varying float vCap;`)
      .replace('#include <map_fragment>', `
        float litMask = 0.0;
        #ifdef USE_MAP
          vec2 fCell = fract(vFac);
          float fRow = vFac.y < 1.0 ? 0.0 : 1.0; // ground floor → the lower atlas row
          vec2 fScale = vec2(0.94 / ${ATLAS_COLS.toFixed(1)}, 0.47);
          vec2 fUv = vec2((vFacade.x + 0.03 + 0.94 * fCell.x) / ${ATLAS_COLS.toFixed(1)}, (fRow + 0.03 + 0.94 * fCell.y) * 0.5);
          vec2 fDx = dFdx(vFac) * fScale;
          vec2 fDy = dFdy(vFac) * fScale;
          if (vCap > 0.5) {
            fUv = vec2((${FACADE.ROOF.toFixed(1)} + 0.5) / ${ATLAS_COLS.toFixed(1)}, 0.75);
            fDx = vec2(0.0);
            fDy = vec2(0.0);
          }
          vec4 sampledDiffuseColor = textureGrad(map, fUv, fDx, fDy);
          diffuseColor *= sampledDiffuseColor;
          litMask = vCap > 0.5 ? 0.0 : textureGrad(uLitMap, fUv, fDx, fDy).r;
        #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.32, litMask);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec2 fId = floor(vFac) + vec2(vFacade.y * 7.13, vFacade.y * 3.71);
          float fHash = fract(sin(dot(fId, vec2(12.9898, 78.233))) * 43758.5453);
          float fOn = step(fHash, vFacade.z * uLights) * (1.0 - vCap);
          totalEmissiveRadiance += uWindowColor * litMask * fOn;
        }`);
  };
  material.customProgramCacheKey = () => 'facade-v1';
  return { material, uniforms };
}

/** Unit box (base at y = 0) with the aFace attribute the facade material needs. */
export function bodyGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 vertices each).
  const face = new Float32Array(24);
  for (let k = 0; k < 24; k++) face[k] = k < 8 ? 0 : k < 16 ? 2 : 1;
  geo.setAttribute('aFace', new THREE.BufferAttribute(face, 1));
  return geo;
}

// ---- parts (unit-sized, vertex-coloured) -----------------------------------------------------------

/** Gable roof: ridge along local x, 1 wide (x), 1 deep (z), 1 high, slight overhang. */
export function gableGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.58, 0);
  s.lineTo(0.58, 0);
  s.lineTo(0, 1);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 1.08, bevelEnabled: false });
  geo.translate(0, 0, -0.54);
  geo.rotateY(Math.PI / 2); // ridge along x, slopes face ±z
  return new Kit().add(geo, { color: '#ffffff' }).build();
}

/** Mansard roof: a square frustum (1 × 1 at the bottom, 0.62 at the top, 1 high). */
export function mansardGeometry() {
  const geo = new THREE.CylinderGeometry((0.62 / Math.SQRT2) * 1.02, (1.04 / Math.SQRT2) * 1.02, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals(); // faceted, not smooth-shaded
  geo.dispose();
  const kit = new Kit().add(flat, { color: '#ffffff' });
  // A dormer on each long side.
  for (const s of [-1, 1]) kit.add(new THREE.BoxGeometry(0.22, 0.4, 0.2), { x: 0, y: 0.4, z: s * 0.36, color: '#f4f1ea' });
  return kit.build();
}

/** Flat-roof kit: a low parapet ring and a rooftop plant box (unit footprint, 1 = parapet height). */
export function parapetGeometry() {
  const kit = new Kit();
  const t = 0.06;
  kit.add(new THREE.BoxGeometry(1.02, 1, t), { y: 0.5, z: 0.5 - t / 2, color: '#e9e5dc' });
  kit.add(new THREE.BoxGeometry(1.02, 1, t), { y: 0.5, z: -0.5 + t / 2, color: '#e9e5dc' });
  kit.add(new THREE.BoxGeometry(t, 1, 1), { x: 0.5 - t / 2, y: 0.5, color: '#e9e5dc' });
  kit.add(new THREE.BoxGeometry(t, 1, 1), { x: -0.5 + t / 2, y: 0.5, color: '#e9e5dc' });
  kit.add(new THREE.BoxGeometry(0.3, 1.8, 0.26), { x: -0.18, y: 0.9, z: 0.1, color: '#a9adb0' });
  kit.add(new THREE.BoxGeometry(0.16, 1.2, 0.16), { x: 0.2, y: 0.6, z: -0.16, color: '#b8bcbe' });
  return kit.build();
}

/** Shop awning: a sloped striped canopy on the local +z face (unit width, fixed depth). */
export function awningGeometry() {
  const kit = new Kit();
  const n = 6;
  for (let k = 0; k < n; k++) {
    kit.add(new THREE.BoxGeometry(1 / n, 0.012, 0.11), { x: -0.5 + (k + 0.5) / n, y: 0.1, z: 0.555, rx: 0.45, color: k % 2 ? '#ffffff' : '#d8413a' });
  }
  kit.add(new THREE.BoxGeometry(1, 0.03, 0.012), { y: 0.074, z: 0.61, color: '#d8413a' });
  return kit.build();
}

/** Chimney for cottages (sits on the roof slope). */
export function chimneyGeometry() {
  return new Kit()
    .add(new THREE.BoxGeometry(0.06, 0.14, 0.06), { y: 0.07, color: '#9c5a44' })
    .add(new THREE.BoxGeometry(0.075, 0.015, 0.075), { y: 0.14, color: '#6f3f30' })
    .build();
}

/** Antenna / mast: 1 unit tall with a red tip. */
export function antennaGeometry() {
  return new Kit()
    .add(new THREE.CylinderGeometry(0.008, 0.012, 1, 5), { y: 0.5, color: '#b9bcbf' })
    .add(new THREE.BoxGeometry(0.05, 0.05, 0.05), { y: 0.1, color: '#9da1a4' })
    .add(new THREE.SphereGeometry(0.018, 6, 4), { y: 1, color: '#e0392f' })
    .build();
}

/** Spire with a crown ring (luxury towers): 1 unit tall. */
export function spireGeometry() {
  return new Kit()
    .add(new THREE.BoxGeometry(0.7, 0.14, 0.7), { y: 0.07, color: '#f1ece2' })
    .add(new THREE.BoxGeometry(0.5, 0.12, 0.5), { y: 0.2, color: '#d8b25a' })
    .add(new THREE.ConeGeometry(0.18, 0.75, 8), { y: 0.62, color: '#d8b25a' })
    .build();
}

/** Hotel crown: stepped top with a flag mast (unit footprint, 1 = its height). */
export function crownGeometry() {
  return new Kit()
    .add(new THREE.BoxGeometry(0.92, 0.28, 0.92), { y: 0.14, color: '#f5efe2' })
    .add(new THREE.BoxGeometry(0.68, 0.26, 0.68), { y: 0.41, color: '#b3272d' })
    .add(new THREE.BoxGeometry(0.46, 0.2, 0.46), { y: 0.64, color: '#d8b25a' })
    .add(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5), { y: 1.2, color: '#c9c9c9' })
    .add(new THREE.BoxGeometry(0.02, 0.18, 0.3), { y: 1.52, z: 0.15, color: '#d62b2b' })
    .build();
}

/** The glowing band of a hotel crown (MeshBasic, brightens at dusk). */
export function crownGlowGeometry() {
  return new THREE.BoxGeometry(0.7, 0.05, 0.7).translate(0, 0.53, 0);
}

/** Department-store rooftop sign on two legs (unit width). */
export function storeSignGeometry() {
  return new Kit()
    .add(new THREE.BoxGeometry(0.8, 0.5, 0.05), { y: 0.62, color: '#ffffff' })
    .add(new THREE.BoxGeometry(0.62, 0.18, 0.052), { y: 0.64, color: '#fbe07a' })
    .add(new THREE.BoxGeometry(0.04, 0.4, 0.04), { x: -0.3, y: 0.2, color: '#7b7f82' })
    .add(new THREE.BoxGeometry(0.04, 0.4, 0.04), { x: 0.3, y: 0.2, color: '#7b7f82' })
    .build();
}

/** "For sale" sign: a post and a red-and-white board (~0.13 tall). */
export function saleSignGeometry() {
  return new Kit()
    .add(new THREE.BoxGeometry(0.012, 0.13, 0.012), { y: 0.065, color: '#8a6a4a' })
    .add(new THREE.BoxGeometry(0.1, 0.065, 0.012), { y: 0.11, z: 0.008, color: '#ffffff' })
    .add(new THREE.BoxGeometry(0.1, 0.02, 0.013), { y: 0.132, z: 0.008, color: '#d62b2b' })
    .build();
}

/** Scaffolding: a unit cube of poles with a plank every storey (scaled to the building). */
export function scaffoldGeometry() {
  const kit = new Kit();
  const c = '#e0b13c';
  const t = 0.035;
  for (const x of [-0.53, 0.53]) {
    for (const z of [-0.53, 0.53]) kit.add(new THREE.BoxGeometry(t, 1, t), { x, y: 0.5, z, color: c });
  }
  for (let k = 1; k <= 4; k++) {
    const y = k / 4;
    for (const z of [-0.53, 0.53]) kit.add(new THREE.BoxGeometry(1.1, t * 0.6, t), { y, z, color: '#c9982e' });
    for (const x of [-0.53, 0.53]) kit.add(new THREE.BoxGeometry(t, t * 0.6, 1.1), { x, y, color: '#c9982e' });
  }
  // Diagonal braces on the long faces.
  for (const z of [-0.53, 0.53]) kit.add(new THREE.BoxGeometry(1.45, t * 0.5, t * 0.5), { y: 0.5, z, rz: Math.atan2(1, 1.06), color: c });
  return kit.build();
}

/** Round tree (trunk + two-tone crown), ~0.3 tall. */
export function treeGeometry() {
  return new Kit()
    .add(new THREE.CylinderGeometry(0.018, 0.025, 0.12, 6), { y: 0.06, color: '#6b4a2b' })
    .add(new THREE.IcosahedronGeometry(0.1, 1), { y: 0.19, sy: 1.15, color: '#3f8f4a' })
    .add(new THREE.IcosahedronGeometry(0.065, 1), { x: 0.04, y: 0.25, z: 0.03, color: '#56a35a' })
    .build();
}

/** A tiny car, facing +x (instance colour = body colour; dark windows and wheels). */
export function carGeometry() {
  const kit = new Kit();
  kit.add(new THREE.BoxGeometry(0.17, 0.04, 0.085), { y: 0.034, color: '#ffffff' });
  kit.add(new THREE.BoxGeometry(0.09, 0.034, 0.075), { x: -0.012, y: 0.07, color: '#ffffff' });
  kit.add(new THREE.BoxGeometry(0.092, 0.024, 0.077), { x: -0.012, y: 0.07, color: '#26303a' });
  for (const [x, z] of [[0.052, 0.042], [0.052, -0.042], [-0.052, 0.042], [-0.052, -0.042]]) {
    kit.add(new THREE.CylinderGeometry(0.017, 0.017, 0.012, 8).rotateX(Math.PI / 2), { x, y: 0.017, z, color: '#1b1b1b' });
  }
  kit.add(new THREE.BoxGeometry(0.005, 0.012, 0.07), { x: 0.086, y: 0.036, color: '#fff3c0' });
  return kit.build();
}

/** A tiny person: body (instance colour) — heads are a second mesh (personHeadGeometry). */
export function personGeometry() {
  return new Kit()
    .add(new THREE.CylinderGeometry(0.012, 0.016, 0.045, 6), { y: 0.0225 + 0.02, color: '#ffffff' })
    .add(new THREE.BoxGeometry(0.02, 0.022, 0.012), { y: 0.011, color: '#3a3f4a' })
    .build();
}

export function personHeadGeometry() {
  return new THREE.SphereGeometry(0.011, 6, 4).translate(0, 0.078, 0);
}

/** A bird: two thin wings in a shallow V (flap = scale.y), wingspan ~0.14. */
export function birdGeometry() {
  const pos = new Float32Array([
    0, 0, 0, -0.03, 0.02, 0.07, 0.02, 0, 0.01,
    0, 0, 0, 0.02, 0, -0.01, -0.03, 0.02, -0.07,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Owner flag on a pole (flag in local +x, instance colour = the flag). Pole 0.32 tall. */
export function flagGeometry() {
  return new Kit()
    .add(new THREE.BoxGeometry(0.1, 0.065, 0.006), { x: 0.055, y: 0.27, color: '#ffffff' })
    .build();
}

export function flagPoleGeometry() {
  return new THREE.CylinderGeometry(0.006, 0.008, 0.32, 5).translate(0, 0.16, 0);
}

/** Street lamp post (0.2 tall), the lamp head is a separate glow mesh (lampGlowGeometry). */
export function lampPostGeometry() {
  return new Kit()
    .add(new THREE.CylinderGeometry(0.005, 0.008, 0.2, 5), { y: 0.1, color: '#3b3f42' })
    .add(new THREE.BoxGeometry(0.05, 0.006, 0.006), { x: 0.022, y: 0.2, color: '#3b3f42' })
    .build();
}

export function lampGlowGeometry() {
  return new THREE.SphereGeometry(0.014, 6, 4).translate(0.045, 0.19, 0);
}
