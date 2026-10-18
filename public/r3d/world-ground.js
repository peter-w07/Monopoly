// public/r3d/world-ground.js — Loop City's streets (city design §3.1, §6.2, §11.1): the token lane
// with the 40 painted address bays (the board made of road paint), the two traffic lanes, the cycle
// track, kerbs, sidewalks paved by district, the group-colour paving strip, lamps with neighbourhood
// banners, district totems, benches, bins, bus shelters, street trees, the rear service lane and the
// rail bed. Plus the ground API: pulseBay (counting ritual) and the sat-nav route ribbon.
//
// The street is ONE mesh with one material: every vertex carries aG = (s, lat, kind, u) — the token-
// lane arc length s, the lateral offset from the lane's centre line, a surface kind and a pattern
// coordinate u — and the fragment shader paints asphalt, markings, the bays (one name atlas, no
// decals), paving patterns and the night-time lamp pools from those. Patterns never use world xz.

import * as THREE from './three.js';
import { M, LOOP, QUARTER, HALF_ARC, sOf, wrap } from './city-layout.js';
import { MeshBuf, ringBand, ringFace, ringPoints, LOT_BOUNDS, OUT, ALONG, SIGN } from './world-build.js';
import { GLSL_HASH, chainPatch, weatherPatch } from './world-shaders.js';
import { rng } from './world-geo.js';

// Surface kinds (aG.z). Keep in sync with STREET_FRAG.
export const K = {
  ROAD: 0, CYCLE: 2, KERB: 3, FLAG: 5, COBBLE: 6, PAVING: 7, GRANITE: 8, TEAK: 9, STRIP: 10, INNER: 11,
  SERVICE: 12, BALLAST: 13, PATH: 14, PLAZA: 15, VERGE: 16, PITCH: 17, RUBBER: 18, CORNER: 19, ARTERIAL: 20,
  DECK: 21, CONCRETE: 22, SOIL: 23,
};

/** Neighbourhoods (§6.2). */
export const HOODS = {
  brown: { name: 'Brickworks Row', lines: ['BRICKWORKS', 'ROW'], walk: K.FLAG },
  lightblue: { name: 'Old Town', lines: ['OLD', 'TOWN'], walk: K.COBBLE },
  pink: { name: 'Market Lanes', lines: ['MARKET', 'LANES'], walk: K.COBBLE },
  orange: { name: 'Midtown', lines: ['MIDTOWN'], walk: K.PAVING },
  red: { name: 'Theatre Row', lines: ['THEATRE', 'ROW'], walk: K.PAVING },
  yellow: { name: 'Downtown', lines: ['DOWN', 'TOWN'], walk: K.PAVING },
  green: { name: 'Bank Quarter', lines: ['BANK', 'QUARTER'], walk: K.GRANITE },
  darkblue: { name: 'Harbour Heights', lines: ['HARBOUR', 'HEIGHTS'], walk: K.TEAK },
};
const DEFAULT_GROUPS = {
  brown: '#955436', lightblue: '#aae0fa', pink: '#d93a96', orange: '#f7941d', red: '#ed1b24', yellow: '#fef200', green: '#1fb25a', darkblue: '#0072bb',
};
const DEFAULT_TYPES = ['go', 'property', 'community', 'property', 'tax', 'railroad', 'property', 'chance', 'property', 'property',
  'jail', 'property', 'utility', 'property', 'property', 'railroad', 'property', 'community', 'property', 'property',
  'free_parking', 'property', 'chance', 'property', 'property', 'railroad', 'property', 'property', 'utility', 'property',
  'go_to_jail', 'property', 'property', 'community', 'property', 'railroad', 'chance', 'property', 'tax', 'property'];
const DEFAULT_GROUP_OF = { 1: 'brown', 3: 'brown', 6: 'lightblue', 8: 'lightblue', 9: 'lightblue', 11: 'pink', 13: 'pink', 14: 'pink', 16: 'orange', 18: 'orange', 19: 'orange', 21: 'red', 23: 'red', 24: 'red', 26: 'yellow', 27: 'yellow', 29: 'yellow', 31: 'green', 32: 'green', 34: 'green', 37: 'darkblue', 39: 'darkblue' };

/** Tile facts the world needs, from /api/board (with a built-in fallback). */
export function tileFacts(BOARD) {
  const groups = {};
  for (const [g, c] of Object.entries(DEFAULT_GROUPS)) groups[g] = BOARD?.groups?.[g]?.color ?? c;
  return Array.from({ length: 40 }, (_, i) => {
    const t = BOARD?.tiles?.[i] ?? {};
    const type = t.type ?? DEFAULT_TYPES[i];
    const group = t.group ?? DEFAULT_GROUP_OF[i] ?? null;
    return { i, type, group, color: group ? groups[group] : null, name: String(t.name ?? ''), hood: group ? HOODS[group] : null };
  });
}

const shortName = (n) => n
  .replace(/\bAvenue\b/, 'Ave').replace(/\bPlace\b/, 'Pl').replace(/\bRailroad\b/, 'RR')
  .replace(/^North Carolina/, 'N. Carolina').replace(/\bCompany\b/, 'Co.');

// ---- the bay atlas ------------------------------------------------------------------------------

const ATLAS_W = 2048;
const ATLAS_H = 1024;
const CELL_W = 512; // = 20 m along the lane
const CELL_H = 102.4; // = 3.5 m across

function luminance(hex) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // linear
}

/** Paints the 40 bays (the board squares) into one canvas: 4 columns × 10 rows of 20 × 3.5 m. */
function bayAtlas(facts) {
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W;
  cv.height = ATLAS_H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, ATLAS_W, ATLAS_H);
  for (const f of facts) {
    const x0 = (f.i % 4) * CELL_W;
    const y0 = Math.floor(f.i / 4) * CELL_H;
    g.save();
    g.translate(x0, y0);
    g.beginPath();
    g.rect(0, 0, CELL_W, CELL_H);
    g.clip();
    paintBay(g, f);
    g.restore();
  }
  return cv;
}

