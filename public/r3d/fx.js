// public/r3d/fx.js — one-shot effects on the shared Animator, all pooled and allocation-free per
// frame: dust and puffs, sparkles, confetti, fireworks, money flights (coins and banknotes), the
// auction gavel and SOLD stamp, deed cards sliding between players, the GO burst and the jail-door
// slam. Every effect returns its duration (seconds), is skip-safe (Animator.finishAll lands it and
// hides it) and never casts shadows.
//
// Draw calls while something plays: particles 1–2 (dust, glow), coins 1, notes 1, confetti 1, plus
// one per visible gavel / stamp / deed / ring / label. Idle: 0 (everything is hidden).
//
// The Fx registers itself as scene.userData.fx so other actors (tokens' boot dust, the dice's
// doubles sparkle) find it without extra wiring. Callbacks (onLand, onStrike…) never fire during
// a skip; onDone gets { skipped }.

import * as THREE from './three.js';
import { PartKit, trackEnvironment } from './token-models.js';
import { deedTexture, cardGeometry } from './cards.js';
import { ease, clamp } from './tween.js';

const DUST_CAP = 360;
const GLOW_CAP = 900;
const COIN_CAP = 48;
const NOTE_CAP = 16;
const DEED_POOL = 8;
const CONFETTI = 200;
const CONFETTI_TIME = 3.2;
const CONFETTI_COLORS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#ffffff', '#e67e22'];
const FIREWORK_COLORS = [['#ff5a5a', '#ffd166'], ['#66d9ff', '#ffffff'], ['#b28dff', '#ff8fd6'], ['#7dff9a', '#fff27a'], ['#ffb347', '#ff5a5a']];
const BANK = new THREE.Vector3(0, 0.3, 0.15); // the bank / pot: the plaza
const GOLD = '#ffc21a';

/** A pooled CPU particle system drawn as one THREE.Points (world-sized, per-particle alpha / size). */
class Particles {
  constructor(cap, { additive = false, texture, name }) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.rgb = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.twinkle = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: true,
      vertexColors: true,
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: !additive,
    });
    mat.onBeforeCompile = patchPoints;
    mat.customProgramCacheKey = () => 'fx-points-v1';
    this.points = new THREE.Points(geo, mat);
    this.points.name = name;
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 11;
    this.points.visible = false;
    this.next = 0;
    this.alive = 0;
    this.hi = 0;
  }

  /** Adds one particle (the oldest is recycled when full). `c` is a THREE.Color (linear). */
  spawn(x, y, z, vx, vy, vz, life, s0, s1, c, a, grav = 0, drag = 0, twinkle = 0) {
    const i = this.next;
    this.next = (i + 1) % this.cap;
    if (!(this.life[i] > 0)) this.alive++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.rgb[i * 3] = c.r; this.rgb[i * 3 + 1] = c.g; this.rgb[i * 3 + 2] = c.b;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = a;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.twinkle[i] = twinkle;
    this.size[i] = 0;
    this.col[i * 4 + 3] = 0;
    if (i + 1 > this.hi) this.hi = i + 1;
    this.points.visible = true;
    return i;
  }

  step(dt) {
    if (!this.alive) return;
    const { pos, vel, col, size, age, life } = this;
    let hi = 0;
    for (let i = 0; i < this.hi; i++) {
      if (!(life[i] > 0)) continue;
      age[i] += dt;
      if (age[i] >= life[i]) {
        life[i] = 0;
        size[i] = 0;
        col[i * 4 + 3] = 0;
        this.alive--;
        continue;
      }
      hi = i + 1;
      const k = age[i] / life[i];
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      vel[i * 3] *= damp;
      vel[i * 3 + 1] = (vel[i * 3 + 1] - this.grav[i] * dt) * damp;
      vel[i * 3 + 2] *= damp;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      let a = this.a0[i] * Math.min(1, k / 0.08) * Math.min(1, (1 - k) / 0.45);
      if (this.twinkle[i]) a *= 1 - this.twinkle[i] * 0.5 * (1 + Math.sin(age[i] * 34 + i * 1.7));
      col[i * 4] = this.rgb[i * 3];
      col[i * 4 + 1] = this.rgb[i * 3 + 1];
      col[i * 4 + 2] = this.rgb[i * 3 + 2];
      col[i * 4 + 3] = a;
    }
    this.hi = hi;
    this.points.geometry.setDrawRange(0, hi);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.points.visible = this.alive > 0;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
    this.alive = 0;
    this.hi = 0;
    this.next = 0;
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }
}

/** World-sized points: gl_PointSize = diameter (world units) projected at the particle's depth. */
function patchPoints(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('uniform float size;', 'uniform float size;\nattribute float aSize;')
    .replace('gl_PointSize = size;', 'gl_PointSize = size * aSize * projectionMatrix[1][1];');
}

