// public/r3d/overlay.js — the HTML layer over the 3D canvas (inside #board): whose turn, callouts
// (dice total, DOUBLES!, SOLD!), the drawn card's caption, the winner banner, floating money labels
// anchored to 3D points (clamped to the visible area with an arrow when off screen), labels that
// stay pinned to the board (player pins over the tokens in wide shots, the running auction's price
// tag, the tiles of a pending trade), a compact game log, the tile info card, and the camera buttons.
//
// Everything is placed inside the "safe area": the part of #board that ui.js's header / panel /
// bottom sheet leave uncovered (setSafeArea → CSS variables --sa-t/r/b/l on the root). Styles live
// in r3d.css.

import * as THREE from './three.js';

const CARD_MS = 4200;
const FLOAT_MS = 1600;
const EDGE = 26; // px: floats that would leave the visible area stick to its edge
const LOG_LINES = 4;
// Player pins over the tokens show in wide shots only: fully visible beyond PIN_FAR camera units
// from the token, gone inside PIN_NEAR.
const PIN_NEAR = 8.5;
const PIN_FAR = 11.5;
const PIN_LIFT = 0.95; // world units above the token's base
const TAG_LIFT = 0.55; // …and above a tile, for auction / trade labels
const PIN_H = 34; // px: a pin's height (r3d.css .r3d-pin)

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
    this.camera = camera; // projects anchored labels (size = the live { w, h } of the canvas)
    this.size = size;
    this.isQuiet = isQuiet;
    this.safe = { top: 0, right: 0, bottom: 0, left: 0 };
    this.ui = el('div', 'r3d-ui');
    this.turn = el('div', 'r3d-turn');
    this.turn.hidden = true;
    this.pins = el('div', 'r3d-pins'); // pins, auction tag, trade chips (under the floats)
    this.floats = el('div', 'r3d-floats');
    this.callouts = el('div', 'r3d-callouts');
    this.card = el('div', 'r3d-card');
    this.card.setAttribute('role', 'status');
    this.card.addEventListener('click', (e) => { e.stopPropagation(); this.hideCard(); });
    this.winner = el('div', 'r3d-winner');
    this.winner.hidden = true;

    // Compact log (bottom-left of the visible area). Hidden on narrow layouts, where ui.js shows its
    // own; collapsed to its last line while a ui.js dialog floats over the board.
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
    this.watchDialogs();

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
    this.resetBtn = reset;
    this.tools.append(this.freeChip, this.freeBtn, reset);

    this.ui.append(this.pins, this.turn, this.floats, this.callouts, this.card, this.winner, this.log, this.info, this.tools);
    root.append(this.ui);

    this.cardTimer = 0;
    this.live = []; // floating labels: { node, pos, until, timer }
    this.anchors = new Map(); // key → { node, pos | posOf, kind, x, y, alpha }
    this.sig = { turn: '', winner: '', log: '', pins: '', auction: '', trade: '' };
    this.v = new THREE.Vector3();
  }

  // ---- safe area ------------------------------------------------------------------------------------

  /** CSS px of the canvas covered by ui.js from each edge; chips and labels stay inside the rest. */
  setSafeArea({ top = 0, right = 0, bottom = 0, left = 0 } = {}) {
    const W = this.size?.w || this.root.clientWidth || 0;
    const H = this.size?.h || this.root.clientHeight || 0;
    // Never let the insets eat the whole canvas (a tiny window): keep at least 40% per axis.
    const fit = (a, b, total) => (total && a + b > total * 0.6 ? [a * ((total * 0.6) / (a + b)), b * ((total * 0.6) / (a + b))] : [a, b]);
    const [l, r] = fit(left, right, W);
    const [t, b] = fit(top, bottom, H);
    this.safe = { top: t, right: r, bottom: b, left: l };
    const s = this.root.style;
    s.setProperty('--sa-t', `${t.toFixed(1)}px`);
    s.setProperty('--sa-r', `${r.toFixed(1)}px`);
    s.setProperty('--sa-b', `${b.toFixed(1)}px`);
    s.setProperty('--sa-l', `${l.toFixed(1)}px`);
    // The vignette centres on the visible area.
    if (W && H) {
      s.setProperty('--vig-x', `${(((l + (W - r)) / 2 / W) * 100).toFixed(1)}%`);
      s.setProperty('--vig-y', `${(((t + (H - b)) / 2 / H) * 100).toFixed(1)}%`);
    }
    this.root.classList.toggle('r3d-narrow-safe', W - l - r < 520);
  }

  /** The visible rectangle in canvas px. */
  safeRect() {
    const W = this.size?.w || this.root.clientWidth || 0;
    const H = this.size?.h || this.root.clientHeight || 0;
    const { top, right, bottom, left } = this.safe;
    return { x0: left, y0: top, x1: Math.max(left + 1, W - right), y1: Math.max(top + 1, H - bottom), W, H };
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

  // ---- callouts (dice total, DOUBLES!, SOLD!) -------------------------------------------------------

  /**
   * A big word centred in the visible area that pops and fades.
   * kind: 'total' | 'doubles' | 'alert' | 'gold' | 'deal'. `sub`: a smaller second line.
   */
  callout(text, kind = 'total', ms = 1000, { sub = null, color = null } = {}) {
    if (this.isQuiet()) return;
    const node = el('div', `r3d-callout r3d-callout-${kind}`);
    node.append(el('span', 'r3d-callout-main', text));
    if (sub) {
      const s = el('span', 'r3d-callout-sub', sub);
      if (color) s.style.setProperty('--chip', color);
      node.append(s);
    }
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

  /** While ui.js shows a dialog over the board, the log shrinks to its last line (they overlap). */
  watchDialogs() {
    const layer = typeof document !== 'undefined' ? document.getElementById('dialog-layer') : null;
    if (!layer || typeof MutationObserver !== 'function') return;
    const update = () => this.log.classList.toggle('is-dialog', layer.childElementCount > 0);
    this.dialogObs = new MutationObserver(update);
    this.dialogObs.observe(layer, { childList: true });
    update();
  }

  // ---- floating labels --------------------------------------------------------------------------

  /**
   * A label that rises and fades above a 3D point. Off screen, it sticks to the nearest edge of the
   * visible area with an arrow pointing where it belongs.
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

  /** Re-projects live labels and anchors onto the canvas. Returns true while floats are alive. */
  update() {
    const now = performance.now();
    for (const item of this.live.slice()) {
      if (now > item.until) this.dropFloat(item);
      else this.placeFloat(item);
    }
    this.placeAnchors();
    return this.live.length > 0;
  }

  /** Older name of update(). */
  updateFloats() {
    return this.update();
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
    const r = this.safeRect();
    const cx = Math.min(r.x1 - EDGE * 2.2, Math.max(r.x0 + EDGE * 2.2, x));
    const cy = Math.min(r.y1 - EDGE * 0.6, Math.max(r.y0 + EDGE * 1.6, y));
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

  // ---- anchored labels (pins, auction tag, trade chips) ---------------------------------------------

  /**
   * Player pins over the tokens (readable in the overview, fading out in close shots).
   * @param {{id:string, color:string, emoji:string, current:boolean}[]} list
   * @param {(id:string, out:THREE.Vector3) => THREE.Vector3|null} posOf world position of a token (null: hidden)
   * @param {{lift?:number}} [opts] world units between that position and the pin's tip
   */
  setPins(list, posOf, { lift = PIN_LIFT } = {}) {
    this.pinPos = posOf;
    this.pinLift = lift;
    const sig = list.map((p) => [p.id, p.color, p.emoji, p.current].join(':')).join('|');
    if (sig === this.sig.pins) return;
    this.sig.pins = sig;
    const keep = new Set();
    for (const p of list) {
      const key = `pin:${p.id}`;
      keep.add(key);
      let a = this.anchors.get(key);
      if (!a) {
        const node = el('div', 'r3d-pin');
        node.append(el('span', 'r3d-pin-emoji'));
        a = this.addAnchor(key, node, { id: p.id, kind: 'pin' });
      }
      a.node.style.setProperty('--pc', p.color);
      a.node.firstChild.textContent = p.emoji;
      a.node.classList.toggle('is-current', !!p.current);
    }
    for (const key of [...this.anchors.keys()]) if (key.startsWith('pin:') && !keep.has(key)) this.removeAnchor(key);
    this.placeAnchors();
  }

  /**
   * The running auction's price tag over its tile, or null to remove it.
   * @param {{tileIndex:number, pos:THREE.Vector3, name:string, highBid:number, bidder:string|null, color:string|null}|null} a
   */
  setAuction(a) {
    const sig = a ? [a.tileIndex, a.name, a.highBid, a.bidder, a.color].join('|') : '';
    if (sig === this.sig.auction) return;
    this.sig.auction = sig;
    if (!a) {
      this.removeAnchor('auction');
      return;
    }
    let an = this.anchors.get('auction');
    if (!an) an = this.addAnchor('auction', el('div', 'r3d-tag r3d-tag-auction'), { kind: 'tag' });
    an.pos = a.pos.clone();
    const price = el('span', 'r3d-tag-price', a.highBid > 0 ? `$${a.highBid}` : 'No bids');
    const head = el('span', 'r3d-tag-head', `🔨 ${a.name}`);
    const who = el('span', 'r3d-tag-who');
    if (a.bidder) {
      const dot = el('span', 'r3d-float-chip');
      dot.style.background = a.color ?? '#999';
      who.append(dot, el('span', null, a.bidder));
    }
    an.node.replaceChildren(head, price, who);
    this.placeAnchors();
  }

  /** A bid landed: the auction tag pulses (in the bidder's colour). */
  pulseAuction(color = null) {
    const a = this.anchors.get('auction');
    if (!a || this.isQuiet()) return;
    if (color) a.node.style.setProperty('--pulse', color);
    a.node.classList.remove('is-pulse');
    void a.node.offsetWidth;
    a.node.classList.add('is-pulse');
  }

  /**
   * Chips over the tiles of a pending trade (an arrow in the colour of the player who would get
   * each tile), or null to remove them.
   * @param {{tiles:{index:number, pos:THREE.Vector3, color:string}[]}|null} t
   */
  setTrade(t) {
    const sig = t ? t.tiles.map((x) => `${x.index}:${x.color}`).join('|') : '';
    if (sig === this.sig.trade) return;
    this.sig.trade = sig;
    for (const key of [...this.anchors.keys()]) if (key.startsWith('trade:')) this.removeAnchor(key);
    if (!t) return;
    for (const x of t.tiles) {
      const node = el('div', 'r3d-tchip', '⇄');
      node.style.setProperty('--pc', x.color);
      const a = this.addAnchor(`trade:${x.index}`, node, { kind: 'tag' });
      a.pos = x.pos.clone();
    }
    this.placeAnchors();
  }

  addAnchor(key, node, { id = null, kind = 'tag' } = {}) {
    this.pins.append(node);
    const a = { node, id, kind, pos: null, x: NaN, y: NaN, alpha: -1 };
    this.anchors.set(key, a);
    return a;
  }

  removeAnchor(key) {
    const a = this.anchors.get(key);
    if (!a) return;
    a.node.remove();
    this.anchors.delete(key);
  }

  /** Projects every anchored label (cheap: a handful of vectors, DOM writes only on change). */
  placeAnchors() {
    if (!this.camera || !this.size?.w || !this.anchors.size) return;
    const cam = this.camera.position;
    const r = this.safeRect();
    for (const a of this.anchors.values()) {
      let pos = a.pos;
      let alpha = 1;
      if (a.kind === 'pin') {
        pos = this.pinPos?.(a.id, this.v2 ?? (this.v2 = new THREE.Vector3())) ?? null;
        if (pos) {
          pos.y += this.pinLift ?? PIN_LIFT;
          const d = pos.distanceTo(cam);
          alpha = Math.max(0, Math.min(1, (d - PIN_NEAR) / (PIN_FAR - PIN_NEAR)));
        } else alpha = 0;
      } else if (pos) {
        pos = (this.v3 ?? (this.v3 = new THREE.Vector3())).copy(pos);
        pos.y += TAG_LIFT;
      }
      if (!pos) alpha = 0;
      let x = a.x;
      let y = a.y;
      if (alpha > 0) {
        const p = this.project(pos);
        x = p.x;
        y = p.y;
        if (p.behind || x < r.x0 - 40 || x > r.x1 + 40 || y < r.y0 - 40 || y > r.y1 + 60) alpha = 0;
        else if (a.kind === 'pin') y = Math.max(y, r.y0 + PIN_H); // a far-row pin stays below the header
      }
      if (Math.abs(alpha - a.alpha) > 0.02 || (alpha === 0) !== (a.alpha === 0)) {
        a.alpha = alpha;
        a.node.style.opacity = alpha.toFixed(2);
        a.node.style.visibility = alpha > 0 ? 'visible' : 'hidden';
      }
      if (alpha > 0 && !(Math.abs(x - a.x) <= 0.4 && Math.abs(y - a.y) <= 0.4)) { // (a.x starts NaN)
        a.x = x;
        a.y = y;
        a.node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
    }
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
    const r = this.safeRect();
    const x = Math.min(r.x1 - w - 8, Math.max(r.x0 + 8, at.x - w / 2));
    const y = at.y - h - 18 > r.y0 + 8 ? at.y - h - 18 : Math.min(r.y1 - h - 8, at.y + 18);
    this.info.style.left = `${x}px`;
    this.info.style.top = `${y}px`;
    this.infoShown = true;
  }

  hideInfo() {
    this.info.hidden = true;
    this.infoShown = false;
  }

  // ---- camera state -------------------------------------------------------------------------------

  /**
   * Free-camera state: the chip shows while the player has the camera; ✋ lit while pinned. In the
   * "free" camera style the player always has it: ✋ hides and ⟲ glides back to the overview.
   */
  setFreeCam({ suspended, pinned, style = 'cinematic' }) {
    const free = style === 'free';
    this.freeBtn.hidden = free;
    this.freeChip.hidden = free || !(suspended || pinned);
    this.freeChip.textContent = pinned ? 'Free camera' : 'Free camera · returns shortly';
    this.freeBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    this.freeBtn.classList.toggle('is-on', pinned);
    this.resetBtn.title = free ? 'Back to the whole board' : 'Reset view (the camera follows the game again)';
  }

  reset() {
    this.hideCard();
    this.hideInfo();
    this.clearFloats();
    this.callouts.replaceChildren();
    this.setWinner(null);
    this.setLog([]);
    this.setAuction(null);
    this.setTrade(null);
    this.sig.turn = '';
  }

  dispose() {
    this.hideCard();
    this.clearFloats();
    this.dialogObs?.disconnect();
    this.ui.remove();
  }
}
