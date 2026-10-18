// public/r3d/fx.js — one-shot effects on the shared Animator, all pooled and allocation-free per
// frame: dust and puffs, sparkles, confetti, fireworks, money flights (coins and banknotes), the
// auction gavel and SOLD stamp, deed cards sliding between players, the GO burst and the jail-door
// slam. Every effect returns its duration (seconds), is skip-safe (Animator.finishAll lands it and
// hides it) and never casts shadows.
//
// UNITS: METRES (Loop City, design §2 / §17.8). Every default size, distance, speed and gravity is a
// real-world value: gravity 9.8 m/s², dust `size` 1 m, puffs 2 m, sparkles radius 3 m (up 3 m/s),
// confetti spread 10 m and 6 m high, fireworks radius 18 m bursting 60 m up, coins 0.25 m. Positions may
// be THREE.Vector3 or plain { x, y, z } objects (y defaults to the ground, 0).
//
// Draw calls while something plays: particles 1–2 (dust, glow), coins 1, notes 1, confetti 1, plus
// one per visible gavel / stamp / deed / ring / label. Idle: 0 (everything is hidden).
//
// The Fx registers itself as scene.userData.fx so other actors (characters' dust, the dice's doubles
// sparkle) find it without extra wiring. Callbacks (onLand, onStrike…) never fire during a skip;
// onDone gets { skipped }. Sounds go through `sfx` (setSfx); place-tied ones carry `pos`.

import * as THREE from './three.js';
import { PartKit, trackEnvironment } from './token-models.js';
import { deedTexture, cardGeometry } from './cards.js';
import { ease, clamp } from './tween.js';

export const GRAVITY = 9.8; // m/s²
const DUST_CAP = 420;
const GLOW_CAP = 1400;
const COIN_CAP = 48;
const NOTE_CAP = 16;
const DEED_POOL = 8;
const CONFETTI = 260;
const CONFETTI_TIME = 3.6;
const CONFETTI_COLORS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#ffffff', '#e67e22'];
const FIREWORK_COLORS = [['#ff5a5a', '#ffd166'], ['#66d9ff', '#ffffff'], ['#b28dff', '#ff8fd6'], ['#7dff9a', '#fff27a'], ['#ffb347', '#ff5a5a']];
const BANK = new THREE.Vector3(156, 1, 156); // the City Bank on the GO block (money from / to "the bank")
const HARBOUR = new THREE.Vector3(320, 0, 200); // default fireworks: over the harbour
const GOLD = '#ffc21a';