function paintBay(g, f) {
  // Paint area: inset 6 px at the ends and 5 px at the sides (transparent margins: no mip bleeding).
  const X0 = 6;
  const X1 = CELL_W - 6;
  const Y0 = 5;
  const Y1 = CELL_H - 5;
  const W = X1 - X0;
  const H = Y1 - Y0;
  const font = (px, w = 900) => `${w} ${px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  const text = (s, x, y, px, color, maxW, align = 'left') => {
    g.font = font(px);
    g.fillStyle = color;
    g.textBaseline = 'middle';
    g.textAlign = align;
    const w = g.measureText(s).width;
    g.save();
    g.translate(x, y);
    if (w > maxW) g.scale(maxW / w, 1);
    g.fillText(s, 0, 0);
    g.restore();
  };
  const stripes = (a, b, width = 22) => {
    g.fillStyle = a;
    g.fillRect(X0, Y0, W, H);
    g.fillStyle = b;
    for (let x = X0 - H; x < X1 + H; x += width * 2) {
      g.beginPath();
      g.moveTo(x, Y1);
      g.lineTo(x + width, Y1);
      g.lineTo(x + width + H, Y0);
      g.lineTo(x + H, Y0);
      g.closePath();
      g.fill();
    }
  };
  const plate = (x, w, bg) => {
    g.fillStyle = bg;
    g.fillRect(x, Y0 + 10, w, H - 20);
  };
  const border = (color = '#ffffff') => {
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.strokeRect(X0 + 5, Y0 + 5, W - 10, H - 10);
  };
  const disc = (n, bg, fg) => {
    g.fillStyle = bg;
    g.beginPath();
    g.arc(X0 + 40, CELL_H / 2, 30, 0, Math.PI * 2);
    g.fill();
    text(String(n), X0 + 40, CELL_H / 2 + 2, 34, fg, 50, 'center');
  };
  const T = f.type;
  if (T === 'go') {
    const sq = H / 4;
    for (let r = 0; r < 4; r++) for (let c = 0; c * sq < W; c++) {
      g.fillStyle = (r + c) % 2 ? '#111111' : '#f4f4f0';
      g.fillRect(X0 + c * sq, Y0 + r * sq, Math.min(sq, X1 - X0 - c * sq), sq);
    }
    plate(X0 + 110, 290, '#f4f4f0');
    text('GO', X0 + 190, CELL_H / 2 + 3, 74, '#d0202c', 150, 'center');
    // Arrow in the travel direction (to the right).
    g.fillStyle = '#d0202c';
    g.beginPath();
    g.moveTo(X0 + 270, CELL_H / 2 - 9);
    g.lineTo(X0 + 340, CELL_H / 2 - 9);
    g.lineTo(X0 + 340, CELL_H / 2 - 26);
    g.lineTo(X0 + 385, CELL_H / 2);
    g.lineTo(X0 + 340, CELL_H / 2 + 26);
    g.lineTo(X0 + 340, CELL_H / 2 + 9);
    g.lineTo(X0 + 270, CELL_H / 2 + 9);
    g.closePath();
    g.fill();
    return;
  }
  if (T === 'jail') {
    stripes('#f2c21b', '#151515');
    plate(X0 + 120, 270, '#151515');
    text('JAIL', X0 + 255, CELL_H / 2 + 3, 62, '#f2c21b', 240, 'center');
    return;
  }
  if (T === 'go_to_jail') {
    stripes('#f4f4f0', '#c8202c');
    plate(X0 + 70, 360, '#c8202c');
    text('GO TO JAIL', X0 + 250, CELL_H / 2 + 3, 54, '#ffffff', 330, 'center');
    return;
  }
  if (T === 'free_parking') {
    g.fillStyle = '#1f5fae';
    g.fillRect(X0, Y0, W, H);
    border();
    g.fillStyle = '#ffffff';
    g.fillRect(X0 + 22, Y0 + 12, 64, H - 24);
    text('P', X0 + 54, CELL_H / 2 + 3, 66, '#1f5fae', 60, 'center');
    text('FREE PARKING', X0 + 105, CELL_H / 2 + 2, 50, '#ffffff', W - 125);
    return;
  }
  let bg = '#5a6068';
  let label = shortName(f.name || '');
  let icon = null;
  if (T === 'property') bg = f.color ?? '#888888';
  else if (T === 'railroad') { bg = '#2f3640'; icon = 'rail'; }
  else if (T === 'utility') { bg = '#d99a1c'; icon = f.i === 28 ? 'drop' : 'bulb'; }
  else if (T === 'chance') { bg = '#23864a'; icon = '?'; label = label || 'Chance'; }
  else if (T === 'community') { bg = '#2a63ad'; icon = 'chest'; label = label || 'Community Chest'; }
  else if (T === 'tax') { bg = '#5d646c'; icon = '$'; }
  const light = luminance(bg) > 0.42;
  const fg = light ? '#1a1a1a' : '#ffffff';
  g.fillStyle = bg;
  g.fillRect(X0, Y0, W, H);
  border(light ? '#1a1a1a' : '#ffffff');
  disc(f.i, fg, bg);
  let tx = X0 + 82;
  if (icon) {
    drawIcon(g, icon, X0 + 112, CELL_H / 2, fg, bg);
    tx = X0 + 148;
  }
  text(label.toUpperCase(), tx, CELL_H / 2 + 3, 46, fg, X1 - 16 - tx);
}

function drawIcon(g, icon, cx, cy, fg, bg) {
  g.save();
  g.fillStyle = fg;
  g.strokeStyle = fg;
  g.lineWidth = 5;
  g.lineCap = 'round';
  if (icon === 'rail') {
    for (let k = -2; k <= 2; k++) g.fillRect(cx - 22, cy + k * 9 - 2, 44, 4);
    g.fillRect(cx - 14, cy - 26, 6, 52);
    g.fillRect(cx + 8, cy - 26, 6, 52);
  } else if (icon === 'bulb') {
    g.beginPath();
    g.arc(cx, cy - 6, 17, Math.PI * 0.8, Math.PI * 2.2);
    g.lineTo(cx + 8, cy + 16);
    g.lineTo(cx - 8, cy + 16);
    g.closePath();
    g.fill();
    g.fillRect(cx - 8, cy + 19, 16, 6);
  } else if (icon === 'drop') {
    g.beginPath();
    g.moveTo(cx, cy - 26);
    g.bezierCurveTo(cx + 6, cy - 10, cx + 20, cy, cx + 18, cy + 10);
    g.arc(cx, cy + 10, 18, 0, Math.PI);
    g.bezierCurveTo(cx - 20, cy, cx - 6, cy - 10, cx, cy - 26);
    g.fill();
  } else if (icon === 'chest') {
    g.fillRect(cx - 24, cy - 8, 48, 30);
    g.beginPath();
    g.moveTo(cx - 24, cy - 8);
    g.quadraticCurveTo(cx, cy - 34, cx + 24, cy - 8);
    g.fill();
    g.fillStyle = bg;
    g.fillRect(cx - 24, cy - 4, 48, 4);
    g.fillRect(cx - 4, cy - 2, 8, 10);
  } else {
    g.font = '900 56px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(icon, cx, cy + 3);
  }
  g.restore();
}

// ---- the street material -----------------------------------------------------------------------

const f3 = (x) => Number(x).toFixed(4);

const STREET_FRAG_PARS = /* glsl */ `
uniform sampler2D uBays;
uniform float uBayGlow[40];
uniform vec3 uBayGlowCol[40];
uniform float uMapMode;
uniform float uLights;
uniform float uSnow;
varying vec4 vG;
${GLSL_HASH}
vec3 streetEmissive = vec3(0.0);
float streetRough = 0.88;
float lineAA(float x, float halfW) {
  float w = fwidth(x) * 0.75;
  return 1.0 - smoothstep(halfW - w, halfW + w, abs(x));
}
float grid(vec2 p, vec2 cell, float joint) {
  vec2 g = p / cell;
  vec2 w = fwidth(g);
  vec2 f = abs(fract(g) - 0.5) * cell;
  vec2 j = smoothstep(cell * 0.5 - joint - w * cell, cell * 0.5 - joint + w * cell, f);
  float far = smoothstep(0.3, 0.8, max(w.x, w.y));
  return mix(max(j.x, j.y), joint * 2.0 / min(cell.x, cell.y), far);
}
float lampPools(float s, float lat) {
  float ss = mod(s, ${f3(LOOP)});
  float q = floor(ss / ${f3(QUARTER)});
  float u = ss - q * ${f3(QUARTER)};
  float kb = clamp(floor((u - ${f3(HALF_ARC + 6.25)}) / 26.0 + 0.5), 1.0, 8.0);
  float da = u - (${f3(HALF_ARC + 6.25)} + 26.0 * kb);
  float o = lat - 3.05;
  float i = lat + 11.0;
  return exp(-(da * da + o * o) / 24.0) + exp(-(da * da + i * i) / 24.0) * 0.8;
}
vec3 streetColor(vec3 vcol) {
  float kind = floor(vG.z + 0.5);
  float s = vG.x;
  float lat = vG.y;
  float u = vG.w;
  vec2 p = vec2(u, lat);
  float grain = cityNoise(p * 0.9) * 0.5 + cityNoise(p * 4.3) * 0.3 + cityNoise(p * 17.0) * 0.2;
  vec3 c = vec3(0.5);
  float paint = 0.0; // 0..1: how much of this fragment is a bay (map view glow)
  if (kind < 0.5) {
    // Traffic lanes (lat −8.25 … −1.75) and the token lane (−1.75 … 1.75).
    vec3 asphalt = mix(vec3(0.115, 0.12, 0.128), vec3(0.17, 0.172, 0.178), grain);
    vec3 terra = mix(vec3(0.33, 0.16, 0.115), vec3(0.42, 0.22, 0.16), grain);
    float lane = smoothstep(-1.78, -1.72, lat);
    c = mix(asphalt, terra, lane);
    // Tyre-polished wheel paths in the traffic lanes.
    float track = exp(-pow((lat + 3.375 - 0.9) * 2.2, 2.0)) + exp(-pow((lat + 3.375 + 0.9) * 2.2, 2.0))
      + exp(-pow((lat + 6.625 - 0.9) * 2.2, 2.0)) + exp(-pow((lat + 6.625 + 0.9) * 2.2, 2.0));
    c *= 1.0 - 0.12 * track * (1.0 - lane);
    float white = lineAA(lat + 1.75, 0.075) + lineAA(lat + 8.08, 0.07);
    float dash = step(fract(s / 9.0), 0.34);
    white += lineAA(lat + 5.0, 0.065) * dash;
    c = mix(c, vec3(0.78, 0.78, 0.76), clamp(white, 0.0, 1.0) * (0.75 + 0.25 * grain));
    // The bays: the board squares painted on the token lane.
    float ss = mod(s, ${f3(LOOP)});
    float q = floor(ss / ${f3(QUARTER)});
    float qu = ss - q * ${f3(QUARTER)};
    float k = clamp(floor((qu - ${f3(HALF_ARC - 6.75)}) / 26.0 + 0.5), 0.0, 10.0);
    float sk = k < 0.5 ? 0.0 : (k > 9.5 ? ${f3(QUARTER)} : ${f3(HALF_ARC - 6.75)} + 26.0 * k);
    float d = qu - sk;
    float idx = mod(q * 10.0 + k, 40.0);
    int ii = int(idx + 0.5);
    float col = mod(idx, 4.0);
    float row = floor(idx / 4.0);
    vec2 local = vec2(clamp(d, -10.0, 10.0), clamp(lat, -1.75, 1.75));
    vec2 buv = vec2((col + (local.x + 10.0) / 20.0) / 4.0, 1.0 - (row + 1.0) / 10.0 + (local.y + 1.75) / 35.0);
    vec2 gx = vec2(dFdx(d) / 80.0, dFdx(lat) / 35.0);
    vec2 gy = vec2(dFdy(d) / 80.0, dFdy(lat) / 35.0);
    vec4 bay = textureGrad(uBays, buv, gx, gy);
    float inBay = step(abs(d), 10.0) * lane;
    float wear = 0.8 + 0.2 * smoothstep(0.2, 0.7, cityNoise(p * vec2(1.7, 3.1)) + 0.3);
    float a = bay.a * inBay * wear;
    float glow = uBayGlow[ii];
    vec3 gc = uBayGlowCol[ii];
    vec3 pc = mix(bay.rgb * 0.92, gc, glow * 0.45);
    c = mix(c, pc, a);
    paint = a;
    streetEmissive += (gc * glow * 1.3 + pc * uMapMode * 0.65) * a;
    // Hatching in the middle of the gaps between bays.
    float ad = abs(d);
    float hatch = step(11.6, ad) * step(abs(lat), 1.5) * lane;
    float hx = fract((ad + lat * 0.9) / 1.2);
    float hw = fwidth((ad + lat * 0.9) / 1.2);
    float stripe = smoothstep(0.0, hw, hx) * (1.0 - smoothstep(0.42 - hw, 0.42 + hw, hx));
    c = mix(c, vec3(0.8, 0.8, 0.78), hatch * stripe * 0.85 * wear);
    streetRough = mix(0.82, 0.62, a);
  } else if (kind < 2.5) {
    // Cycle track (green) with a dashed white edge.
    c = mix(vec3(0.15, 0.3, 0.17), vec3(0.2, 0.36, 0.21), grain);
    float edge = lineAA(lat + 9.95, 0.06) * step(fract(u / 4.0), 0.55);
    c = mix(c, vec3(0.8), edge * 0.85);
    streetRough = 0.8;
  } else if (kind < 3.5) {
    // Granite kerb.
    c = mix(vec3(0.42, 0.42, 0.43), vec3(0.55, 0.55, 0.56), grain) * (1.0 - 0.3 * grid(vec2(u, 0.0), vec2(1.0, 10.0), 0.012));
    streetRough = 0.7;
  } else if (kind < 5.5) {
    // Suburb flagstones (0.9 m), slightly irregular tones.
    vec2 cell = vec2(0.9, 0.9);
    vec2 id = floor(p / cell);
    c = mix(vec3(0.52, 0.5, 0.46), vec3(0.62, 0.6, 0.55), cityHash(id)) * (0.9 + 0.1 * grain);
    c *= 1.0 - 0.35 * grid(p, cell, 0.02);
  } else if (kind < 6.5) {
    // Cobbles (setts in staggered rows).
    vec2 cell = vec2(0.22, 0.16);
    vec2 pp = vec2(p.x + 0.11 * step(1.0, mod(floor(p.y / cell.y), 2.0)), p.y);
    vec2 id = floor(pp / cell);
    c = mix(vec3(0.34, 0.31, 0.29), vec3(0.5, 0.45, 0.4), cityHash(id)) * (0.85 + 0.15 * grain);
    c *= 1.0 - 0.45 * grid(pp, cell, 0.018);
    streetRough = 0.82;
  } else if (kind < 7.5) {
    // Wide buff paving (1.5 × 0.75 m).
    vec2 cell = vec2(1.5, 0.75);
    vec2 pp = vec2(p.x + 0.75 * step(1.0, mod(floor(p.y / cell.y), 2.0)), p.y);
    c = mix(vec3(0.6, 0.57, 0.5), vec3(0.68, 0.65, 0.58), cityHash(floor(pp / cell))) * (0.92 + 0.08 * grain);
    c *= 1.0 - 0.3 * grid(pp, cell, 0.015);
  } else if (kind < 8.5) {
    // Granite slabs (1.2 × 0.6 m), speckled.
    vec2 cell = vec2(1.2, 0.6);
    float sp = step(0.82, cityHash(floor(p * 40.0)));
    c = mix(vec3(0.4, 0.41, 0.42), vec3(0.5, 0.5, 0.51), cityHash(floor(p / cell))) * (0.9 + 0.1 * grain) + sp * 0.05;
    c *= 1.0 - 0.3 * grid(p, cell, 0.012);
    streetRough = 0.6;
  } else if (kind < 9.5 || (kind > 20.5 && kind < 21.5)) {
    // Teak decking (planks 0.16 m across the walk).
    vec2 q2 = vec2(p.y, p.x);
    vec2 cell = vec2(0.16, 2.4);
    vec2 pp = vec2(q2.x, q2.y + 1.2 * cityHash(vec2(floor(q2.x / 0.16), 1.0)));
    c = mix(vec3(0.42, 0.27, 0.16), vec3(0.55, 0.37, 0.22), cityHash(floor(pp / cell))) * (0.85 + 0.15 * cityNoise(pp * vec2(2.0, 0.3)));
    c *= 1.0 - 0.4 * grid(pp, cell, 0.01);
    streetRough = 0.72;
  } else if (kind < 10.5) {
    // The group-colour paving strip (bricks).
    vec2 cell = vec2(0.2, 0.4);
    c = vcol * (0.82 + 0.18 * cityHash(floor(p / cell))) * (0.92 + 0.08 * grain);
    c *= 1.0 - 0.3 * grid(p, cell, 0.012);
  } else if (kind < 11.5) {
    // Inner sidewalk: light concrete tiles (0.6 m).
    vec2 cell = vec2(0.6, 0.6);
    c = mix(vec3(0.6, 0.6, 0.58), vec3(0.66, 0.66, 0.63), cityHash(floor(p / cell))) * (0.93 + 0.07 * grain);
    c *= 1.0 - 0.25 * grid(p, cell, 0.01);
  } else if (kind < 12.5 || (kind > 19.5 && kind < 20.5)) {
    // Plain asphalt (service lane, arterials) with a dashed centre line.
    c = mix(vec3(0.12, 0.125, 0.13), vec3(0.17, 0.17, 0.175), grain);
    float centre = kind < 12.5 ? 44.75 : 0.0;
    float dash = step(fract(u / 8.0), 0.4);
    c = mix(c, vec3(0.78, 0.72, 0.5), lineAA(lat - centre, 0.06) * dash * 0.85);
    float edges = kind < 12.5 ? lineAA(lat - 41.0, 0.05) + lineAA(lat - 48.5, 0.05) : lineAA(abs(lat) - 4.2, 0.06);
    c = mix(c, vec3(0.75), clamp(edges, 0.0, 1.0) * 0.7);
  } else if (kind < 13.5) {
    // Rail bed: ballast with sleepers under the two tracks.
    c = mix(vec3(0.32, 0.3, 0.28), vec3(0.45, 0.42, 0.38), cityNoise(p * 9.0)) * (0.85 + 0.15 * grain);
    float t1 = abs(lat - 62.75);
    float t2 = abs(lat - 66.75);
    float under = step(min(t1, t2), 1.3);
    float sl = fract(u / 0.65);
    float sw = fwidth(u / 0.65);
    float sleeper = under * smoothstep(0.0, sw, sl) * (1.0 - smoothstep(0.36 - sw, 0.36 + sw, sl));
    float far = smoothstep(0.3, 0.8, sw);
    sleeper = mix(sleeper, under * 0.36, far);
    c = mix(c, vec3(0.2, 0.15, 0.11), sleeper * 0.9);
    // Dark shadow lines where the rails sit.
    float rail = lineAA(t1 - 0.7175, 0.05) + lineAA(t2 - 0.7175, 0.05);
    c *= 1.0 - 0.35 * clamp(rail, 0.0, 1.0);
    streetRough = 0.95;
  } else if (kind < 14.5) {
    // Park path: fine gravel.
    c = mix(vec3(0.6, 0.55, 0.45), vec3(0.7, 0.65, 0.54), cityNoise(p * 12.0)) * (0.9 + 0.1 * grain);
    streetRough = 0.95;
  } else if (kind < 15.5) {
    // Civic plaza: warm stone, 2 m slabs with a darker border grid.
    vec2 cell = vec2(2.0, 2.0);
    c = mix(vec3(0.62, 0.57, 0.5), vec3(0.7, 0.65, 0.57), cityHash(floor(p / cell))) * (0.92 + 0.08 * grain);
    c *= 1.0 - 0.28 * grid(p, cell, 0.02);
    c *= 1.0 - 0.15 * grid(p, vec2(10.0), 0.12);
    streetRough = 0.7;
  } else if (kind < 16.5) {
    // Grass verge.
    c = mix(vec3(0.17, 0.27, 0.11), vec3(0.25, 0.36, 0.15), grain);
    streetRough = 0.95;
  } else if (kind < 17.5) {
    // Five-a-side pitch: mown stripes + white lines (u along 0..40, lat across −10..10 around its centre).
    c = mix(vec3(0.16, 0.33, 0.13), vec3(0.2, 0.4, 0.16), step(0.5, fract(u / 5.0)));
    float l = lineAA(abs(lat) - 9.6, 0.06) + lineAA(abs(u - 20.0) - 19.6, 0.06) + lineAA(u - 20.0, 0.06) + lineAA(length(vec2(u - 20.0, lat)) - 3.0, 0.06);
    c = mix(c, vec3(0.85), clamp(l, 0.0, 1.0));
  } else if (kind < 18.5) {
    c = mix(vec3(0.42, 0.16, 0.11), vec3(0.5, 0.2, 0.14), grain);
  } else if (kind < 19.5) {
    // Corner plazas (the elbows): big granite slabs.
    vec2 cell = vec2(1.8, 1.8);
    c = mix(vec3(0.46, 0.46, 0.46), vec3(0.55, 0.55, 0.54), cityHash(floor(p / cell))) * (0.92 + 0.08 * grain);
    c *= 1.0 - 0.25 * grid(p, cell, 0.015);
    streetRough = 0.65;
  } else if (kind > 22.5) {
    // Vertex colour with grain (allotment soil and beds, yards).
    c = vcol * (0.8 + 0.2 * grain);
    streetRough = 0.95;
  } else {
    // Harbour concrete.
    c = mix(vec3(0.45, 0.45, 0.44), vec3(0.55, 0.55, 0.53), grain);
    c *= 1.0 - 0.25 * grid(p, vec2(6.0, 6.0), 0.03);
  }
  // Night: warm pools under the street lamps (no real lights).
  if (uLights > 0.01 && abs(lat) < 20.0) {
    float pool = lampPools(s, lat);
    streetEmissive += c * vec3(1.0, 0.76, 0.48) * pool * uLights * 2.4;
  }
  // Map view: everything but the bays desaturates and darkens a little.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(l) * 0.85, uMapMode * 0.4 * (1.0 - paint));
  return c;
}`;

/** The street material: a MeshStandardMaterial painted from aG (+ wet / snow). */
function streetMaterial(uniforms, bayTex, glow) {
  const m = new THREE.MeshStandardMaterial({ name: 'street', vertexColors: true, roughness: 0.88, metalness: 0 });
  chainPatch(m, 'street-v1', (shader) => {
    shader.uniforms.uBays = { value: bayTex };
    shader.uniforms.uBayGlow = glow.amount;
    shader.uniforms.uBayGlowCol = glow.color;
    shader.uniforms.uMapMode = uniforms.uMapMode;
    shader.uniforms.uLights = uniforms.uLights;
    shader.uniforms.uSnow = uniforms.uSnow;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec4 aG;\nvarying vec4 vG;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvG = aG;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${STREET_FRAG_PARS}\nvoid main() {`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = streetColor(diffuseColor.rgb);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = streetRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += streetEmissive;');
  });
  weatherPatch(m, uniforms, { wet: 1, snow: 0.8, desat: 0 });
  return m;
}

