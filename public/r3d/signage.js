// public/r3d/signage.js — every painted word and emblem of Loop City's lots, drawn once into canvases (lane B).
//
//   * The SIGN ATLAS (2048²): one "name cell" per tile (group band + number + street name), a glyph strip
//     ($ 0–9 ×), short words (PRICE, RENT, FOR SALE, MORTGAGED, SOLD, BANK OWNED, …), the four station
//     "FOR SALE — RESTORATION" billboards (a painting of the restored building) and landmark lettering.
//     The address posts, for-sale hoardings and auction boards are COMPOSED in the sign shader from these cells
//     plus per-instance numbers (lot-kit.js signMaterial), so prices, rents, owner plates and house pips change
//     without any texture upload.
//   * The TOKEN SILHOUETTE ATLAS (512 × 64): car, dog, top hat, ship, boot, cat, thimble, wheelbarrow — our own
//     procedural shapes (never emoji in WebGL).
//   * The AUCTION BOARD (512 × 256): the only canvas re-uploaded during play (one redraw per bid).
//
// Canvases are drawn once per page (module cache); textures are made per renderer by lot-kit.js.

export const SIGN_SIZE = 2048;
export const TOKENS = ['car', 'dog', 'hat', 'ship', 'boot', 'cat', 'thimble', 'wheelbarrow'];
export const SIL_W = 512;
export const SIL_H = 64;

const NAME_W = 384;
const NAME_H = 132;
const NAME_COLS = 5;
const GLYPH = 64; // glyph cell (square)
export const GLYPHS = '$0123456789×';
const WORD_W = 256;
const WORD_H = 64;
const BILL_W = 512;
const BILL_H = 256;
const LETTER_W = 512;
const LETTER_H = 64;

/** Short words (index = WORDS.indexOf(word)). */
export const WORDS = ['PRICE', 'RENT', 'FOR SALE', 'MORTGAGED', 'SOLD', 'BANK OWNED', 'FORECLOSED', 'DICE ×4', 'DICE ×10', 'HOTEL', 'PAY', 'AUCTION', 'NO SALE', 'RESTORATION', 'CLOSED', 'OPEN', 'TICKETS', 'EXIT', 'ENTRY', 'STOP', 'BID', 'JUST VISITING', 'TAX', 'GO', '?', 'STATIONS'];
/** Landmark lettering (index = LETTERS.indexOf(text)). */
export const LETTERS = [
  'CITY BANK', 'CENTRAL POLICE', 'FREE PARKING', 'CHECKPOINT', 'PRECINCT 30', 'COMMUNITY HALL', 'FORTUNE KIOSK',
  'CITY REVENUE OFFICE', 'THE JEWELLER', 'ELECTRIC COMPANY', 'WATER WORKS', '+$200',
  'THE RAILWAY ARMS', 'OLD TOWN INN', 'THE EMPORIUM', 'ROTUNDA GRAND', 'MARQUEE TOWER', 'THE HELIX', 'EXCHANGE TOWER', 'HARBOUR SPIRE',
  'READING TERMINUS', 'PENNSYLVANIA HALL', 'B. & O. CENTRAL', 'SHORT LINE METRO', 'OBSERVATION WHEEL', 'SALARY DAY',
];

// Layout (pixels, origin top-left of the canvas).
const Y_NAMES = 0; // 8 rows × 132 = 1056
const Y_GLYPHS = 1056; // 1 row of 16 glyph cells (x 0..1024)
const Y_WORDS = 1056; // word cells: x 1024..2048 (4 per row) and x 0..1024 below the glyphs (4 per row)
const Y_BILLS = 1312; // 4 billboards 512 × 256 (x 0..1024, two rows)
const Y_LETTERS = 1312; // lettering 512 × 64 (x 1024..2048, 2 per row; continues at x 0..1024 below the billboards)

const TYPE_BAND = { railroad: '#3b4650', utility: '#d39a2a', chance: '#2f8f5b', community: '#2e6fb5', tax: '#6d747a', go: '#2b2b2b', jail: '#e0b52f', free_parking: '#2e6fb5', go_to_jail: '#c0392b' };
const NEIGHBOURHOOD = { brown: 'BRICKWORKS ROW', lightblue: 'OLD TOWN', pink: 'MARKET LANES', orange: 'MIDTOWN', red: 'THEATRE ROW', yellow: 'DOWNTOWN', green: 'BANK QUARTER', darkblue: 'HARBOUR HEIGHTS' };
const FONT = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