export class Fx {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./tween.js').Animator} animator
   * @param {{sfx?: object}} [opts]
   */
  constructor(scene, animator, { sfx = null } = {}) {
    this.scene = scene;
    this.animator = animator;
    this.sfx = sfx;
    this.gen = 0; // bumped by clear(): running effects stop touching their meshes
    this.group = new THREE.Group();
    this.group.name = 'fx';
    scene.add(this.group);
    scene.userData.fx = this;
    const softTex = softDot();
    this.textures = [softTex];
    this.dustPS = new Particles(DUST_CAP, { texture: softTex, name: 'fx-dust' });
    const starTex = starDot();
    this.textures.push(starTex);
    this.glowPS = new Particles(GLOW_CAP, { texture: starTex, name: 'fx-glow' }); // normal blending: additive washes out on the pale board
    this.group.add(this.dustPS.points, this.glowPS.points);
    this.driver = null;
    this.lastT = 0;

    // Confetti: one InstancedMesh of small paper squares, per-piece parameters preallocated.
    this.confettiMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.075, 0.045),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }),
      CONFETTI,
    );
    this.confettiMesh.count = 0;
    this.confettiMesh.frustumCulled = false;
    this.confettiMesh.name = 'fx-confetti';
    const c = new THREE.Color();
    for (let k = 0; k < CONFETTI; k++) this.confettiMesh.setColorAt(k, c.set(CONFETTI_COLORS[k % CONFETTI_COLORS.length]));
    this.confP = new Float32Array(CONFETTI * 10); // x, z, y0, fall, sway, phase, spin, vx, vy, vz
    this.group.add(this.confettiMesh);

    // Money: gold coins (lathe with a raised rim) and banknotes.
    const coinGeo = new THREE.LatheGeometry([[0, 0], [0.068, 0], [0.075, 0.004], [0.075, 0.016], [0.068, 0.02], [0.056, 0.02], [0.054, 0.016], [0, 0.016]].map(([r, y]) => new THREE.Vector2(r, y)), 18);
    coinGeo.translate(0, -0.01, 0);
    this.coins = new THREE.InstancedMesh(coinGeo, new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 1, roughness: 0.28 }), COIN_CAP);
    this.coins.name = 'fx-coins';
    trackEnvironment(this.coins, 2.2);
    this.notes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.3, 0.14), new THREE.MeshStandardMaterial({ map: noteTexture(), side: THREE.DoubleSide, roughness: 0.8 }), NOTE_CAP);
    this.notes.name = 'fx-notes';
    for (const m of [this.coins, this.notes]) {
      m.frustumCulled = false;
      m.visible = false;
      m.count = m === this.coins ? COIN_CAP : NOTE_CAP;
      for (let k = 0; k < m.count; k++) m.setMatrixAt(k, ZERO_M);
      this.group.add(m);
    }
    this.coinFree = Array.from({ length: COIN_CAP }, (_, k) => COIN_CAP - 1 - k);
    this.noteFree = Array.from({ length: NOTE_CAP }, (_, k) => NOTE_CAP - 1 - k);
    this.moneyLive = 0;

    // Deed cards (trades).
    this.deedGeo = cardGeometry(0.46, 0.575, 0.04);
    this.deedPool = Array.from({ length: DEED_POOL }, () => {
      const m = new THREE.Mesh(this.deedGeo, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }));
      m.visible = false;
      m.renderOrder = 13;
      m.name = 'fx-deed';
      this.group.add(m);
      return m;
    });
    this.deedFree = this.deedPool.slice();
    this.deedCache = new Map(); // key → texture (small LRU)

    // Gavel, SOLD stamp, GO ring / label, jail door.
    this.gavelRig = buildGavel();
    this.group.add(this.gavelRig.root);
    this.stamp = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: stampTexture(), transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.stamp.visible = false;
    this.stamp.renderOrder = 12;
    this.stamp.name = 'fx-stamp';
    this.textures.push(this.stamp.material.map);
    this.group.add(this.stamp);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: ringTexture(), color: GOLD, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 12;
    this.ring.name = 'fx-ring';
    this.textures.push(this.ring.material.map);
    this.group.add(this.ring);
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
    this.label.visible = false;
    this.label.renderOrder = 21;
    this.label.name = 'fx-label';
    this.labelText = null;
    this.group.add(this.label);
    this.door = buildDoor();
    this.group.add(this.door.root);

    this.m = new THREE.Matrix4();
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.s = new THREE.Vector3();
    this.c = new THREE.Color();
    this.c2 = new THREE.Color();
    this.dustColor = new THREE.Color('#b9a888');
    this.gold = new THREE.Color(GOLD);
    this.white = new THREE.Color('#ffffff');
  }

  /** Plays the effects' own sounds through `sfx` (sfx.js API) — off unless set. */
  setSfx(sfx) {
    this.sfx = sfx ?? null;
  }

  /** True while any effect is playing. */
  get busy() {
    return this.dustPS.alive + this.glowPS.alive + this.moneyLive > 0 || this.confettiMesh.count > 0;
  }

  // ---- plumbing ----------------------------------------------------------------------------------

  /** Keeps the particle driver running for at least `life` more seconds. */
  drive(life) {
    const a = this.animator;
    const d = this.driver;
    if (d && !d.done && a.items.includes(d)) {
      d.duration = Math.max(d.duration, a.time + life - d.at);
      return;
    }
    this.lastT = a.time;
    this.driver = a.add({
      duration: life,
      update: () => {
        const dt = clamp(a.time - this.lastT, 0, 0.05);
        this.lastT = a.time;
        this.dustPS.step(dt);
        this.glowPS.step(dt);
      },
      end: () => {
        this.dustPS.clear();
        this.glowPS.clear();
      },
    });
  }

  /** Runs fn at `delay` (skips it during finishAll: cosmetic spawns aren't worth landing). */
  later(delay, fn) {
    const gen = this.gen;
    if (delay <= 0) {
      if (!this.animator.finishing) fn();
      return;
    }
    this.animator.at(delay, () => { if (gen === this.gen && !this.animator.finishing) fn(); });
  }

  cue(opts, name, rate = 1, volume = 1) {
    if (opts?.silent || this.animator.finishing) return;
    try {
      (opts?.sfx ?? this.sfx)?.play?.(name, { rate, volume });
    } catch { /* sound must never break the board */ }
  }

  call(fn, ...args) {
    if (this.animator.finishing || typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error('[renderer3d] fx callback failed:', err);
    }
  }

  done(fn, skipped) {
    if (typeof fn !== 'function') return;
    try {
      fn({ skipped });
    } catch (err) {
      console.error('[renderer3d] fx callback failed:', err);
    }
  }

  // ---- particles ---------------------------------------------------------------------------------

  /**
   * A ring of dust kicked up along the ground at `pos` (stomps, landings, slams, building).
   * @param {THREE.Vector3} pos
   * @param {{delay?:number, size?:number, count?:number, color?:THREE.ColorRepresentation}} [opts]
   * @returns {number} seconds
   */
  dust(pos, { delay = 0, size = 1, count = 0, color = null } = {}) {
    if (!pos) return 0;
    const x = pos.x, y = pos.y ?? 0, z = pos.z;
    const n = count || Math.round(8 + 8 * size);
    const life = 0.5 + 0.2 * Math.sqrt(size);
    this.later(delay, () => {
      const c = color ? this.c.set(color) : this.dustColor;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.5;
        const sp = (0.7 + Math.random() * 0.6) * (0.6 + 0.5 * size);
        const r = 0.12 * size;
        this.dustPS.spawn(x + Math.cos(a) * r, y + 0.04, z + Math.sin(a) * r, Math.cos(a) * sp, 0.2 + Math.random() * 0.35, Math.sin(a) * sp,
          life * (0.8 + Math.random() * 0.4), 0.14 * size, (0.42 + Math.random() * 0.18) * size, c, 0.62, -0.25, 4.2);
      }
      this.drive(life * 1.25);
    });
    return delay + life * 1.2;
  }

  /**
   * A little cloud of dust at `pos` (world), `delay` seconds from now. `size` scales it.
   * (The original building puff; board.js / city.js call it.)
   * @returns {number} seconds
   */
  puff(pos, delay = 0, size = 1) {
    return this.dust(pos, { delay, size: size * 0.8, count: Math.round(7 + 4 * size) });
  }

  /**
   * Twinkling sparkles bursting from `pos` (doubles, arrivals, purchases).
   * @param {{delay?:number, count?:number, radius?:number, color?:THREE.ColorRepresentation, up?:number}} [opts]
   * @returns {number} seconds
   */
  sparkles(pos, { delay = 0, count = 24, radius = 0.6, color = GOLD, up = 0.6 } = {}) {
    if (!pos) return 0;
    const x = pos.x, y = pos.y ?? 0.3, z = pos.z;
    this.later(delay, () => {
      const c = this.c.set(color);
      for (let k = 0; k < count; k++) {
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(1 - Math.random() * 1.6);
        const sp = radius * (1.2 + Math.random() * 1.6);
        const cc = k % 3 === 0 ? this.white : c;
        this.glowPS.spawn(x, y, z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp * up + up, Math.sin(th) * Math.sin(ph) * sp,
          0.55 + Math.random() * 0.45, 0.2 + Math.random() * 0.1, 0.04, cc, 1, 1.4, 2.6, 0.7);
      }
      this.drive(1.1);
    });
    return delay + 1;
  }

  /**
   * Confetti at `pos`: a burst fired upward that flutters down (default), or rain from above.
   * @param {{delay?:number, count?:number, duration?:number, spread?:number, burst?:boolean}} [opts]
   * @returns {number} seconds
   */
  confetti(pos, { delay = 0, count = CONFETTI, duration = CONFETTI_TIME, spread = 1.8, burst = true } = {}) {
    if (!pos) return 0;
    const n = Math.min(CONFETTI, count);
    const P = this.confP;
    const m = this.confettiMesh;
    const d = this.dummy ?? (this.dummy = new THREE.Object3D());
    const gen = this.gen;
    const px = pos.x, py = pos.y ?? 0, pz = pos.z;
    this.animator.add({
      delay,
      duration,
      start: () => {
        for (let k = 0; k < n; k++) {
          const o = k * 10;
          const r = Math.sqrt(Math.random()) * spread;
          const a = Math.random() * Math.PI * 2;
          P[o] = burst ? px : px + Math.cos(a) * r;
          P[o + 1] = burst ? pz : pz + Math.sin(a) * r;
          P[o + 2] = burst ? py + 0.3 : 2.2 + Math.random() * 1.6;
          P[o + 3] = 0.7 + Math.random() * 0.6; // fall speed
          P[o + 4] = 0.08 + Math.random() * 0.12; // sway
          P[o + 5] = Math.random() * 6.3; // phase
          P[o + 6] = 3 + Math.random() * 6; // spin
          const sp = burst ? 1.4 + Math.random() * 2.2 : 0;
          P[o + 7] = Math.cos(a) * sp * (r / spread + 0.2);
          P[o + 8] = burst ? 3.4 + Math.random() * 2.4 : 0;
          P[o + 9] = Math.sin(a) * sp * (r / spread + 0.2);
        }
        m.count = n;
        m.instanceColor.needsUpdate = true;
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * duration;
        for (let k = 0; k < n; k++) {
          const o = k * 10;
          let x = P[o], z = P[o + 1], y;
          if (burst) {
            // Ballistic up to a drag-limited apex, then drifting down at the fall speed.
            const tt = Math.min(t, 0.55);
            const e = 1 - Math.exp(-tt * 3.2);
            x += (P[o + 7] / 3.2) * e;
            z += (P[o + 9] / 3.2) * e;
            y = P[o + 2] + (P[o + 8] / 3.2) * e - Math.max(0, t - 0.55) * P[o + 3] * 0.8;
          } else y = P[o + 2] - P[o + 3] * t;
          y = Math.max(0.012, y);
          d.position.set(x + Math.sin(t * 2 + P[o + 5]) * P[o + 4], y, z + Math.cos(t * 1.7 + P[o + 5]) * P[o + 4]);
          d.rotation.set(t * P[o + 6], t * P[o + 6] * 0.7, P[o + 5]);
          d.scale.setScalar(y <= 0.013 ? 0.8 : 1);
          d.updateMatrix();
          m.setMatrixAt(k, d.matrix);
        }
        m.instanceMatrix.needsUpdate = true;
      },
      end: () => { if (gen === this.gen) m.count = 0; },
    });
    return delay + duration;
  }

  /** Confetti raining down around `pos` (world) for a few seconds (the original API). */
  confettiAt(pos, delay = 0) {
    return this.confetti(pos, { delay, burst: false });
  }

  /**
   * Victory fireworks around `center`: rockets with glittering trails bursting into coloured stars.
   * @param {{delay?:number, bursts?:number, radius?:number, onLaunch?:Function, onBurst?:Function}} [opts]
   *   onBurst(k) → a good moment for a bang / crackle sound
   * @returns {number} seconds
   */
  fireworks(center = BANK, { delay = 0, bursts = 6, radius = 2.6, onLaunch, onBurst } = {}) {
    const cx = center?.x ?? 0, cz = center?.z ?? 0;
    const gen = this.gen;
    const RISE = 0.6;
    const GAP = 0.42;
    const rockets = Array.from({ length: bursts }, (_, k) => {
      const a = (k / bursts) * Math.PI * 2 + Math.random() * 0.8;
      const r = radius * (0.35 + Math.random() * 0.65);
      return {
        at: k * GAP + Math.random() * 0.15,
        x0: cx + Math.cos(a) * r * 0.6, z0: cz + Math.sin(a) * r * 0.6,
        x1: cx + Math.cos(a) * r, z1: cz + Math.sin(a) * r,
        h: 2.6 + Math.random() * 1.6,
        pal: FIREWORK_COLORS[k % FIREWORK_COLORS.length],
        launched: false,
        burst: false,
      };
    });
    const total = rockets.at(-1).at + RISE + 1.7;
    const c1 = new THREE.Color();
    const c2 = new THREE.Color();
    this.animator.add({
      delay,
      duration: total,
      update: (p) => {
        if (gen !== this.gen || this.animator.finishing) return;
        const t = p * total;
        for (let k = 0; k < rockets.length; k++) {
          const R = rockets[k];
          if (t < R.at || R.burst) continue;
          const u = Math.min(1, (t - R.at) / RISE);
          const e = ease.outQuad(u);
          const x = R.x0 + (R.x1 - R.x0) * e;
          const z = R.z0 + (R.z1 - R.z0) * e;
          const y = 0.2 + (R.h - 0.2) * e;
          if (!R.launched) {
            R.launched = true;
            this.cue(null, 'whoosh', 1.5, 0.25);
            this.call(onLaunch, k);
          }
          if (u < 1) {
            this.glowPS.spawn(x, y, z, (Math.random() - 0.5) * 0.3, -0.4, (Math.random() - 0.5) * 0.3, 0.35, 0.09, 0.02, this.gold, 0.9, 1, 1.5, 0.6);
            continue;
          }
          R.burst = true;
          this.call(onBurst, k);
          c1.set(R.pal[0]);
          c2.set(R.pal[1]);
          this.glowPS.spawn(x, y, z, 0, 0, 0, 0.25, 1.4, 2.2, this.white, 0.7, 0, 0, 0); // flash
          const N = 80;
          for (let j = 0; j < N; j++) {
            const th = Math.random() * Math.PI * 2;
            const ph = Math.acos(2 * Math.random() - 1);
            const sp = 2.4 + Math.random() * 1.1;
            this.glowPS.spawn(x, y, z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp, Math.sin(th) * Math.sin(ph) * sp,
              1.1 + Math.random() * 0.6, 0.2, 0.05, j % 2 ? c1 : c2, 1, 2.2, 1.3, 0.8);
          }
        }
        this.drive(1.8);
      },
    });
    return delay + total;
  }

  // ---- money -------------------------------------------------------------------------------------

  /**
   * Coins (and banknotes for bigger sums) arcing from `from` to `to`, sparkling on arrival.
   * @param {THREE.Vector3|null} from  payer's token position (world, at the board) — null = the bank
   * @param {THREE.Vector3|null} to    payee's token position — null = the bank / pot
   * @param {number} amount            count scales with it: $10 → 3 coins, $200 → 6 + 2 notes, $1500 → 8 + 5
   * @param {{delay?:number, onLand?:(k:number, n:number) => void, onDone?:Function, stagger?:number}} [opts]
   *   onLand(k, n) as each piece arrives (a coin clink)
   * @returns {number} seconds until the last piece has landed
   */
  money(from, to, amount, { delay = 0, onLand, onDone, stagger = 0.06 } = {}) {
    const amt = Math.max(1, Math.abs(Number(amount) || 0));
    const nCoins = clamp(Math.round(2 + 2.4 * Math.log10(amt / 5)), 2, 10);
    const nNotes = amt >= 100 ? clamp(Math.round(Math.log2(amt / 100)) + 1, 1, 5) : 0;
    const A = (from ?? BANK).clone();
    const B = (to ?? BANK).clone();
    A.y = (from ? 0 : BANK.y) + 0.7; // out of the payer's head…
    B.y = (to ? 0 : BANK.y) + 0.3; // …into the payee
    const dist = Math.hypot(B.x - A.x, B.z - A.z);
    const fly = clamp(0.5 + 0.05 * dist, 0.55, 0.95);
    const arc = 0.6 + 0.12 * dist;
    const n = nCoins + nNotes;
    const pieces = [];
    let coinsSoFar = 0;
    let notesSoFar = 0;
    for (let k = 0; k < n; k++) {
      const note = notesSoFar < nNotes && (k % 2 === 1 || coinsSoFar >= nCoins); // notes interleaved with coins
      if (note) notesSoFar++;
      else coinsSoFar++;
      pieces.push({
        note,
        at: k * stagger,
        slot: -1,
        sx: (Math.random() - 0.5) * 0.35, sz: (Math.random() - 0.5) * 0.35, // scatter at the start
        lat: (Math.random() - 0.5) * 0.6, // sideways bow of the arc
        spin: (6 + Math.random() * 8) * (Math.random() < 0.5 ? -1 : 1),
        ph: Math.random() * 6.3,
        landed: false,
      });
    }
    const total = (n - 1) * stagger + fly;
    const gen = this.gen;
    const side = this.v2.set(-(B.z - A.z), 0, B.x - A.x).normalize().clone();
    let landedCount = 0;
    this.animator.add({
      delay,
      duration: total + 0.05,
      start: () => {
        for (const P of pieces) {
          const free = P.note ? this.noteFree : this.coinFree;
          P.slot = free.length ? free.pop() : -1;
        }
        this.moneyLive++;
        this.coins.visible = true;
        if (nNotes) this.notes.visible = true;
        this.cue(null, 'coins', 1, clamp(0.4 + 0.15 * Math.log10(amt), 0.4, 1));
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * (total + 0.05);
        for (const P of pieces) {
          if (P.slot < 0) continue;
          const mesh = P.note ? this.notes : this.coins;
          const u = (t - P.at) / fly;
          if (u <= 0 || u >= 1) {
            mesh.setMatrixAt(P.slot, ZERO_M);
            if (u >= 1 && !P.landed) {
              P.landed = true;
              landedCount++;
              if (!this.animator.finishing) {
                this.glowPS.spawn(B.x, B.y + 0.1, B.z, 0, 0.6, 0, 0.35, 0.3, 0.05, this.gold, 0.9, 0, 2, 0);
                for (let j = 0; j < 3; j++) this.glowPS.spawn(B.x, B.y + 0.1, B.z, (Math.random() - 0.5) * 1.6, 0.8 + Math.random(), (Math.random() - 0.5) * 1.6, 0.45, 0.12, 0.02, this.gold, 1, 3, 2, 0.8);
                this.drive(0.6);
                if (landedCount <= 6) this.cue(null, 'coin', 0.9 + 0.3 * Math.random(), 0.5);
                this.call(onLand, landedCount - 1, n);
              }
            }
            continue;
          }
          const e = ease.inOutSine(u);
          const bow = Math.sin(Math.PI * u);
          const x = A.x + P.sx * (1 - e) + (B.x - A.x) * e + side.x * P.lat * bow;
          const z = A.z + P.sz * (1 - e) + (B.z - A.z) * e + side.z * P.lat * bow;
          const y = A.y + (B.y - A.y) * e + arc * 4 * u * (1 - u);
          const s = Math.min(1, u * 6, (1 - u) * 5 + 0.25) * (P.note ? 1.3 : 1.5);
          if (P.note) this.e.set(-Math.PI / 2 + 0.35 * Math.sin(u * 11 + P.ph), P.spin * 0.3 * u + P.ph, 0.3 * Math.sin(u * 9 + P.ph)); // fluttering, mostly flat
          else this.e.set(P.spin * u + P.ph, P.ph, 0.4); // coins flip end over end
          this.q.setFromEuler(this.e);
          this.m.compose(this.v.set(x, y, z), this.q, this.s.set(s, s, s));
          mesh.setMatrixAt(P.slot, this.m);
        }
        this.coins.instanceMatrix.needsUpdate = true;
        if (nNotes) this.notes.instanceMatrix.needsUpdate = true;
      },
      end: () => {
        if (gen !== this.gen) return; // clear() already reset the pools
        for (const P of pieces) {
          if (P.slot < 0) continue;
          (P.note ? this.notes : this.coins).setMatrixAt(P.slot, ZERO_M);
          (P.note ? this.noteFree : this.coinFree).push(P.slot);
          P.slot = -1;
        }
        this.coins.instanceMatrix.needsUpdate = true;
        this.notes.instanceMatrix.needsUpdate = true;
        this.moneyLive = Math.max(0, this.moneyLive - 1);
        if (!this.moneyLive) {
          this.coins.visible = false;
          this.notes.visible = false;
        }
        if (!this.animator.finishing && gen === this.gen) this.sparkles(B, { count: 10, radius: 0.35 });
        this.done(onDone, this.animator.finishing);
      },
    });
    return delay + total;
  }

  // ---- auctions ------------------------------------------------------------------------------------

  /**
   * The auction gavel: it appears beside `pos` (the tile), rises and strikes its block `strikes`
   * times, then shrinks away.
   * @param {THREE.Vector3} pos
   * @param {{delay?:number, strikes?:number, yaw?:number, onStrike?:(k:number) => void, onDone?:Function}} [opts]
   *   onStrike(k) at each impact (a gavel bang)
   * @returns {number} seconds; the last strike lands at (returned − 0.45)
   */
  gavel(pos, { delay = 0, strikes = 1, yaw = -0.5, onStrike, onDone } = {}) {
    if (!pos) return 0;
    const G = this.gavelRig;
    const APPEAR = 0.16;
    const STRIKE = 0.36; // wind-up 0.22 + hit 0.07 + rebound 0.07
    const HOLD = 0.25;
    const GONE = 0.2;
    const total = APPEAR + strikes * STRIKE + HOLD + GONE;
    const gen = this.gen;
    let hits = 0;
    const px = pos.x, pz = pos.z;
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        G.root.visible = true;
        G.root.position.set(px, 0, pz);
        G.root.rotation.y = yaw;
        hits = 0;
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * total;
        let s = 1;
        let ang = 0;
        if (t < APPEAR) {
          s = ease.outBack(t / APPEAR);
          ang = -0.5;
        } else if (t < APPEAR + strikes * STRIKE) {
          const k = Math.floor((t - APPEAR) / STRIKE);
          const u = (t - APPEAR - k * STRIKE) / STRIKE;
          if (u < 0.6) ang = -0.5 - 0.45 * ease.outQuad(u / 0.6); // wind up
          else if (u < 0.8) ang = -0.95 * (1 - ease.inQuad((u - 0.6) / 0.2)); // strike
          else ang = -0.12 * Math.sin(Math.PI * ((u - 0.8) / 0.2)); // rebound
          if (u >= 0.8 && hits <= k) {
            hits = k + 1;
            if (!this.animator.finishing) {
              G.root.updateMatrixWorld();
              const hp = G.head.getWorldPosition(this.v);
              this.dust(hp.setY(0.02), { size: 0.45 });
              this.sparkles(this.v.setY(0.25), { count: 8, radius: 0.3, color: '#fff2c0' });
              this.cue(null, 'gavel', 1, 0.9);
              this.call(onStrike, k);
            }
          }
        } else if (t < total - GONE) {
          ang = -0.25 * ease.outQuad((t - APPEAR - strikes * STRIKE) / HOLD);
        } else {
          ang = -0.25;
          s = 1 - ease.inQuad((t - (total - GONE)) / GONE);
        }
        G.arm.rotation.z = ang;
        G.root.scale.setScalar(Math.max(0.001, s));
      },
      end: () => {
        G.root.visible = false;
        this.done(onDone, this.animator.finishing);
      },
    });
    return delay + total;
  }

  /**
   * A red "SOLD" stamp slammed onto the tile at `pos`, held, then faded.
   * @param {THREE.Vector3} pos
   * @param {{delay?:number, color?:THREE.ColorRepresentation, hold?:number, yaw?:number, onLand?:Function, onDone?:Function}} [opts]
   * @returns {number} seconds (the stamp lands 0.14 s in)
   */
  soldStamp(pos, { delay = 0, color = '#d0202e', hold = 1.1, yaw = -0.14, onLand, onDone } = {}) {
    if (!pos) return 0;
    const S = this.stamp;
    const DROP = 0.14;
    const FADE = 0.3;
    const total = DROP + 0.12 + hold + FADE;
    const gen = this.gen;
    let landed = false;
    const px = pos.x, pz = pos.z;
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        S.visible = true;
        S.material.color.set(color);
        S.rotation.y = yaw;
        landed = false;
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * total;
        let y = 0.018;
        let s = 1;
        let a = 0.92;
        if (t < DROP) {
          const u = ease.inQuad(t / DROP);
          y = 0.9 + (0.018 - 0.9) * u;
          s = 1.9 - 0.9 * u;
          a = 0.3 + 0.62 * u;
        } else {
          if (!landed) {
            landed = true;
            if (!this.animator.finishing) {
              this.dust(this.v.set(px, 0, pz), { size: 1.1, count: 18 });
              this.cue(null, 'stamp', 1, 1);
              this.call(onLand);
            }
          }
          const u = t - DROP;
          if (u < 0.12) s = 1 + 0.1 * Math.sin(Math.PI * (u / 0.12));
          if (t > total - FADE) a = 0.92 * (1 - (t - (total - FADE)) / FADE);
        }
        S.position.set(px, y, pz);
        S.scale.set(s, 1, s);
        S.material.opacity = a;
      },
      end: () => {
        S.visible = false;
        this.done(onDone, this.animator.finishing);
      },
    });
    return delay + total;
  }

  /**
   * Gavel then stamp: the whole "going… SOLD!" moment on the tile at `pos`.
   * @param {{delay?:number, strikes?:number, color?:THREE.ColorRepresentation, onStrike?:Function, onStamp?:Function}} [opts]
   * @returns {number} seconds
   */
  auctionSold(pos, { delay = 0, strikes = 1, color, onStrike, onStamp } = {}) {
    if (!pos) return 0;
    const g = this.gavel(this.v2.copy(pos).add(GAVEL_OFFSET), { delay, strikes, onStrike });
    const landAt = g - 0.45 - 0.1; // just after the last strike
    return Math.max(g, this.soldStamp(pos, { delay: landAt, color, onLand: onStamp }));
  }

  // ---- trades --------------------------------------------------------------------------------------

  /**
   * Deed cards flying from one player to another (trades), one after another, twirling on the way,
   * then tucked into the receiver.
   * @param {THREE.Vector3} from  giver's token position (world)
   * @param {THREE.Vector3} to    receiver's token position
   * @param {{name:string, color?:string, kind?:'street'|'railroad'|'utility'|'cash'|'jail', amount?:number}[]} cards
   * @param {{delay?:number, stagger?:number, onLand?:(k:number, n:number) => void, onDone?:Function}} [opts]
   * @returns {number} seconds
   */
  deeds(from, to, cards, { delay = 0, stagger = 0.14, onLand, onDone } = {}) {
    if (!from || !to || !Array.isArray(cards) || !cards.length) return 0;
    const list = cards.slice(0, DEED_POOL);
    const FLY = 0.8;
    const TUCK = 0.22;
    const total = (list.length - 1) * stagger + FLY + TUCK;
    const A = from.clone().setY(0.55);
    const B = to.clone().setY(0.55);
    const gen = this.gen;
    const slots = list.map((card, k) => ({ card, k, mesh: null, landed: false }));
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        for (const S of slots) {
          S.mesh = this.deedFree.pop() ?? null;
          if (!S.mesh) continue;
          S.mesh.material.map = this.deedTex(S.card);
          S.mesh.material.needsUpdate = true;
          S.mesh.visible = false;
        }
        this.cue(null, 'cardFlip', 1, 0.6);
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * total;
        for (const S of slots) {
          const M = S.mesh;
          if (!M) continue;
          const u = (t - S.k * stagger) / FLY;
          if (u <= 0) { M.visible = false; continue; }
          M.visible = true;
          const fan = (S.k - (slots.length - 1) / 2) * 0.16;
          let s = 1;
          if (u < 1) {
            const e = ease.inOutCubic(u);
            M.position.set(A.x + (B.x - A.x) * e + fan * Math.sin(Math.PI * u), A.y + (B.y - A.y) * e + 1.0 * Math.sin(Math.PI * u), A.z + (B.z - A.z) * e);
            M.rotation.set(-0.55, Math.PI * 2 * e, 0.12 * Math.sin(Math.PI * 2 * u));
            s = Math.min(1, u * 5);
          } else {
            if (!S.landed) {
              S.landed = true;
              if (!this.animator.finishing) {
                this.sparkles(B, { count: 6, radius: 0.25, color: '#ffffff' });
                this.call(onLand, S.k, slots.length);
              }
            }
            const w = Math.min(1, (u - 1) * (FLY / TUCK));
            M.position.set(B.x + fan, B.y + 0.05 * S.k - 0.35 * ease.inQuad(w), B.z);
            M.rotation.set(-0.55, 0, 0);
            s = 1 - ease.inQuad(w);
          }
          M.scale.setScalar(Math.max(0.001, s));
        }
      },
      end: () => {
        if (gen !== this.gen) return; // clear() already reset the pool
        for (const S of slots) {
          if (!S.mesh) continue;
          S.mesh.visible = false;
          S.mesh.material.map = null;
          this.deedFree.push(S.mesh);
          S.mesh = null;
        }
        this.done(onDone, this.animator.finishing);
      },
    });
    return delay + total;
  }

  /** Cached deed textures (a few recent ones). */
  deedTex(card) {
    const key = `${card.kind ?? 'street'}|${card.name ?? ''}|${card.color ?? ''}|${card.amount ?? ''}`;
    let tex = this.deedCache.get(key);
    if (tex) {
      this.deedCache.delete(key);
      this.deedCache.set(key, tex);
      return tex;
    }
    tex = deedTexture(card);
    this.deedCache.set(key, tex);
    if (this.deedCache.size > 12) {
      const [oldKey, old] = this.deedCache.entries().next().value;
      if (!this.deedPool.some((m) => m.material.map === old)) {
        old.dispose();
        this.deedCache.delete(oldKey);
      }
    }
    return tex;
  }

  // ---- GO and jail -------------------------------------------------------------------------------

  /**
   * "GO! +$200": a golden shockwave on the GO tile, a fountain of sparks and a popping label.
   * @param {THREE.Vector3} pos  the GO tile (or the token passing it)
   * @param {{delay?:number, amount?:number, text?:string, onBurst?:Function}} [opts]
   * @returns {number} seconds
   */
  goBurst(pos, { delay = 0, amount = 200, text = null, onBurst } = {}) {
    if (!pos) return 0;
    const TOTAL = 1.4;
    const gen = this.gen;
    const label = text ?? `GO!  +$${Math.abs(Math.round(Number(amount) || 0))}`;
    const px = pos.x, pz = pos.z;
    const R = this.ring;
    const L = this.label;
    this.animator.add({
      delay,
      duration: TOTAL,
      start: () => {
        this.setLabel(label);
        R.visible = true;
        L.visible = true;
        R.material.color.set(GOLD);
        if (!this.animator.finishing) {
          for (let k = 0; k < 44; k++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 0.4 + Math.random() * 0.9;
            this.glowPS.spawn(px, 0.1, pz, Math.cos(a) * sp, 2.6 + Math.random() * 1.8, Math.sin(a) * sp, 0.8 + Math.random() * 0.5, 0.17, 0.04, k % 4 ? this.gold : this.white, 1, 4.2, 0.6, 0.7);
          }
          this.drive(1.4);
          this.cue(null, 'passGo', 1, 1);
          this.call(onBurst);
        }
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * TOTAL;
        const r = Math.min(1, t / 0.7);
        R.position.set(px, 0.02, pz);
        R.scale.setScalar(0.3 + 1.5 * ease.outCubic(r));
        R.material.opacity = 0.95 * (1 - r);
        R.visible = r < 1;
        const pop = t < 0.3 ? ease.outBack(t / 0.3) : 1;
        const fade = t > TOTAL - 0.35 ? (TOTAL - t) / 0.35 : 1;
        L.position.set(px, 0.9 + 0.35 * ease.outQuad(p), pz);
        L.scale.set(1.6 * pop, 0.4 * pop, 1);
        L.material.opacity = fade;
      },
      end: () => {
        R.visible = false;
        L.visible = false;
      },
    });
    return delay + TOTAL;
  }

  setLabel(text) {
    if (this.labelText === text) return;
    this.labelText = text;
    this.label.material.map?.dispose();
    this.label.material.map = labelTexture(text);
    this.label.material.needsUpdate = true;
  }

  /**
   * A barred door swinging shut with a clang (dust, a spark flash), held, then sinking away.
   * Defaults to the jail cell's inner (+X) side; pass `pos` = hinge position and `yaw` to place it.
   * @param {THREE.Vector3} [pos]  hinge (world)
   * @param {{delay?:number, yaw?:number, hold?:number, width?:number, onSlam?:Function, onDone?:Function}} [opts]
   * @returns {number} seconds; the door slams shut at delay + 0.22
   */
  jailSlam(pos = JAIL_HINGE, { delay = 0, yaw = Math.PI / 2, hold = 0.7, width = 1.04, onSlam, onDone } = {}) {
    const D = this.door;
    const SWING = 0.22;
    const BOUNCE = 0.28;
    const SINK = 0.3;
    const total = SWING + BOUNCE + hold + SINK;
    const gen = this.gen;
    let slammed = false;
    const hx = pos.x, hz = pos.z;
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        D.root.visible = true;
        D.root.position.set(hx, 0, hz);
        D.root.rotation.y = yaw;
        D.door.scale.set(width / 1.04, 1, 1);
        slammed = false;
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * total;
        let ang = 0;
        let y = 0;
        if (t < SWING) ang = -1.75 * (1 - ease.inQuad(t / SWING));
        else {
          if (!slammed) {
            slammed = true;
            if (!this.animator.finishing) {
              D.root.updateMatrixWorld();
              const mid = D.door.localToWorld(this.v.set(width / 2, 0.02, 0));
              this.dust(mid, { size: 1.2, count: 20 });
              this.sparkles(this.v2.copy(mid).setY(0.45), { count: 14, radius: 0.5, color: '#ffffff' });
              this.cue(null, 'jailSlam', 1, 1);
              this.call(onSlam);
            }
          }
          const u = t - SWING;
          if (u < BOUNCE) ang = -0.16 * Math.sin(Math.PI * 2 * (u / BOUNCE)) * (1 - u / BOUNCE);
          if (t > total - SINK) y = -0.85 * ease.inQuad((t - (total - SINK)) / SINK);
        }
        D.door.rotation.y = ang;
        D.root.position.y = y;
      },
      end: () => {
        D.root.visible = false;
        D.root.position.y = 0;
        this.done(onDone, this.animator.finishing);
      },
    });
    return delay + total;
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  /** Hides everything (reset / skip-safe). */
  clear() {
    this.gen++;
    this.dustPS.clear();
    this.glowPS.clear();
    this.confettiMesh.count = 0;
    for (const m of [this.coins, this.notes]) {
      for (let k = 0; k < m.count; k++) m.setMatrixAt(k, ZERO_M);
      m.instanceMatrix.needsUpdate = true;
      m.visible = false;
    }
    this.coinFree = Array.from({ length: COIN_CAP }, (_, k) => COIN_CAP - 1 - k);
    this.noteFree = Array.from({ length: NOTE_CAP }, (_, k) => NOTE_CAP - 1 - k);
    this.moneyLive = 0;
    for (const m of this.deedPool) {
      m.visible = false;
      m.material.map = null;
    }
    this.deedFree = this.deedPool.slice();
    this.gavelRig.root.visible = false;
    this.stamp.visible = false;
    this.ring.visible = false;
    this.label.visible = false;
    this.door.root.visible = false;
  }

  /** Frees the cached textures the scene no longer references (the scene disposes the rest). */
  dispose() {
    this.clear();
    for (const t of this.deedCache.values()) t.dispose();
    this.deedCache.clear();
    if (this.scene.userData.fx === this) delete this.scene.userData.fx;
  }
}