// ---- the route ribbon ---------------------------------------------------------------------------

const ROUTE_VERT = /* glsl */ `
attribute float aS;
varying float vS;
varying float vX;
void main() {
  vS = aS;
  vX = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const ROUTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uS0;
uniform float uLen;
uniform float uDir;
uniform float uReveal;
uniform float uTime;
uniform float uOpacity;
varying float vS;
varying float vX;
void main() {
  float rel = uDir > 0.0 ? mod(vS - uS0, ${f3(LOOP)}) : mod(uS0 - vS, ${f3(LOOP)});
  if (uLen >= ${f3(LOOP - 0.01)}) rel = mod(rel, ${f3(LOOP)});
  float head = uLen * uReveal;
  if (rel > head + 0.01) discard;
  // Chevrons streaming toward the destination.
  float across = abs(vX - 0.5) * 2.0;
  float ch = fract((rel - uTime * 9.0) / 5.0 - across * 0.35);
  float chev = smoothstep(0.0, 0.08, ch) * (1.0 - smoothstep(0.42, 0.5, ch));
  float edge = smoothstep(0.82, 0.92, across);
  float tip = 1.0 - smoothstep(0.0, 6.0, head - rel);
  float a = (0.45 + 0.4 * chev + 0.5 * edge) * (1.0 - smoothstep(0.92, 1.0, across)) * uOpacity;
  vec3 col = mix(uColor, vec3(1.0), 0.35 * chev + 0.5 * tip);
  gl_FragColor = vec4(col * 1.25, a);
  #include <colorspace_fragment>
}`;

