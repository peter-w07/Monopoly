// public/r3d/cards.js — a drawn Chance / Community Chest card hops off its pile, flips over with a
// little twirl as it flies up, lands in front of the camera with a settle wobble (text facing the
// player), floats there for a moment, then flicks away. The overlay shows the same text as a
// caption (overlay.showCard), which stays readable a little longer.
//
// Also the card artwork shared with fx.js: rounded card geometry and title-deed textures (trades).

import * as THREE from './three.js';
import { COLORS } from './board-texture.js';
import { ease } from './tween.js';

const HOP = 0.14; // lift off the pile
const FLY_IN = 0.46; // pile → in front of the camera (flip + twirl)
const SETTLE = 0.16; // arrival wobble
const FLY_OUT = 0.32;
const VIEW_DIST = 3; // how far in front of the camera the card hangs
const VIEW_FRACTION = 0.46; // of the view width (0.66 on narrow canvases)
const VIEW_UP = 0.2; // raised by this much of the view height, clear of the tile in focus below
const TEX_W = 768;
const TEX_H = 485;
const FONT = 'system-ui, "Segoe UI", Roboto, Arial, sans-serif';

export class CardFlight {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./tween.js').Animator} animator
   * @param {object} board createBoard(...) (deckPose)
   * @param {{w:number,h:number}} size live canvas size
   * @param {{sfx?: object}} [opts]
   */
  constructor(scene, camera, animator, board, size, { sfx = null } = {}) {
    this.camera = camera;
    this.animator = animator;
    this.board = board;
    this.size = size;
    this.sfx = sfx;
    this.root = new THREE.Group();
    this.root.name = 'flying-card';
    this.root.visible = false;
    this.root.renderOrder = 20;
    const mat = () => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthTest: false, depthWrite: false });
    const geo = cardGeometry(1, TEX_H / TEX_W, 0.05);
    this.front = new THREE.Mesh(geo, mat());
    this.back = new THREE.Mesh(geo.clone().rotateY(Math.PI), mat());
    this.front.renderOrder = this.back.renderOrder = 20;
    this.root.add(this.front, this.back);
    scene.add(this.root);
    this.backs = { chance: backTexture('chance'), community: backTexture('community') };
    this.flights = 0;
    this.current = 0;
    this.tmp = {
      q: new THREE.Quaternion(), q2: new THREE.Quaternion(), p: new THREE.Vector3(),
      fwd: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(),
      view: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1, up: new THREE.Vector3(), right: new THREE.Vector3() },
      axis: new THREE.Vector3(),
    };
  }

  /** Plays cardDraw / cardFlip through `sfx` (sfx.js API) — off unless set. */
  setSfx(sfx) {
    this.sfx = sfx ?? null;
  }

  /**
   * Schedules the flight `delay` seconds from now; the card faces the camera for `hold` seconds.
   * @param {{deck:'chance'|'community', text:string, who?:string}} card
   * @param {number} delay
   * @param {number} hold   seconds in front of the camera (not scaled by speed)
   * @param {{speed?:number, onDraw?:Function, onFlip?:Function, onGone?:Function, sfx?:object, silent?:boolean}} [opts]
   *   onDraw at lift-off (0 s) · onFlip as its face turns to the camera (~0.35 s) · onGone({ skipped })
   * @returns {number} seconds until it is gone
   */
  schedule({ deck, text, who }, delay = 0, hold = 1.3, opts = {}) {
    const community = deck === 'community';
    const speed = opts.speed > 0 ? opts.speed : 1;
    const hop = HOP / speed;
    const fly = FLY_IN / speed;
    const settle = SETTLE / speed;
    const out = FLY_OUT / speed;
    const total = hop + fly + settle + hold + out;
    let tex = null;
    let from = null;
    const start = new THREE.Quaternion();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // back side up
    const id = ++this.flights; // a later card takes the stage from an earlier one
    let flipped = false;
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        this.current = id;
        tex = frontTexture(community ? 'community' : 'chance', text, who);
        this.front.material.map?.dispose?.();
        this.front.material.map = tex;
        this.back.material.map = this.backs[community ? 'community' : 'chance'];
        this.front.material.needsUpdate = this.back.material.needsUpdate = true;
        const pose = this.board.deckPose(community ? 'community' : 'chance');
        from = { pos: pose.position.clone().setY(pose.position.y + 0.02), w: pose.w, h: pose.h };
        start.copy(pose.quaternion).multiply(flat);
        this.root.visible = true;
        flipped = false;
        this.fire(opts, opts.onDraw, 'cardDraw');
      },
      update: (p) => {
        if (this.current !== id || !from) return;
        const t = p * total;
        const { q, q2, p: pos, axis } = this.tmp;
        const view = this.viewPose(from.w);
        let s = view.scale;
        let alpha = 1;
        if (t < hop) {
          // Hop off the pile (still face down), tilting up.
          const k = ease.outQuad(t / hop);
          pos.copy(from.pos);
          pos.y += 0.35 * k;
          q.copy(start);
          s = 1;
        } else if (t < hop + fly) {
          // Fly to the camera, flipping over and twirling once about the view axis.
          const k = (t - hop) / fly;
          const e = ease.outCubic(k);
          pos.copy(from.pos).setY(from.pos.y + 0.35);
          pos.lerp(view.pos, e);
          pos.addScaledVector(view.up, Math.sin(Math.PI * e) * 0.5);
          q.slerpQuaternions(start, view.quat, e);
          axis.set(0, 0, 1).applyQuaternion(view.quat);
          q.premultiply(q2.setFromAxisAngle(axis, 0.9 * Math.sin(Math.PI * e)));
          s = 1 + (view.scale - 1) * e;
          if (!flipped && k > 0.42) {
            flipped = true;
            this.fire(opts, opts.onFlip, 'cardFlip');
          }
        } else if (t < hop + fly + settle + hold) {
          // Arrive with a wobble, then float gently.
          const u = t - hop - fly;
          pos.copy(view.pos);
          q.copy(view.quat);
          const wob = u < settle ? Math.sin(Math.PI * (u / settle)) * (1 - u / settle) : 0;
          s = view.scale * (1 + 0.06 * wob);
          pos.addScaledVector(view.up, 0.02 * Math.sin(u * 2.4));
          axis.set(0, 0, 1).applyQuaternion(view.quat);
          q.premultiply(q2.setFromAxisAngle(axis, 0.012 * Math.sin(u * 1.7) - 0.05 * wob));
        } else {
          // Flick away: up and to the side, spinning, fading.
          const k = ease.inQuad((t - (total - out)) / out);
          pos.copy(view.pos).addScaledVector(view.up, 0.9 * k).addScaledVector(view.right, 1.4 * k);
          axis.set(0, 0, 1).applyQuaternion(view.quat);
          q.copy(view.quat).premultiply(q2.setFromAxisAngle(axis, -1.2 * k));
          s = view.scale * (1 - 0.35 * k);
          alpha = 1 - k;
        }
        this.root.position.copy(pos);
        this.root.quaternion.copy(q);
        this.root.scale.set(from.w * s, from.w * s, 1);
        this.front.material.opacity = this.back.material.opacity = alpha;
      },
      end: () => {
        const skipped = this.animator.finishing;
        if (this.current === id) {
          this.root.visible = false;
          this.front.material.map = null;
          this.front.material.needsUpdate = true;
        }
        tex?.dispose();
        tex = null;
        try {
          opts.onGone?.({ skipped });
        } catch (err) {
          console.error('[renderer3d] card callback failed:', err);
        }
      },
    });
    return total;
  }

  /** Where the card hangs right now: in front of the live camera, facing it (no allocation). */
  viewPose(cardW) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const v = this.tmp.view;
    const fwd = this.tmp.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    v.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    v.right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const vh = 2 * VIEW_DIST * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const vw = vh * (cam.aspect || 1);
    const narrow = (this.size?.w ?? 800) < 500;
    v.scale = ((narrow ? 0.66 : VIEW_FRACTION) * vw) / cardW;
    v.pos.copy(cam.position).addScaledVector(fwd, VIEW_DIST).addScaledVector(v.up, vh * VIEW_UP);
    v.quat.copy(cam.quaternion);
    return v;
  }

  hide() {
    this.root.visible = false;
  }

  fire(opts, fn, snd) {
    if (this.animator.finishing) return;
    if (snd && !opts.silent) {
      try {
        (opts.sfx ?? this.sfx)?.play?.(snd, {});
      } catch { /* sound must never break the board */ }
    }
    try {
      fn?.();
    } catch (err) {
      console.error('[renderer3d] card callback failed:', err);
    }
  }

  dispose() {
    this.front.material.map?.dispose?.();
    for (const t of Object.values(this.backs)) t.dispose();
  }
}