/** A THREE.Vector3 copy of a Vector3 or a plain { x, y, z } (y defaults to `y0`). */
function vec(p, y0 = 0, out = new THREE.Vector3()) {
  return out.set(Number(p?.x) || 0, Number.isFinite(Number(p?.y)) ? Number(p.y) : y0, Number(p?.z) || 0);
}

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

    // Confetti: one InstancedMesh of paper pieces (14 × 9 cm: big enough to read from across the street),
    // per-piece parameters preallocated.
    this.confettiMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.14, 0.09),
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

    // Money: gold coins 0.25 m across (lathe with a raised rim) and 0.7 m banknotes — storybook-sized so
    // they read at street distance.
    const K = 0.125 / 0.075;
    const coinGeo = new THREE.LatheGeometry([[0, 0], [0.068, 0], [0.075, 0.004], [0.075, 0.016], [0.068, 0.02], [0.056, 0.02], [0.054, 0.016], [0, 0.016]].map(([r, y]) => new THREE.Vector2(r * K, y * K)), 18);
    coinGeo.translate(0, -0.01 * K, 0);
    this.coins = new THREE.InstancedMesh(coinGeo, new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 1, roughness: 0.28 }), COIN_CAP);
    this.coins.name = 'fx-coins';
    trackEnvironment(this.coins, 2.2);
    this.notes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.7, 0.33), new THREE.MeshStandardMaterial({ map: noteTexture(), side: THREE.DoubleSide, roughness: 0.8 }), NOTE_CAP);
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

  /** Plays an effect sound (never during a skip). `pos` places it in the city (positional audio). */
  cue(opts, name, rate = 1, volume = 1, pos = null, delay = 0) {
    if (opts?.silent || this.animator.finishing) return;
    try {
      const o = { rate, volume };
      if (pos) o.pos = { x: pos.x, y: pos.y ?? 0, z: pos.z };
      if (delay > 0) o.delay = delay;
      (opts?.sfx ?? this.sfx)?.play?.(name, o);
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
   * A ring of dust kicked up along the ground at `pos` (wheel spins, landings, slams, building sites).
   * `size` ≈ the cloud's radius in metres (1 = a car pulling away; 4–8 = floors collapsing).
   * @param {THREE.Vector3|{x:number,y?:number,z:number}} pos
   * @param {{delay?:number, size?:number, count?:number, color?:THREE.ColorRepresentation}} [opts]
   * @returns {number} seconds
   */
  dust(pos, { delay = 0, size = 1, count = 0, color = null } = {}) {
    if (!pos) return 0;
    const x = Number(pos.x) || 0, y = Number(pos.y) || 0, z = Number(pos.z) || 0;
    const S = Math.max(0.05, Number(size) || 1);
    const n = Math.min(80, count || Math.round(10 + 7 * Math.sqrt(S) * 2));
    const life = 0.7 + 0.3 * Math.sqrt(S);
    this.later(delay, () => {
      const c = color ? this.c.set(color) : this.dustColor;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + Math.random() * 0.5;
        const sp = (0.7 + Math.random() * 0.6) * (0.9 + 1.1 * S);
        const r = 0.3 * S;
        this.dustPS.spawn(x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, Math.cos(a) * sp, (0.25 + Math.random() * 0.5) * (0.6 + 0.5 * S), Math.sin(a) * sp,
          life * (0.8 + Math.random() * 0.4), 0.35 * S, (1.0 + Math.random() * 0.45) * S, c, 0.6, -0.3, 3.6);
      }
      this.drive(life * 1.25);
    });
    return delay + life * 1.2;
  }

  /**
   * A cloud of dust at `pos`, `delay` seconds from now; `size` in metres (default 2: a small building).
   * @returns {number} seconds
   */
  puff(pos, delay = 0, size = 2) {
    return this.dust(pos, { delay, size: size * 0.8, count: Math.round(9 + 5 * Math.sqrt(size) * 2) });
  }

  /**
   * Twinkling sparkles bursting from `pos` (doubles, arrivals, purchases): `radius` m spread, `up` m/s
   * upward bias, falling under gravity.
   * @param {{delay?:number, count?:number, radius?:number, color?:THREE.ColorRepresentation, up?:number}} [opts]
   * @returns {number} seconds
   */
  sparkles(pos, { delay = 0, count = 24, radius = 3, color = GOLD, up = 3 } = {}) {
    if (!pos) return 0;
    const x = Number(pos.x) || 0, y = Number.isFinite(Number(pos.y)) && pos.y !== null ? Number(pos.y) : 1.5, z = Number(pos.z) || 0;
    const R = Math.max(0.05, Number(radius) || 3);
    const size = 0.12 + 0.11 * R; // a star ~0.45 m wide for the default 3 m burst
    this.later(delay, () => {
      const c = this.c.set(color);
      for (let k = 0; k < count; k++) {
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(1 - Math.random() * 1.6);
        const sp = R * (1.2 + Math.random() * 1.6);
        const cc = k % 3 === 0 ? this.white : c;
        this.glowPS.spawn(x, y, z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp * 0.6 + up, Math.sin(th) * Math.sin(ph) * sp,
          0.6 + Math.random() * 0.5, size * (1 + Math.random() * 0.4), size * 0.2, cc, 1, GRAVITY * 0.5, 2.6, 0.7);
      }
      this.drive(1.2);
    });
    return delay + 1.1;
  }

  /**
   * Confetti at `pos`: a burst fired up to ~`height` m that spreads over a `spread` m radius and
   * flutters down (default), or rain from above (burst: false).
   * @param {{delay?:number, count?:number, duration?:number, spread?:number, height?:number, burst?:boolean}} [opts]
   * @returns {number} seconds
   */
  confetti(pos, { delay = 0, count = 200, duration = CONFETTI_TIME, spread = 10, height = 6, burst = true } = {}) {
    if (!pos) return 0;
    const n = Math.min(CONFETTI, Math.max(1, Math.round(Number(count) || 200)));
    const P = this.confP;
    const m = this.confettiMesh;
    const d = this.dummy ?? (this.dummy = new THREE.Object3D());
    const gen = this.gen;
    const px = Number(pos.x) || 0, py = Number(pos.y) || 0, pz = Number(pos.z) || 0;
    const H = Math.max(0.5, Number(height) || 6), SP = Math.max(0.5, Number(spread) || 10);
    const DRAG = 3.2, RISE = 0.6;
    const dur = Math.max(0.5, Number(duration) || CONFETTI_TIME);
    this.animator.add({
      delay,
      duration: dur,
      start: () => {
        for (let k = 0; k < n; k++) {
          const o = k * 10;
          const u = Math.sqrt(Math.random());
          const a = Math.random() * Math.PI * 2;
          P[o] = burst ? px : px + Math.cos(a) * u * SP;
          P[o + 1] = burst ? pz : pz + Math.sin(a) * u * SP;
          P[o + 2] = burst ? py + 0.5 : py + H * (0.8 + Math.random() * 0.6);
          P[o + 3] = 1.6 + Math.random() * 0.9; // fall speed (m/s)
          P[o + 4] = 0.25 + Math.random() * 0.35; // sway (m)
          P[o + 5] = Math.random() * 6.3; // phase
          P[o + 6] = 3 + Math.random() * 6; // spin
          // drag-limited ballistics: displacement = v / DRAG · (1 − e^(−DRAG·t)) → v = DRAG · distance
          P[o + 7] = burst ? Math.cos(a) * u * SP * DRAG : 0;
          P[o + 8] = burst ? H * (0.55 + Math.random() * 0.45) * DRAG : 0;
          P[o + 9] = burst ? Math.sin(a) * u * SP * DRAG : 0;
        }
        m.count = n;
        m.instanceColor.needsUpdate = true;
        if (burst) this.cue(null, 'confettiPop', 1, 0.8, { x: px, y: py, z: pz });
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * dur;
        const shrink = Math.min(1, (dur - t) / 0.4); // the last pieces fade away instead of popping
        for (let k = 0; k < n; k++) {
          const o = k * 10;
          let x = P[o], z = P[o + 1], y;
          if (burst) {
            const tt = Math.min(t, RISE);
            const e = 1 - Math.exp(-tt * DRAG);
            x += (P[o + 7] / DRAG) * e;
            z += (P[o + 9] / DRAG) * e;
            y = P[o + 2] + (P[o + 8] / DRAG) * e - Math.max(0, t - RISE) * P[o + 3];
          } else y = P[o + 2] - P[o + 3] * t;
          const floor = 0.02;
          y = Math.max(floor, y);
          d.position.set(x + Math.sin(t * 2 + P[o + 5]) * P[o + 4], y, z + Math.cos(t * 1.7 + P[o + 5]) * P[o + 4]);
          d.rotation.set(t * P[o + 6], t * P[o + 6] * 0.7, P[o + 5]);
          d.scale.setScalar((y <= floor + 0.001 ? 0.8 : 1) * Math.max(0.001, shrink));
          d.updateMatrix();
          m.setMatrixAt(k, d.matrix);
        }
        m.instanceMatrix.needsUpdate = true;
      },
      end: () => { if (gen === this.gen) m.count = 0; },
    });
    return delay + dur;
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
  fireworks(center = HARBOUR, { delay = 0, bursts = 6, radius = 18, height = 60, onLaunch, onBurst } = {}) {
    const cx = Number(center?.x) || 0, cz = Number(center?.z) || 0, cy = Number(center?.y) || 0;
    const R0 = Math.max(1, Number(radius) || 18), H0 = Math.max(5, Number(height) || 60);
    const gen = this.gen;
    const RISE = clamp(0.55 + H0 / 120, 0.6, 1.4); // shells climb ~60 m in about a second
    const GAP = 0.42;
    const POP = 0.36; // the 'firework' sound's boom lands this long after it starts
    const STAR = R0 / 0.9; // star speed (m/s) so the shell opens to ~radius against the drag
    const rockets = Array.from({ length: bursts }, (_, k) => {
      const a = (k / bursts) * Math.PI * 2 + Math.random() * 0.8;
      const r = R0 * (0.35 + Math.random() * 0.65);
      return {
        at: k * GAP + Math.random() * 0.15,
        x0: cx + Math.cos(a) * r * 0.25, z0: cz + Math.sin(a) * r * 0.25,
        x1: cx + Math.cos(a) * r, z1: cz + Math.sin(a) * r,
        h: cy + H0 * (0.8 + Math.random() * 0.4),
        pal: FIREWORK_COLORS[k % FIREWORK_COLORS.length],
        launched: false,
        heard: false,
        burst: false,
      };
    });
    const total = rockets.at(-1).at + RISE + 2.0;
    const c1 = new THREE.Color();
    const c2 = new THREE.Color();
    const at = { x: 0, y: 0, z: 0 };
    this.animator.add({
      delay,
      duration: total,
      update: (p) => {
        if (gen !== this.gen || this.animator.finishing) return;
        const t = p * total;
        for (let k = 0; k < rockets.length; k++) {
          const R = rockets[k];
          // the sound starts early so its boom lands on the burst
          if (!R.heard && t >= R.at + RISE - POP) {
            R.heard = true;
            at.x = R.x1; at.y = R.h; at.z = R.z1;
            this.cue(null, 'firework', 0.9 + Math.random() * 0.2, 0.9, at);
          }
          if (t < R.at || R.burst) continue;
          const u = Math.min(1, (t - R.at) / RISE);
          const e = ease.outQuad(u);
          const x = R.x0 + (R.x1 - R.x0) * e;
          const z = R.z0 + (R.z1 - R.z0) * e;
          const y = cy + 1 + (R.h - cy - 1) * e;
          if (!R.launched) {
            R.launched = true;
            this.call(onLaunch, k);
          }
          if (u < 1) { // a glittering trail
            this.glowPS.spawn(x, y, z, (Math.random() - 0.5) * 1.5, -2, (Math.random() - 0.5) * 1.5, 0.45, 0.7, 0.15, this.gold, 0.9, GRAVITY * 0.3, 1.5, 0.6);
            continue;
          }
          R.burst = true;
          this.call(onBurst, k);
          c1.set(R.pal[0]);
          c2.set(R.pal[1]);
          this.glowPS.spawn(x, y, z, 0, 0, 0, 0.25, R0 * 0.6, R0 * 0.9, this.white, 0.7, 0, 0, 0); // flash
          const N = 90;
          for (let j = 0; j < N; j++) {
            const th = Math.random() * Math.PI * 2;
            const ph = Math.acos(2 * Math.random() - 1);
            const sp = STAR * (0.85 + Math.random() * 0.3);
            this.glowPS.spawn(x, y, z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp, Math.sin(th) * Math.sin(ph) * sp,
              1.3 + Math.random() * 0.7, 0.07 * R0, 0.015 * R0, j % 2 ? c1 : c2, 1, GRAVITY * 0.35, 1.3, 0.8);
          }
        }
        this.drive(2.1);
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
    // Short range (a payer and a payee in the same shot): out of the payer's head, into the payee.
    const A = vec(from ?? BANK, from ? 0 : BANK.y);
    const B = vec(to ?? BANK, to ? 0 : BANK.y);
    A.y += 2.2;
    B.y += 1.2;
    const dist = Math.hypot(B.x - A.x, B.z - A.z);
    const fly = clamp(0.5 + 0.012 * dist, 0.55, 0.95);
    const arc = Math.min(25, 1.5 + 0.15 * dist);
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
        sx: (Math.random() - 0.5) * 0.8, sz: (Math.random() - 0.5) * 0.8, // scatter at the start (m)
        lat: (Math.random() - 0.5) * 1.5, // sideways bow of the arc (m)
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
                this.glowPS.spawn(B.x, B.y + 0.2, B.z, 0, 1.5, 0, 0.35, 0.9, 0.15, this.gold, 0.9, 0, 2, 0);
                for (let j = 0; j < 3; j++) this.glowPS.spawn(B.x, B.y + 0.2, B.z, (Math.random() - 0.5) * 4, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 4, 0.45, 0.35, 0.06, this.gold, 1, GRAVITY, 2, 0.8);
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
          const s = Math.min(1, u * 6, (1 - u) * 5 + 0.25);
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
        if (!this.animator.finishing && gen === this.gen) this.sparkles(B, { count: 10, radius: 0.9, up: 1.5 });
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
  gavel(pos, { delay = 0, strikes = 1, yaw = -0.5, scale = 4, onStrike, onDone } = {}) {
    if (!pos) return 0;
    const G = this.gavelRig;
    const APPEAR = 0.16;
    const STRIKE = 0.36; // wind-up 0.22 + hit 0.07 + rebound 0.07
    const HOLD = 0.25;
    const GONE = 0.2;
    const total = APPEAR + strikes * STRIKE + HOLD + GONE;
    const gen = this.gen;
    let hits = 0;
    const px = Number(pos.x) || 0, py = Number(pos.y) || 0, pz = Number(pos.z) || 0;
    const K = Math.max(0.1, Number(scale) || 4); // a storybook gavel ~2 m long over the lot
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        G.root.visible = true;
        G.root.position.set(px, py, pz);
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
              this.dust(hp.setY(py + 0.05), { size: 0.12 * K });
              this.sparkles(this.v.setY(py + 0.25 * K), { count: 8, radius: 0.3 * K, up: 0.6 * K, color: '#fff2c0' });
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
        G.root.scale.setScalar(Math.max(0.001, s) * K);
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
  soldStamp(pos, { delay = 0, color = '#d0202e', hold = 1.1, yaw = -0.14, size = 8, onLand, onDone } = {}) {
    if (!pos) return 0;
    const S = this.stamp;
    const DROP = 0.14;
    const FADE = 0.3;
    const total = DROP + 0.12 + hold + FADE;
    const gen = this.gen;
    let landed = false;
    const px = Number(pos.x) || 0, py = Number(pos.y) || 0, pz = Number(pos.z) || 0;
    const K = Math.max(0.1, Number(size) || 8) / 0.96; // the stamp is `size` m wide on the ground
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
        const rest = py + 0.06;
        let y = rest;
        let s = 1;
        let a = 0.92;
        if (t < DROP) {
          const u = ease.inQuad(t / DROP);
          y = rest + 0.9 * K * (1 - u);
          s = 1.9 - 0.9 * u;
          a = 0.3 + 0.62 * u;
        } else {
          if (!landed) {
            landed = true;
            if (!this.animator.finishing) {
              this.dust(this.v.set(px, py, pz), { size: 0.35 * K, count: 24 });
              this.cue(null, 'stamp', 1, 1);
              this.call(onLand);
            }
          }
          const u = t - DROP;
          if (u < 0.12) s = 1 + 0.1 * Math.sin(Math.PI * (u / 0.12));
          if (t > total - FADE) a = 0.92 * (1 - (t - (total - FADE)) / FADE);
        }
        S.position.set(px, y, pz);
        S.scale.set(s * K, 1, s * K);
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
  auctionSold(pos, { delay = 0, strikes = 1, color, scale = 4, onStrike, onStamp } = {}) {
    if (!pos) return 0;
    const K = Math.max(0.1, Number(scale) || 4);
    const g = this.gavel(vec(pos, 0, this.v2).addScaledVector(GAVEL_OFFSET, K), { delay, strikes, scale: K, onStrike });
    const landAt = g - 0.45 - 0.1; // just after the last strike
    return Math.max(g, this.soldStamp(pos, { delay: landAt, color, size: 2 * K, onLand: onStamp }));
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
  deeds(from, to, cards, { delay = 0, stagger = 0.14, scale = 3.5, onLand, onDone } = {}) {
    if (!from || !to || !Array.isArray(cards) || !cards.length) return 0;
    const list = cards.slice(0, DEED_POOL);
    const FLY = 0.8;
    const TUCK = 0.22;
    const total = (list.length - 1) * stagger + FLY + TUCK;
    const K = Math.max(0.1, Number(scale) || 3.5); // a deed ~1.6 × 2 m, flying at head height
    const A = vec(from);
    const B = vec(to);
    A.y += 0.75 * K;
    B.y += 0.75 * K;
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
          const fan = (S.k - (slots.length - 1) / 2) * 0.16 * K;
          let s = 1;
          if (u < 1) {
            const e = ease.inOutCubic(u);
            M.position.set(A.x + (B.x - A.x) * e + fan * Math.sin(Math.PI * u), A.y + (B.y - A.y) * e + 1.0 * K * Math.sin(Math.PI * u), A.z + (B.z - A.z) * e);
            M.rotation.set(-0.55, Math.PI * 2 * e, 0.12 * Math.sin(Math.PI * 2 * u));
            s = Math.min(1, u * 5);
          } else {
            if (!S.landed) {
              S.landed = true;
              if (!this.animator.finishing) {
                this.sparkles(B, { count: 6, radius: 0.25 * K, up: 0.6 * K, color: '#ffffff' });
                this.call(onLand, S.k, slots.length);
              }
            }
            const w = Math.min(1, (u - 1) * (FLY / TUCK));
            M.position.set(B.x + fan, B.y + 0.05 * K * S.k - 0.35 * K * ease.inQuad(w), B.z);
            M.rotation.set(-0.55, 0, 0);
            s = 1 - ease.inQuad(w);
          }
          M.scale.setScalar(Math.max(0.001, s) * K);
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
  goBurst(pos, { delay = 0, amount = 200, text = null, radius = 14, onBurst } = {}) {
    if (!pos) return 0;
    const TOTAL = 1.4;
    const gen = this.gen;
    const label = text ?? `GO!  +$${Math.abs(Math.round(Number(amount) || 0))}`;
    const px = Number(pos.x) || 0, py = Number(pos.y) || 0, pz = Number(pos.z) || 0;
    const K = Math.max(0.5, Number(radius) || 14) / 1.8; // the shockwave ends `radius` m wide
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
          for (let k = 0; k < 60; k++) {
            const a = Math.random() * Math.PI * 2;
            const sp = (0.4 + Math.random() * 0.9) * K * 0.8;
            this.glowPS.spawn(px, py + 0.3, pz, Math.cos(a) * sp, (2.6 + Math.random() * 1.8) * Math.sqrt(K) * 1.6, Math.sin(a) * sp,
              0.9 + Math.random() * 0.5, 0.17 * K * 0.8, 0.04 * K, k % 4 ? this.gold : this.white, 1, GRAVITY, 0.6, 0.7);
          }
          this.drive(1.5);
          this.cue(null, 'passGo', 1, 1);
          this.call(onBurst);
        }
      },
      update: (p) => {
        if (gen !== this.gen) return;
        const t = p * TOTAL;
        const r = Math.min(1, t / 0.7);
        R.position.set(px, py + 0.05, pz);
        R.scale.setScalar((0.3 + 1.5 * ease.outCubic(r)) * K);
        R.material.opacity = 0.95 * (1 - r);
        R.visible = r < 1;
        const pop = t < 0.3 ? ease.outBack(t / 0.3) : 1;
        const fade = t > TOTAL - 0.35 ? (TOTAL - t) / 0.35 : 1;
        L.position.set(px, py + (0.9 + 0.35 * ease.outQuad(p)) * K, pz);
        L.scale.set(1.6 * pop * K, 0.4 * pop * K, 1);
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
  jailSlam(pos = JAIL_HINGE, { delay = 0, yaw = Math.PI / 2, hold = 0.7, width = DOOR_W, onSlam, onDone } = {}) {
    const D = this.door;
    const SWING = 0.22;
    const BOUNCE = 0.28;
    const SINK = 0.3;
    const total = SWING + BOUNCE + hold + SINK;
    const gen = this.gen;
    let slammed = false;
    const hx = Number(pos?.x) || 0, hy = Number(pos?.y) || 0, hz = Number(pos?.z) || 0;
    const W = Math.max(0.3, Number(width) || DOOR_W);
    this.animator.add({
      delay,
      duration: total,
      start: () => {
        D.root.visible = true;
        D.root.position.set(hx, hy, hz);
        D.root.rotation.y = yaw;
        D.door.scale.set(W / DOOR_W, 1, 1);
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
              const mid = D.door.localToWorld(this.v.set(DOOR_W / 2, 0.05, 0));
              this.dust(mid, { size: 1.4, count: 26 });
              this.sparkles(this.v2.copy(mid).setY(hy + 1.4), { count: 16, radius: 1.2, up: 1.5, color: '#ffffff' });
              this.cue(null, 'jailSlam', 1, 1);
              this.call(onSlam);
            }
          }
          const u = t - SWING;
          if (u < BOUNCE) ang = -0.16 * Math.sin(Math.PI * 2 * (u / BOUNCE)) * (1 - u / BOUNCE);
          if (t > total - SINK) y = -(DOOR_H + 0.2) * ease.inQuad((t - (total - SINK)) / SINK);
        }
        D.door.rotation.y = ang;
        D.root.position.y = hy + y;
      },
      end: () => {
        D.root.visible = false;
        D.root.position.y = hy;
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
const GAVEL_OFFSET = new THREE.Vector3(0.1, 0, -0.55); // × the gavel scale: it strikes just behind the stamp
const JAIL_HINGE = new THREE.Vector3(-146, 0, 146); // the Jail yard gate (city-layout JAIL_YARD.gate)
const DOOR_W = 2.4; // a barred cell door, metres
const DOOR_H = 2.8;

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

/** A barred cell door (dark iron) hinged at its local origin, DOOR_W (2.4 m) wide along +X, 2.8 m tall. */
function buildDoor() {
  const root = new THREE.Group();
  root.name = 'fx-door';
  root.visible = false;
  const k = new PartKit();
  const W = DOOR_W;
  const H = DOOR_H;
  const iron = '#3a3d42';
  const bars = 11;
  for (let i = 0; i < bars; i++) k.add(new THREE.CylinderGeometry(0.03, 0.03, H, 8), { at: [0.12 + (i * (W - 0.24)) / (bars - 1), H / 2, 0], color: iron, smooth: 40 });
  for (const y of [0.15, H * 0.5, H - 0.12]) k.add(new THREE.BoxGeometry(W, 0.1, 0.07), { at: [W / 2, y, 0], color: iron });
  k.add(new THREE.CylinderGeometry(0.06, 0.06, H + 0.1, 10), { at: [0, H / 2, 0], color: '#2a2c30', smooth: 40 }); // hinge post
  k.add(new THREE.BoxGeometry(0.18, 0.26, 0.14), { at: [W - 0.16, H * 0.45, 0], color: '#b8963e' }); // lock
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