function routeRibbon() {
  // One lap of the lane, 1.6 m wide, sampled every 1 m (0.25 m on the corner arcs).
  const pos = [];
  const uv = [];
  const sA = [];
  const idx = [];
  const p = {};
  const ss = [];
  for (let s = 0; s <= LOOP + 1e-6;) {
    ss.push(Math.min(s, LOOP));
    const u = s % QUARTER;
    s += u < HALF_ARC + 0.5 || u > QUARTER - HALF_ARC - 0.5 ? 0.25 : 1;
  }
  if (ss[ss.length - 1] < LOOP) ss.push(LOOP);
  for (const s of ss) {
    for (const lat of [-0.8, 0.8]) {
      lanePoint(s, lat, p);
      pos.push(p.x, 0.035, p.z);
      uv.push(lat < 0 ? 0 : 1, 0);
      sA.push(s);
    }
  }
  for (let k = 0; k + 1 < ss.length; k++) {
    const a = k * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aS', new THREE.Float32BufferAttribute(sA, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const uniforms = {
    uColor: { value: new THREE.Color('#ffffff') },
    uS0: { value: 0 },
    uLen: { value: 0 },
    uDir: { value: 1 },
    uReveal: { value: 0 },
    uTime: { value: 0 },
    uOpacity: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    name: 'route',
    uniforms,
    vertexShader: ROUTE_VERT,
    fragmentShader: ROUTE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'route-ribbon';
  mesh.renderOrder = 3;
  mesh.visible = false;
  return { mesh, uniforms };
}

/** pointAt without the import cycle (same maths as city-layout.pointAt). */
function lanePoint(s, lat, out) {
  const L = LOOP;
  s = ((s % L) + L) % L;
  const q = Math.min(3, Math.floor(s / QUARTER));
  let u = s - q * QUARTER;
  const r = M.ARC_R + lat;
  const C = (k) => ({ x: SIGN[k][0] * M.ARC_C, z: SIGN[k][1] * M.ARC_C });
  if (u < HALF_ARC) {
    const phi = Math.PI / 4 + (q * Math.PI) / 2 + u / M.ARC_R;
    out.x = C(q).x + r * Math.cos(phi);
    out.z = C(q).z + r * Math.sin(phi);
    return out;
  }
  u -= HALF_ARC;
  if (u < 2 * M.ARC_C) {
    out.x = C(q).x + r * OUT[q][0] + ALONG[q][0] * u;
    out.z = C(q).z + r * OUT[q][1] + ALONG[q][1] * u;
    return out;
  }
  u -= 2 * M.ARC_C;
  const q1 = (q + 1) % 4;
  const phi = Math.PI / 4 + (q1 * Math.PI) / 2 - (HALF_ARC - u) / M.ARC_R;
  out.x = C(q1).x + r * Math.cos(phi);
  out.z = C(q1).z + r * Math.sin(phi);
  return out;
}

// ---- furniture ----------------------------------------------------------------------------------

// (south: x = along, z = h; west: x = −h, z = along; north: x = −along, z = −h; east: x = h, z = −along)
function sideXZ(q, along, h) {
  switch (q) {
    case 0: return { x: along, z: h };
    case 1: return { x: -h, z: along };
    case 2: return { x: -along, z: -h };
    default: return { x: h, z: -along };
  }
}

const GO_APEXES = [[129.61, 129.61], [-129.61, 129.61], [-129.61, -129.61], [129.61, -129.61]];
const nearApex = (x, z, r = 14) => GO_APEXES.some(([ax, az]) => Math.hypot(x - ax, z - az) < r);

/**
 * Builds the streets + furniture. Returns meshes, the trees it wants, the ground API.
 * @param {object} ctx { uniforms, facts, kits: { furniture, glow }, trees[], street }
 */
export function buildGround(ctx) {
  const { uniforms, facts, street, furniture, glow, trees } = ctx;
  const white = [1, 1, 1];
  const groupCol = (g) => new THREE.Color(facts.find((f) => f.group === g)?.color ?? '#888888').toArray();
  const tileOfAlong = (q, a) => {
    const k = Math.floor((143 - a) / 26);
    return k >= 1 && k <= 9 ? q * 10 + k : null;
  };
  // Which surface each outer-sidewalk lot gets (§3.1 / surfaceAt: Old Town + Market cobbles).
  const walkKind = (tile) => {
    const f = facts[tile];
    const q = Math.floor(tile / 10);
    const along = 130 - 26 * (tile % 10);
    if (q === 0) return along < -13 ? K.COBBLE : K.FLAG;
    if (q === 1) return along > 13 ? K.COBBLE : K.PAVING;
    if (q === 2) return K.PAVING;
    return f.group === 'darkblue' || tile >= 36 ? K.TEAK : K.GRANITE;
  };

  // -- the bands, centre outward --
  const inner = (h, c) => ({ h, c });
  const segTile = (a, b) => (a.seg === 1 && b.seg === 1 ? tileOfAlong(a.q, (a.along + b.along) / 2) : null);
  // Inner sidewalk 117–122 (+0.15) with kerbs on both sides.
  ringBand(street, inner(117, 117), inner(122, 122), { y0: 0.15, info: () => ({ kind: K.INNER }) });
  ringFace(street, inner(117, 117), { y0: 0, y1: 0.15, dir: -1, kind: K.KERB });
  ringFace(street, inner(122, 122), { y0: 0, y1: 0.15, dir: 1, kind: K.KERB });
  // Cycle track 122–124.
  ringBand(street, inner(122, 122), inner(124, M.ARC_C), { y0: 0.0, arcN: 8, info: () => ({ kind: K.CYCLE }) });
  // Traffic lanes + token lane 124–134 (the bays are painted in the shader from s / lat).
  ringBand(street, inner(124, M.ARC_C), inner(134, M.ARC_C), { y0: 0, arcN: 16, step: 13, info: () => ({ kind: K.ROAD }) });
  // Outer kerb (face + granite top), outer sidewalk, group-colour strip.
  ringFace(street, inner(134, M.ARC_C), { y0: 0, y1: 0.15, dir: -1, kind: K.KERB, arcN: 16 });
  ringBand(street, inner(134, M.ARC_C), inner(134.35, M.ARC_C), { y0: 0.15, arcN: 16, info: () => ({ kind: K.KERB }) });
  ringBand(street, inner(134.35, M.ARC_C), inner(138.2, 138.2), {
    y0: 0.15, arcN: 16,
    info: (a, b) => {
      const t = segTile(a, b);
      return { kind: t === null ? K.CORNER : walkKind(t) };
    },
  });
  ringBand(street, inner(138.2, 138.2), inner(139, 139), {
    y0: 0.15, arcN: 8,
    info: (a, b) => {
      const t = segTile(a, b);
      const f = t === null ? null : facts[t];
      return f?.group ? { kind: K.STRIP, color: groupCol(f.group) } : { kind: t === null ? K.CORNER : K.STRIP, color: [0.42, 0.44, 0.46] };
    },
  });
  // Rear service lane 173–181 and the verge behind it (181–191).
  ringBand(street, inner(173, 169), inner(181, 169), { y0: 0, arcN: 10, step: 40, info: () => ({ kind: K.SERVICE }) });
  ringBand(street, inner(181, 169), inner(191, M.RAIL_C), { y0: 0, arcN: 10, step: 40, info: () => ({ kind: K.VERGE }) });
  // Rail bed 191–203 (ballast raised 0.3 m with sloped shoulders; sleepers painted).
  ringBand(street, inner(191, M.RAIL_C), inner(192, M.RAIL_C), { y0: 0.0, y1: 0.3, arcN: 18, step: 40, info: () => ({ kind: K.BALLAST }) });
  ringBand(street, inner(192, M.RAIL_C), inner(202, M.RAIL_C), { y0: 0.3, arcN: 18, step: 40, info: () => ({ kind: K.BALLAST }) });
  ringBand(street, inner(202, M.RAIL_C), inner(203, M.RAIL_C), { y0: 0.3, y1: 0.0, arcN: 18, step: 40, info: () => ({ kind: K.BALLAST }) });

  // -- rails (steel, swept) --
  const steel = new THREE.Color('#7d8085').toArray();
  for (const h of [195 - 0.7175, 195 + 0.7175, 199 - 0.7175, 199 + 0.7175]) {
    const pts = ringPoints({ h, c: M.RAIL_C }, { arcN: 18, step: 30 });
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-4) continue;
      const w = 0.035;
      const y0 = 0.3;
      const y1 = 0.46;
      const A = (p, s) => [p.x + p.nx * w * s, 0, p.z + p.nz * w * s];
      const [ai, ao, bi, bo] = [A(a, -1), A(a, 1), A(b, -1), A(b, 1)];
      furniture.quad([ai[0], y1, ai[2]], [ao[0], y1, ao[2]], [bo[0], y1, bo[2]], [bi[0], y1, bi[2]], [0, 1, 0], steel);
      furniture.quad([ao[0], y0, ao[2]], [bo[0], y0, bo[2]], [bo[0], y1, bo[2]], [ao[0], y1, ao[2]], [a.nx, 0, a.nz], steel);
      furniture.quad([bi[0], y0, bi[2]], [ai[0], y0, ai[2]], [ai[0], y1, ai[2]], [bi[0], y1, bi[2]], [-a.nx, 0, -a.nz], steel);
    }
  }

  // -- lamps, banners, totems, benches, bins, shelters, planters, street trees --
  const lamps = [];
  const banners = []; // { x, z, y, yaw, cell }
  const totems = [];
  const bannerCell = (tile) => {
    const f = tile === null ? null : facts[tile];
    return f?.group ? Object.keys(HOODS).indexOf(f.group) : 8;
  };
  for (let q = 0; q < 4; q++) {
    const yawStreet = Math.atan2(-OUT[q][0], -OUT[q][1]); // facing the street (inward)
    for (let j = 1; j <= 8; j++) {
      const a = LOT_BOUNDS[j];
      // Outer sidewalk lamp: arm over the token lane, two banners (one per neighbouring lot).
      const po = sideXZ(q, a, 135.3);
      lamps.push({ ...po, yaw: yawStreet, arm: 1.6 });
      const left = tileOfAlong(q, a + 1);
      const right = tileOfAlong(q, a - 1);
      for (const [side, tile] of [[1, left], [-1, right]]) {
        const pb = sideXZ(q, a + side * 0.48, 135.3 - 0.12);
        banners.push({ x: pb.x, z: pb.z, yaw: yawStreet, cell: bannerCell(tile) });
      }
      // Inner sidewalk lamp: arm over the cycle track.
      const pi = sideXZ(q, a, 121.2);
      lamps.push({ ...pi, yaw: yawStreet + Math.PI, arm: 1.0 });
    }
    // Street trees on the inner sidewalk every 13 m (offset from the lamps), clear of the corners.
    for (let a = 110.5; a >= -110.6; a -= 13) {
      const p = sideXZ(q, a, 118.4);
      if (nearApex(p.x, p.z) || Math.abs(a - 26) < 4) continue;
      trees.push({ x: p.x, z: p.z, kind: 0, scale: 0.95 + 0.1 * ((a * 7 + q) % 3) / 2, prio: 0 });
    }
    // Benches + bins on the park edge of the inner sidewalk.
    for (let j = 1; j <= 8; j += 1) {
      const a = LOT_BOUNDS[j] - 3.2;
      const p = sideXZ(q, a, 117.75);
      bench(furniture, p.x, p.z, yawStreet + Math.PI);
      const pb = sideXZ(q, a - 1.9, 117.6);
      bin(furniture, pb.x, pb.z);
    }
    // A bus shelter per side (inner sidewalk, facing the street) at along = 26.
    {
      const p = sideXZ(q, 26, 121.05);
      shelter(furniture, glow, p.x, p.z, yawStreet + Math.PI);
    }
    // Per lot: planters (south / west) or trees (north / east) on the outer sidewalk; totems.
    for (let k = 1; k <= 9; k++) {
      const tile = q * 10 + k;
      const centre = 130 - 26 * k;
      const f = facts[tile];
      const first = f.group && facts.findIndex((x) => x.group === f.group) === tile;
      if (first) {
        const p = sideXZ(q, centre + 9.5, 135.45);
        totems.push({ x: p.x, z: p.z, yaw: yawStreet, group: f.group, color: f.color });
      }
      for (const off of [-7.5, 7.5]) {
        if (first && off > 0) continue;
        const p = sideXZ(q, centre + off, 135.0);
        if (nearApex(p.x, p.z)) continue;
        if (q >= 2) trees.push({ x: p.x, z: p.z, kind: 0, scale: 0.9, prio: 0 });
        else planter(furniture, p.x, p.z, yawStreet);
      }
    }
  }
  for (const l of lamps) lamp(furniture, glow, l);
  for (const t of totems) totem(furniture, t);

  // -- the bay atlas and the street mesh --
  const atlas = bayAtlas(facts);
  const bayTex = new THREE.CanvasTexture(atlas);
  bayTex.colorSpace = THREE.SRGBColorSpace;
  bayTex.anisotropy = ctx.maxAniso ?? 8;
  bayTex.generateMipmaps = true;
  bayTex.minFilter = THREE.LinearMipmapLinearFilter;
  const glowU = {
    amount: { value: new Float32Array(40) },
    color: { value: Array.from({ length: 40 }, () => new THREE.Vector3(1, 1, 1)) },
  };
  const streetMat = streetMaterial(uniforms, bayTex, glowU);

  // -- banners + totem panels: one textured mesh --
  const signTex = signAtlas(facts);
  signTex.anisotropy = ctx.maxAniso ?? 8;
  const signs = signMesh(banners, totems, signTex);

  const route = routeRibbon();

  return { streetMat, bayTex, glowU, signs, route, atlas, lamps, totems };
}