const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const GAVEL_OFFSET = new THREE.Vector3(0.1, 0, -0.55); // the gavel strikes just behind the stamp
const JAIL_HINGE = new THREE.Vector3(-4.5, 0, 5.54); // jail cell, inner (+X) edge, board-edge end

// ---- meshes ---------------------------------------------------------------------------------------

/** Gavel (turned wood head with brass bands, handle) on a round sound block; the arm pivots at the hand. */
function buildGavel() {
  const root = new THREE.Group();
  root.name = 'fx-gavel';
  root.visible = false;
  const wood = '#8a4b22';
  const dark = '#5b2f14';
  const brass = '#d9b25a';
  const blockKit = new PartKit();
  blockKit.add(new THREE.CylinderGeometry(0.2, 0.22, 0.1, 24), { at: [0, 0.05, 0], color: dark, smooth: 40 });
  blockKit.add(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 24), { at: [0, 0.115, 0], color: wood, smooth: 40 });
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 });
  const block = new THREE.Mesh(blockKit.build({ uv: false, rig: false, color: true }), mat);
  root.add(block);
  const arm = new THREE.Group();
  arm.position.set(0.52, 0.2, 0); // the hand: rotating about Z swings the head down onto the block
  root.add(arm);
  const k = new PartKit();
  k.add(new THREE.CylinderGeometry(0.022, 0.026, 0.46, 12), { at: [-0.25, 0, 0], rot: [0, 0, Math.PI / 2], color: wood, smooth: 40 });
  k.add(new THREE.SphereGeometry(0.032, 12, 8), { at: [-0.01, 0, 0], color: dark });
  k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 20), { at: [-0.52, 0, 0], rot: [Math.PI / 2, 0, 0], color: wood, smooth: 40 });
  for (const z of [0.075, -0.075]) k.add(new THREE.CylinderGeometry(0.073, 0.073, 0.022, 20), { at: [-0.52, 0, z], rot: [Math.PI / 2, 0, 0], color: brass, smooth: 40 });
  for (const z of [0.113, -0.113]) k.add(new THREE.CylinderGeometry(0.062, 0.07, 0.012, 20), { at: [-0.52, 0, z], rot: [Math.PI / 2, 0, 0], color: dark, smooth: 40 });
  const gavel = new THREE.Mesh(k.build({ uv: false, rig: false, color: true }), mat);
  arm.add(gavel);
  const head = new THREE.Object3D();
  head.position.set(-0.52, -0.07, 0);
  arm.add(head);
  return { root, arm, gavel, head, block };
}

