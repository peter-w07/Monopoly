// public/r3d/board.js — the physical board: slab + printed face, card piles, jail cage, and the
// per-tile pieces that change during a game (owner markers, mortgage covers, houses, hotels, the
// "pending purchase" glow). Ownership pieces are InstancedMeshes (one draw call each).
//
// Owner marker: a strip in the owner's colour on a white plate along the tile's outer edge (where
// the price is printed), so it never blends into the colour band.
//
// sync(ctx, animate) reconciles every ownable tile with the public state; with animate = true the
// differences pop in / out through the shared Animator, otherwise they snap.

import * as THREE from './three.js';
import { drawBoardCanvas, COLORS } from './board-texture.js';
import { UNITS, CORNER, BAND, SLAB_H, JAIL_CELL, DECK_SPOTS, sideOf, tileCenter, toWorld, SIDE_ROT } from './layout.js';
import { ease } from './tween.js';
import { mergeParts } from './token-models.js';

const TILE_W = 1;
const TILE_D = CORNER;
const MARK_Z = TILE_D / 2 - 0.2; // owner marker: tile-local z (outward) of its centre
const HOUSE_GAP = 0.24;
const COL_HOUSE = '#2e9e4f';
const COL_HOTEL = '#d62b2b';
const GREY = new THREE.Color('#8a8f8c');

const isOwnable = (t) => t.type === 'property' || t.type === 'railroad' || t.type === 'utility';

/**
 * @param {object} BOARD parsed board.json
 * @param {object} deps { renderer, animator, markShadows }
 */
