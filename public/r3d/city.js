// public/r3d/city.js — the living town in the middle of the board (the Monopoly Plus signature).
//
// * Districts: one per colour group, just inside its tiles (layout.districts), two building plots
//   per property (next to the tiles / next to the road). Every group has its own building style
//   (city-kit STYLES): cottages, row houses, townhouses, shops with awnings, offices, department
//   stores, glass skyscrapers, luxury towers with spires. Unowned properties show grey "for sale"
//   lots with a sign (so the centre is never bare); buying one raises the group's building behind
//   scaffolding with a puff of dust, every house adds storeys, a hotel turns the front plot into a
//   landmark tower with a crown; mortgaged → greyed and boarded up.
// * Landmarks in the inner corners: the Bank (GO), the power plant with a smoking chimney (Electric
//   Company, by Jail), the ferris wheel (Free Parking) and the water tower (Water Works, by Go To
//   Jail); parks with trees and a fountain between the districts; owner flags on the utilities and
//   the railway stations.
// * Ambient life (city-life.js): a steam train loops the board on the table and stops at four
//   stations, cars drive round the ring road, people stroll and wait on the platforms, birds circle,
//   street lamps and windows light up as dusk falls (the town asks the stage for dusk as it grows).
// * Hooks for the director: celebrate(group), pulse(tile), bankPulse(), focusPoint(tile).
//
// Building pieces are InstancedMeshes (one draw call per part type, ~15 for the whole town).
// Nothing that moves at idle casts shadows, so the idle loop never re-renders the shadow map.

import * as THREE from './three.js';
import { districts, districtPoint, DISTRICT_IN, DISTRICT_OUT } from './layout.js';
import { ease } from './tween.js';
import { Kit, rng } from './world-geo.js';
import { worldBus } from './world-quality.js';
import { districtGaps, LANDMARK_LOTS } from './board-texture.js';
import {
  FACADE, FLOOR_H, floorsH, styleOf, createFacade, bodyGeometry, gableGeometry, mansardGeometry,
  parapetGeometry, awningGeometry, chimneyGeometry, antennaGeometry, spireGeometry, crownGeometry,
  crownGlowGeometry, storeSignGeometry, saleSignGeometry, scaffoldGeometry, treeGeometry, flagGeometry,
} from './city-kit.js';
import { Particles, TrainLine, Traffic, Walkers, Birds, StreetLamps } from './city-life.js';