// -- furniture pieces (merged into the furniture buffer) --

const C = (hex) => new THREE.Color(hex).toArray();
const PAINT = C('#2c3236');
const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const S = new THREE.Vector3(1, 1, 1);
const YAXIS = new THREE.Vector3(0, 1, 0);

function put(buf, geo, x, y, z, yaw, color) {
  Q.setFromAxisAngle(YAXIS, yaw);
  M4.compose(V.set(x, y, z), Q, S);
  buf.addGeometry(geo, M4, color);
}

/** Local offset (forward = +Z of the yawed frame) → world. */
function off(x, z, yaw, f, side = 0) {
  return { x: x + Math.sin(yaw) * f + Math.cos(yaw) * side, z: z + Math.cos(yaw) * f - Math.sin(yaw) * side };
}

function lamp(buf, glow, { x, z, yaw, arm }) {
  const H = 7.2;
  put(buf, new THREE.CylinderGeometry(0.075, 0.11, H, 6).translate(0, H / 2, 0), x, 0.15, z, 0, new THREE.Color().fromArray(PAINT));
  put(buf, new THREE.CylinderGeometry(0.16, 0.2, 0.6, 6).translate(0, 0.3, 0), x, 0.15, z, 0, new THREE.Color().fromArray(PAINT));
  // Arm toward the street (+Z of the yawed frame) and the head.
  const a = off(x, z, yaw, arm / 2);
  put(buf, new THREE.BoxGeometry(0.07, 0.07, arm), a.x, 0.15 + H - 0.15, a.z, yaw, new THREE.Color().fromArray(PAINT));
  const hpos = off(x, z, yaw, arm);
  put(buf, new THREE.BoxGeometry(0.32, 0.14, 0.62), hpos.x, 0.15 + H - 0.22, hpos.z, yaw, new THREE.Color().fromArray(PAINT));
  put(glow, new THREE.BoxGeometry(0.26, 0.05, 0.54), hpos.x, 0.15 + H - 0.31, hpos.z, yaw, new THREE.Color('#ffd9a0'));
  // Banner brackets.
  put(buf, new THREE.BoxGeometry(1.2, 0.04, 0.04), x, 0.15 + 5.25, z, yaw + Math.PI / 2, new THREE.Color().fromArray(PAINT));
}