export function createBoard(BOARD, { renderer, animator, markShadows, fx = null }) {
  const group = new THREE.Group();
  group.name = 'board';
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---- slab with the printed face ----------------------------------------------------------------
  const texSize = Math.min(2048, renderer.capabilities.maxTextureSize || 2048);
  const faceTex = new THREE.CanvasTexture(drawBoardCanvas(BOARD, texSize));
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.anisotropy = maxAniso;
  faceTex.generateMipmaps = true;
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.78, metalness: 0 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#173a25', roughness: 0.6 });
  // The slab (one material) with the printed face as a plane just on top: 2 draw calls, not 6.
  // The plane is UV-mapped exactly like the canvas (u → +x, v → +z).
  const slab = new THREE.Mesh(new THREE.BoxGeometry(UNITS, SLAB_H - 0.004, UNITS), edgeMat);
  slab.position.y = -SLAB_H / 2 - 0.002;
  slab.receiveShadow = true;
  slab.castShadow = true;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(UNITS, UNITS).rotateX(-Math.PI / 2), faceMat);
  face.receiveShadow = true;
  group.add(slab, face);

  // ---- card piles -----------------------------------------------------------------------------
  const decks = {};
  for (const [deck, spot] of Object.entries(DECK_SPOTS)) decks[deck] = buildDeck(deck, spot, maxAniso);
  group.add(decks.chance.group, decks.community.group);

  // ---- jail cage ------------------------------------------------------------------------------
  const cage = buildCage();
  group.add(cage);

  // ---- per-tile pieces --------------------------------------------------------------------------
  const ownable = BOARD.tiles.filter(isOwnable).map((t) => t.index);
  const properties = BOARD.tiles.filter((t) => t.type === 'property').map((t) => t.index);
  const ownSlot = new Map(ownable.map((i, k) => [i, k]));
  const propSlot = new Map(properties.map((i, k) => [i, k]));

  const plates = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.9, 0.026, 0.25).translate(0, 0.013, 0),
    new THREE.MeshStandardMaterial({ color: '#fbfaf5', roughness: 0.5 }),
    ownable.length,
  );
  const frames = new THREE.InstancedMesh( // the owner-colour strip (called "frame" in the visual state)
    new THREE.BoxGeometry(0.8, 0.036, 0.17).translate(0, 0.018, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 }),
    ownable.length,
  );
  const covers = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(TILE_W, TILE_D).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: mortgageTexture(maxAniso), transparent: true, depthWrite: false, toneMapped: false }),
    ownable.length,
  );
  const houses = new THREE.InstancedMesh(houseGeometry(0.21, 0.17, 0.12, 0.26), new THREE.MeshStandardMaterial({ color: COL_HOUSE, roughness: 0.45 }), properties.length * 4);
  const hotels = new THREE.InstancedMesh(houseGeometry(0.6, 0.25, 0.14, 0.28), new THREE.MeshStandardMaterial({ color: COL_HOTEL, roughness: 0.45 }), properties.length);
  frames.castShadow = plates.castShadow = true;
  houses.castShadow = hotels.castShadow = true;
  houses.receiveShadow = hotels.receiveShadow = true;
  covers.renderOrder = 2;
  for (const m of [plates, frames, covers, houses, hotels]) {
    m.frustumCulled = false; // instances move; skip bounding-sphere bookkeeping
    group.add(m);
  }
  frames.setColorAt(0, new THREE.Color('#fff')); // allocate instanceColor

  // Pending-purchase glow: a gold frame hovering over the tile.
  const glowMat = new THREE.MeshStandardMaterial({ color: '#ffcf3a', emissive: '#ffb000', emissiveIntensity: 0.8, roughness: 0.3 });
  const glow = new THREE.Mesh(frameGeometry(TILE_W + 0.08, TILE_D + 0.08, 0.07, 0.05), glowMat);
  glow.visible = false;
  group.add(glow);

  /** Visual state per ownable tile index. */
  const vis = new Map(ownable.map((i) => [i, {
    owner: null,
    color: new THREE.Color('#ffffff'),
    mortgaged: false,
    houses: 0,
    frame: 0, // scales 0..1 (animated)
    cover: 0,
    house: [0, 0, 0, 0],
    hotel: 0,
  }]));

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();

  function place(i, lx, lz, y, scale, rotY = 0) {
    const side = sideOf(i);
    const rot = SIDE_ROT[side] ?? 0;
    const c = tileCenter(i);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    dummy.position.set(c.x + lx * cos + lz * sin, y, c.z - lx * sin + lz * cos);
    dummy.rotation.set(0, rot + rotY, 0);
    dummy.scale.setScalar(scale > 1e-4 ? scale : 0); // scale 0 hides an instance
    dummy.updateMatrix();
    return dummy.matrix;
  }

  /** World position of a tile-local point (x along the row, z outward). */
  function worldAt(i, lx, lz) {
    place(i, lx, lz, 0.05, 1);
    return dummy.position.clone();
  }

  /** Writes every instance of tile i from its visual state. */
  function write(i) {
    const v = vis.get(i);
    const k = ownSlot.get(i);
    plates.setMatrixAt(k, place(i, 0, MARK_Z, 0.001, v.frame));
    frames.setMatrixAt(k, place(i, 0, MARK_Z, 0.001, v.frame));
    tmpColor.copy(v.color);
    if (v.mortgaged) tmpColor.lerp(GREY, 0.75);
    frames.setColorAt(k, tmpColor);
    covers.setMatrixAt(k, place(i, 0, 0, 0.006 + 0.0001 * k, v.cover));
    const p = propSlot.get(i);
    if (p !== undefined) {
      const bandZ = -TILE_D / 2 + BAND / 2;
      for (let h = 0; h < 4; h++) {
        houses.setMatrixAt(p * 4 + h, place(i, (h - 1.5) * HOUSE_GAP, bandZ, 0, v.house[h]));
      }
      hotels.setMatrixAt(p, place(i, 0, bandZ, 0, v.hotel));
    }
    plates.instanceMatrix.needsUpdate = true;
    frames.instanceMatrix.needsUpdate = true;
    frames.instanceColor.needsUpdate = true;
    covers.instanceMatrix.needsUpdate = true;
    houses.instanceMatrix.needsUpdate = true;
    hotels.instanceMatrix.needsUpdate = true;
    markShadows();
  }
  for (const i of ownable) write(i);

  /** Animates one numeric field of a tile's visual state to `to`. */
  function animateField(i, get, set, to, { delay = 0, duration = 0.35, easing = ease.outBack } = {}) {
    const from = get();
    if (Math.abs(from - to) < 1e-4) return;
    animator.add({
      delay,
      duration,
      easing: to > from ? easing : ease.inQuad,
      update: (p) => { set(from + (to - from) * p); write(i); },
      end: () => { set(to); write(i); },
    });
  }

  /**
   * Reconciles tile i with the state. Returns true if anything changed.
   * @param {number} i
   * @param {{owner:string|null, color:string, mortgaged:boolean, houses:number}} want
   */
  function syncTile(i, want, animate, delay = 0) {
    const v = vis.get(i);
    if (!v) return false;
    const owner = want.owner ?? null;
    const houses = owner ? Math.max(0, Math.min(5, want.houses | 0)) : 0;
    const mortgaged = !!(owner && want.mortgaged);
    const colorChanged = !!owner && !!want.color && v.color.getHex() !== tmpColor.set(want.color).getHex();
    if (v.owner === owner && v.houses === houses && v.mortgaged === mortgaged && !colorChanged) return false;

    const hadOwner = !!v.owner;
    v.owner = owner;
    if (owner && want.color) v.color.set(want.color);
    v.mortgaged = mortgaged;
    const prevHouses = v.houses;
    v.houses = houses;

    const targets = {
      frame: owner ? 1 : 0,
      cover: mortgaged ? 1 : 0,
      house: [0, 1, 2, 3].map((h) => (houses >= 1 && houses <= 4 && h < houses ? 1 : 0)),
      hotel: houses === 5 ? 1 : 0,
    };
    if (!animate) {
      v.frame = targets.frame;
      v.cover = targets.cover;
      v.house = targets.house;
      v.hotel = targets.hotel;
      write(i);
      return true;
    }
    // Owner frame pops in (or shrinks away); a new owner flashes through a pop.
    if (!hadOwner && owner) { v.frame = 0; animateField(i, () => v.frame, (x) => { v.frame = x; }, 1, { delay }); }
    else if (hadOwner && !owner) animateField(i, () => v.frame, (x) => { v.frame = x; }, 0, { delay, duration: 0.25 });
    else if (owner) {
      v.frame = 0.6;
      animateField(i, () => v.frame, (x) => { v.frame = x; }, 1, { delay, duration: 0.3 });
    }
    animateField(i, () => v.cover, (x) => { v.cover = x; }, targets.cover, { delay, duration: 0.3, easing: ease.outCubic });

    // Buildings: houses pop in one by one; a hotel replaces four houses (they shrink, it rises).
    const toHotel = houses === 5 && prevHouses !== 5;
    const fromHotel = prevHouses === 5 && houses !== 5;
    const bandZ = -TILE_D / 2 + BAND / 2;
    let t = delay;
    for (let h = 0; h < 4; h++) {
      const want = targets.house[h];
      if (Math.abs(v.house[h] - want) < 1e-4) continue;
      const growing = want > v.house[h];
      const d = toHotel ? delay : growing ? t + (fromHotel ? 0.18 : 0) : delay;
      animateField(i, () => v.house[h], (x) => { v.house[h] = x; }, want, { delay: d, duration: growing ? 0.4 : 0.16 });
      if (growing) {
        fx?.puff(worldAt(i, (h - 1.5) * HOUSE_GAP, bandZ), d + 0.05, 0.6);
        t += 0.1;
      }
    }
    if (Math.abs(v.hotel - targets.hotel) > 1e-4) {
      const d = toHotel ? delay + 0.16 : delay;
      animateField(i, () => v.hotel, (x) => { v.hotel = x; }, targets.hotel, { delay: d, duration: toHotel ? 0.5 : 0.18 });
      if (toHotel) fx?.puff(worldAt(i, 0, bandZ), d + 0.05, 1.2);
    }
    if (!hadOwner && owner) fx?.puff(worldAt(i, 0, MARK_Z), delay + 0.05, 0.8);
    write(i);
    return true;
  }

  /** Reconciles every ownable tile with ctx (see renderer3d makeCtx). */
  function sync(ctx, animate) {
    let changed = false;
    for (const i of ownable) {
      const ts = ctx.tileState.get(i);
      const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
      changed = syncTile(i, {
        owner,
        color: owner ? ctx.colorOf.get(owner) : null,
        mortgaged: !!ts?.mortgaged,
        houses: Number(ts?.houses) || 0,
      }, animate) || changed;
    }
    return changed;
  }

  function reset() {
    for (const i of ownable) {
      const v = vis.get(i);
      Object.assign(v, { owner: null, mortgaged: false, houses: 0, frame: 0, cover: 0, house: [0, 0, 0, 0], hotel: 0 });
      write(i);
    }
    setPending(null);
  }

  // ---- highlight / pulses -----------------------------------------------------------------------
  let pending = null;
  let flashUntil = 0;

  function aim(i) {
    const c = tileCenter(i);
    glow.position.set(c.x, 0.002, c.z);
    glow.rotation.set(0, SIDE_ROT[sideOf(i)] ?? 0, 0);
    const corner = sideOf(i) === 'corner';
    glow.scale.set(corner ? 1.5 : 1, 1, corner ? 1 : 1);
  }

  function setPending(i) {
    pending = Number.isInteger(i) ? i : null;
    if (pending !== null) aim(pending);
    glow.visible = pending !== null || performance.now() < flashUntil;
  }

  /** Short gold flash on a tile (landing). */
  function flash(i, seconds = 0.9) {
    if (pending !== null && pending !== i) return;
    aim(i);
    flashUntil = performance.now() + seconds * 1000;
    glow.visible = true;
  }

  /** Idle effect: the pending glow breathes. Returns true while something is animating. */
  function ambient(now) {
    const flashing = now < flashUntil;
    glow.visible = pending !== null || flashing;
    if (!glow.visible) return false;
    glowMat.emissiveIntensity = 0.55 + 0.45 * Math.sin(now / 260);
    return true;
  }

  // ---- decks & cage effects -------------------------------------------------------------------
  /** The pile's top card lifts a little as a card is drawn (cards.js flies the drawn card). */
  function drawCard(deck, delay = 0) {
    const d = decks[deck === 'community' ? 'community' : 'chance'];
    const card = d.top;
    const base = card.userData.base;
    animator.add({
      delay,
      duration: 0.5,
      update: (p) => {
        card.position.y = base.y + Math.sin(Math.PI * p) * 0.12;
        markShadows();
      },
      end: () => { card.position.y = base.y; },
    });
  }

  /** World pose of a pile's top card: { position, quaternion, w, h } (where a drawn card starts). */
  function deckPose(deck) {
    const d = decks[deck === 'community' ? 'community' : 'chance'];
    d.group.updateMatrixWorld(true);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    d.top.getWorldPosition(position);
    d.top.getWorldQuaternion(quaternion);
    return { position, quaternion, w: d.w, h: d.h };
  }

  /** The bars drop onto the cell with a bounce (someone was sent to jail). */
  function cageBounce(delay = 0) {
    animator.add({
      delay,
      duration: 0.5,
      update: (p) => {
        cage.position.y = 0.7 * (1 - ease.outBounce(p));
        markShadows();
      },
      end: () => { cage.position.y = 0; },
    });
  }

  /** Current visual state of an ownable tile (for tests / debugging). */
  function inspect(i) {
    const v = vis.get(i);
    return v && { owner: v.owner, color: `#${v.color.getHexString()}`, mortgaged: v.mortgaged, houses: v.houses, frame: v.frame, cover: v.cover, house: v.house.slice(), hotel: v.hotel, pending: pending === i };
  }

  return { group, sync, syncTile, reset, setPending, flash, ambient, drawCard, deckPose, cageBounce, inspect, ownable };
}

