// public/r3d/overlay.js — the HTML layer over the 3D canvas (inside #board): whose turn, callouts
// (dice total, DOUBLES!), the drawn card's caption, the winner banner, floating money labels
// anchored to 3D points (clamped to the edge with an arrow when off screen), a compact game log,
// the tile info card, and the camera buttons. Styles live in r3d.css.

import * as THREE from './three.js';

const CARD_MS = 4200;
const FLOAT_MS = 1600;
const EDGE = 26; // px: floats that would leave the canvas stick to its edge
const LOG_LINES = 4;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class Overlay {
  /**
   * @param {HTMLElement} root  the .r3d element
   * @param {object} opts { camera, size, onReset, onFreeLook, isQuiet }
   */
  constructor(root, { onReset, onFreeLook, isQuiet = () => false, camera = null, size = null } = {}) {
    this.root = root;
    this.camera = camera; // projects floating labels (size = the live { w, h } of the canvas)
    this.size = size;
    this.isQuiet = isQuiet;
    this.ui = el('div', 'r3d-ui');
    this.turn = el('div', 'r3d-turn');
    this.turn.hidden = true;
    this.floats = el('div', 'r3d-floats');
    this.callouts = el('div', 'r3d-callouts');
    this.card = el('div', 'r3d-card');
    this.card.setAttribute('role', 'status');
    this.card.addEventListener('click', (e) => { e.stopPropagation(); this.hideCard(); });
    this.winner = el('div', 'r3d-winner');
    this.winner.hidden = true;

    // Compact log (bottom-left). Hidden on narrow layouts, where ui.js shows its own.
    this.log = el('div', 'r3d-log');
    this.log.hidden = true;
    this.logHead = el('button', 'r3d-log-head');
    this.logHead.type = 'button';
    this.logHead.setAttribute('aria-expanded', 'true');
    this.logHead.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = this.log.classList.toggle('is-collapsed');
      this.logHead.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    this.logList = el('ol', 'r3d-log-list');
    this.logList.setAttribute('aria-label', 'Recent events');
    this.log.append(this.logHead, this.logList);

    // Tile info card (click a tile when nothing is animating).
    this.info = el('div', 'r3d-info');
    this.info.hidden = true;
    this.info.setAttribute('role', 'status');
    this.info.addEventListener('click', (e) => { e.stopPropagation(); this.hideInfo(); });

    this.tools = el('div', 'r3d-tools');
    this.freeChip = el('span', 'r3d-free-chip', 'Free camera');
    this.freeChip.hidden = true;
    this.freeBtn = el('button', 'r3d-btn', '✋');
    this.freeBtn.type = 'button';
    this.freeBtn.title = 'Free camera: drag to look around; the camera stays where you leave it';
    this.freeBtn.setAttribute('aria-label', 'Free camera');
    this.freeBtn.setAttribute('aria-pressed', 'false');
    this.freeBtn.addEventListener('click', (e) => { e.stopPropagation(); onFreeLook?.(); });
    const reset = el('button', 'r3d-btn', '⟲');
    reset.type = 'button';
    reset.title = 'Reset view (the camera follows the game again)';
    reset.setAttribute('aria-label', 'Reset view');
    reset.addEventListener('click', (e) => { e.stopPropagation(); onReset?.(); });
    this.tools.append(this.freeChip, this.freeBtn, reset);

    this.ui.append(this.turn, this.floats, this.callouts, this.card, this.winner, this.log, this.info, this.tools);
    root.append(this.ui);

    this.cardTimer = 0;
    this.live = []; // floating labels: { node, pos, until, timer }
    this.sig = { turn: '', winner: '', log: '' };
    this.v = new THREE.Vector3();
  }

  // ---- whose turn -------------------------------------------------------------------------------

  /** @param {{id,name,emoji,color,me,meta}|null} info  @param {boolean} announce slide in anew */
  setTurn(info, announce = false) {
    const sig = info ? [info.id, info.name, info.label, info.emoji, info.color, info.me, info.meta].join('|') : '';
    if (sig === this.sig.turn && !announce) return;
    this.sig.turn = sig;
    const box = this.turn;
    box.hidden = !info;
    if (!info) return;
    box.style.setProperty('--pc', info.color);
    box.replaceChildren(
      el('span', 'r3d-turn-token', info.emoji),
      el('span', 'r3d-turn-name', info.label ?? (info.me ? 'Your turn' : `${info.name}'s turn`)),
    );
    if (info.meta) box.append(el('span', 'r3d-turn-meta', info.meta));
    if (announce && !this.isQuiet()) {
      box.classList.remove('is-new');
      void box.offsetWidth; // restart the CSS animation
      box.classList.add('is-new');
    }
  }

  // ---- callouts (dice total, DOUBLES!) ------------------------------------------------------------

  /** A big centred word that pops and fades. kind: 'total' | 'doubles' | 'alert'. */
  callout(text, kind = 'total', ms = 1000) {
    if (this.isQuiet()) return;
    const node = el('div', `r3d-callout r3d-callout-${kind}`, text);
    node.style.setProperty('--ms', `${ms}ms`);
    this.callouts.replaceChildren(node);
    setTimeout(() => node.remove(), ms + 60);
  }

  // ---- card caption -------------------------------------------------------------------------------

  showCard({ deck, who, text }) {
    clearTimeout(this.cardTimer);
    const community = deck === 'community';
    this.card.classList.toggle('is-community', community);
    this.card.replaceChildren(
      el('div', 'r3d-card-deck', `${community ? 'Community Chest' : 'Chance'} · ${who} drew`),
      el('div', 'r3d-card-text', text),
    );
    this.card.classList.remove('is-visible');
    void this.card.offsetWidth;
    this.card.classList.add('is-visible');
    this.cardTimer = setTimeout(() => this.hideCard(), CARD_MS);
  }

  hideCard() {
    clearTimeout(this.cardTimer);
    this.card.classList.remove('is-visible');
  }

  // ---- winner -----------------------------------------------------------------------------------

  /** @param {{name,emoji,color,me}|null} info */
  setWinner(info) {
    const sig = info ? [info.name, info.emoji, info.color, info.me].join('|') : '';
    if (sig === this.sig.winner) return;
    this.sig.winner = sig;
    this.winner.hidden = !info;
    if (!info) return;
    this.winner.style.setProperty('--pc', info.color ?? '#e0a800');
    this.winner.replaceChildren(
      el('div', 'r3d-winner-trophy', '🏆'),
      el('div', 'r3d-winner-name', info.me ? 'You win!' : `${info.name} wins!`),
      el('div', 'r3d-winner-sub', `${info.emoji ?? ''} Last player standing`.trim()),
    );
  }

  // ---- log ------------------------------------------------------------------------------------------

  /** @param {string[]} lines newest last  @param {string} head e.g. "Game log · Free Parking pot $120" */
  setLog(lines, head = 'Game log') {
    const sig = `${head}\n${lines.join('\n')}`;
    if (sig === this.sig.log) return;
    this.sig.log = sig;
    this.log.hidden = !lines.length;
    this.logHead.textContent = head;
    this.logList.replaceChildren(...lines.slice(-LOG_LINES).map((line) => {
      const li = el('li', null, line);
      li.title = line;
      return li;
    }));
  }

  // ---- floating labels --------------------------------------------------------------------------

  /**
   * A label that rises and fades above a 3D point. Off screen, it sticks to the nearest edge with
   * an arrow pointing where it belongs.
   * @param {THREE.Vector3} pos  world position (copied)
   * @param {string} text
   * @param {'plus'|'minus'|'gold'|'info'|'big'} kind
   * @param {{chip?: string}} [opts] chip: a colour dot (whose money it is)
   */
  float(pos, text, kind = 'info', { chip = null } = {}) {
    if (!pos || this.isQuiet()) return;
    const node = el('div', `r3d-float r3d-float-${kind}`);
    if (chip) {
      const dot = el('span', 'r3d-float-chip');
      dot.style.background = chip;
      node.append(dot);
    }
    node.append(el('span', 'r3d-float-text', text));
    this.floats.append(node);
    const item = { node, pos: pos.clone(), until: performance.now() + FLOAT_MS };
    item.timer = setTimeout(() => this.dropFloat(item), FLOAT_MS + 100); // never outlive its animation
    this.live.push(item);
    this.placeFloat(item);
  }

  dropFloat(item) {
    clearTimeout(item.timer);
    item.node.remove();
    this.live = this.live.filter((x) => x !== item);
  }

  /** Re-projects live labels onto the canvas. Returns true while any are alive. */
  updateFloats() {
    const now = performance.now();
    for (const item of this.live.slice()) {
      if (now > item.until) this.dropFloat(item);
      else this.placeFloat(item);
    }
    return this.live.length > 0;
  }

  /** Canvas px of a world point: { x, y, behind }. */
  project(pos) {
    const v = this.v.copy(pos).project(this.camera);
    const behind = v.z > 1;
    let x = ((v.x + 1) / 2) * this.size.w;
    let y = ((1 - v.y) / 2) * this.size.h;
    if (behind) { // mirror to the far edge in the right direction
      x = this.size.w - x;
      y = this.size.h * 2;
    }
    return { x, y, behind };
  }

  placeFloat(item) {
    if (!this.camera || !this.size?.w) return;
    const { x, y } = this.project(item.pos);
    const w = this.size.w;
    const h = this.size.h;
    const cx = Math.min(w - EDGE * 2.2, Math.max(EDGE * 2.2, x));
    const cy = Math.min(h - EDGE * 0.6, Math.max(EDGE * 1.6, y));
    let arrow = '';
    if (Math.abs(cx - x) > 2 || Math.abs(cy - y) > 2) {
      const dx = x - cx;
      const dy = y - cy;
      arrow = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    item.node.style.left = `${cx.toFixed(1)}px`;
    item.node.style.top = `${cy.toFixed(1)}px`;
    if (item.node.dataset.edge !== arrow) {
      if (arrow) item.node.dataset.edge = arrow;
      else delete item.node.dataset.edge;
    }
  }

  clearFloats() {
    for (const item of this.live.slice()) this.dropFloat(item);
  }

  // ---- tile info card -----------------------------------------------------------------------------

  /**
   * @param {{name:string, band?:string, owner?:{name:string,color:string}|null, status:string[], facts:string[]}} data
   * @param {{x:number,y:number}} at canvas px near which to show it
   */
  showInfo(data, at) {
    const head = el('div', 'r3d-info-head', data.name);
    if (data.band) head.style.setProperty('--band', data.band);
    const box = [head];
    if (data.status?.length) {
      const st = el('div', 'r3d-info-status');
      data.status.forEach((line, k) => {
        const row = el('div', k === 0 && data.owner ? 'r3d-info-owner' : null, line);
        if (k === 0 && data.owner) row.style.setProperty('--owner', data.owner.color);
        st.append(row);
      });
      box.push(st);
    }
    const facts = el('div', 'r3d-info-facts');
    facts.append(...(data.facts ?? []).map((line) => el('div', null, line)));
    box.push(facts);
    this.info.replaceChildren(...box);
    this.info.hidden = false;
    const w = this.info.offsetWidth || 220;
    const h = this.info.offsetHeight || 120;
    const W = this.size?.w || this.root.clientWidth;
    const H = this.size?.h || this.root.clientHeight;
    const x = Math.min(W - w - 8, Math.max(8, at.x - w / 2));
    const y = at.y - h - 18 > 8 ? at.y - h - 18 : Math.min(H - h - 8, at.y + 18);
    this.info.style.left = `${x}px`;
    this.info.style.top = `${y}px`;
    this.infoShown = true;
  }

  hideInfo() {
    this.info.hidden = true;
    this.infoShown = false;
  }

  // ---- camera state -------------------------------------------------------------------------------

  /** Free-camera state: the chip shows while the player has the camera; ✋ lit while pinned. */
  setFreeCam({ suspended, pinned }) {
    this.freeChip.hidden = !(suspended || pinned);
    this.freeChip.textContent = pinned ? 'Free camera' : 'Free camera · returns shortly';
    this.freeBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    this.freeBtn.classList.toggle('is-on', pinned);
  }

  reset() {
    this.hideCard();
    this.hideInfo();
    this.clearFloats();
    this.callouts.replaceChildren();
    this.setWinner(null);
    this.setLog([]);
    this.sig.turn = '';
  }

  dispose() {
    this.hideCard();
    this.clearFloats();
    this.ui.remove();
  }
}