function bench(buf, x, z, yaw) {
  const wood = new THREE.Color('#7a5236');
  const iron = new THREE.Color('#2b2b2b');
  const s = off(x, z, yaw, 0);
  put(buf, new THREE.BoxGeometry(1.8, 0.06, 0.45), s.x, 0.15 + 0.45, s.z, yaw, wood);
  const b = off(x, z, yaw, -0.22);
  put(buf, new THREE.BoxGeometry(1.8, 0.4, 0.05).rotateX(-0.15), b.x, 0.15 + 0.75, b.z, yaw, wood);
  for (const side of [-0.8, 0.8]) {
    const l = off(x, z, yaw, -0.02, side);
    put(buf, new THREE.BoxGeometry(0.06, 0.45, 0.45), l.x, 0.15 + 0.225, l.z, yaw, iron);
  }
}

function bin(buf, x, z) {
  put(buf, new THREE.CylinderGeometry(0.24, 0.22, 0.85, 8).translate(0, 0.425, 0), x, 0.15, z, 0, new THREE.Color('#2f4a3a'));
}

function planter(buf, x, z, yaw) {
  put(buf, new THREE.BoxGeometry(1.6, 0.6, 0.7).translate(0, 0.3, 0), x, 0.15, z, yaw, new THREE.Color('#8b8277'));
  for (const side of [-0.4, 0.4]) {
    const p = off(x, z, yaw, 0, side);
    put(buf, new THREE.IcosahedronGeometry(0.36, 0), p.x, 0.15 + 0.82, p.z, side, new THREE.Color(side > 0 ? '#4c7a3a' : '#5d8a44'));
  }
}