const OUTER_R = DISTRICT_OUT - 0.25; // front row of plots (next to the tiles)
const INNER_R = DISTRICT_IN + 0.22; // back row (next to the road)
const GROW_TIME = 0.8; // a building rising behind its scaffold
const SHRINK_TIME = 0.35;
const WHEEL_TURN_S = 26; // one turn of the ferris wheel
const CELEBRATE_S = 1.9;
const WHITE = new THREE.Color('#ffffff');
const GREY = new THREE.Color('#9a9d9b');
const VACANT_GREY = new THREE.Color('#b7b9b5');
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** Building heights for a property: [front, back] (0 = no building). Logical development height,
 * kept for tests (the visible heights depend on the group's style: see look()). */
export function plotHeights(owned, houses) {
  if (!owned) return [0, 0];
  if (houses >= 5) return [1.05, 0.62];
  return [0.32 + 0.1 * houses, houses ? 0.2 + 0.09 * houses : 0];
}

/** The level a plot shows: -1 for sale, 0..4 houses, 5 hotel. */
const levelOf = (owned, houses) => (owned ? Math.max(0, Math.min(5, houses | 0)) : -1);

export class City {
  /**
   * @param {THREE.Scene} scene
   * @param {object} BOARD parsed board.json
   * @param {object} deps { animator, markShadows, fx, renderer }
   */
  constructor(scene, BOARD, { animator, markShadows, fx = null, renderer = null }) {
    this.animator = animator;
    this.markShadows = markShadows;
    this.fx = fx;
    this.board = BOARD;
    this.bus = renderer ? worldBus(renderer) : null;
    /** When true (default) a colour set completed during an animated sync celebrates by itself,
     * ~1 s after its building rises. The director may set it false and call celebrate() itself. */
    this.autoCelebrate = true;
    /** Called as an automatic celebration starts: fn(group, seconds) — the director's cue for the
     * crowd's cheer and the "MONOPOLY!" callout. Not called while the animator is skipping. */
    this.onCelebrate = null;
    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);
    this.dummy = new THREE.Object3D();
    this.tmpColor = new THREE.Color();
    this.celebrated = new Map();
    this.monopolies = new Set();
    this.lastNow = -1;

    this.buildPlots(BOARD);
    this.buildMeshes(renderer);
    this.buildLandmarks(BOARD);

    // Particles and the ambient life.
    this.smoke = new Particles(120, { name: 'smoke' });
    this.sparks = new Particles(320, { name: 'sparks' }); // normal blending: visible in daylight too
    this.group.add(this.smoke.points, this.sparks.points);
    this.train = new TrainLine(this.group, BOARD, this.smoke);
    this.traffic = new Traffic(this.group, 12);
    this.walkers = new Walkers(this.group, this.train.stations, 30);
    this.birds = new Birds(this.group, 10);
    this.lamps = new StreetLamps(this.group);
    this.placeFlags();

    // Quality (density of life) and time of day (lights).
    this.offs = [];
    if (this.bus) {
      this.offs.push(this.bus.on('tier', (t) => this.setDensity(t.density)));
      this.offs.push(this.bus.on('dusk', () => this.setLights(this.bus.lights)));
      this.offs.push(this.bus.on('frame', (now) => this.ambient(now)));
      this.setDensity(this.bus.tier?.density ?? 0.67);
      this.setLights(this.bus.lights ?? 0);
    } else {
      this.setDensity(0.67);
    }
    this.plots.forEach((_, k) => this.writePlot(k));
    this.ambient(0);
  }

  // ---- construction -------------------------------------------------------------------------------

  buildPlots(BOARD) {
    this.plots = [];
    const rnd = rng(11);
    const groupNames = Object.keys(BOARD.groups ?? {});
    for (const d of districts(BOARD)) {
      const style = styleOf(d.group, groupNames.indexOf(d.group));
      const tint = new THREE.Color(d.color).lerp(WHITE, style.pastel);
      const roofColor = new THREE.Color(d.color).multiplyScalar(0.62);
      const tiles = d.tiles.slice().sort((a, b) => a - b);
      const n = tiles.length;
      const step = (d.a1 - d.a0) / n;
      const alongSign = d.side === 'bottom' || d.side === 'left' ? -1 : 1;
      // Local +z faces the road (inward).
      const yaw = Math.atan2(-d.out.x, -d.out.z);
      tiles.forEach((tile, k) => {
        const a = alongSign > 0 ? d.a0 + (k + 0.5) * step : d.a1 - (k + 0.5) * step;
        for (const [row, r] of [[0, OUTER_R], [1, INNER_R]]) {
          const jitter = (rnd() - 0.5) * 0.06;
          const p = districtPoint(d, a + jitter, r);
          const w = row === 0 ? Math.min(style.w, step * 0.82) : Math.min(style.w * 0.82, step * 0.72);
          const dep = row === 0 ? style.d : Math.min(0.3, style.d * 0.85);
          this.plots.push({
            tile,
            row,
            group: d.group,
            style,
            x: p.x,
            z: p.z,
            yaw,
            w,
            d: dep,
            seed: rnd(),
            tint,
            roofColor,
            level: -1, // shown
            mortgaged: false,
            wantLevel: -1,
            wantMortgaged: false,
            gen: 0,
            cur: null, // current look + animated values (see snapPlot)
          });
        }
      });
    }
    this.plotsByTile = new Map();
    this.plots.forEach((p, k) => {
      if (!this.plotsByTile.has(p.tile)) this.plotsByTile.set(p.tile, []);
      this.plotsByTile.get(p.tile).push(k);
    });
    for (const p of this.plots) p.cur = this.stateFor(p, -1, false);
  }

  buildMeshes(renderer) {
    const n = Math.max(1, this.plots.length);
    const facade = createFacade(renderer ?? { capabilities: { getMaxAnisotropy: () => 4 } });
    this.facade = facade;
    const partMat = new THREE.MeshStandardMaterial({ name: 'city-parts', vertexColors: true, roughness: 0.65 });
    const metalMat = new THREE.MeshStandardMaterial({ name: 'city-metal', vertexColors: true, roughness: 0.35, metalness: 0.6 });
    this.glowMat = new THREE.MeshBasicMaterial({ name: 'city-glow', color: '#8a8272' });
    const inst = (name, geo, mat, count, { shadow = true, color = true } = {}) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.name = name;
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      m.frustumCulled = false;
      if (color) m.setColorAt(0, WHITE);
      for (let k = 0; k < count; k++) m.setMatrixAt(k, ZERO);
      this.group.add(m);
      return m;
    };
    this.bodies = inst('buildings', bodyGeometry(), facade.material, n * 2);
    this.facadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2 * 4), 4);
    this.bodies.geometry.setAttribute('aFacade', this.facadeAttr);
    this.gables = inst('roofs-gable', gableGeometry(), partMat, n);
    this.mansards = inst('roofs-mansard', mansardGeometry(), partMat, n);
    this.parapets = inst('roofs-flat', parapetGeometry(), partMat, n);
    this.awnings = inst('awnings', awningGeometry(), partMat, n, { shadow: false });
    this.chimneys = inst('chimneys', chimneyGeometry(), partMat, n);
    this.antennas = inst('antennas', antennaGeometry(), metalMat, n);
    this.spires = inst('spires', spireGeometry(), metalMat, n);
    this.crowns = inst('crowns', crownGeometry(), partMat, n);
    this.crownGlow = inst('crown-glow', crownGlowGeometry(), this.glowMat, n, { shadow: false, color: false });
    this.storeSigns = inst('store-signs', storeSignGeometry(), partMat, n);
    this.saleSigns = inst('sale-signs', saleSignGeometry(), partMat, n, { shadow: false });
    this.scaffolds = inst('scaffolds', scaffoldGeometry(), partMat, n, { shadow: false });
    this.partMat = partMat;
    this.metalMat = metalMat;
  }

  // ---- looks ------------------------------------------------------------------------------------

  /**
   * What a plot should look like at `level` (-1 for sale … 5 hotel), `mortgaged`: the building's
   * parts and sizes. Returns a fresh state object with animated fields at their resting values.
   */
  stateFor(p, level, mortgaged) {
    const s = p.style;
    const st = {
      level,
      mortgaged,
      col: s.facade,
      color: p.tint.clone(),
      roofColor: p.roofColor.clone(),
      lit: 0,
      w: p.w,
      d: p.d,
      h: 0,
      upper: null,
      roof: null,
      roofH: 0,
      chimney: false,
      awning: false,
      antenna: 0,
      spire: 0,
      crown: false,
      storeSign: false,
      sign: false,
      tree: false,
      // Animated (0..1 scales, multipliers):
      hK: 1, // body height factor
      partK: 1, // roofs and extras
      signK: 1,
      treeK: 1,
      scaffK: 0,
      scaffH: 0,
      bounce: 1,
      flash: false,
    };
    if (level < 0) {
      if (p.row === 0) {
        st.col = FACADE.VACANT;
        st.color.copy(VACANT_GREY);
        st.roofColor.copy(VACANT_GREY);
        st.w = Math.min(p.w, 0.34);
        st.d = Math.min(p.d, 0.3);
        st.h = floorsH(1);
        st.roof = 'flat';
        st.sign = true;
      } else {
        st.tree = true;
      }
      return st;
    }
    const hotel = level === 5 && p.row === 0;
    const floors = hotel ? s.hotel : (p.row === 0 ? s.front : s.back)[Math.min(4, level)];
    if (!floors) {
      st.tree = true;
      return st;
    }
    st.lit = hotel ? 0.8 : 0.28 + 0.1 * Math.min(4, level);
    if (hotel) {
      st.col = FACADE.HOTEL;
      st.w = p.w * 1.08;
      st.d = p.d * 1.06;
      st.color.copy(p.tint).lerp(WHITE, 0.25);
    }
    let main = floors;
    if (s.setback && floors >= s.setback) {
      main = Math.ceil(floors * 0.62);
      st.upper = { w: st.w * 0.72, d: st.d * 0.78, h: floors === main ? 0 : (floors - main) * FLOOR_H };
    }
    st.h = floorsH(main);
    if (hotel) {
      st.crown = true;
      st.roof = 'flat';
    } else {
      st.roof = s.roof;
      st.roofH = (s.roofH ?? 0) * (st.w / 0.42);
      st.chimney = !!s.chimney && p.row === 0;
      st.awning = !!s.awning;
      st.storeSign = !!s.sign && p.row === 0 && level >= 1;
      if (s.antenna && floors >= s.antenna) st.antenna = 0.1 + 0.012 * floors;
      if (s.spire && p.row === 0 && floors >= 7) st.spire = 0.16 + 0.012 * floors;
    }
    if (mortgaged) {
      st.col = FACADE.BOARDED;
      st.color.lerp(GREY, 0.72);
      st.roofColor.lerp(GREY, 0.72);
      st.lit = 0;
      st.storeSign = false;
    }
    return st;
  }

  /** Total visible height of a plot's building (for focus points / scaffolds). */
  static topOf(st) {
    return (st.h + (st.upper?.h ?? 0)) * st.hK;
  }

  // ---- instance writing -----------------------------------------------------------------------------

  /** Writes every instance of plot k from its current state. */
  writePlot(k) {
    const p = this.plots[k];
    const st = p.cur;
    const d = this.dummy;
    const b = st.bounce;
    const cos = Math.cos(p.yaw);
    const sin = Math.sin(p.yaw);
    const put = (mesh, slot, lx, y, lz, sx, sy, sz, color = null) => {
      if (!(sx > 1e-4 && sy > 1e-4 && sz > 1e-4)) {
        mesh.setMatrixAt(slot, ZERO);
        return;
      }
      d.position.set(p.x + lx * cos + lz * sin, y, p.z - lx * sin + lz * cos);
      d.rotation.set(0, p.yaw, 0);
      d.scale.set(sx, sy, sz);
      d.updateMatrix();
      mesh.setMatrixAt(slot, d.matrix);
      if (color && mesh.instanceColor) mesh.setColorAt(slot, color);
    };
    const mainH = st.h * st.hK * b;
    const upperH = (st.upper?.h ?? 0) * st.hK * b;
    const top = mainH + upperH;
    const lit = st.flash ? 2 : st.lit;
    // Bodies (slot 2k main, 2k+1 upper setback).
    put(this.bodies, 2 * k, 0, 0, 0, st.w, mainH, st.d, st.color);
    this.facadeAttr.setXYZW(2 * k, st.col, p.seed, lit, b * Math.max(0.2, st.hK));
    if (st.upper && upperH > 1e-4) {
      put(this.bodies, 2 * k + 1, 0, mainH, 0, st.upper.w, upperH, st.upper.d, st.color);
      this.facadeAttr.setXYZW(2 * k + 1, st.col, p.seed + 0.5, lit, b * Math.max(0.2, st.hK));
    } else {
      this.bodies.setMatrixAt(2 * k + 1, ZERO);
    }
    const tw = st.upper && upperH > 1e-4 ? st.upper.w : st.w;
    const td = st.upper && upperH > 1e-4 ? st.upper.d : st.d;
    const pk = st.partK * (top > 1e-3 ? 1 : 0);
    // Roofs.
    put(this.gables, k, 0, top, 0, st.roof === 'gable' ? st.w : 0, st.roofH * pk * b, st.d, st.roofColor);
    put(this.mansards, k, 0, top, 0, st.roof === 'mansard' ? st.w : 0, st.roofH * pk * b, st.d, st.roofColor);
    const flatColor = this.tmpColor.copy(st.color).lerp(WHITE, 0.4);
    put(this.parapets, k, 0, top, 0, st.roof === 'flat' || st.crown ? tw : 0, 0.028 * pk * b, td, flatColor);
    put(this.chimneys, k, st.w * 0.22, top + st.roofH * 0.35 * pk * b, -st.d * 0.12, st.chimney ? pk : 0, pk, pk, st.roofColor);
    put(this.awnings, k, 0, floorsH(1) * 0.95 * st.hK * b - 0.1 * pk, 0, st.awning ? st.w : 0, pk, st.d, st.color);
    put(this.antennas, k, tw * 0.18, top, -td * 0.1, st.antenna ? pk : 0, st.antenna * pk, pk);
    put(this.spires, k, 0, top, 0, st.spire ? tw : 0, st.spire * pk, td);
    put(this.crowns, k, 0, top, 0, st.crown ? tw : 0, 0.2 * pk * b, st.crown ? td : 0, st.roofColor);
    put(this.crownGlow, k, 0, top, 0, st.crown && !st.mortgaged ? tw : 0, 0.2 * pk * b, st.crown ? td : 0);
    put(this.storeSigns, k, 0, top, -td * 0.1, st.storeSign ? tw : 0, 0.16 * pk, pk, st.color);
    put(this.saleSigns, k, st.w / 2 + 0.03, 0, st.d * 0.35, st.sign ? st.signK * 1.3 : 0, st.signK * 1.3, st.signK * 1.3);
    put(this.scaffolds, k, 0, 0, 0, st.scaffK > 0 ? st.w * 1.1 : 0, st.scaffH * st.scaffK, st.d * 1.1);
    // Trees on empty plots (slots [0, plots) of the tree mesh).
    put(this.trees, k, 0, 0, 0, st.tree ? st.treeK * (0.85 + p.seed * 0.4) : 0, st.treeK * (0.85 + p.seed * 0.4), st.treeK * (0.85 + p.seed * 0.4));
    for (const m of [this.bodies, this.gables, this.mansards, this.parapets, this.chimneys, this.awnings, this.antennas, this.spires, this.crowns, this.crownGlow, this.storeSigns, this.saleSigns, this.scaffolds, this.trees]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.facadeAttr.needsUpdate = true;
  }

  // ---- sync -------------------------------------------------------------------------------------

  /** Reconciles every plot, flag and the time of day with the state (animated: builds / shrinks). */
  sync(ctx, animate) {
    let changed = false;
    const owners = new Map(); // group → Set of owners (for completed sets)
    const counts = new Map(); // group → property count
    for (const t of this.board.tiles) {
      if (t.type !== 'property') continue;
      counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
      const ts = ctx.tileState.get(t.index);
      const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
      if (!owners.has(t.group)) owners.set(t.group, new Map());
      if (owner) owners.get(t.group).set(owner, (owners.get(t.group).get(owner) ?? 0) + 1);
    }
    this.plots.forEach((p, k) => {
      const ts = ctx.tileState.get(p.tile);
      const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
      const level = levelOf(!!owner, Number(ts?.houses) || 0);
      const mortgaged = !!(owner && ts.mortgaged);
      if (level === p.wantLevel && mortgaged === p.wantMortgaged) return;
      p.wantLevel = level;
      p.wantMortgaged = mortgaged;
      changed = true;
      if (animate) this.transition(k, level, mortgaged, p.row * 0.14);
      else this.snapPlot(k, level, mortgaged);
    });

    // Completed colour sets.
    const now = new Set();
    for (const [group, m] of owners) {
      for (const c of m.values()) if (c === counts.get(group) && c > 0) now.add(group);
    }
    if (animate && this.autoCelebrate) {
      let j = 0; // several sets at once (a bankrupt's estate): one district after another
      for (const g of now) {
        if (this.monopolies.has(g)) continue;
        this.animator.at(GROW_TIME + 0.35 + 0.9 * j++, () => {
          const s = this.celebrate(g);
          if (s > 0 && !this.animator.finishing) this.onCelebrate?.(g, s);
        });
      }
    }
    this.monopolies = now;

    changed = this.syncFlags(ctx, animate) || changed;
    this.syncDusk(ctx, animate);
    if (changed) this.markShadows();
    return changed;
  }

  /** Jumps plot k to its look at once. */
  snapPlot(k, level, mortgaged) {
    const p = this.plots[k];
    p.gen++;
    p.level = level;
    p.mortgaged = mortgaged;
    p.cur = this.stateFor(p, level, mortgaged);
    this.writePlot(k);
  }

  /**
   * Animates plot k to (level, mortgaged): for-sale lots clear, buildings rise behind scaffolding
   * (dust puffs), shrink when houses are sold, grey out when mortgaged. ~1.3 s for a new building.
   * A newer transition on the same plot supersedes this one (generation check).
   */
  transition(k, level, mortgaged, delay = 0) {
    const p = this.plots[k];
    const gen = ++p.gen;
    const A = this.animator;
    const live = () => p.gen === gen;
    const write = () => this.writePlot(k);
    const from = p.cur;
    const fromLevel = p.level;
    p.level = level;
    p.mortgaged = mortgaged;
    const to = this.stateFor(p, level, mortgaged);
    const fromTop = City.topOf(from);
    const targetTop = City.topOf(to);
    const base = this.worldAt(p, 0, 0, 0.02);
    const finish = () => {
      if (!live()) return;
      p.cur = this.stateFor(p, level, mortgaged);
      write();
      this.markShadows();
    };

    // Only the mortgage flag changed: a quick squash while the facade swaps.
    if (fromLevel === level) {
      A.add({
        delay,
        duration: 0.36,
        easing: ease.inOutSine,
        update: (e) => {
          if (!live()) return;
          if (e >= 0.5 && p.cur !== to) {
            to.bounce = p.cur.bounce;
            p.cur = to;
          }
          p.cur.bounce = 1 - 0.1 * Math.sin(Math.PI * e);
          write();
          this.markShadows();
        },
        end: finish,
      });
      if (targetTop > 1e-3) this.fx?.puff(base, delay + 0.12, 0.5);
      return;
    }

    const sameShape = to.col === from.col && to.roof === from.roof && to.crown === from.crown && !!to.upper === !!from.upper;
    const changes = Math.abs(targetTop - fromTop) > 1e-4 || !sameShape || to.tree !== from.tree || to.sign !== from.sign || to.storeSign !== from.storeSign;
    if (!changes) {
      // Nothing visible changes on this plot (e.g. the back plot when a hotel replaces 4 houses).
      finish();
      return;
    }
    const clearFirst = fromLevel < 0 || !sameShape || (from.tree && !to.tree) || targetTop < 1e-3;
    const growing = targetTop > 1e-3 && (fromLevel < 0 || targetTop > fromTop + 1e-4 || !sameShape);
    // A building that only gets taller (or restyled, e.g. into a hotel) keeps standing while its
    // roof comes off; a lot, a tree or a building being replaced by a lower one is flattened first.
    const keepBody = growing && fromLevel >= 0 && fromTop > 1e-3 && targetTop >= fromTop;
    let t = delay;
    if (clearFirst && (fromTop > 1e-3 || from.tree || from.sign)) {
      const dur = keepBody ? 0.18 : 0.26;
      A.add({
        delay: t,
        duration: dur,
        easing: ease.inQuad,
        start: () => {
          if (live()) p.cur = from;
        },
        update: (e) => {
          if (!live()) return;
          from.signK = 1 - e;
          from.treeK = 1 - e;
          from.partK = 1 - e;
          if (!keepBody) from.hK = 1 - e;
          write();
          this.markShadows();
        },
      });
      if (fromTop > 1e-3 && !keepBody) this.fx?.puff(base, t + 0.05, 0.7);
      t += dur;
    }

    if (growing) {
      // Construction: scaffold up, the building rises inside it, roof pops, scaffold comes down.
      const startTop = keepBody || !clearFirst ? Math.min(fromTop, targetTop) : 0;
      const st = this.stateFor(p, level, mortgaged);
      st.partK = 0;
      st.tree = false;
      st.scaffH = targetTop + 0.03;
      const h0 = Math.min(1, startTop / targetTop);
      A.add({
        delay: t,
        duration: 0.16,
        easing: ease.outCubic,
        start: () => {
          if (!live()) return;
          st.hK = h0;
          st.scaffK = 0;
          p.cur = st;
        },
        update: (e) => {
          if (!live()) return;
          st.scaffK = e;
          write();
        },
      });
      this.fx?.puff(base, t + 0.1, 0.9);
      A.add({
        delay: t + 0.12,
        duration: GROW_TIME,
        easing: ease.inOutCubic,
        update: (e) => {
          if (!live()) return;
          st.hK = h0 + (1 - h0) * e;
          write();
          this.markShadows();
        },
      });
      this.fx?.puff(base, t + 0.12 + GROW_TIME * 0.6, 0.6);
      A.add({
        delay: t + 0.12 + GROW_TIME,
        duration: 0.3,
        easing: ease.outBack,
        update: (e) => {
          if (!live()) return;
          st.hK = 1;
          st.partK = e;
          st.scaffK = 1 - Math.min(1, e * 1.6);
          write();
          this.markShadows();
        },
        end: finish,
      });
      if (level === 5 && p.row === 0) {
        A.at(t + 0.12 + GROW_TIME + 0.2, () => {
          if (!live()) return;
          this.walkers.cheer(1.2);
          this.burst(this.worldAt(p, 0, 0, targetTop + 0.25), p.tint, 26, 0.9);
        });
      }
      return;
    }

    // Lower (houses sold), a lot for sale again, or a tree.
    const st = this.stateFor(p, level, mortgaged);
    if (!clearFirst && fromTop > targetTop) {
      const k0 = fromTop / targetTop;
      st.partK = 0;
      A.add({
        delay: t,
        duration: SHRINK_TIME,
        easing: ease.inQuad,
        start: () => {
          if (!live()) return;
          st.hK = k0;
          p.cur = st;
        },
        update: (e) => {
          if (!live()) return;
          st.hK = k0 + (1 - k0) * e;
          write();
          this.markShadows();
        },
      });
      this.fx?.puff(base, t + 0.08, 0.8);
      t += SHRINK_TIME;
      A.add({
        delay: t,
        duration: 0.25,
        easing: ease.outBack,
        update: (e) => {
          if (!live()) return;
          st.hK = 1;
          st.partK = e;
          write();
          this.markShadows();
        },
        end: finish,
      });
      return;
    }
    A.add({
      delay: t,
      duration: 0.32,
      easing: ease.outBack,
      start: () => {
        if (live()) p.cur = st;
      },
      update: (e) => {
        if (!live()) return;
        st.hK = e;
        st.partK = e;
        st.signK = e;
        st.treeK = e;
        write();
        this.markShadows();
      },
      end: finish,
    });
  }

  /** Snaps everything back to for-sale lots (a different game). */
  reset() {
    this.plots.forEach((p, k) => {
      p.wantLevel = -1;
      p.wantMortgaged = false;
      this.snapPlot(k, -1, false);
    });
    this.flags.forEach((f, k) => {
      f.owner = null;
      f.k = 0;
      this.writeFlag(k);
    });
    this.monopolies = new Set();
    this.celebrated.clear();
    this.smoke.clear();
    this.sparks.clear();
    this.bus?.emit('duskTarget', { value: DUSK_START, instant: true });
    this.markShadows();
  }

  // ---- flags on the utilities and stations --------------------------------------------------------

  placeFlags() {
    const spots = [];
    for (const st of this.train.stations) spots.push({ tile: st.tile, ...this.train.flagSpot(st) });
    const util = (this.board.tiles ?? []).filter((t) => t.type === 'utility');
    for (const u of util) {
      const water = /water/i.test(u.name);
      const lot = water ? LANDMARK_LOTS.gotojail : LANDMARK_LOTS.jail;
      spots.push({ tile: u.index, x: lot.x + (water ? 0.22 : -0.28), y: water ? 0.98 : 0.42, z: lot.z + (water ? 0.22 : 0.05) });
    }
    this.flagSpots = spots;
    this.flagMesh = new THREE.InstancedMesh(flagGeometry(), new THREE.MeshStandardMaterial({ name: 'flags', vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), Math.max(1, spots.length));
    this.flagMesh.frustumCulled = false;
    this.flagMesh.setColorAt(0, WHITE);
    this.group.add(this.flagMesh);
    // Poles (static).
    const kit = new Kit();
    for (const s of spots) kit.add(new THREE.CylinderGeometry(0.006, 0.008, 0.34, 5), { x: s.x, y: s.y - 0.17 + 0.3, z: s.z, color: '#cfd2d4' });
    const poles = new THREE.Mesh(kit.build(), this.metalMat);
    poles.name = 'flag-poles';
    this.group.add(poles);
    this.flags = spots.map(() => ({ owner: null, color: new THREE.Color('#ffffff'), k: 0, mortgaged: false }));
    this.flags.forEach((_, k) => this.writeFlag(k));
  }

  writeFlag(k, wave = 0) {
    const s = this.flagSpots[k];
    const f = this.flags[k];
    const d = this.dummy;
    if (f.k <= 1e-3) {
      this.flagMesh.setMatrixAt(k, ZERO);
    } else {
      // The flag climbs the pole (k: 0 → 1); mortgaged flags fly at half mast, greyed.
      const mast = f.mortgaged ? 0.55 : 1;
      d.position.set(s.x, s.y - 0.27 + 0.3 * (0.2 + 0.8 * f.k * mast) - 0.0, s.z);
      d.rotation.set(0, wave, 0);
      d.scale.set(1.5, 1.5 * Math.min(1, f.k * 1.5), 1.5);
      d.updateMatrix();
      this.flagMesh.setMatrixAt(k, d.matrix);
      this.tmpColor.copy(f.color);
      if (f.mortgaged) this.tmpColor.lerp(GREY, 0.7);
      this.flagMesh.setColorAt(k, this.tmpColor);
    }
    this.flagMesh.instanceMatrix.needsUpdate = true;
    if (this.flagMesh.instanceColor) this.flagMesh.instanceColor.needsUpdate = true;
  }

  syncFlags(ctx, animate) {
    let changed = false;
    this.flagSpots.forEach((s, k) => {
      const ts = ctx.tileState.get(s.tile);
      const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
      const color = owner ? ctx.colorOf.get(owner) : null;
      const mortgaged = !!(owner && ts.mortgaged);
      const f = this.flags[k];
      const colorChanged = owner && color && f.color.getHex() !== this.tmpColor.set(color).getHex();
      if (f.owner === owner && f.mortgaged === mortgaged && !colorChanged) return;
      changed = true;
      const had = !!f.owner;
      f.owner = owner;
      f.mortgaged = mortgaged;
      if (color) f.color.set(color);
      const target = owner ? 1 : 0;
      if (!animate) {
        f.k = target;
        this.writeFlag(k);
        return;
      }
      const from = had && owner ? 0 : f.k; // a new owner hoists a fresh flag
      this.animator.add({
        duration: 0.7,
        easing: target ? ease.outCubic : ease.inQuad,
        update: (e) => {
          f.k = from + (target - from) * e;
          this.writeFlag(k);
        },
        end: () => {
          f.k = target;
          this.writeFlag(k);
        },
      });
    });
    return changed;
  }

  // ---- time of day ------------------------------------------------------------------------------

  /** Asks the stage for dusk as the town develops: golden afternoon → blue hour. */
  syncDusk(ctx, animate) {
    if (!this.bus) return;
    let owned = 0;
    let ownable = 0;
    let units = 0;
    for (const t of this.board.tiles) {
      if (t.type !== 'property' && t.type !== 'railroad' && t.type !== 'utility') continue;
      ownable++;
      const ts = ctx.tileState.get(t.index);
      if (ts?.ownerId && ctx.byId.has(ts.ownerId)) {
        owned++;
        units += Math.max(0, Math.min(5, Number(ts.houses) || 0));
      }
    }
    const dev = 0.45 * (ownable ? owned / ownable : 0) + 0.55 * Math.min(1, units / 40);
    const finished = ctx.state?.status === 'finished';
    const value = finished ? 0.9 : DUSK_START + (DUSK_END - DUSK_START) * dev;
    this.bus.emit('duskTarget', { value, instant: !animate });
  }

  setLights(v) {
    const on = Math.min(1, Math.max(0, v));
    this.facade.uniforms.uLights.value = on;
    this.lamps.setLights(on);
    this.glowMat.color.copy(GLOW_OFF).lerp(GLOW_ON, on);
    this.landGlowMat.color.copy(GLOW_OFF).lerp(GLOW_ON, Math.max(on, 0.08));
  }

  setDensity(density) {
    const dd = Math.min(1, Math.max(0, Number(density) || 0));
    this.traffic.setCount(Math.round(12 * dd));
    this.walkers.setCount(Math.round(30 * dd));
    this.birds.setCount(dd < 0.5 ? 0 : Math.round(10 * dd));
  }

  // ---- landmarks -----------------------------------------------------------------------------------

  buildLandmarks(BOARD) {
    const kit = new Kit(); // static, vertex-coloured, casts shadows
    const glow = new Kit(); // lamps / windows that light up at dusk
    const trees = [];
    // Bank (GO corner), facing the centre.
    {
      const L = LANDMARK_LOTS.go;
      const ry = Math.atan2(-L.x, -L.z);
      const b = new Kit();
      const stone = '#efe7d6';
      b.add(new THREE.BoxGeometry(0.8, 0.035, 0.64), { y: 0.0175, color: '#d9cfbb' });
      b.add(new THREE.BoxGeometry(0.74, 0.035, 0.58), { y: 0.052, color: '#e6dcc8' });
      b.add(new THREE.BoxGeometry(0.62, 0.3, 0.4), { y: 0.22, z: -0.05, color: stone });
      for (let c = 0; c < 6; c++) b.add(new THREE.CylinderGeometry(0.022, 0.026, 0.27, 10), { x: -0.26 + c * 0.104, y: 0.205, z: 0.21, color: '#faf6ec' });
      b.add(new THREE.BoxGeometry(0.68, 0.05, 0.56), { y: 0.365, z: 0, color: stone });
      const ped = new THREE.Shape();
      ped.moveTo(-0.34, 0);
      ped.lineTo(0.34, 0);
      ped.lineTo(0, 0.13);
      ped.closePath();
      b.add(new THREE.ExtrudeGeometry(ped, { depth: 0.56, bevelEnabled: false }).translate(0, 0, -0.28), { y: 0.39, color: '#e8dfcb' });
      b.add(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 16), { y: 0.47, z: -0.05, color: '#b9c4c9' });
      b.add(new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), { y: 0.5, z: -0.05, color: '#8fb1bd' });
      kit.addKit(b, { x: L.x, z: L.z, ry });
      // Gold medallion on the pediment (glows).
      const m = new THREE.Matrix4().makeRotationY(ry).setPosition(L.x, 0, L.z);
      glow.add(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 16).rotateX(Math.PI / 2).translate(0, 0.445, 0.285).applyMatrix4(m), { color: '#ffd36b' });
      this.bankSpot = new THREE.Vector3(L.x, 0.5, L.z);
    }
    // Power plant (Jail corner): turbine hall, striped chimney, cooling tower.
    {
      const L = LANDMARK_LOTS.jail;
      const ry = Math.atan2(-L.x, -L.z);
      const b = new Kit();
      b.add(new THREE.BoxGeometry(0.58, 0.26, 0.38), { x: -0.08, y: 0.13, z: 0.05, color: '#a2563f' });
      const r = new THREE.Shape();
      r.moveTo(-0.21, 0);
      r.lineTo(0.21, 0);
      r.lineTo(0, 0.1);
      r.closePath();
      b.add(new THREE.ExtrudeGeometry(r, { depth: 0.62, bevelEnabled: false }).translate(0, 0, -0.31).rotateY(Math.PI / 2), { x: -0.08, y: 0.26, z: 0.05, color: '#5d6770' });
      for (let k = 0; k < 4; k++) b.add(new THREE.BoxGeometry(0.07, 0.1, 0.01), { x: -0.3 + k * 0.145, y: 0.14, z: 0.245, color: '#2e3b48' });
      // Chimney with red/white bands.
      for (let k = 0; k < 7; k++) {
        const r0 = 0.062 - k * 0.004;
        b.add(new THREE.CylinderGeometry(r0 - 0.004, r0, 0.15, 12), { x: 0.3, y: 0.075 + k * 0.15, z: -0.1, color: k % 2 ? '#f4f1ea' : '#c8352b' });
      }
      // Cooling tower (hyperboloid-ish lathe).
      const prof = [[0.2, 0], [0.16, 0.12], [0.13, 0.26], [0.135, 0.36], [0.15, 0.44]].map(([x, y]) => new THREE.Vector2(x, y));
      b.add(new THREE.LatheGeometry(prof, 18), { x: 0.2, y: 0, z: 0.25, color: '#c9cbc6' });
      // Transformer yard.
      for (let k = 0; k < 3; k++) b.add(new THREE.BoxGeometry(0.07, 0.08, 0.07), { x: -0.32 + k * 0.1, y: 0.04, z: -0.28, color: '#7d8a90' });
      kit.addKit(b, { x: L.x, z: L.z, ry });
      const m = new THREE.Matrix4().makeRotationY(ry).setPosition(L.x, 0, L.z);
      this.chimneyTop = new THREE.Vector3(0.3, 1.1, -0.1).applyMatrix4(m);
      this.towerTop = new THREE.Vector3(0.2, 0.46, 0.25).applyMatrix4(m);
      for (let k = 0; k < 4; k++) glow.add(new THREE.BoxGeometry(0.06, 0.08, 0.006).translate(-0.3 + k * 0.145, 0.14, 0.252).applyMatrix4(m), { color: '#ffd9a0' });
      this.plantSpot = new THREE.Vector3(L.x, 0.6, L.z);
    }
    // Water tower (Go To Jail corner).
    {
      const L = LANDMARK_LOTS.gotojail;
      const b = new Kit();
      const steel = '#6f93ad';
      for (const [x, z] of [[-0.16, -0.16], [0.16, -0.16], [0.16, 0.16], [-0.16, 0.16]]) {
        const len = 0.64;
        b.add(new THREE.CylinderGeometry(0.014, 0.018, len, 6), { x: x * 1.2, y: len / 2, z: z * 1.2, rx: z * 0.2, rz: -x * 0.2, color: '#5b6f7c' });
      }
      for (const y of [0.22, 0.42]) {
        b.add(new THREE.BoxGeometry(0.38, 0.012, 0.012), { y, z: 0.17, color: '#5b6f7c' });
        b.add(new THREE.BoxGeometry(0.38, 0.012, 0.012), { y, z: -0.17, color: '#5b6f7c' });
        b.add(new THREE.BoxGeometry(0.012, 0.012, 0.38), { y, x: 0.17, color: '#5b6f7c' });
        b.add(new THREE.BoxGeometry(0.012, 0.012, 0.38), { y, x: -0.17, color: '#5b6f7c' });
      }
      b.add(new THREE.CylinderGeometry(0.24, 0.24, 0.28, 20), { y: 0.78, color: steel });
      b.add(new THREE.CylinderGeometry(0.245, 0.245, 0.03, 20), { y: 0.7, color: '#b86b47' });
      b.add(new THREE.ConeGeometry(0.26, 0.14, 20), { y: 0.99, color: '#56788f' });
      b.add(new THREE.CylinderGeometry(0.2, 0.18, 0.05, 20), { y: 0.62, color: '#56788f' });
      kit.addKit(b, { x: L.x, z: L.z });
      this.towerSpot = new THREE.Vector3(L.x, 0.8, L.z);
      trees.push([L.x - 0.34, L.z + 0.3, 0.9], [L.x + 0.3, L.z + 0.34, 0.8]);
    }
    // Parks between the districts: trees along the path; a fountain in the widest one.
    const gaps = districtGaps(BOARD).sort((a, b) => (b.a1 - b.a0) - (a.a1 - a.a0));
    gaps.forEach((g, gi) => {
      const len = g.a1 - g.a0;
      const n = Math.max(1, Math.floor(len / 0.38));
      for (let k = 0; k < n; k++) {
        const a = g.a0 + ((k + 0.5) / n) * len;
        for (const r of [DISTRICT_IN + 0.14, DISTRICT_OUT - 0.14]) {
          if (gi === 0 && Math.abs(a - (g.a0 + g.a1) / 2) < 0.3) continue;
          const pt = districtPoint(g, a, r);
          trees.push([pt.x, pt.z, 0.8 + ((k * 7 + r * 10) % 3) * 0.12]);
        }
      }
      if (gi === 0) {
        const c = districtPoint(g, (g.a0 + g.a1) / 2, (DISTRICT_IN + DISTRICT_OUT) / 2);
        kit.add(new THREE.CylinderGeometry(0.2, 0.22, 0.05, 24), { x: c.x, y: 0.025, z: c.z, color: '#d8d2c4' });
        kit.add(new THREE.CylinderGeometry(0.17, 0.17, 0.052, 24), { x: c.x, y: 0.028, z: c.z, color: '#7fc4e6' });
        kit.add(new THREE.CylinderGeometry(0.03, 0.04, 0.14, 10), { x: c.x, y: 0.07, z: c.z, color: '#d8d2c4' });
        kit.add(new THREE.SphereGeometry(0.05, 10, 6), { x: c.x, y: 0.16, z: c.z, color: '#9fd6ef' });
        this.fountain = new THREE.Vector3(c.x, 0.2, c.z);
      }
    });
    // Trees by the bank and the fair.
    trees.push([LANDMARK_LOTS.go.x + 0.38, LANDMARK_LOTS.go.z - 0.3, 0.8], [LANDMARK_LOTS.go.x - 0.3, LANDMARK_LOTS.go.z + 0.38, 0.8]);
    trees.push([LANDMARK_LOTS.parking.x + 0.38, LANDMARK_LOTS.parking.z + 0.34, 0.85]);

    const land = new THREE.Mesh(kit.build(), new THREE.MeshStandardMaterial({ name: 'landmarks', vertexColors: true, roughness: 0.7 }));
    land.name = 'landmarks';
    land.castShadow = true;
    land.receiveShadow = true;
    this.landGlowMat = new THREE.MeshBasicMaterial({ name: 'landmark-glow', vertexColors: true, color: '#8a8272' });
    const landGlow = new THREE.Mesh(glow.build(), this.landGlowMat);
    landGlow.name = 'landmark-glow';
    this.group.add(land, landGlow);

    // Trees: slots [0, plots) belong to the plots, the rest are the parks'.
    const n = this.plots.length;
    this.trees = new THREE.InstancedMesh(treeGeometry(), this.partMat, n + trees.length);
    this.trees.name = 'trees';
    this.trees.castShadow = true;
    this.trees.receiveShadow = true;
    this.trees.frustumCulled = false;
    const d = this.dummy;
    for (let k = 0; k < n; k++) this.trees.setMatrixAt(k, ZERO);
    trees.forEach(([x, z, s], j) => {
      d.position.set(x, 0, z);
      d.rotation.set(0, j * 1.7, 0);
      d.scale.setScalar(s);
      d.updateMatrix();
      this.trees.setMatrixAt(n + j, d.matrix);
    });
    this.group.add(this.trees);

    // Ferris wheel (Free Parking corner), facing the centre.
    this.wheel = buildWheel(this.partMat, this.landGlowMat);
    const L = LANDMARK_LOTS.parking;
    this.wheel.root.position.set(L.x, 0, L.z);
    this.wheel.root.rotation.y = Math.atan2(-L.x, -L.z) + Math.PI / 2;
    this.group.add(this.wheel.root);
    this.wheelSpot = new THREE.Vector3(L.x, 0.9, L.z);
  }

  // ---- director hooks --------------------------------------------------------------------------------

  /**
   * A completed colour set: the district's buildings bounce in a wave, every window flashes, a few
   * fireworks burst above it and the townsfolk cheer. Returns its duration (s); a second call for
   * the same group within 3 s is ignored (returns 0). Plays no sound (the director plays 'cheer').
   */
  celebrate(group) {
    const nowMs = performance.now();
    if ((this.celebrated.get(group) ?? -1e9) > nowMs - 3000) return 0;
    this.celebrated.set(group, nowMs);
    const ks = this.plots.map((p, k) => (p.group === group ? k : -1)).filter((k) => k >= 0);
    if (!ks.length) return 0;
    const color = this.plots[ks[0]].tint;
    ks.forEach((k, j) => {
      const p = this.plots[k];
      this.animator.add({
        delay: j * 0.07,
        duration: 0.75,
        easing: ease.linear,
        start: () => {
          p.cur.flash = true;
        },
        update: (e) => {
          p.cur.bounce = 1 + 0.2 * Math.sin(Math.PI * e) * (1 - 0.4 * e);
          this.writePlot(k);
          this.markShadows();
        },
        end: () => {
          p.cur.bounce = 1;
          this.writePlot(k);
          this.markShadows();
        },
      });
      this.animator.at(1.4 + j * 0.05, () => {
        p.cur.flash = false;
        this.writePlot(k);
      });
    });
    // Fireworks over the district's middle.
    let cx = 0;
    let cz = 0;
    for (const k of ks) {
      cx += this.plots[k].x;
      cz += this.plots[k].z;
    }
    cx /= ks.length;
    cz /= ks.length;
    [0, 0.4, 0.8].forEach((t, j) => {
      const at = new THREE.Vector3(cx * 0.92 + (j - 1) * 0.55, 1.5 + j * 0.3, cz * 0.92);
      this.animator.at(t, () => this.rocket(at));
      this.animator.at(t + 0.45, () => this.burst(at, j === 1 ? GOLD : color, 60, 1.25));
    });
    this.walkers.cheer(CELEBRATE_S);
    return CELEBRATE_S;
  }

  /** A property's buildings bounce once (e.g. rent was paid there). Returns 0.5 (s). */
  pulse(tile) {
    for (const k of this.plotsByTile.get(tile) ?? []) {
      const p = this.plots[k];
      this.animator.add({
        duration: 0.5,
        update: (e) => {
          p.cur.bounce = 1 + 0.12 * Math.sin(Math.PI * e);
          this.writePlot(k);
          this.markShadows();
        },
        end: () => {
          p.cur.bounce = 1;
          this.writePlot(k);
        },
      });
    }
    return 0.5;
  }

  /** The Bank sparkles (passing GO / collecting salary). Returns 0.8 (s). */
  bankPulse() {
    this.burst(this.bankSpot.clone().add(new THREE.Vector3(0, 0.2, 0)), GOLD, 30, 0.7);
    return 0.8;
  }

  /**
   * World point to frame for a tile's development: the top of its tallest building (properties),
   * its station (railroads) or its landmark (utilities); null for other tiles.
   */
  focusPoint(tile) {
    const ks = this.plotsByTile.get(tile);
    if (ks) {
      let best = null;
      for (const k of ks) {
        const p = this.plots[k];
        const top = Math.max(0.15, City.topOf(this.stateFor(p, p.wantLevel, p.wantMortgaged)));
        if (!best || top > best.y) best = new THREE.Vector3(p.x, top, p.z);
      }
      return best;
    }
    const st = this.train.stations.find((s) => s.tile === tile);
    if (st) return new THREE.Vector3(st.x, 0.3, st.z);
    const t = this.board.tiles?.[tile];
    if (t?.type === 'utility') return (/water/i.test(t.name) ? this.towerSpot : this.plantSpot).clone();
    return null;
  }

  /** A firework rocket's trail rising to `top` (its burst follows ~0.45 s later). */
  rocket(top) {
    for (let j = 0; j < 12; j++) {
      const f = j / 12;
      this.sparks.emit(top.x, 0.25 + (top.y - 0.25) * f * 0.35, top.z, {
        vx: 0,
        vy: (top.y - 0.25) * 2.2 * (1 - f * 0.4),
        vz: 0,
        life: 0.42 - f * 0.25,
        s0: 0.06,
        s1: 0.02,
        a0: 0.9,
        drag: 2.2,
        color: SPARK_WHITE,
      });
    }
  }

  /** A firework burst of `n` sparks at `pos`. */
  burst(pos, color, n = 40, size = 1) {
    const c = new THREE.Color(color);
    for (let j = 0; j < n; j++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const v = (0.7 + Math.random() * 0.5) * size;
      this.sparks.emit(pos.x, pos.y, pos.z, {
        vx: Math.cos(a) * r * v,
        vy: u * v + 0.3,
        vz: Math.sin(a) * r * v,
        life: 0.9 + Math.random() * 0.5,
        s0: 0.13 * size,
        s1: 0.04,
        a0: 1,
        g: 1.2,
        drag: 1.4,
        color: j % 3 ? c : GOLD,
      });
    }
  }

  // ---- idle life ---------------------------------------------------------------------------------------

  /** Idle motion: wheel, train, cars, people, birds, smoke. Returns true (always something to animate). */
  ambient(now) {
    if (now === this.lastNow) return true;
    const dt = this.lastNow > 0 ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 0;
    this.lastNow = now;
    const t = now / 1000;
    this.wheel.spin(-(t / WHEEL_TURN_S) * Math.PI * 2);
    this.train.update(now);
    this.traffic.update(now);
    this.walkers.update(now);
    this.birds.update(now);
    // Chimney smoke and cooling-tower steam.
    this.smokeClock = (this.smokeClock ?? 0) + dt;
    if (this.smokeClock > 0.3) {
      this.smokeClock = 0;
      this.smoke.emit(this.chimneyTop.x, this.chimneyTop.y, this.chimneyTop.z, { vx: 0.07 + Math.random() * 0.05, vy: 0.22, vz: -0.03, life: 3, s0: 0.12, s1: 0.6, a0: 0.7, drag: 0.3, color: SMOKE });
      if (Math.random() < 0.5) this.smoke.emit(this.towerTop.x, this.towerTop.y, this.towerTop.z, { vx: 0.03, vy: 0.14, vz: 0, life: 2.4, s0: 0.18, s1: 0.5, a0: 0.55, drag: 0.3, color: STEAM });
    }
    this.smoke.update(dt);
    this.sparks.update(dt);
    // Flags flutter.
    this.flags?.forEach((f, k) => {
      if (f.k > 1e-3) this.writeFlag(k, Math.sin(t * 2.3 + k) * 0.35);
    });
    return true;
  }

  /** Visual state for tests: [{ tile, row, h, target, mortgaged, level, height, style }]. */
  inspect() {
    return this.plots.map((p) => ({
      tile: p.tile,
      row: p.row,
      h: plotHeights(p.level >= 0, Math.max(0, p.level))[p.row],
      target: plotHeights(p.wantLevel >= 0, Math.max(0, p.wantLevel))[p.row],
      mortgaged: p.mortgaged,
      level: p.level,
      height: City.topOf(p.cur),
      style: p.style.name,
    }));
  }

  /** World position of a plot-local point (x along the street, z toward the road). */
  worldAt(p, lx, lz, y) {
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    return new THREE.Vector3(p.x + lx * c + lz * s, y, p.z - lx * s + lz * c);
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
  }
}