// ---- rect lookups (uv rects: [u0, v0, u1, v1] with v up, as three samples a flipY CanvasTexture) ----

const uvRect = (x, y, w, h, size = SIGN_SIZE) => [x / size, 1 - (y + h) / size, (x + w) / size, 1 - y / size];
export function nameRect(tile) {
  const t = Math.max(0, Math.min(39, tile | 0));
  return uvRect((t % NAME_COLS) * NAME_W, Y_NAMES + Math.floor(t / NAME_COLS) * NAME_H, NAME_W, NAME_H);
}
export function glyphRect(k) {
  return uvRect(k * GLYPH, Y_GLYPHS, GLYPH, GLYPH);
}
export function wordRect(word) {
  const k = typeof word === 'number' ? word : WORDS.indexOf(word);
  if (k < 0) return [0, 0, 0, 0];
  if (k < 16) return uvRect(1024 + (k % 4) * WORD_W, Y_WORDS + Math.floor(k / 4) * WORD_H, WORD_W, WORD_H);
  const j = k - 16;
  return uvRect((j % 4) * WORD_W, Y_GLYPHS + GLYPH + Math.floor(j / 4) * WORD_H, WORD_W, WORD_H);
}
export function billboardRect(tile) {
  const k = [5, 15, 25, 35].indexOf(tile);
  if (k < 0) return [0, 0, 0, 0];
  return uvRect((k % 2) * BILL_W, Y_BILLS + Math.floor(k / 2) * BILL_H, BILL_W, BILL_H);
}
export function letterRect(text) {
  const k = LETTERS.indexOf(text);
  if (k < 0) return [0, 0, 0, 0];
  if (k < 22) return uvRect(1024 + (k % 2) * LETTER_W, Y_LETTERS + Math.floor(k / 2) * LETTER_H, LETTER_W, LETTER_H);
  const j = k - 22;
  return uvRect((j % 2) * LETTER_W, Y_BILLS + 2 * BILL_H + Math.floor(j / 2) * LETTER_H, LETTER_W, LETTER_H);
}
/** Glyph-strip geometry for the shader: [u0 of glyph 0, v0, glyph width in u, height in v]. */
export function glyphStrip() {
  const r = glyphRect(0);
  return [r[0], r[1], GLYPH / SIGN_SIZE, GLYPH / SIGN_SIZE];
}
export const silIndex = (tokenId) => TOKENS.indexOf(tokenId);

// ---- drawing --------------------------------------------------------------------------------------

function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

/** Draws `text` centred in a box, shrinking the font until it fits. */
function fitText(g, text, cx, cy, maxW, size, { weight = 700, family = FONT, color = '#1f2328', min = 10 } = {}) {
  let s = size;
  for (; s > min; s -= 2) {
    g.font = `${weight} ${s}px ${family}`;
    if (g.measureText(text).width <= maxW) break;
  }
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy);
  return s;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Splits a long street name over two lines at a space near the middle. */
function splitName(name) {
  if (name.length <= 15) return [name];
  const mid = name.length / 2;
  let best = -1;
  for (let k = 0; k < name.length; k++) if (name[k] === ' ' && (best < 0 || Math.abs(k - mid) < Math.abs(best - mid))) best = k;
  return best < 0 ? [name] : [name.slice(0, best), name.slice(best + 1)];
}