/** A barred cell door (dark iron) hinged at its local origin, 1.04 wide along +X. */
function buildDoor() {
  const root = new THREE.Group();
  root.name = 'fx-door';
  root.visible = false;
  const k = new PartKit();
  const W = 1.04;
  const H = 0.78;
  const iron = '#3a3d42';
  for (let i = 0; i < 6; i++) k.add(new THREE.CylinderGeometry(0.018, 0.018, H, 8), { at: [0.07 + (i * (W - 0.14)) / 5, H / 2, 0], color: iron, smooth: 40 });
  for (const y of [0.1, H - 0.08]) k.add(new THREE.BoxGeometry(W, 0.05, 0.04), { at: [W / 2, y, 0], color: iron });
  k.add(new THREE.CylinderGeometry(0.03, 0.03, H + 0.04, 10), { at: [0, H / 2, 0], color: '#2a2c30', smooth: 40 }); // hinge post
  k.add(new THREE.BoxGeometry(0.08, 0.12, 0.07), { at: [W - 0.08, H * 0.5, 0], color: '#b8963e' }); // lock
  const door = new THREE.Mesh(k.build({ uv: false, rig: false, color: true }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.75 }));
  root.add(door);
  return { root, door };
}

// ---- textures --------------------------------------------------------------------------------------