function shelter(buf, glow, x, z, yaw) {
  const frame = new THREE.Color('#3b4248');
  const glass = new THREE.Color('#5c7480');
  // Back wall (glass) toward the park, roof, side panels, a lit advert panel.
  const back = off(x, z, yaw, -0.75);
  put(buf, new THREE.BoxGeometry(4, 2.3, 0.05).translate(0, 1.15, 0), back.x, 0.15, back.z, yaw, glass);
  put(buf, new THREE.BoxGeometry(4.3, 0.12, 1.75).translate(0, 2.45, 0), x, 0.15, z, yaw, frame);
  for (const side of [-2, 2]) {
    const p = off(x, z, yaw, -0.05, side);
    put(buf, new THREE.BoxGeometry(0.05, 2.3, 1.4).translate(0, 1.15, 0), p.x, 0.15, p.z, yaw, side > 0 ? frame : glass);
    const post = off(x, z, yaw, 0.75, side);
    put(buf, new THREE.BoxGeometry(0.08, 2.4, 0.08).translate(0, 1.2, 0), post.x, 0.15, post.z, yaw, frame);
  }
  const ad = off(x, z, yaw, -0.7, 1.2);
  put(glow, new THREE.BoxGeometry(1.2, 1.7, 0.04).translate(0, 1.25, 0), ad.x, 0.15, ad.z, yaw, new THREE.Color('#bfe3ff'));
  const seat = off(x, z, yaw, -0.45, -0.6);
  put(buf, new THREE.BoxGeometry(2.2, 0.06, 0.35).translate(0, 0.48, 0), seat.x, 0.15, seat.z, yaw, new THREE.Color('#9aa3a8'));
}