function drawNameCell(g, x, y, tile, board) {
  const t = board?.tiles?.[tile] ?? { name: `Lot ${tile}`, type: 'property' };
  const band = t.type === 'property' ? board?.groups?.[t.group]?.color ?? '#888888' : TYPE_BAND[t.type] ?? '#666666';
  g.save();
  g.translate(x, y);
  g.fillStyle = '#fbfaf6';
  g.fillRect(0, 0, NAME_W, NAME_H);
  g.fillStyle = band;
  g.fillRect(0, 0, NAME_W, 46);
  // A darker underline so pale bands (yellow, light blue) still read.
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, 44, NAME_W, 3);
  const light = luminance(band) > 0.62;
  const ink = light ? '#1d1f22' : '#ffffff';
  g.font = `800 30px ${FONT}`;
  g.fillStyle = ink;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(`No. ${tile}`, 12, 24);
  const kind = t.type === 'property' ? NEIGHBOURHOOD[t.group] ?? '' : { railroad: 'CIRCLE LINE', utility: 'UTILITY', chance: 'FORTUNE', community: 'COMMUNITY', tax: 'TAX' }[t.type] ?? '';
  g.textAlign = 'right';
  fitRight(g, kind, NAME_W - 12, 24, 230, 22, ink);
  const lines = splitName(String(t.name ?? ''));
  if (lines.length === 1) fitText(g, lines[0], NAME_W / 2, 90, NAME_W - 24, 40);
  else {
    fitText(g, lines[0], NAME_W / 2, 70, NAME_W - 24, 32);
    fitText(g, lines[1], NAME_W / 2, 108, NAME_W - 24, 32);
  }
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, NAME_W - 3, NAME_H - 3);
  g.restore();
}

function fitRight(g, text, xr, cy, maxW, size, color) {
  let s = size;
  for (; s > 10; s -= 1) {
    g.font = `700 ${s}px ${FONT}`;
    if (g.measureText(text).width <= maxW) break;
  }
  g.fillStyle = color;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillText(text, xr, cy);
}

function luminance(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  const r = (n >> 16) & 255;
  const gg = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
}

function drawGlyphs(g) {
  for (let k = 0; k < 16; k++) {
    const x = k * GLYPH;
    g.fillStyle = '#fbfaf6';
    g.fillRect(x, Y_GLYPHS, GLYPH, GLYPH);
    if (k < GLYPHS.length) fitText(g, GLYPHS[k], x + GLYPH / 2, Y_GLYPHS + GLYPH / 2 + 2, GLYPH - 6, 54, { weight: 800 });
  }
}

const WORD_STYLE = {
  PRICE: ['#fbfaf6', '#5a6168'], RENT: ['#fbfaf6', '#5a6168'], 'FOR SALE': ['#d62b2b', '#ffffff'], MORTGAGED: ['#fbfaf6', '#c0262d'],
  SOLD: ['#d62b2b', '#ffffff'], 'BANK OWNED': ['#c0262d', '#ffffff'], FORECLOSED: ['#1f2328', '#ffd34d'], 'DICE ×4': ['#fbfaf6', '#1f2328'],
  'DICE ×10': ['#fbfaf6', '#1f2328'], HOTEL: ['#c0262d', '#ffffff'], PAY: ['#fbfaf6', '#1f2328'], AUCTION: ['#1f2328', '#ffd34d'],
  'NO SALE': ['#1f2328', '#ffffff'], RESTORATION: ['#1f5a8a', '#ffffff'], STOP: ['#c0262d', '#ffffff'], TICKETS: ['#2e6fb5', '#ffffff'],
  'JUST VISITING': ['#e0b52f', '#1f2328'], GO: ['#1f2328', '#ffd34d'], '?': ['#1c6b46', '#ffe066'], STATIONS: ['#fbfaf6', '#3b4650'],
};
function drawWords(g) {
  WORDS.forEach((w, k) => {
    const [u0, v1, u1, v0] = wordRect(k);
    const x = Math.round(u0 * SIGN_SIZE);
    const y = Math.round((1 - v0) * SIGN_SIZE);
    const [bg, fg] = WORD_STYLE[w] ?? ['#fbfaf6', '#1f2328'];
    g.fillStyle = bg;
    g.fillRect(x, y, WORD_W, WORD_H);
    fitText(g, w, x + WORD_W / 2, y + WORD_H / 2 + 2, WORD_W - 16, 44, { weight: 800, color: fg });
    void u1;
    void v1;
  });
}

function drawLetters(g) {
  LETTERS.forEach((text, k) => {
    const [u0, , , v0] = letterRect(text);
    const x = Math.round(u0 * SIGN_SIZE);
    const y = Math.round((1 - v0) * SIGN_SIZE);
    const gold = /BANK|REVENUE|JEWELLER|EXCHANGE|ROTUNDA|SPIRE|\+\$|SALARY/.test(text);
    g.fillStyle = gold ? '#1f2a36' : '#f6f1e6';
    g.fillRect(x, y, LETTER_W, LETTER_H);
    const serif = /BANK|REVENUE|ROTUNDA|EXCHANGE|ARMS|INN|EMPORIUM|PENNSYLVANIA|READING|JEWELLER/.test(text);
    fitText(g, text, x + LETTER_W / 2, y + LETTER_H / 2 + 2, LETTER_W - 24, 46, { weight: 800, family: serif ? SERIF : FONT, color: gold ? '#e9c46a' : '#1f2328' });
  });
}