function canvasTex(cv, srgb = true) {
  const tex = new THREE.CanvasTexture(cv);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A soft white dot (radial gradient) for dust. */
function softDot() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return canvasTex(cv);
}

/** A four-point star with an opaque core (sparkles, fireworks); tinted by the particle colour. */
function starDot() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  for (const [w, h] of [[31, 3], [3, 31]]) {
    const lg = g.createRadialGradient(32, 32, 0, 32, 32, 31);
    lg.addColorStop(0, 'rgba(255,255,255,1)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.beginPath();
    g.ellipse(32, 32, w, h, 0, 0, Math.PI * 2);
    g.fill();
  }
  return canvasTex(cv);
}

/** Soft ring gradient for the GO shockwave (radial across the RingGeometry's UV). */
function ringTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 38, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return canvasTex(cv);
}

/** A generic banknote: pale green, darker border, an oval with a "$". */
function noteTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 120;
  const g = cv.getContext('2d');
  g.fillStyle = '#cfe8c4';
  g.fillRect(0, 0, 256, 120);
  g.strokeStyle = '#3f7a44';
  g.lineWidth = 8;
  g.strokeRect(8, 8, 240, 104);
  g.lineWidth = 2;
  g.strokeRect(18, 18, 220, 84);
  g.fillStyle = '#a9d39c';
  g.beginPath();
  g.ellipse(128, 60, 44, 34, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2f6a36';
  g.font = '900 54px Georgia, "Times New Roman", serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('$', 128, 63);
  g.font = '800 22px system-ui, "Segoe UI", Arial, sans-serif';
  g.fillText('$', 38, 36);
  g.fillText('$', 218, 86);
  return canvasTex(cv);
}