// ---- geometry helpers ------------------------------------------------------------------------------

/** A flat rectangular ring lying on the XZ plane (w along x, d along z), `t` wide, `h` tall. */
function frameGeometry(w, d, t, h) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -d / 2);
  shape.lineTo(w / 2, -d / 2);
  shape.lineTo(w / 2, d / 2);
  shape.lineTo(-w / 2, d / 2);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-w / 2 + t, -d / 2 + t);
  hole.lineTo(-w / 2 + t, d / 2 - t);
  hole.lineTo(w / 2 - t, d / 2 - t);
  hole.lineTo(w / 2 - t, -d / 2 + t);
  hole.closePath();
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2);
}

/** A house: pentagon prism (walls `wallH`, roof `roofH`), `w` wide, `d` deep, base at y = 0. */
function houseGeometry(w, wallH, roofH, d) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, wallH);
  s.lineTo(0, wallH + roofH);
  s.lineTo(-w / 2, wallH);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1 });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  return geo;
}

function mortgageTexture(aniso) {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 384;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(20, 22, 21, 0.55)';
  g.fillRect(0, 0, cv.width, cv.height);
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 6;
  for (let k = -cv.height; k < cv.width; k += 36) {
    g.beginPath();
    g.moveTo(k, cv.height);
    g.lineTo(k + cv.height, 0);
    g.stroke();
  }
  g.save();
  g.translate(cv.width / 2, cv.height / 2);
  g.rotate(-Math.PI / 2.6);
  g.fillStyle = '#fff';
  g.font = '900 44px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#c8102e';
  g.fillRect(-150, -34, 300, 68);
  g.fillStyle = '#fff';
  g.fillText('MORTGAGED', 0, 2);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

function deckTexture(deck) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 320;
  const g = cv.getContext('2d');
  const chance = deck === 'chance';
  g.fillStyle = chance ? COLORS.chance : COLORS.community;
  g.fillRect(0, 0, 512, 320);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 10;
  g.strokeRect(18, 18, 476, 284);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (chance) {
    g.font = '900 200px Georgia, "Times New Roman", serif';
    g.fillText('?', 256, 150);
    g.font = '900 44px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
    g.fillText('CHANCE', 256, 268);
  } else {
    g.font = '900 54px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
    g.fillText('COMMUNITY', 256, 120);
    g.fillText('CHEST', 256, 190);
    g.font = '800 30px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
    g.fillText('★ ★ ★', 256, 258);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A pile of cards on its printed spot, with a separate top card that can be lifted. */
function buildDeck(deck, spot, aniso) {
  const grp = new THREE.Group();
  const { x, z } = toWorld(spot.u, spot.v);
  grp.position.set(x, 0, z);
  grp.rotation.y = -spot.rot; // canvas rotation is clockwise-positive seen from above
  const tex = deckTexture(deck);
  tex.anisotropy = aniso;
  const paper = new THREE.MeshStandardMaterial({ color: '#f3efe4', roughness: 0.8 });
  const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
  const pileH = 0.1;
  const pile = new THREE.Mesh(new THREE.BoxGeometry(spot.w, pileH, spot.h), paper);
  pile.position.y = pileH / 2;
  pile.castShadow = pile.receiveShadow = true;
  const faceGeo = new THREE.PlaneGeometry(spot.w, spot.h).rotateX(-Math.PI / 2);
  const under = new THREE.Mesh(faceGeo, face); // the next card, seen when the top one lifts
  under.position.y = pileH + 0.001;
  const top = new THREE.Mesh(faceGeo, face);
  top.position.y = pileH + 0.004;
  top.userData.base = top.position.clone();
  grp.add(pile, under, top);
  return { group: grp, top, w: spot.w, h: spot.h };
}

/** Iron bars around the jail cell. */
function buildCage() {
  const cage = new THREE.Group();
  cage.name = 'jail-cage';
  const iron = new THREE.MeshStandardMaterial({ color: '#2b2f33', metalness: 0.85, roughness: 0.35 });
  const h = 0.46;
  const cell = { x0: JAIL_CELL.x, x1: JAIL_CELL.x + JAIL_CELL.w, y0: JAIL_CELL.y, y1: JAIL_CELL.y + JAIL_CELL.h };
  const a = toWorld(cell.x0 + 0.03, cell.y0 + 0.03);
  const b = toWorld(cell.x1 - 0.03, cell.y1 - 0.03);
  const bars = [];
  const step = 0.125;
  const along = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) bars.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  };
  along(a.x, a.z, b.x, a.z);
  along(b.x, a.z, b.x, b.z);
  along(b.x, b.z, a.x, b.z);
  along(a.x, b.z, a.x, a.z);
  const barMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.016, 0.016, h, 6), iron, bars.length);
  const m = new THREE.Matrix4();
  bars.forEach(([x, z], k) => barMesh.setMatrixAt(k, m.makeTranslation(x, h / 2, z)));
  barMesh.castShadow = true;
  cage.add(barMesh);
  const rails = new THREE.Group();
  for (const [x, z, len, rot] of [
    [(a.x + b.x) / 2, a.z, b.x - a.x, 0],
    [(a.x + b.x) / 2, b.z, b.x - a.x, 0],
    [a.x, (a.z + b.z) / 2, b.z - a.z, Math.PI / 2],
    [b.x, (a.z + b.z) / 2, b.z - a.z, Math.PI / 2],
  ]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(len + 0.04, 0.04, 0.04));
    r.position.set(x, h, z);
    r.rotation.y = rot;
    rails.add(r);
  }
  const railMesh = new THREE.Mesh(mergeParts(rails), iron); // one draw call for all four rails
  railMesh.castShadow = true;
  cage.add(railMesh);
  return cage;
}