/** The four "FOR SALE — RESTORATION" billboards: a painting of the restored station over a sky. */
function drawBillboards(g, board) {
  [5, 15, 25, 35].forEach((tile, k) => {
    const x = (k % 2) * BILL_W;
    const y = Y_BILLS + Math.floor(k / 2) * BILL_H;
    g.save();
    g.translate(x, y);
    const sky = g.createLinearGradient(0, 0, 0, BILL_H);
    sky.addColorStop(0, '#7fb6e6');
    sky.addColorStop(0.7, '#f3d9b1');
    sky.addColorStop(1, '#e9c99a');
    g.fillStyle = sky;
    g.fillRect(0, 0, BILL_W, BILL_H);
    g.fillStyle = '#8fae6e';
    g.fillRect(0, BILL_H - 50, BILL_W, 50);
    paintStation(g, k);
    // Frame, the name and the red strap.
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillRect(0, BILL_H - 46, BILL_W, 46);
    const name = board?.tiles?.[tile]?.name ?? ['Reading Railroad', 'Pennsylvania Railroad', 'B. & O. Railroad', 'Short Line'][k];
    fitText(g, `${name} — FOR SALE`, BILL_W / 2 - 40, BILL_H - 23, BILL_W - 120, 30, { weight: 800 });
    g.save();
    g.translate(BILL_W - 70, 52);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#d62b2b';
    g.fillRect(-120, -18, 240, 36);
    fitText(g, 'RESTORATION', 0, 2, 200, 22, { weight: 800, color: '#ffffff' });
    g.restore();
    g.strokeStyle = '#2b2f33';
    g.lineWidth = 8;
    g.strokeRect(4, 4, BILL_W - 8, BILL_H - 8);
    g.restore();
  });
}