/** "SOLD" in a double-bordered rounded box, with rubber-stamp wear. */
function stampTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const g = cv.getContext('2d');
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 14;
  roundRect(g, 16, 16, 480, 224, 30);
  g.stroke();
  g.lineWidth = 5;
  roundRect(g, 36, 36, 440, 184, 20);
  g.stroke();
  g.font = '900 150px Impact, "Arial Black", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('SOLD', 256, 136);
  // Wear: knock out speckles (seeded, so every client sees the same stamp).
  g.globalCompositeOperation = 'destination-out';
  let s = 9;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 520; k++) {
    g.globalAlpha = 0.3 + rnd() * 0.7;
    g.beginPath();
    g.arc(rnd() * 512, rnd() * 256, 0.8 + rnd() * 3.2, 0, Math.PI * 2);
    g.fill();
  }
  return canvasTex(cv);
}

/** Big gold label text (GO burst). */
function labelTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 256;
  const g = cv.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 150px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
  g.lineJoin = 'round';
  g.lineWidth = 22;
  g.strokeStyle = 'rgba(60, 30, 0, 0.85)';
  g.strokeText(text, 512, 132);
  const grad = g.createLinearGradient(0, 50, 0, 210);
  grad.addColorStop(0, '#fff6c8');
  grad.addColorStop(0.5, '#ffd24a');
  grad.addColorStop(1, '#e09a12');
  g.fillStyle = grad;
  g.fillText(text, 512, 132);
  return canvasTex(cv);
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