function totem(buf, { x, z, yaw, color }) {
  // A 5 m pylon in the group colour; the name panels are on the sign mesh.
  put(buf, new THREE.BoxGeometry(1.9, 5, 0.42).translate(0, 2.5, 0), x, 0.15, z, yaw, new THREE.Color(color));
  put(buf, new THREE.BoxGeometry(2.1, 0.25, 0.6).translate(0, 0.125, 0), x, 0.15, z, yaw, new THREE.Color('#3a3f44'));
  put(buf, new THREE.BoxGeometry(2.0, 0.18, 0.5).translate(0, 5.09, 0), x, 0.15, z, yaw, new THREE.Color('#ffffff'));
}

// -- banners and totem panels (one atlas) --

const SIGN_W = 2048;
const SIGN_H = 1024;
const TOTEM_CELL = { w: 256, h: 640 };
const BANNER_CELL = { w: 128, h: 320, y: 660 };

function signAtlas(facts) {
  const cv = document.createElement('canvas');
  cv.width = SIGN_W;
  cv.height = SIGN_H;
  const g = cv.getContext('2d');
  const groups = Object.keys(HOODS);
  const colorOf = (grp) => facts.find((f) => f.group === grp)?.color ?? '#888';
  const font = (px) => `900 ${px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  groups.forEach((grp, k) => {
    const hood = HOODS[grp];
    const col = colorOf(grp);
    const light = luminance(col) > 0.42;
    const fg = light ? '#1a1a1a' : '#ffffff';
    // Totem panel: colour field, white frame, the name stacked, a small skyline emblem.
    const x0 = k * TOTEM_CELL.w;
    g.fillStyle = col;
    g.fillRect(x0, 0, TOTEM_CELL.w, TOTEM_CELL.h);
    g.strokeStyle = fg;
    g.lineWidth = 8;
    g.strokeRect(x0 + 14, 14, TOTEM_CELL.w - 28, TOTEM_CELL.h - 28);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = hood.lines;
    lines.forEach((line, n) => {
      g.font = font(56);
      const w = g.measureText(line).width;
      g.save();
      g.translate(x0 + TOTEM_CELL.w / 2, 150 + n * 72);
      const sc = Math.min(1, (TOTEM_CELL.w - 50) / w);
      g.scale(sc, 1);
      g.fillText(line, 0, 0);
      g.restore();
    });
    // Emblem: a little skyline.
    const by = 430;
    for (let b = 0; b < 5; b++) {
      const h = [40, 70, 55, 90, 50][(b + k) % 5];
      g.fillRect(x0 + 50 + b * 32, by + 100 - h, 26, h);
    }
    g.fillRect(x0 + 40, by + 100, TOTEM_CELL.w - 80, 8);
    // Banner: colour, white stripes, the name running down.
    const bx = k * BANNER_CELL.w;
    g.fillStyle = col;
    g.fillRect(bx, BANNER_CELL.y, BANNER_CELL.w, BANNER_CELL.h);
    g.fillStyle = fg;
    g.fillRect(bx + 10, BANNER_CELL.y + 12, BANNER_CELL.w - 20, 6);
    g.fillRect(bx + 10, BANNER_CELL.y + BANNER_CELL.h - 18, BANNER_CELL.w - 20, 6);
    g.save();
    g.translate(bx + BANNER_CELL.w / 2, BANNER_CELL.y + BANNER_CELL.h / 2);
    g.rotate(Math.PI / 2);
    g.font = font(40);
    const label = hood.name.toUpperCase();
    const w = g.measureText(label).width;
    g.scale(Math.min(1, (BANNER_CELL.h - 60) / w), 1);
    g.fillText(label, 0, 2);
    g.restore();
  });
  // Cell 8: the city's own banner.
  const bx = 8 * BANNER_CELL.w;
  g.fillStyle = '#26415f';
  g.fillRect(bx, BANNER_CELL.y, BANNER_CELL.w, BANNER_CELL.h);
  g.fillStyle = '#f2c94c';
  g.save();
  g.translate(bx + BANNER_CELL.w / 2, BANNER_CELL.y + BANNER_CELL.h / 2);
  g.rotate(Math.PI / 2);
  g.font = font(44);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('LOOP CITY', 0, 2);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function signMesh(banners, totems, tex) {
  const pos = [];
  const nor = [];
  const uv = [];
  const quad = (cx, cy, cz, yaw, w, h, u0, v0, u1, v1, dz = 0) => {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const fx = sn;
    const fz = cs; // forward (+Z of the yawed frame)
    const rx = cs;
    const rz = -sn; // right
    const P = (sx, sy) => [cx + rx * sx * (w / 2) + fx * dz, cy + sy * h, cz + rz * sx * (w / 2) + fz * dz];
    // Front face (normal +forward), counter-clockwise as seen by a viewer in front; u grows to
    // the viewer's right (the +right axis), so the text is not mirrored.
    const A = P(-1, 0);
    const B = P(1, 0);
    const Cc = P(1, 1);
    const D = P(-1, 1);
    const t = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = [A, B, Cc, D][k];
      pos.push(...p);
      nor.push(fx, 0, fz);
      uv.push(...t[k]);
    }
  };
  const tu = (x) => x / SIGN_W;
  const tv = (y) => 1 - y / SIGN_H;
  for (const b of banners) {
    const u0 = tu(b.cell * BANNER_CELL.w);
    const u1 = tu((b.cell + 1) * BANNER_CELL.w);
    quad(b.x, 0.15 + 3.55, b.z, b.yaw, 0.62, 1.55, u0, tv(BANNER_CELL.y + BANNER_CELL.h), u1, tv(BANNER_CELL.y));
    quad(b.x, 0.15 + 3.55, b.z, b.yaw + Math.PI, 0.62, 1.55, u0, tv(BANNER_CELL.y + BANNER_CELL.h), u1, tv(BANNER_CELL.y));
  }
  for (const t of totems) {
    const k = Object.keys(HOODS).indexOf(t.group);
    const u0 = tu(k * TOTEM_CELL.w);
    const u1 = tu((k + 1) * TOTEM_CELL.w);
    quad(t.x, 0.15 + 0.45, t.z, t.yaw, 1.7, 4.4, u0, tv(TOTEM_CELL.h), u1, tv(0), 0.215);
    quad(t.x, 0.15 + 0.45, t.z, t.yaw + Math.PI, 1.7, 4.4, u0, tv(TOTEM_CELL.h), u1, tv(0), 0.215);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ name: 'signs', map: tex, roughness: 0.75, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'signs';
  return mesh;
}

/** Keeps a bay index in 0..39. */
export const bayIndex = (i) => wrap(i);
export { sOf, lanePoint, sideXZ, nearApex };