function paintStation(g, k) {
  const base = 206;
  g.save();
  if (k === 0) {
    // Victorian terminus: brick hall, arched windows, clock tower.
    g.fillStyle = '#a8452f';
    g.fillRect(150, 110, 260, base - 110);
    g.fillRect(90, 40, 56, base - 40);
    g.fillStyle = '#4d535a';
    g.beginPath();
    g.moveTo(140, 112);
    g.lineTo(280, 70);
    g.lineTo(420, 112);
    g.fill();
    g.beginPath();
    g.moveTo(84, 44);
    g.lineTo(118, 10);
    g.lineTo(152, 44);
    g.fill();
    g.fillStyle = '#f5efe2';
    g.beginPath();
    g.arc(118, 64, 16, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#2b2f33';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(118, 64);
    g.lineTo(118, 53);
    g.moveTo(118, 64);
    g.lineTo(126, 66);
    g.stroke();
    g.fillStyle = '#f3d27a';
    for (let i = 0; i < 6; i++) archWindow(g, 166 + i * 40, 130, 22, 50);
  } else if (k === 1) {
    // Beaux-Arts hall with a columned portico.
    g.fillStyle = '#e9e0cf';
    g.fillRect(100, 92, 320, base - 92);
    g.fillStyle = '#d5c9b0';
    g.beginPath();
    g.moveTo(150, 96);
    g.lineTo(260, 52);
    g.lineTo(370, 96);
    g.fill();
    g.fillStyle = '#f7f2e6';
    for (let i = 0; i < 8; i++) g.fillRect(160 + i * 28, 100, 12, base - 100);
    g.fillStyle = '#8b9a97';
    g.fillRect(200, 30, 120, 24);
  } else if (k === 2) {
    // Art-deco station with a vertical fin.
    g.fillStyle = '#d9cdb2';
    g.fillRect(110, 110, 300, base - 110);
    g.fillRect(230, 40, 60, 80);
    g.fillStyle = '#b68a3e';
    g.fillRect(250, 20, 20, 100);
    g.fillStyle = '#36516a';
    for (let i = 0; i < 9; i++) g.fillRect(124 + i * 32, 130, 14, 60);
  } else {
    // Glass metro pavilion.
    g.fillStyle = 'rgba(160,210,230,0.95)';
    g.fillRect(120, 120, 280, base - 120);
    g.fillStyle = '#3d4a52';
    g.fillRect(100, 108, 320, 14);
    for (let i = 0; i <= 10; i++) g.fillRect(120 + i * 28, 122, 3, base - 122);
    g.fillStyle = '#2e6fb5';
    g.beginPath();
    g.arc(260, 84, 22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = `800 26px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('M', 260, 86);
  }
  g.restore();
}

function archWindow(g, x, y, w, h) {
  g.beginPath();
  g.moveTo(x, y + h);
  g.lineTo(x, y + w / 2);
  g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
  g.lineTo(x + w, y + h);
  g.closePath();
  g.fill();
}

let signCache = null;
/** The 2048² sign atlas canvas (cached; null without a DOM). */
export function signAtlas(board) {
  if (signCache) return signCache;
  const cv = makeCanvas(SIGN_SIZE, SIGN_SIZE);
  if (!cv) return null;
  const g = cv.getContext('2d');
  g.fillStyle = '#fbfaf6';
  g.fillRect(0, 0, SIGN_SIZE, SIGN_SIZE);
  for (let t = 0; t < 40; t++) drawNameCell(g, (t % NAME_COLS) * NAME_W, Y_NAMES + Math.floor(t / NAME_COLS) * NAME_H, t, board);
  drawGlyphs(g);
  drawWords(g);
  drawBillboards(g, board);
  drawLetters(g);
  signCache = cv;
  return cv;
}

// ---- token silhouettes ------------------------------------------------------------------------------

const SIL_DRAW = {
  car(g) {
    g.beginPath();
    g.moveTo(4, 44);
    g.lineTo(6, 34);
    g.quadraticCurveTo(10, 28, 20, 28);
    g.lineTo(26, 18);
    g.quadraticCurveTo(30, 15, 38, 16);
    g.lineTo(44, 27);
    g.quadraticCurveTo(58, 28, 60, 36);
    g.lineTo(60, 44);
    g.closePath();
    g.fill();
    wheel(g, 17, 46, 8);
    wheel(g, 49, 46, 8);
  },
  dog(g) {
    // Scottie: block body, square head with a beard, pointed ears, short legs, upright tail.
    g.beginPath();
    g.rect(14, 26, 34, 16);
    g.rect(14, 40, 6, 12);
    g.rect(40, 40, 6, 12);
    g.rect(26, 40, 5, 9);
    g.fill();
    g.beginPath();
    g.moveTo(44, 30);
    g.lineTo(46, 14);
    g.lineTo(50, 20);
    g.lineTo(54, 14);
    g.lineTo(56, 22);
    g.lineTo(62, 26);
    g.lineTo(60, 34);
    g.lineTo(52, 40);
    g.lineTo(46, 38);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(14, 28);
    g.lineTo(8, 12);
    g.lineTo(13, 13);
    g.lineTo(18, 27);
    g.closePath();
    g.fill();
  },
  hat(g) {
    g.beginPath();
    g.rect(18, 10, 28, 34);
    g.fill();
    g.beginPath();
    g.ellipse(32, 46, 28, 7, 0, 0, Math.PI * 2);
    g.fill();
    g.clearRect(18, 34, 28, 4);
  },
  ship(g) {
    g.beginPath();
    g.moveTo(4, 38);
    g.lineTo(60, 38);
    g.lineTo(52, 52);
    g.lineTo(12, 52);
    g.closePath();
    g.fill();
    g.fillRect(16, 28, 30, 10);
    g.fillRect(36, 14, 8, 15);
    g.fillRect(22, 8, 2, 20);
    g.beginPath();
    g.moveTo(24, 8);
    g.lineTo(34, 12);
    g.lineTo(24, 16);
    g.fill();
  },
  boot(g) {
    g.beginPath();
    g.moveTo(18, 6);
    g.lineTo(36, 6);
    g.lineTo(36, 34);
    g.quadraticCurveTo(58, 36, 60, 48);
    g.lineTo(60, 54);
    g.lineTo(12, 54);
    g.lineTo(12, 46);
    g.lineTo(16, 44);
    g.closePath();
    g.fill();
    g.clearRect(20, 12, 12, 2);
    g.clearRect(20, 18, 12, 2);
    g.clearRect(20, 24, 12, 2);
  },
  cat(g) {
    g.beginPath();
    g.ellipse(30, 42, 15, 14, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(30, 22, 10, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(21, 18);
    g.lineTo(22, 6);
    g.lineTo(29, 13);
    g.closePath();
    g.moveTo(39, 18);
    g.lineTo(38, 6);
    g.lineTo(31, 13);
    g.closePath();
    g.fill();
    g.lineWidth = 5;
    g.lineCap = 'round';
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.moveTo(44, 50);
    g.quadraticCurveTo(60, 50, 56, 32);
    g.stroke();
  },
  thimble(g) {
    g.beginPath();
    g.moveTo(14, 54);
    g.lineTo(18, 22);
    g.quadraticCurveTo(32, 2, 46, 22);
    g.lineTo(50, 54);
    g.closePath();
    g.fill();
    g.fillRect(10, 48, 44, 8);
    g.globalCompositeOperation = 'destination-out';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3 + r; c++) {
      g.beginPath();
      g.arc(24 + c * 6 - r * 3, 22 + r * 8, 1.8, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  },
  wheelbarrow(g) {
    g.beginPath();
    g.moveTo(8, 22);
    g.lineTo(44, 22);
    g.lineTo(38, 40);
    g.lineTo(16, 40);
    g.closePath();
    g.fill();
    wheel(g, 14, 48, 8);
    g.lineWidth = 4;
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.moveTo(14, 40);
    g.lineTo(60, 30);
    g.moveTo(36, 40);
    g.lineTo(40, 54);
    g.stroke();
  },
};

function wheel(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

let silCache = null;
/** The 512 × 64 token silhouette atlas (white on transparent; cell k = TOKENS[k]). */
export function silhouetteAtlas() {
  if (silCache) return silCache;
  const cv = makeCanvas(SIL_W, SIL_H);
  if (!cv) return null;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, SIL_W, SIL_H);
  TOKENS.forEach((id, k) => {
    g.save();
    g.translate(k * 64, 0);
    g.beginPath();
    g.rect(0, 0, 64, 64);
    g.clip();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    SIL_DRAW[id](g);
    g.restore();
  });
  silCache = cv;
  return cv;
}

// ---- the auction board ------------------------------------------------------------------------------

/** A fresh 512 × 256 auction-board canvas (one per view; redrawn per bid). */
export function auctionCanvas() {
  return makeCanvas(512, 256);
}

/**
 * Draws the LED auction board: "AUCTION", the lot name, the leading bid in the leader's colour and an
 * optional flip progress (0..1: the digits roll over like a split-flap).
 */
export function drawAuction(cv, { name = '', bid = 0, color = '#ffd34d', leader = '', flip = 1 } = {}) {
  if (!cv) return;
  const g = cv.getContext('2d');
  g.fillStyle = '#0c0f12';
  g.fillRect(0, 0, 512, 256);
  // LED dot grid.
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 4; y < 256; y += 8) for (let x = 4; x < 512; x += 8) g.fillRect(x, y, 3, 3);
  fitText(g, 'AUCTION', 256, 34, 480, 40, { weight: 900, color: '#ffd34d' });
  fitText(g, String(name).toUpperCase(), 256, 78, 480, 30, { weight: 700, color: '#e8eef2' });
  const text = `$${Math.max(0, Math.round(Number(bid) || 0))}`;
  g.save();
  const f = Math.max(0, Math.min(1, flip));
  g.translate(256, 156);
  g.scale(1, f < 1 ? Math.max(0.05, Math.abs(Math.cos(f * Math.PI))) : 1);
  fitText(g, text, 0, 0, 470, 96, { weight: 900, color });
  g.restore();
  if (leader) fitText(g, String(leader), 256, 226, 470, 28, { weight: 700, color });
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 250);
}

/** Exposed for tests / harnesses. */
export const SIGN_LAYOUT = Object.freeze({ NAME_W, NAME_H, NAME_COLS, GLYPH, WORD_W, WORD_H, BILL_W, BILL_H, LETTER_W, LETTER_H, Y_GLYPHS, Y_BILLS, Y_LETTERS });
