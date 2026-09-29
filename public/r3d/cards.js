// public/r3d/cards.js — a drawn Chance / Community Chest card lifts off its pile, flips over and
// hangs in front of the camera (text facing the player) for a moment, then drops away. The overlay
// shows the same text as a caption (overlay.showCard), which stays readable a little longer.

import * as THREE from './three.js';
import { COLORS } from './board-texture.js';
import { ease } from './tween.js';

const FLY_IN = 0.5;
const FLY_OUT = 0.35;
const VIEW_DIST = 3; // how far in front of the camera the card hangs
const VIEW_FRACTION = 0.46; // of the view width (0.66 on narrow canvases)
const VIEW_UP = 0.2; // raised by this much of the view height, clear of the tile in focus below
const TEX_W = 768;
const TEX_H = 485;

export class CardFlight {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./tween.js').Animator} animator
   * @param {object} board createBoard(...) (deckPose)
   * @param {{w:number,h:number}} size live canvas size
   */
  constructor(scene, camera, animator, board, size) {
    this.camera = camera;
    this.animator = animator;
    this.board = board;
    this.size = size;
    this.root = new THREE.Group();
    this.root.name = 'flying-card';
    this.root.visible = false;
    this.root.renderOrder = 20;
    const mat = () => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthTest: false, depthWrite: false });
    this.front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat());
    this.back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateY(Math.PI), mat());
    this.front.renderOrder = this.back.renderOrder = 20;
    this.root.add(this.front, this.back);
    scene.add(this.root);
    this.backs = { chance: backTexture('chance'), community: backTexture('community') };
    this.flights = 0;
    this.current = 0;
    this.tmp = { q: new THREE.Quaternion(), p: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3() };
  }

  /**
   * Schedules the flight `delay` seconds from now; the card faces the camera for `hold` seconds.
   * @returns {number} seconds until it is gone
   */
  schedule({ deck, text, who }, delay = 0, hold = 1.3) {
    const community = deck === 'community';
    let tex = null;
    let from = null;
    const start = new THREE.Quaternion();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // back side up
    const total = FLY_IN + hold + FLY_OUT;
    const id = ++this.flights; // a later card takes the stage from an earlier one
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
      },
      update: (p) => {
        if (this.current !== id) return;
        const t = p * total;
        const { q, p: pos } = this.tmp;
        const view = this.viewPose(from.w);
        let e;
        let s;
        let lift = 0;
        let alpha = 1;
        if (t < FLY_IN) {
          e = ease.outCubic(t / FLY_IN);
          s = 1 + (view.scale - 1) * e;
          lift = Math.sin(Math.PI * e) * 0.6;
        } else if (t < FLY_IN + hold) {
          e = 1;
          s = view.scale;
        } else {
          const k = (t - FLY_IN - hold) / FLY_OUT;
          e = 1;
          s = view.scale * (1 - 0.6 * ease.inQuad(k));
          alpha = 1 - k;
          view.pos.addScaledVector(view.up, -0.9 * ease.inQuad(k));
        }
        pos.lerpVectors(from.pos, view.pos, e);
        pos.y += lift;
        q.slerpQuaternions(start, view.quat, e);
        this.root.position.copy(pos);
        this.root.quaternion.copy(q);
        this.root.scale.set(from.w * s, from.h * s, 1);
        this.front.material.opacity = this.back.material.opacity = alpha;
      },
      end: () => {
        if (this.current !== id) {
          tex?.dispose();
          return;
        }
        this.root.visible = false;
        this.front.material.map = null;
        this.front.material.needsUpdate = true;
        tex?.dispose();
        tex = null;
      },
    });
    return total;
  }

  /** Where the card hangs right now: in front of the live camera, facing it. */
  viewPose(cardW) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const fwd = this.tmp.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = this.tmp.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const vh = 2 * VIEW_DIST * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const vw = vh * (cam.aspect || 1);
    const narrow = (this.size?.w ?? 800) < 500;
    const scale = ((narrow ? 0.66 : VIEW_FRACTION) * vw) / cardW;
    const pos = cam.position.clone().addScaledVector(fwd, VIEW_DIST).addScaledVector(up, vh * VIEW_UP);
    return { pos, quat: cam.quaternion.clone(), scale, up: up.clone() };
  }

  hide() {
    this.root.visible = false;
  }

  dispose() {
    this.front.material.map?.dispose?.();
    for (const t of Object.values(this.backs)) t.dispose();
  }
}

// ---- textures -------------------------------------------------------------------------------------

function frontTexture(deck, text, who) {
  const cv = document.createElement('canvas');
  cv.width = TEX_W;
  cv.height = TEX_H;
  const g = cv.getContext('2d');
  const community = deck === 'community';
  const accent = community ? COLORS.community : COLORS.chance;
  g.fillStyle = community ? '#eef7fd' : '#fff4e2';
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.strokeStyle = accent;
  g.lineWidth = 16;
  g.strokeRect(14, 14, TEX_W - 28, TEX_H - 28);
  g.fillStyle = accent;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.font = '900 44px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
  g.fillText(community ? 'COMMUNITY CHEST' : 'CHANCE', TEX_W / 2, 44);
  g.fillStyle = '#2b1d08';
  const lines = wrap(g, String(text ?? ''), TEX_W - 110, [46, 40, 34, 30]);
  const lh = lines.px * 1.22;
  let y = (TEX_H - lines.list.length * lh) / 2 + 22;
  g.font = `700 ${lines.px}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  for (const line of lines.list) {
    g.fillText(line, TEX_W / 2, y);
    y += lh;
  }
  if (who) {
    g.font = '600 26px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
    g.fillStyle = 'rgba(43, 29, 8, 0.6)';
    g.fillText(`${who} drew`, TEX_W / 2, TEX_H - 70);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Word-wraps `text` at the largest of `sizes` (px) that fits in 5 lines. */
function wrap(g, text, maxW, sizes) {
  let out = null;
  for (const px of sizes) {
    g.font = `700 ${px}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
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
  g.fillStyle = community ? COLORS.community : COLORS.chance;
  g.fillRect(0, 0, 512, 323);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 10;
  g.strokeRect(18, 18, 476, 287);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = community ? '900 54px system-ui, "Segoe UI", Roboto, Arial, sans-serif' : '900 190px Georgia, "Times New Roman", serif';
  if (community) {
    g.fillText('COMMUNITY', 256, 130);
    g.fillText('CHEST', 256, 195);
  } else g.fillText('?', 256, 165);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