// ---- shared card artwork --------------------------------------------------------------------------

/** A card-shaped plane (w × h, facing +Z) with rounded corners; UVs span its bounding box. */
export function cardGeometry(w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geo = new THREE.ShapeGeometry(s, 4);
  const p = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  return geo;
}

/**
 * A title-deed card texture (256 × 320, sRGB) for fx.deeds():
 *   street    white card, colour-group band with "TITLE DEED" and the name, a faint rent table
 *   railroad  black band with a locomotive          utility  grey band with a bulb or a tap
 *   cash      a banknote with the amount            jail     "Get Out of Jail Free"
 * @param {{name?:string, color?:string, kind?:string, amount?:number}} card
 */
export function deedTexture({ name = '', color = '#888888', kind = 'street', amount = 0 } = {}) {
  const W = 256;
  const H = 320;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  roundRect(g, 2, 2, W - 4, H - 4, 16);
  g.save();
  g.clip();
  if (kind === 'cash') {
    g.fillStyle = '#cfe8c4';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#3f7a44';
    g.lineWidth = 10;
    g.strokeRect(12, 12, W - 24, H - 24);
    g.fillStyle = '#2f6a36';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 40px ${FONT}`;
    g.fillText('CASH', W / 2, 70);
    fitText(g, `$${Math.abs(Math.round(Number(amount) || 0))}`, W / 2, H / 2 + 20, W - 50, 96, 900);
  } else if (kind === 'jail') {
    g.fillStyle = '#fff4e2';
    g.fillRect(0, 0, W, H);
    g.fillStyle = COLORS.chance;
    g.fillRect(0, 0, W, 64);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 26px ${FONT}`;
    g.fillText('GET OUT OF', W / 2, 32);
    g.fillStyle = '#2b1d08';
    g.font = `900 42px ${FONT}`;
    g.fillText('JAIL', W / 2, 150);
    g.fillText('FREE', W / 2, 200);
  } else {
    g.fillStyle = '#fbfaf5';
    g.fillRect(0, 0, W, H);
    const band = kind === 'railroad' ? '#1d1d1d' : kind === 'utility' ? '#7d8a86' : color;
    g.fillStyle = band;
    g.fillRect(14, 14, W - 28, 96);
    const light = luminance(band) > 0.55;
    g.fillStyle = light ? '#111' : '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 14px ${FONT}`;
    g.fillText(kind === 'street' ? 'TITLE DEED' : kind === 'railroad' ? 'RAILROAD' : 'UTILITY', W / 2, 34);
    fitText(g, String(name).toUpperCase(), W / 2, 72, W - 44, 30, 900);
    if (kind === 'railroad') drawTrain(g, W / 2, 180);
    else if (kind === 'utility') (/water/i.test(name) ? drawTap : drawBulb)(g, W / 2, 180);
    else {
      g.strokeStyle = 'rgba(0,0,0,0.18)';
      g.lineWidth = 3;
      for (let k = 0; k < 6; k++) {
        const y = 140 + k * 26;
        g.beginPath();
        g.moveTo(34, y);
        g.lineTo(W - 34, y);
        g.stroke();
      }
    }
    g.strokeStyle = '#1b1b1b';
    g.lineWidth = 3;
    g.strokeRect(14, 14, W - 28, H - 28);
  }
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function drawTrain(g, x, y) {
  g.fillStyle = '#1d1d1d';
  g.fillRect(x - 70, y - 20, 90, 42); // boiler
  g.fillRect(x + 20, y - 45, 42, 67); // cab
  g.fillRect(x - 58, y - 48, 16, 30); // chimney
  g.fillRect(x - 84, y + 14, 20, 10); // buffer
  for (const cx of [x - 48, x - 12, x + 40]) {
    g.beginPath();
    g.arc(cx, y + 30, 14, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#fbfaf5';
  g.fillRect(x + 28, y - 36, 26, 20); // cab window
}

function drawBulb(g, x, y) {
  g.fillStyle = '#f6d34a';
  g.strokeStyle = '#1d1d1d';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(x, y - 10, 40, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#8a8f96';
  g.fillRect(x - 18, y + 28, 36, 30);
  g.strokeRect(x - 18, y + 28, 36, 30);
}

function drawTap(g, x, y) {
  g.fillStyle = '#6f7a86';
  g.fillRect(x - 60, y - 10, 90, 26);
  g.fillRect(x + 12, y + 16, 22, 34);
  g.fillRect(x - 20, y - 38, 12, 30);
  g.fillRect(x - 40, y - 44, 52, 10);
  g.fillStyle = '#3a8ee0';
  g.beginPath();
  g.ellipse(x + 23, y + 70, 9, 13, 0, 0, Math.PI * 2);
  g.fill();
}

function luminance(hex) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Centred text shrunk to fit `maxW` (largest size ≤ px). */
function fitText(g, text, x, y, maxW, px, weight = 700) {
  let size = px;
  g.font = `${weight} ${size}px ${FONT}`;
  while (size > 12 && g.measureText(text).width > maxW) {
    size -= 2;
    g.font = `${weight} ${size}px ${FONT}`;
  }
  g.fillText(text, x, y);
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

// ---- Chance / Community Chest textures ------------------------------------------------------------

function frontTexture(deck, text, who) {
  const cv = document.createElement('canvas');
  cv.width = TEX_W;
  cv.height = TEX_H;
  const g = cv.getContext('2d');
  const community = deck === 'community';
  const accent = community ? COLORS.community : COLORS.chance;
  roundRect(g, 0, 0, TEX_W, TEX_H, 36);
  g.save();
  g.clip();
  const paper = g.createLinearGradient(0, 0, 0, TEX_H);
  paper.addColorStop(0, community ? '#f3f9fe' : '#fff8ec');
  paper.addColorStop(1, community ? '#e2eff9' : '#fbe9cc');
  g.fillStyle = paper;
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.strokeStyle = accent;
  g.lineWidth = 16;
  roundRect(g, 16, 16, TEX_W - 32, TEX_H - 32, 26);
  g.stroke();
  g.lineWidth = 3;
  roundRect(g, 32, 32, TEX_W - 64, TEX_H - 64, 18);
  g.stroke();
  // Deck mark in both top corners.
  for (const x of [78, TEX_W - 78]) deckMark(g, x, 84, community, accent);
  g.fillStyle = accent;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.font = `900 44px ${FONT}`;
  g.fillText(community ? 'COMMUNITY CHEST' : 'CHANCE', TEX_W / 2, 56);
  g.fillStyle = '#2b1d08';
  const lines = wrap(g, String(text ?? ''), TEX_W - 130, [46, 40, 34, 30]);
  const lh = lines.px * 1.22;
  let y = (TEX_H - lines.list.length * lh) / 2 + 26;
  g.font = `700 ${lines.px}px ${FONT}`;
  for (const line of lines.list) {
    g.fillText(line, TEX_W / 2, y);
    y += lh;
  }
  if (who) {
    g.font = `600 26px ${FONT}`;
    g.fillStyle = 'rgba(43, 29, 8, 0.6)';
    g.fillText(`${who} drew`, TEX_W / 2, TEX_H - 76);
  }
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A "?" in a circle (Chance) or a little chest (Community Chest). */
function deckMark(g, x, y, community, accent) {
  g.save();
  g.fillStyle = accent;
  if (community) {
    g.fillRect(x - 26, y - 6, 52, 30);
    g.beginPath();
    g.moveTo(x - 26, y - 6);
    g.quadraticCurveTo(x, y - 34, x + 26, y - 6);
    g.fill();
    g.fillStyle = '#ffd35a';
    g.fillRect(x - 5, y - 4, 10, 12);
  } else {
    g.beginPath();
    g.arc(x, y, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 38px Georgia, "Times New Roman", serif';
    g.fillText('?', x, y + 2);
  }
  g.restore();
}

/** Word-wraps `text` at the largest of `sizes` (px) that fits in 5 lines. */
function wrap(g, text, maxW, sizes) {
  let out = null;
  for (const px of sizes) {
    g.font = `700 ${px}px ${FONT}`;
    const list = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > maxW && line) {
        list.push(line);
        line = word;
      } else line = next;
    }
    if (line) list.push(line);
    out = { px, list };
    if (list.length <= 5) break;
  }
  return out;
}

function backTexture(deck) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 323;
  const g = cv.getContext('2d');
  const community = deck === 'community';
  roundRect(g, 0, 0, 512, 323, 24);
  g.save();
  g.clip();
  g.fillStyle = community ? COLORS.community : COLORS.chance;
  g.fillRect(0, 0, 512, 323);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 10;
  roundRect(g, 18, 18, 476, 287, 16);
  g.stroke();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = community ? `900 54px ${FONT}` : '900 190px Georgia, "Times New Roman", serif';
  if (community) {
    g.fillText('COMMUNITY', 256, 130);
    g.fillText('CHEST', 256, 195);
  } else g.fillText('?', 256, 165);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