const DUSK_START = 0.12;
const DUSK_END = 0.86;
const GOLD = new THREE.Color('#ffd36b');
const SPARK_WHITE = new THREE.Color('#fff6d8');
const SMOKE = new THREE.Color('#9d9a96');
const STEAM = new THREE.Color('#ffffff');
const GLOW_OFF = new THREE.Color('#8a8272');
const GLOW_ON = new THREE.Color('#ffcf85').multiplyScalar(2.4);

/** Ferris wheel: static legs + a turning rim with spokes and bulbs (lit at dusk); cabins hang level. */
function buildWheel(partMat, glowMat) {
  const root = new THREE.Group();
  root.name = 'ferris-wheel';
  const R = 0.62;
  const HUB_Y = 0.84;
  const legs = new Kit();
  for (const z of [-0.11, 0.11]) {
    for (const x0 of [-0.42, 0.42]) {
      const len = Math.hypot(x0, HUB_Y);
      legs.add(new THREE.CylinderGeometry(0.016, 0.022, len, 8), { x: x0 / 2, y: HUB_Y / 2, z, rz: Math.atan2(x0, HUB_Y), color: '#f3f1ec' });
    }
  }
  legs.add(new THREE.CylinderGeometry(0.03, 0.03, 0.26, 10).rotateX(Math.PI / 2), { y: HUB_Y, color: '#c9c9c9' });
  legs.add(new THREE.BoxGeometry(0.22, 0.12, 0.16), { x: 0.36, y: 0.06, z: 0.2, color: '#d8413a' });
  legs.add(new THREE.BoxGeometry(0.26, 0.02, 0.2), { x: 0.36, y: 0.13, z: 0.2, color: '#f4f1ea' });
  const legMesh = new THREE.Mesh(legs.build(), partMat);
  legMesh.castShadow = true;
  root.add(legMesh);

  const rimKit = new Kit();
  for (const z of [-0.05, 0.05]) {
    rimKit.add(new THREE.TorusGeometry(R, 0.012, 6, 64), { z, color: '#d8423a' });
    rimKit.add(new THREE.TorusGeometry(R * 0.5, 0.008, 6, 32), { z, color: '#d8423a' });
  }
  const spokes = 12;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    rimKit.add(new THREE.BoxGeometry(R, 0.008, 0.008), { x: (Math.cos(a) * R) / 2, y: (Math.sin(a) * R) / 2, rz: a, color: '#f3f1ec' });
  }
  const rim = new THREE.Mesh(rimKit.build(), partMat);
  rim.position.y = HUB_Y;
  root.add(rim);
  const bulbs = new Kit();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    bulbs.add(new THREE.SphereGeometry(0.013, 6, 4), { x: Math.cos(a) * R, y: Math.sin(a) * R, z: 0.062, color: k % 2 ? '#ffe6a8' : '#ffb3c8' });
  }
  const bulbMesh = new THREE.Mesh(bulbs.build(), glowMat); // vertex-coloured glow (brightens at dusk)
  rim.add(bulbMesh);

  const cabinKit = new Kit()
    .add(new THREE.BoxGeometry(0.1, 0.08, 0.09), { y: -0.07, color: '#ffffff' })
    .add(new THREE.BoxGeometry(0.11, 0.015, 0.1), { y: -0.025, color: '#ffffff' })
    .add(new THREE.BoxGeometry(0.006, 0.05, 0.006), { y: -0.01, color: '#9a9a9a' });
  const count = 10;
  const cabins = new THREE.InstancedMesh(cabinKit.build(), partMat, count);
  const colors = ['#f1c40f', '#3498db', '#2ecc71', '#e67e22', '#9b59b6', '#1abc9c', '#e84393', '#ecf0f1', '#e74c3c', '#16a085'];
  const c = new THREE.Color();
  colors.forEach((col, k) => cabins.setColorAt(k, c.set(col)));
  cabins.frustumCulled = false;
  root.add(cabins);
  const d = new THREE.Object3D();
  return {
    root,
    spin(angle) {
      rim.rotation.z = angle;
      for (let k = 0; k < count; k++) {
        const a = angle + (k / count) * Math.PI * 2;
        d.position.set(Math.cos(a) * R, HUB_Y + Math.sin(a) * R, 0);
        d.updateMatrix();
        cabins.setMatrixAt(k, d.matrix);
      }
      cabins.instanceMatrix.needsUpdate = true;
    },
  };
}

