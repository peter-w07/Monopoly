// public/r3d/char-motion.js — the CharacterLayer: life-size characters moving through the city
// (city design §7, §8, §10, §17.7).
//
// Semantics follow the old TokenLayer: sync() converges on the state (slots from city-layout restSlots), every
// animation is laid out on the shared Animator and ends at rest pose in its slot, callbacks (onStart, onTile,
// onPassGo, onLand) never fire during a skip (Animator.finishAll) except the final onLand({ skipped: true }).
//
//   drives      roll / card moves follow travel.js: a real-speed launch, a time-lapse cruise along the token
//               lane (pointAt, corners on the arc), a real-speed arrival. Wheels spin with v/r (blur disc above
//               6 rev/s), front wheels steer by the bicycle model, bodies squat / dive / roll on springs; walkers
//               step off the kerb, stride with planted feet (gait.js) and step back onto the sidewalk.
//               The layer drives the city clock: clock.setTarget(plan.clockAt(t) × animator.rate); go back = −4.
//   tow         moved{via:'jail'}: the tow truck arrives from 60 m behind, winches the vehicle / the walker hops
//               on, cut (cutAt), the truck backs up to the yard gate (gateAt), the character rolls into its yard
//               slot, the gate slams (slamAt), the truck leaves. 2.4 s (1.6 s short).
//   reactions   REACTIONS + 'wake', each character in its own way (§7.1 signatures).
//   halos       one InstancedMesh for all (fade in 60 → 250 m from the camera, the current player's pulses).
//   trails      one ribbon along the lane revealed by uniforms (4 trail slots), 1.5 s after a move.
//
// No per-frame allocation in the update paths (shared temporaries).

import * as THREE from './three.js';
import { CHARACTER_INFO, buildCharacter, disposeCharacter, setCharacterColor, infoOf, knownToken } from './characters.js';
import { travelPlan } from './travel.js';
import {
  createGait, stepGait, resetGait, ik2, createSpring, stepSpring, restSpring, stepWheel, stopWheel, steer as steerAngle,
  pitchFor, rollFor, leanFor, CADENCE_CAP,
} from './gait.js';
import { pointAt, pathFor, restSlots, sOf, wrap, LOOP, QUARTER, HALF_ARC, M, JAIL_YARD, surfaceAt, angleDelta } from './city-layout.js';
import { Actors, ACTOR_INFO } from './actors.js';
import { ease, clamp } from './tween.js';

export const REACTIONS = Object.freeze({ celebrate: 0.95, sad: 1.2, jail: 1.4, goJump: 0.6, bankrupt: 1.15, victory: 0.62, wake: 0.6 });
export const TOW_TIME = 2.4;
export const TOW_SHORT = 1.6;
export const DROP_TIME = 0.3;
export const RELEASE_TIME = 0.6;
export const EXIT_TIME = 1.0;
export const CAMEO_TIME = 1.0;
export const TRAIL_LENGTH = 40;
export const TRAIL_LIFE = 1.5; // s after the move
const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];

/** Signature sounds per character ([sfx name, rate, volume]); suggestions passed to callbacks as info.sound. */
export const SIGNATURES = Object.freeze({
  car: { land: ['hornCar', 1, 0.5], happy: ['hornCar', 1.12, 0.6], sad: ['doorSlam', 0.6, 0.5], wake: ['engineStart', 1, 0.6] },
  dog: { land: ['bark', 1, 0.75], happy: ['bark', 1.1, 0.8], sad: ['bark', 0.7, 0.35], wake: ['bark', 1.2, 0.4] },
  hat: { land: ['bikeBell', 1, 0.6], happy: ['hatSpin', 1, 0.6], sad: ['bikeBell', 0.7, 0.3], wake: ['bikeBell', 1.1, 0.5] },
  ship: { land: ['horn', 0.7, 0.6], happy: ['horn', 0.8, 0.65], sad: ['horn', 0.55, 0.45], wake: ['horn', 0.7, 0.5] },
  boot: { land: ['hydraulicHop', 1, 0.6], happy: ['hydraulicHop', 1.1, 0.65], sad: ['stomp', 0.8, 0.5], wake: ['hydraulicHop', 0.9, 0.5] },
  cat: { land: ['meow', 1, 0.7], happy: ['purr', 1, 0.8], sad: ['meow', 0.75, 0.45], wake: ['meow', 1.15, 0.4] },
  thimble: { land: ['clink', 1, 0.8], happy: ['clink', 1.2, 0.8], sad: ['engineStart', 1.6, 0.4], wake: ['engineStart', 1.3, 0.5] },
  wheelbarrow: { land: ['squeak', 1, 0.5], happy: ['squeak', 1.25, 0.5], sad: ['squeak', 0.75, 0.45], wake: ['squeak', 1.1, 0.35] },
  pawn: { land: ['land', 1, 0.6], happy: ['land', 1.2, 0.5], sad: null, wake: null },
});

const TAU = Math.PI * 2;
const sm = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const sstep = (a, b, x) => sm((x - a) / (b - a));
const wrapDelta = (d) => { d = ((d % LOOP) + LOOP) % LOOP; return d > LOOP / 2 ? d - LOOP : d; };
const mod = (x, m) => ((x % m) + m) % m;
const hump = (u) => Math.sin(Math.PI * clamp(u, 0, 1));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SIGN = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

// Shared temporaries (no per-frame allocation).
const P = { x: 0, z: 0, heading: 0, nx: 0, nz: 0 };
const P2 = { x: 0, z: 0, heading: 0, nx: 0, nz: 0 };
const LC = { s: 0, lat: 0 };
const IK = { a: 0, b: 0, reach: 0 };
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const M1 = new THREE.Matrix4();
const Q1 = new THREE.Quaternion();
const S1 = new THREE.Vector3();
const COL = new THREE.Color();

/** (x, z) → token-lane coordinates { s (wrapped), lat } (inverse of pointAt near the lane). */
export function laneCoords(x, z, out = {}) {
  const C = M.ARC_C;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax > C && az > C) {
    const sx = Math.sign(x);
    const sz = Math.sign(z);
    const q1 = SIGN.findIndex(([a, b]) => a === sx && b === sz);
    const cx = sx * C;
    const cz = sz * C;
    const phi = Math.atan2(z - cz, x - cx);
    out.s = mod(q1 * QUARTER + angleDelta(Math.PI / 4 + (q1 * Math.PI) / 2, phi) * M.ARC_R, LOOP);
    out.lat = Math.hypot(x - cx, z - cz) - M.ARC_R;
  } else if (az >= ax) {
    if (z > 0) { out.s = HALF_ARC + (C - x); out.lat = z - M.LANE; }
    else { out.s = 2 * QUARTER + HALF_ARC + (x + C); out.lat = -z - M.LANE; }
  } else if (x < 0) { out.s = QUARTER + HALF_ARC + (C - z); out.lat = -x - M.LANE; }
  else { out.s = 3 * QUARTER + HALF_ARC + (z + C); out.lat = x - M.LANE; }
  return out;
}

/** Ground height for a lateral offset from the lane centre (sidewalk +0.15 beyond the kerb). */
const groundAt = (lat) => 0.15 * sstep(1.55, 1.95, lat);
const slotY = (place, lat) => (place === 'yard' ? 0.15 : place === 'sidewalk' ? 0.15 : groundAt(lat));
const sameSpot = (a, b) => a && b && a.index === b.index && !!a.jailed === !!b.jailed;
const spotKey = (s) => (s.jailed ? 'J' : String(s.index));

let reported = new Set();
function report(where, err) {
  if (reported.has(where)) return;
  reported.add(where);
  console.error(`[renderer3d] chars.${where} failed:`, err);
}
function safe(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (err) { console.error('[renderer3d] character callback failed:', err); }
}

// ---- halos & trails ------------------------------------------------------------------------------------

const MAX_HALOS = 12;
const TRAILS = 4;

function createHalos() {
  const geo = new THREE.RingGeometry(0.8, 1.0, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const inner = new THREE.CircleGeometry(0.8, 48);
  inner.rotateX(-Math.PI / 2);
  // One geometry: the ring (aRing 1) + a faint disc (aRing 0).
  const merged = new THREE.BufferGeometry();
  const a = geo.toNonIndexed();
  const b = inner.toNonIndexed();
  const pos = new Float32Array(a.attributes.position.count * 3 + b.attributes.position.count * 3);
  pos.set(a.attributes.position.array, 0);
  pos.set(b.attributes.position.array, a.attributes.position.array.length);
  const ring = new Float32Array(a.attributes.position.count + b.attributes.position.count);
  ring.fill(1, 0, a.attributes.position.count);
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('aRing', new THREE.BufferAttribute(ring, 1));
  geo.dispose(); inner.dispose(); a.dispose(); b.dispose();
  const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mat.name = 'char-halo';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRing;\nattribute float aPulse;\nvarying float vRing;\nvarying float vPulse;\nvarying float vFade;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRing = aRing;
vPulse = aPulse;
vec4 haloC = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
vFade = smoothstep(60.0, 250.0, distance(cameraPosition, haloC.xyz));
transformed.xz *= 1.0 + 0.12 * aPulse * aRing;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRing;\nvarying float vPulse;\nvarying float vFade;')
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.35 * vPulse * vRing);
diffuseColor.a *= vFade * (vRing > 0.5 ? (0.85 + 0.15 * vPulse) : (0.16 + 0.14 * vPulse));`);
  };
  mat.customProgramCacheKey = () => 'char-halo-v1';
  const mesh = new THREE.InstancedMesh(merged, mat, MAX_HALOS);
  mesh.name = 'character-halos';
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HALOS * 3), 3);
  const pulse = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HALOS), 1);
  pulse.setUsage(THREE.DynamicDrawUsage);
  merged.setAttribute('aPulse', pulse);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, pulse };
}

function createTrails() {
  const step = 2;
  const n = Math.ceil(LOOP / step);
  const half = 0.8;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const sArr = new Float32Array((n + 1) * 2);
  const across = new Float32Array((n + 1) * 2);
  for (let k = 0; k <= n; k++) {
    const s = Math.min(LOOP, k * step);
    for (let side = 0; side < 2; side++) {
      pointAt(s, side ? half : -half, P);
      const i = k * 2 + side;
      pos[i * 3] = P.x; pos[i * 3 + 1] = 0.07; pos[i * 3 + 2] = P.z;
      sArr[i] = s;
      across[i] = side ? 1 : -1;
    }
  }
  const index = [];
  for (let k = 0; k < n; k++) {
    const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
    index.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aS', new THREE.BufferAttribute(sArr, 1));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setIndex(index);
  const uniforms = {
    uTrail: { value: Array.from({ length: TRAILS }, () => new THREE.Vector4(0, 1, 0, 0)) }, // head s, dir, alpha
    uTrailColor: { value: Array.from({ length: TRAILS }, () => new THREE.Color()) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aS;
      attribute float aAcross;
      uniform vec4 uTrail[${TRAILS}];
      uniform vec3 uTrailColor[${TRAILS}];
      varying vec3 vCol;
      varying float vA;
      varying float vAcross;
      void main() {
        vCol = vec3(0.0);
        vA = 0.0;
        for (int k = 0; k < ${TRAILS}; k++) {
          vec4 t = uTrail[k];
          if (t.z <= 0.0) continue;
          float d = mod(t.y * (t.x - aS), ${LOOP.toFixed(4)});
          if (d < ${TRAIL_LENGTH.toFixed(1)}) {
            float w = (1.0 - d / ${TRAIL_LENGTH.toFixed(1)}) * t.z;
            vCol += uTrailColor[k] * w;
            vA = max(vA, w);
          }
        }
        vAcross = aAcross;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vA;
      varying float vAcross;
      void main() {
        float edge = 1.0 - abs(vAcross);
        float a = vA * smoothstep(0.0, 0.7, edge);
        if (a < 0.003) discard;
        gl_FragColor = vec4(vCol * 1.6 * smoothstep(0.0, 0.7, edge), a);
      }`,
  });
  mat.name = 'char-trails';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'character-trails';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;
  return { mesh, uniforms, slots: Array.from({ length: TRAILS }, () => ({ owner: null, moving: false, end: -1e9 })) };
}

// ---- the layer ---------------------------------------------------------------------------------------

export class CharacterLayer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./tween.js').Animator} animator
   * @param {{ markShadows?: Function, fx?: object, clock?: object, bus?: object, BOARD?: object }} [opts]
   */
  constructor(scene, animator, { markShadows = null, fx = null, clock = null, bus = null, BOARD = null } = {}) {
    this.scene = scene;
    this.animator = animator;
    this.markShadows = typeof markShadows === 'function' ? markShadows : () => {};
    this.fx = fx;
    this.clock = clock;
    this.bus = bus;
    this.BOARD = BOARD;
    this.audio = null;
    this.sfx = null;
    this.info = CHARACTER_INFO;
    this.map = new Map();
    this.currentId = null;
    this.lights = bus?.uniforms?.uLights ?? { value: 0 };
    this.group = new THREE.Group();
    this.group.name = 'characters';
    scene?.add?.(this.group);
    const halos = createHalos();
    this.halos = halos.mesh;
    this.haloPulse = halos.pulse;
    this.group.add(this.halos);
    this.trails = createTrails();
    this.group.add(this.trails.mesh);
    this.actors = new Actors(this.group, animator, { markShadows: this.markShadows, bus, lights: this.lights });
    this.lastFrame = 0;
    this.offFrame = null;
    try {
      this.offFrame = bus?.on?.('frame', (now) => this.frame(now)) ?? null;
    } catch { this.offFrame = null; }
    this.debug = {
      drive: (id, steps, opts = {}) => {
        const r = this.map.get(id);
        if (!r) return null;
        const from = (r.plan?.spot ?? r.spot).index;
        return this.scheduleMove({ type: 'moved', playerId: id, from, to: wrap(from + steps), steps, via: 'roll' }, opts.delay ?? 0, opts);
      },
      tow: (id, opts = {}) => {
        const r = this.map.get(id);
        if (!r) return null;
        return this.scheduleMove({ type: 'moved', playerId: id, from: (r.plan?.spot ?? r.spot).index, to: 10, steps: null, via: 'jail' }, opts.delay ?? 0, opts);
      },
      react: (id, kind, opts = {}) => this.react(id, kind, opts),
      release: (id) => this.release(id, 0),
      counts: () => this.counts(),
      records: () => this.map,
    };
  }

  // ---- registry ----------------------------------------------------------------------------------------

  setAudio(audio) { this.audio = audio ?? null; }
  /** Optional: when set, the layer plays signature sounds (landing, reactions) itself through this sfx. */
  setSfx(sfx) { this.sfx = sfx ?? null; }
  setFx(fx) { this.fx = fx ?? null; }

  get(id) {
    return this.map.get(id) ?? null;
  }

  sizeOf(id) {
    const r = this.map.get(id);
    return r ? { length: r.info.length, height: r.info.top ?? r.info.height, kind: r.kind, width: r.info.width } : null;
  }

  worldPos(id, out = new THREE.Vector3()) {
    const r = this.map.get(id);
    if (!r || !r.visible || r.exited) return null;
    return out.copy(r.root.position);
  }

  headPos(id, out = new THREE.Vector3()) {
    const r = this.map.get(id);
    if (!r || !r.visible || r.exited) return null;
    return out.copy(r.root.position).setY(r.root.position.y + r.c.model.position.y + (r.info.top ?? r.info.height) + 0.25);
  }

  ensure(p, order, color) {
    let r = this.map.get(p.id);
    const tok = knownToken(p.token);
    if (r && r.tokenId !== tok) {
      this.remove(p.id);
      r = null;
    }
    if (!r) {
      r = this.create(p.id, p.token, color, order);
      this.map.set(p.id, r);
    }
    r.order = order;
    if (r.color !== color) {
      r.color = color;
      setCharacterColor(r.c.material, color);
    }
    return r;
  }

  create(id, tokenId, color, order) {
    const c = buildCharacter(tokenId, { color, lights: this.lights });
    c.root.rotation.order = 'YXZ';
    c.root.visible = false;
    this.group.add(c.root);
    const rig = c.rig ?? {};
    const spring = rig.spring ?? [1.3, 0.45];
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const restList = Object.entries(c.bones).map(([name, bone]) => [bone, c.rest[name]]);
    const r = {
      id, tokenId: c.tokenId, kind: c.info.kind, info: c.info, rig, c, root: c.root, bones: c.bones, rest: c.rest, restList,
      scale: c.scale, color, order, visible: false, exited: false, spot: { index: 0, jailed: false }, plan: null,
      acts: 0, popping: false, reaction: null, phase: (h % 1000) / 159.2, pulseAt: -1e9, trail: -1,
      stepPos: new THREE.Vector3(), lastStep: -1, squeakAcc: 0,
      loco: {
        wheels: (rig.wheels ?? []).map(([b, rad]) => ({ bone: c.bones[b], w: { r: rad * c.scale, angle: 0, rate: 0, blur: false } })),
        steerBones: (rig.steer ?? []).map((b) => c.bones[b]),
        wheelbase: (rig.wheelbase ?? 2) * c.scale,
        pitch: createSpring(spring[0], spring[1]), roll: createSpring(spring[0], spring[1]), heave: createSpring(spring[0] * 1.2, spring[1]),
        lean: createSpring(1.2, 0.6), tail: createSpring(2.4, 0.3), ears: createSpring(3, 0.45), tub: createSpring(5, 0.22), lift: createSpring(3, 0.8),
        gait: rig.gait ? createGait(rig.gait, { hip: rig.hip, strideScale: rig.strideScale ?? 1 }) : null,
        vPrev: 0, kappa: 0, joint: 0, ikW: 0, engine: null, steer: 0,
      },
    };
    this.restPose(r);
    return r;
  }

  remove(id) {
    const r = this.map.get(id);
    if (!r) return;
    try {
      this.stopEngine(r);
      this.releaseTrail(r);
      disposeCharacter(r.c);
    } catch (err) { report('remove', err); }
    this.map.delete(id);
    this.refreshHalos();
  }

  clear() {
    for (const id of [...this.map.keys()]) this.remove(id);
    this.currentId = null;
    this.actors.hideAll();
    for (const s of this.trails.slots) { s.owner = null; s.moving = false; s.end = -1e9; }
    this.trails.mesh.visible = false;
    this.refreshHalos();
  }

  dispose() {
    try {
      this.clear();
      this.offFrame?.();
      this.offFrame = null;
      this.actors.dispose();
      this.halos.geometry.dispose();
      this.halos.material.dispose();
      this.trails.mesh.geometry.dispose();
      this.trails.mesh.material.dispose();
      this.group.parent?.remove(this.group);
    } catch (err) { report('dispose', err); }
  }

  counts() {
    let calls = 0, triangles = 0, shadow = 0;
    for (const r of this.map.values()) if (r.visible && r.root.visible) { calls++; shadow++; triangles += r.c.triangles; }
    if (this.halos.count > 0) calls++;
    if (this.trails.mesh.visible) calls++;
    for (const a of this.actors.pool.values()) if (a.visible) { calls++; shadow++; triangles += a.triangles; }
    return { characters: this.map.size, calls, shadowCalls: shadow, triangles };
  }

  // ---- state convergence ---------------------------------------------------------------------------------

  /**
   * Reconciles characters with the players list (TokenLayer.sync semantics): creates / removes, shows /
   * hides, sets the target spot. With `place` every visible character is put in its slot (animated if
   * `animate`); keep: ids leaving the board later (bankrupt farewell), popNew: newcomers pop in.
   */
  sync(ctx, { animate = false, place = true, popNew = false, keep = null } = {}) {
    try {
      const seen = new Set();
      const fresh = new Set();
      (ctx?.players ?? []).forEach((p, i) => {
        if (!p || p.id == null) return;
        seen.add(p.id);
        const r = this.ensure(p, i, ctx.colorOf?.get?.(p.id) ?? PALETTE[i % PALETTE.length]);
        const onBoard = !!ctx.live && !p.bankrupt;
        if (!onBoard && keep?.has?.(p.id) && r.visible) return;
        if (!onBoard) {
          this.hide(r);
          return;
        }
        const index = wrap(p.position);
        const truth = { index, jailed: !!p.inJail && index === 10 };
        if (!r.visible) {
          r.visible = true;
          r.exited = false;
          r.root.visible = true;
          r.spot = truth;
          fresh.add(r);
          if (popNew && animate) this.pop(r, 0.08 * i);
          return;
        }
        if (r.reaction && !sameSpot(r.spot, truth)) r.reaction = null;
        if (place) {
          r.spot = truth;
          r.root.visible = true;
          r.exited = false;
        }
      });
      for (const id of [...this.map.keys()]) if (!seen.has(id)) this.remove(id);
      if (place) this.layout(animate, null, fresh);
      else if (fresh.size) this.layout(false, fresh);
      this.refreshHalos();
      this.setCurrent(this.currentId);
    } catch (err) { report('sync', err); }
  }

  hide(r) {
    r.visible = false;
    r.root.visible = false;
    r.reaction = null;
    r.plan = null;
    this.stopEngine(r);
  }

  /** Effective spot at the end of everything scheduled. */
  effSpot(r) {
    return r.plan?.spot ?? r.spot;
  }

  /** Slots for every member of `spot`'s group ({ id → slot }), using planned spots. */
  slotsAt(spot) {
    const members = [];
    for (const r of this.map.values()) {
      if (!r.visible || r.exited) continue;
      if (sameSpot(this.effSpot(r), spot)) members.push(r);
    }
    members.sort((a, b) => a.order - b.order);
    const list = restSlots(spot.index, members.map((r) => ({ id: r.id, kind: r.kind, length: r.info.length })), { jailed: !!spot.jailed });
    const out = new Map();
    for (const s of list) {
      laneCoords(s.x, s.z, LC);
      out.set(s.id, { x: s.x, z: s.z, heading: s.heading, place: s.place, s: LC.s, lat: LC.lat, y: slotY(s.place, LC.lat) });
    }
    return out;
  }

  /** The slot a character occupies (or will, after its scheduled moves). */
  slotOf(r) {
    return this.slotsAt(this.effSpot(r)).get(r.id) ?? null;
  }

  /**
   * Puts visible characters in their slots; groups that share a spot pack per restSlots.
   * @param {boolean} animate glide (wheels turning / walking) instead of snapping
   * @param {Set|null} only   move only these records
   * @param {Set|null} snapSet records that always snap
   */
  layout(animate, only = null, snapSet = null) {
    let changed = false;
    const groups = new Map();
    for (const r of this.map.values()) {
      if (!r.visible || r.exited) continue;
      const k = spotKey(this.effSpot(r));
      if (!groups.has(k)) groups.set(k, this.effSpot(r));
    }
    for (const spot of groups.values()) {
      const slots = this.slotsAt(spot);
      for (const r of this.map.values()) {
        const slot = slots.get(r.id);
        if (!slot || (only && !only.has(r))) continue;
        if (r.plan && r.acts > 0) continue; // mid-move: its own animation lands it
        const p = r.root.position;
        const d = Math.hypot(p.x - slot.x, p.z - slot.z);
        const dh = Math.abs(angleDelta(r.root.rotation.y, slot.heading));
        if (d < 0.01 && dh < 0.01 && Math.abs(p.y - slot.y) < 0.005) continue;
        changed = true;
        if (!animate || snapSet?.has(r) || d > 40 || this.animator.finishing) {
          this.put(r, slot);
          if (!r.acts) this.restPose(r);
        } else this.glide(r, slot);
      }
    }
    if (changed) {
      this.refreshHalos();
      this.markShadows();
    }
  }

  put(r, slot) {
    r.root.position.set(slot.x, slot.y, slot.z);
    r.root.rotation.set(0, slot.heading, 0);
  }

  /** A short repositioning (a vehicle creeps forward in the queue, a walker steps aside). */
  glide(r, slot) {
    const from = r.root.position.clone();
    const h0 = r.root.rotation.y;
    const dur = clamp(0.35 + Math.hypot(slot.x - from.x, slot.z - from.z) * 0.05, 0.35, 0.9);
    let prev = 0;
    r.acts++;
    this.animator.add({
      duration: dur,
      start: () => { this.restPose(r); },
      update: (p) => {
        const e = ease.inOutCubic(p);
        const x = from.x + (slot.x - from.x) * e;
        const z = from.z + (slot.z - from.z) * e;
        const ds = Math.hypot(x - r.root.position.x, z - r.root.position.z);
        const fwd = Math.sin(r.root.rotation.y) * (x - r.root.position.x) + Math.cos(r.root.rotation.y) * (z - r.root.position.z);
        r.root.position.set(x, from.y + (slot.y - from.y) * e, z);
        r.root.rotation.y = h0 + angleDelta(h0, slot.heading) * e;
        const t = p * dur;
        this.locomote(r, fwd >= 0 ? ds : -ds, t - prev, 0, false);
        prev = t;
        this.refreshHalos();
        this.markShadows();
      },
      end: () => {
        this.put(r, slot);
        r.acts = Math.max(0, r.acts - 1);
        this.endLoco(r);
        this.restPose(r);
        this.refreshHalos();
        this.markShadows();
      },
    });
  }

  /** Scales a character in with a bounce (game start). */
  pop(r, delay = 0) {
    r.popping = true;
    r.root.scale.setScalar(0.001);
    this.animator.add({
      delay,
      duration: 0.45,
      easing: ease.outBack,
      update: (p) => { r.root.scale.setScalar(Math.max(0.001, p)); this.markShadows(); },
      end: () => { r.popping = false; r.root.scale.setScalar(1); },
    });
  }

  // ---- moves -------------------------------------------------------------------------------------------

  /**
   * Schedules one `moved` event `delay` animation seconds from now (§17.7).
   * opts: { plan, path, onStart(info), onTile(index, info), onPassGo(info), onLand(info), short }
   */
  scheduleMove(e, delay = 0, opts = {}) {
    const d = Math.max(0, Number(delay) || 0);
    const none = { kind: 'none', duration: 0, landAt: d, plan: null, path: null, launchEnd: d, cruiseStart: d, cruiseEnd: d, goAt: null, tileTimes: [] };
    try {
      const r = this.map.get(e?.playerId);
      if (!r || !r.visible) return none;
      if (e.via === 'jail') return this.scheduleTow(r, e, d, opts ?? {});
      const steps = Number.isInteger(e.steps) ? e.steps : null;
      if (steps === null || steps === 0) return this.scheduleDrop(r, e, d, opts ?? {});
      return this.scheduleDrive(r, e, steps, d, opts ?? {});
    } catch (err) {
      report('scheduleMove', err);
      return none;
    }
  }

  /** Current (or planned) start of a character: its slot coordinates. */
  startOf(r) {
    if (r.plan?.slot && r.acts > 0) return r.plan.slot;
    const p = r.root.position;
    laneCoords(p.x, p.z, LC);
    return { x: p.x, z: p.z, heading: r.root.rotation.y, y: p.y, s: LC.s, lat: LC.lat, place: 'lane' };
  }

  scheduleDrive(r, e, steps, delay, opts) {
    // A character still in the yard first drives out to the visitors' kerb.
    if (this.effSpot(r).jailed) delay += this.release(r.id, delay);
    const from = this.effSpot(r).index;
    const path = opts.path ?? pathFor(from, steps);
    const plan = opts.plan ?? travelPlan({ length: path.length, tokenId: r.tokenId, own: true });
    const start = this.startOf(r);
    const originSpot = { ...this.effSpot(r) };
    const startSlots = this.slotsAt(originSpot);
    r.plan = { spot: { index: path.to, jailed: false }, slot: null };
    const destSlots = this.slotsAt(r.plan.spot);
    const dest = destSlots.get(r.id);
    r.plan.slot = dest;
    const s0u = path.s0 + wrapDelta(start.s - sOf(from));
    const s1u = path.s1 + wrapDelta(dest.s - sOf(path.to));
    const dir = steps < 0 ? -1 : 1;
    // Pull out past a vehicle parked ahead at the start, and past those parked behind the destination slot.
    let bumpStart = 0, bumpEnd = 0;
    if (r.kind === 'vehicle') {
      const pass = -(r.info.width / 2 + 1.05);
      for (const [id, s] of startSlots) if (id !== r.id && s.place === 'lane' && dir * wrapDelta(s.s - start.s) > 0 && Math.abs(start.lat) < 1) bumpStart = pass;
      for (const [id, s] of destSlots) if (id !== r.id && s.place === 'lane' && dir * wrapDelta(s.s - dest.s) < 0 && Math.abs(dest.lat) < 1) bumpEnd = pass;
    }
    const T = plan.T;
    const tiles = path.tiles.map((tile, k) => ({ index: tile.index, at: k === path.tiles.length - 1 ? T : plan.timeAt(tile.at * plan.length) }));
    const goT = path.goAt === null || path.goAt === undefined ? null : plan.timeAt(path.goAt * plan.length);
    const res = this.scheduleTravel(r, {
      kind: 'drive', delay, T, plan, timeK: 1, s0u, s1u, lat0: start.lat, lat1: dest.lat, dir, bumpStart, bumpEnd,
      tiles, goT, dest, destSpot: r.plan.spot, origin: originSpot, opts, y0: start.y ?? 0,
    });
    return {
      kind: 'drive', duration: T, landAt: delay + T, plan, path,
      launchEnd: delay + plan.launch, cruiseStart: delay + plan.cruiseStart, cruiseEnd: delay + plan.cruiseEnd,
      goAt: goT === null ? null : delay + goT,
      tileTimes: tiles.map((t) => ({ index: t.index, at: delay + t.at })),
      ...res,
    };
  }

  /**
   * One continuous lane travel (drives, the victory lap): position from plan.sAt, lateral blends, heading
   * from the path (+ crab angle), locomotion, clock, trail, engine, callbacks.
   */
  scheduleTravel(r, cfg) {
    const { delay, T, plan, timeK, s0u, s1u, dir, tiles, goT, dest, opts } = cfg;
    const walker = r.kind === 'walker';
    const L0 = plan.launch / timeK, CS = plan.cruiseStart / timeK, CE = plan.cruiseEnd / timeK, A = plan.arrive / timeK;
    const latAt = (t) => {
      const out = sstep(0.35 * L0, CS, t);
      const inn = sstep(CE, T - 0.35 * A, t);
      let lat = cfg.lat0 * (1 - out) + cfg.lat1 * inn;
      if (cfg.bumpStart) lat += cfg.bumpStart * hump(t / Math.max(0.05, CS + 0.08));
      if (cfg.bumpEnd) lat += cfg.bumpEnd * hump((t - (CE - 0.08)) / Math.max(0.05, T - CE + 0.08));
      return lat;
    };
    let prevT = 0, sPrev = s0u, latPrev = cfg.lat0, hPrev = 0, nextTile = 0, goFired = false, crab = 0, beep = 0;
    r.acts++;
    const finishing = () => this.animator.finishing;
    const info = (extra) => ({ playerId: r.id, tokenId: r.tokenId, kind: cfg.kind, index: r.spot.index, step: 0, of: tiles.length, last: false, sound: null, skipped: false, ...extra });
    this.animator.add({
      delay,
      duration: T,
      start: () => {
        this.restPose(r);
        r.reaction = null;
        pointAt(s0u, cfg.lat0, P);
        hPrev = P.heading;
        sPrev = s0u;
        latPrev = cfg.lat0;
        prevT = 0;
        crab = 0;
        r.loco.vPrev = 0;
        if (cfg.kind === 'drive' || cfg.kind === 'lap') this.claimTrail(r);
        if (!finishing()) {
          if (r.kind === 'vehicle') this.startEngine(r);
          if (r.tokenId === 'car') this.puff(r, 0.6);
          safe(opts.onStart, info({ sound: null }));
        }
      },
      update: (p) => {
        const t = p * T;
        const dt = t - prevT;
        prevT = t;
        const tp = t * timeK;
        const f = plan.length > 0 ? plan.sAt(tp) / plan.length : p;
        const s = s0u + (s1u - s0u) * f;
        const lat = latAt(t);
        pointAt(s, lat, P);
        const ds = s - sPrev;
        const dLat = lat - latPrev;
        const kappa = Math.abs(ds) > 1e-4 ? angleDelta(hPrev, P.heading) / ds : 0;
        hPrev = P.heading;
        sPrev = s;
        latPrev = lat;
        const c = Math.abs(ds) > 1e-5 || Math.abs(dLat) > 1e-5 ? clamp(Math.atan2(dLat, Math.abs(ds)), -0.7, 0.7) : 0;
        crab += (c - crab) * (1 - Math.exp(-Math.max(0, dt) * 18));
        let heading;
        if (walker && dir < 0) heading = P.heading + Math.PI * sm(t / 0.18) * (1 - sm((t - (T - 0.22)) / 0.22)) + crab;
        else heading = P.heading + (dir < 0 ? -crab : crab);
        r.root.position.set(P.x, walker ? groundAt(lat) : (cfg.y0 ?? 0) * (1 - sm(t / 0.2)), P.z);
        r.root.rotation.y = heading;
        // Locomotion (distance along the body's direction: reversing vehicles roll backwards).
        const dist = Math.hypot(ds, dLat);
        this.locomote(r, walker ? dist : dir < 0 ? -dist : dist, dt, kappa, true);
        // Counting ritual / GO / trail / clock / engine.
        while (nextTile < tiles.length && t >= tiles[nextTile].at - 1e-9) {
          const tile = tiles[nextTile];
          r.spot = { index: tile.index, jailed: false };
          nextTile++;
          if (!finishing()) safe(opts.onTile, tile.index, info({ index: tile.index, step: nextTile, last: nextTile === tiles.length }));
        }
        if (goT !== null && !goFired && t >= goT) {
          goFired = true;
          if (!finishing()) safe(opts.onPassGo, info({ index: 0 }));
        }
        this.trailHead(r, s, dir);
        if (!finishing()) {
          const rate = this.animator.rate || 1;
          this.clock?.setTarget?.(dir < 0 ? -4 : plan.clockAt(tp) * timeK * rate);
          if (r.loco.engine) r.loco.engine.set?.({ speed: r.loco.vPrev, pos: r.root.position });
          if (dir < 0 && r.kind === 'vehicle' && t >= beep) {
            beep = t + 0.6;
            this.play('reverseBeep', r, 0.35);
          }
        }
        this.refreshHalos();
        this.markShadows();
      },
      end: () => {
        const skipped = finishing();
        this.put(r, dest);
        r.spot = { ...cfg.destSpot };
        r.acts = Math.max(0, r.acts - 1);
        if (r.acts === 0) r.plan = null;
        this.endLoco(r);
        this.restPose(r);
        this.endTrail(r);
        this.stopEngine(r);
        this.clock?.setTarget?.(1, { snap: true });
        if (!skipped) {
          while (nextTile < tiles.length) {
            const tile = tiles[nextTile++];
            safe(opts.onTile, tile.index, info({ index: tile.index, step: nextTile, last: nextTile === tiles.length }));
          }
          if (goT !== null && !goFired) safe(opts.onPassGo, info({ index: 0 }));
        }
        // The others at the destination / origin shuffle into their new slots.
        this.layout(!skipped);
        const snd = SIGNATURES[r.tokenId]?.land ?? null;
        if (!skipped && cfg.kind === 'drive') this.play(snd, r);
        safe(opts.onLand, info({ index: r.spot.index, last: true, sound: snd ? { name: snd[0], rate: snd[1], volume: snd[2] } : null, skipped }));
        this.refreshHalos();
        this.markShadows();
      },
    });
    return {};
  }

  /** Teleports (steps null, not jail): drops in from 6 m above its destination slot, 0.3 s. */
  scheduleDrop(r, e, delay, opts) {
    const to = wrap(Number.isFinite(Number(e.to)) ? e.to : this.effSpot(r).index);
    r.plan = { spot: { index: to, jailed: false }, slot: null };
    const dest = this.slotOf(r);
    r.plan.slot = dest;
    r.acts++;
    const T = DROP_TIME;
    this.animator.add({
      delay,
      duration: T,
      start: () => {
        this.restPose(r);
        if (!this.animator.finishing) safe(opts.onStart, { playerId: r.id, tokenId: r.tokenId, kind: 'drop', index: to });
      },
      update: (p) => {
        const fall = 1 - p * p;
        r.root.position.set(dest.x, dest.y + 6 * fall, dest.z);
        r.root.rotation.set(0, dest.heading, 0);
        const sq = p > 0.85 ? Math.sin(Math.PI * ((p - 0.85) / 0.15)) * 0.12 : 0;
        r.c.model.scale.set(r.scale * (1 + sq * 0.5), r.scale * (1 - sq), r.scale * (1 + sq * 0.5));
        r.spot = { index: to, jailed: false };
        this.refreshHalos();
        this.markShadows();
      },
      end: () => {
        const skipped = this.animator.finishing;
        r.c.model.scale.setScalar(r.scale);
        this.put(r, dest);
        r.acts = Math.max(0, r.acts - 1);
        if (r.acts === 0) r.plan = null;
        this.restPose(r);
        this.layout(!skipped);
        if (!skipped) this.dust(r.root.position, 1.2);
        safe(opts.onLand, { playerId: r.id, tokenId: r.tokenId, kind: 'drop', index: to, last: true, sound: null, skipped });
        this.markShadows();
      },
    });
    return {
      kind: 'drop', duration: T, landAt: delay + T, plan: null, path: null, launchEnd: delay, cruiseStart: delay, cruiseEnd: delay + T,
      goAt: null, tileTimes: [{ index: to, at: delay + T }],
    };
  }

  // ---- the tow scene ---------------------------------------------------------------------------------

  /**
   * moved{via:'jail'}: the tow scene (§10). Own 2.4 s; opts.short or opts.plan.own === false → 1.6 s.
   * Returns cutAt (the camera cut to the jail), gateAt (gate opens), slamAt (gate slams).
   */
  scheduleTow(r, e, delay, opts) {
    const short = !!opts.short || opts.plan?.own === false;
    const D = short ? TOW_SHORT : TOW_TIME;
    const k = D / TOW_TIME; // all beats scale with the scene
    const start = this.startOf(r);
    const startSpot = { ...this.effSpot(r) };
    r.plan = { spot: { index: 10, jailed: true }, slot: null };
    const dest = this.slotOf(r);
    r.plan.slot = dest;
    const truck = this.actors.get('tow');
    const TI = ACTOR_INFO.tow;
    const walker = r.kind === 'walker';
    const len = r.info.length;
    // Where the truck stops at the pick-up: ahead of the character in the token lane.
    const sStop = start.s + len / 2 + 5.6;
    // Where it parks at the jail: rear at the yard gate, facing the elbow (north-east).
    const G = JAIL_YARD.gate;
    const gdx = Math.SQRT1_2, gdz = -Math.SQRT1_2;
    const gate = { x: G.x + gdx * (1.2 + TI.length / 2), z: G.z + gdz * (1.2 + TI.length / 2), heading: Math.atan2(gdx, gdz) };
    const tt = (x) => x * k; // own-scene seconds → this scene
    let prevT = 0, prevS = 0, phaseNow = '', lastX = 0, lastZ = 0;
    r.acts++;
    const bedPoint = (zLocal, out) => {
      truck.root.updateMatrixWorld(true);
      return out.set(0, TI.bedTop, zLocal).applyMatrix4(truck.bones.bed.matrixWorld);
    };
    const putOnBed = (zLocal, tiltK) => {
      bedPoint(zLocal, V1);
      r.root.position.copy(V1);
      r.root.rotation.set(-0.4 * tiltK, truck.root.rotation.y, 0);
    };
    const drive = (x, z, h, dt, dir = 1) => {
      const ds = Math.hypot(x - lastX, z - lastZ);
      lastX = x; lastZ = z;
      r.root.position.x = x;
      r.root.position.z = z;
      r.root.rotation.y = h;
      this.locomote(r, walker ? ds : dir * ds, dt, 0, true);
    };
    this.animator.add({
      delay,
      duration: D,
      start: () => {
        this.restPose(r);
        r.reaction = null;
        this.actors.show(truck);
        this.actors.rest(truck);
        pointAt(sStop - 60, 0, P);
        this.actors.place(truck, P.x, 0, P.z, P.heading);
        prevS = sStop - 60;
        prevT = 0;
        lastX = r.root.position.x;
        lastZ = r.root.position.z;
        if (!this.animator.finishing) safe(opts.onStart, { playerId: r.id, tokenId: r.tokenId, kind: 'tow', index: startSpot.index });
      },
      update: (p) => {
        const t = p * D;
        const dt = t - prevT;
        prevT = t;
        const fin = this.animator.finishing;
        this.actors.beacon(truck, true, t);
        if (t < tt(0.95)) {
          // 1. Pick-up where the character is.
          if (phaseNow !== 'pick') { phaseNow = 'pick'; }
          const u = clamp((t - tt(0.1)) / tt(0.45), 0, 1);
          const s = sStop - 60 * (1 - u) ** 2;
          pointAt(s, 0, P);
          this.actors.place(truck, P.x, 0, P.z, P.heading);
          this.actors.roll(truck, s - prevS, dt, 0);
          prevS = s;
          if (!fin) this.clock?.setTarget?.(t < tt(0.45) && t > tt(0.1) ? 5 * (this.animator.rate || 1) : 1);
          const tilt = sstep(tt(0.42), tt(0.55), t) * (1 - sstep(tt(0.85), tt(0.95), t));
          this.actors.tilt(truck, tilt);
          if (t >= tt(0.55)) {
            // Winch (vehicles) / walk and hop on (walkers): to the bed lip, then up to the bed centre.
            const lipZ = -TI.bedHalf + 0.2;
            const midZ = -0.3;
            const u1 = clamp((t - tt(0.55)) / tt(0.13), 0, 1);
            const u2 = clamp((t - tt(0.68)) / tt(0.17), 0, 1);
            if (u2 <= 0) {
              bedPoint(lipZ - len / 2 - 0.2, V2);
              const e1 = ease.inOutSine(u1);
              const x = start.x + (V2.x - start.x) * e1;
              const z = start.z + (V2.z - start.z) * e1;
              const y = (start.y ?? 0) * (1 - e1);
              drive(x, z, start.heading + angleDelta(start.heading, truck.root.rotation.y) * e1, dt);
              r.root.position.y = y;
            } else if (walker) {
              // A hop onto the bed.
              bedPoint(midZ, V2);
              bedPoint(lipZ - len / 2 - 0.2, V1);
              const e2 = ease.inOutSine(u2);
              r.root.position.set(V1.x + (V2.x - V1.x) * e2, V1.y + (V2.y - V1.y) * e2 + Math.sin(Math.PI * u2) * 1.0, V1.z + (V2.z - V1.z) * e2);
              r.root.rotation.set(0, truck.root.rotation.y, 0);
              this.locomote(r, 0, dt, 0, false);
            } else {
              const zl = lipZ - len / 2 + (midZ - lipZ + len / 2) * ease.inOutSine(u2);
              const before = V2.copy(r.root.position);
              putOnBed(zl, tilt);
              this.locomote(r, Math.hypot(r.root.position.x - before.x, r.root.position.z - before.z), dt, 0, false);
            }
            if (u2 >= 1) putOnBed(midZ, tilt);
          }
        } else if (t < tt(1.6)) {
          // 2. After the cut: at the yard gate.
          if (phaseNow !== 'gate') {
            phaseNow = 'gate';
            this.actors.place(truck, gate.x, 0.15, gate.z, gate.heading);
            r.spot = { index: 10, jailed: true };
            if (!fin) this.clock?.setTarget?.(1, { snap: true });
          }
          const tilt = sstep(tt(1.0), tt(1.15), t);
          this.actors.tilt(truck, tilt);
          const lipZ = -TI.bedHalf + 0.2;
          if (t < tt(1.15)) putOnBed(-0.3, tilt);
          else if (t < tt(1.32)) {
            const u = (t - tt(1.15)) / tt(0.17);
            if (walker) {
              bedPoint(-0.3, V1);
              bedPoint(lipZ - len / 2 - 0.4, V2);
              const e2 = ease.inOutSine(u);
              r.root.position.set(V1.x + (V2.x - V1.x) * e2, V1.y + (V2.y - 0.15 - V1.y) * e2 + 0.15 * e2 + Math.sin(Math.PI * u) * 0.8, V1.z + (V2.z - V1.z) * e2);
              r.root.rotation.set(0, truck.root.rotation.y, 0);
            } else {
              const before = V2.copy(r.root.position);
              putOnBed(-0.3 + (lipZ - len / 2 - 0.4 + 0.3) * ease.inOutSine(u), tilt);
              this.locomote(r, -Math.hypot(r.root.position.x - before.x, r.root.position.z - before.z), dt, 0, false);
            }
            lastX = r.root.position.x;
            lastZ = r.root.position.z;
            S1.copy(r.root.position);
          } else {
            // Into the yard slot (vehicles reverse; walkers walk), heading eases to the slot's.
            const u = clamp((t - tt(1.32)) / tt(0.23), 0, 1);
            const e2 = ease.inOutSine(u);
            const x = S1.x + (dest.x - S1.x) * e2;
            const z = S1.z + (dest.z - S1.z) * e2;
            const h0 = walker ? Math.atan2(dest.x - S1.x, dest.z - S1.z) : truck.root.rotation.y;
            const h = walker ? h0 + angleDelta(h0, dest.heading) * sstep(0.7, 1, u) : h0 + angleDelta(h0, dest.heading) * e2;
            drive(x, z, h, dt, -1);
            r.root.position.y = 0.15;
            r.root.rotation.x = 0;
          }
        } else {
          // 3. The gate has slammed; the truck levels its bed and leaves toward the elbow.
          if (phaseNow !== 'leave') {
            phaseNow = 'leave';
            this.put(r, dest);
            this.endLoco(r);
            this.restPose(r);
          }
          const u = (t - tt(1.6)) / (D - tt(1.6));
          this.actors.tilt(truck, 1 - sstep(0, 0.25, u));
          const dist = 30 * sstep(0.2, 1, u) ** 2;
          const x = gate.x + gdx * dist;
          const z = gate.z + gdz * dist;
          this.actors.roll(truck, Math.hypot(x - truck.root.position.x, z - truck.root.position.z), dt, 0);
          this.actors.place(truck, x, 0.15 * (1 - sstep(0.3, 0.6, u)), z, gate.heading);
        }
        this.refreshHalos();
        this.markShadows();
      },
      end: () => {
        const skipped = this.animator.finishing;
        this.actors.hide(truck);
        this.put(r, dest);
        r.spot = { index: 10, jailed: true };
        r.acts = Math.max(0, r.acts - 1);
        if (r.acts === 0) r.plan = null;
        this.endLoco(r);
        this.restPose(r);
        this.clock?.setTarget?.(1, { snap: true });
        this.layout(!skipped);
        safe(opts.onLand, { playerId: r.id, tokenId: r.tokenId, kind: 'tow', index: 10, last: true, sound: null, skipped });
        this.refreshHalos();
        this.markShadows();
      },
    });
    return {
      kind: 'tow', duration: D, landAt: delay + D, plan: null, path: null,
      launchEnd: delay + tt(0.1), cruiseStart: delay + tt(0.1), cruiseEnd: delay + tt(0.55),
      goAt: null, tileTimes: [{ index: 10, at: delay + tt(1.55) }],
      cutAt: delay + tt(0.95), gateAt: delay + tt(1.0), slamAt: delay + tt(1.6),
    };
  }

  /** Jail yard → the visitors' kerb slot at tile 10 (left_jail), 0.6 s. Returns seconds. */
  release(id, delay = 0) {
    try {
      const r = this.map.get(id);
      if (!r || !r.visible) return 0;
      const d = Math.max(0, Number(delay) || 0);
      const start = r.plan?.slot && r.acts > 0 ? r.plan.slot : { x: r.root.position.x, z: r.root.position.z, y: r.root.position.y, heading: r.root.rotation.y };
      r.plan = { spot: { index: 10, jailed: false }, slot: null };
      const dest = this.slotOf(r);
      r.plan.slot = dest;
      const G = JAIL_YARD.gate;
      // Path: slot → just inside the gate → just outside it → the kerb slot (Catmull-Rom through the points).
      const pts = [[start.x, start.z], [G.x - 0.8, G.z + 1.6], [G.x + 2.2, G.z - 2.2], [dest.x, dest.z]];
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
      const samples = curve.getSpacedPoints(40);
      const T = RELEASE_TIME;
      let prevT = 0, prevI = 0;
      r.acts++;
      this.animator.add({
        delay: d,
        duration: T,
        start: () => { this.restPose(r); r.spot = { index: 10, jailed: false }; },
        update: (p) => {
          const t = p * T;
          const dt = t - prevT;
          prevT = t;
          const f = ease.inOutSine(p) * 40;
          const i = Math.min(39, Math.floor(f));
          const a = samples[i], b = samples[i + 1];
          const u = f - i;
          const x = a.x + (b.x - a.x) * u;
          const z = a.z + (b.z - a.z) * u;
          const h = Math.atan2(b.x - a.x, b.z - a.z);
          const ds = Math.hypot(x - r.root.position.x, z - r.root.position.z);
          r.root.position.set(x, 0.15 * (1 - sstep(0.65, 0.9, p)) + dest.y * sstep(0.65, 0.9, p), z);
          r.root.rotation.y = p > 0.85 ? h + angleDelta(h, dest.heading) * sstep(0.85, 1, p) : h;
          this.locomote(r, ds, dt, 0, true);
          prevI = i;
          this.refreshHalos();
          this.markShadows();
        },
        end: () => {
          this.put(r, dest);
          r.spot = { index: 10, jailed: false };
          r.acts = Math.max(0, r.acts - 1);
          if (r.acts === 0) r.plan = null;
          this.endLoco(r);
          this.restPose(r);
          this.layout(!this.animator.finishing);
          this.refreshHalos();
          this.markShadows();
        },
      });
      void prevI;
      return T;
    } catch (err) {
      report('release', err);
      return 0;
    }
  }

  /** Bankruptcy farewell: drives / walks to the next corner and out along the arterial into the haze; hides. */
  exitTown(id, delay = 0) {
    try {
      const r = this.map.get(id);
      if (!r || !r.visible || r.exited) return 0;
      const d = Math.max(0, Number(delay) || 0);
      const start = this.startOf(r);
      const q = Math.floor(mod(start.s, LOOP) / QUARTER) + 1;
      const sApex = q * QUARTER;
      const s0u = start.s;
      const s1u = sApex + (sApex - start.s < 20 ? QUARTER : 0);
      const corner = mod(Math.round(s1u / QUARTER), 4);
      const [sx, sz] = SIGN[corner];
      const laneLen = s1u - s0u;
      const outLen = 520;
      const total = laneLen + outLen;
      const T = EXIT_TIME;
      let prevT = 0, prevD = 0, hPrev = 0;
      r.acts++;
      this.animator.add({
        delay: d,
        duration: T,
        start: () => {
          this.restPose(r);
          r.reaction = null;
          if (!this.animator.finishing && r.kind === 'vehicle') this.startEngine(r);
          pointAt(s0u, start.lat, P);
          hPrev = P.heading;
        },
        update: (p) => {
          const t = p * T;
          const dt = t - prevT;
          prevT = t;
          const dist = total * (p < 0.2 ? 0.5 * (p / 0.2) ** 2 * 0.08 : 0.04 + 0.96 * ((p - 0.2) / 0.8) ** 1.3);
          let kappa = 0;
          if (dist < laneLen) {
            const lat = start.lat * (1 - sm(dist / 15));
            pointAt(s0u + dist, lat, P);
            kappa = Math.abs(dist - prevD) > 1e-4 ? angleDelta(hPrev, P.heading) / (dist - prevD) : 0;
            hPrev = P.heading;
            r.root.position.set(P.x, r.kind === 'walker' ? groundAt(lat) : 0, P.z);
            r.root.rotation.y = P.heading;
          } else {
            const o = dist - laneLen;
            const ax = sx * (M.ARC_C + M.ARC_R * Math.SQRT1_2);
            const az = sz * (M.ARC_C + M.ARC_R * Math.SQRT1_2);
            r.root.position.set(ax + sx * Math.SQRT1_2 * o, 0, az + sz * Math.SQRT1_2 * o);
            const h = Math.atan2(sx, sz);
            r.root.rotation.y = hPrev + angleDelta(hPrev, h) * sm(o / 12);
          }
          this.locomote(r, dist - prevD, dt, kappa, true);
          prevD = dist;
          const fade = 1 - sstep(0.82, 1, p);
          r.c.model.scale.setScalar(r.scale * Math.max(0.001, fade));
          if (!this.animator.finishing) this.clock?.setTarget?.(clamp(((dist - prevD) / Math.max(1e-3, dt)) / 14, 1, 30) * (this.animator.rate || 1));
          this.refreshHalos();
          this.markShadows();
        },
        end: () => {
          r.acts = Math.max(0, r.acts - 1);
          this.endLoco(r);
          this.restPose(r);
          this.stopEngine(r);
          r.exited = true;
          r.root.visible = false;
          r.plan = null;
          this.clock?.setTarget?.(1, { snap: true });
          this.refreshHalos();
          this.markShadows();
        },
      });
      return T;
    } catch (err) {
      report('exitTown', err);
      return 0;
    }
  }

  /** The winner's lap: a full lap through the GO Gate back into its slot (time-lapse), `duration` s. */
  victoryLap(id, delay = 0, { duration = 3 } = {}) {
    try {
      const r = this.map.get(id);
      if (!r || !r.visible || r.exited) return 0;
      const d = Math.max(0, Number(delay) || 0);
      const T = Math.max(1, Number(duration) || 3);
      const start = this.startOf(r);
      const slot = this.slotOf(r) ?? start;
      const plan = travelPlan({ length: LOOP, tokenId: r.tokenId, own: true });
      const timeK = plan.T / T;
      const goT = mod(LOOP - start.s, LOOP) / LOOP; // approximate: by distance fraction
      this.scheduleTravel(r, {
        kind: 'lap', delay: d, T, plan, timeK, s0u: start.s, s1u: start.s + LOOP, lat0: start.lat, lat1: slot.lat, dir: 1, bumpStart: 0, bumpEnd: 0,
        tiles: [], goT: plan.timeAt(goT * LOOP) / timeK, dest: slot, destSpot: { ...this.effSpot(r) }, origin: this.effSpot(r), opts: {}, y0: start.y ?? 0,
      });
      return T;
    } catch (err) {
      report('victoryLap', err);
      return 0;
    }
  }

  /** Card act-out pass-bys: 'patrol' | 'ambulance' zip past in the outer traffic lane, the 'bus' in the inner one. */
  cameo(kind, { tile = 0, delay = 0 } = {}) {
    try {
      const a = this.actors.get(kind);
      if (!a || kind === 'tow') return 0;
      const d = Math.max(0, Number(delay) || 0);
      const s = sOf(wrap(tile));
      const lat = kind === 'bus' ? M.TRAFFIC_C[0] - M.LANE : M.TRAFFIC_C[1] - M.LANE;
      const span = kind === 'bus' ? 70 : 120;
      const T = CAMEO_TIME;
      let prevS = s - span / 2, prevT = 0, hPrev = 0;
      this.animator.add({
        delay: d,
        duration: T,
        start: () => {
          this.actors.show(a);
          this.actors.rest(a);
          pointAt(prevS, lat, P);
          hPrev = P.heading;
        },
        update: (p) => {
          const t = p * T;
          const dt = t - prevT;
          prevT = t;
          const u = kind === 'bus' ? p : p * 0.85 + 0.15 * sm(p);
          const sNow = s - span / 2 + span * u;
          pointAt(sNow, lat, P);
          const ds = sNow - prevS;
          const kappa = ds > 1e-4 ? angleDelta(hPrev, P.heading) / ds : 0;
          hPrev = P.heading;
          this.actors.place(a, P.x, 0, P.z, P.heading);
          this.actors.roll(a, ds, dt, kappa);
          this.actors.beacon(a, kind !== 'bus', t);
          prevS = sNow;
          this.markShadows();
        },
        end: () => {
          this.actors.hide(a);
          this.markShadows();
        },
      });
      return T;
    } catch (err) {
      report('cameo', err);
      return 0;
    }
  }

  // ---- locomotion -------------------------------------------------------------------------------------

  /**
   * Advances a character's locomotion by ds metres (signed: negative = rolling backwards) over dt
   * animation seconds on a path of curvature kappa. lapse: cap the visual cadence (time-lapse moves).
   */
  locomote(r, ds, dt, kappa = 0, lapse = true) {
    const L = r.loco;
    const v = dt > 1e-6 ? Math.abs(ds) / dt : 0;
    const vReal = r.info.vReal;
    const vVis = Math.min(v, vReal * CADENCE_CAP);
    const acc = dt > 1e-6 ? clamp((vVis - L.vPrev) / dt, -40, 40) : 0;
    L.vPrev = vVis;
    if (dt > 0) L.kappa += (clamp(kappa, -0.3, 0.3) - L.kappa) * (1 - Math.exp(-dt * 14));
    if (r.kind === 'vehicle') this.rollVehicle(r, ds, dt, vVis, ds < 0 ? -acc : acc, lapse);
    else this.walk(r, ds, dt, vVis, lapse);
  }

  rollVehicle(r, ds, dt, vVis, acc, lapse) {
    const L = r.loco;
    const B = r.bones;
    const vReal = r.info.vReal;
    for (const wh of L.wheels) {
      stepWheel(wh.w, ds, dt, { vReal, lapse });
      wh.bone.rotation.x = wh.w.angle;
    }
    r.c.material.userData.uBlur.value = L.wheels[0]?.w.blur ? 1 : 0;
    L.steer = steerAngle(L.wheelbase, L.kappa);
    for (const b of L.steerBones) b.rotation.y = L.steer;
    const tok = r.tokenId;
    let pitchT = pitchFor(acc);
    let rollT = rollFor(vVis, L.kappa);
    if (tok === 'thimble') rollT = clamp(rollT * 2.4, -0.12, 0.12);
    if (tok === 'ship') pitchT = pitchFor(acc, 0.02, 0.12);
    const pitch = stepSpring(L.pitch, pitchT, dt);
    const roll = stepSpring(L.roll, rollT, dt);
    if (tok === 'hat') {
      B.frame.rotation.z = stepSpring(L.lean, leanFor(vVis, L.kappa), dt);
      this.poseRider(r, L.wheels[0].w.angle, L.steer, clamp(pitch * 2, -0.1, 0.1));
      return;
    }
    if (!B.body) return;
    B.body.rotation.x = pitch;
    B.body.rotation.z = roll + (tok === 'ship' ? 0.035 * Math.sin(this.animator.time * TAU * 0.6) * clamp(vVis / 2, 0, 1) : 0);
    B.body.position.y = r.rest.body.y + (tok === 'boot' ? 0.01 * Math.sin(L.wheels[0].w.angle * 2) : 0);
  }

  /** The magician's legs on the pedals (2-bone IK; cranks turn with the big wheel), hands on the bars. */
  poseRider(r, crank, steer = 0, lean = 0) {
    const B = r.bones;
    const hipY = 1.56, hipZ = -0.02;
    for (const s of [1, -1]) {
      const y0 = -0.13 * s;
      const py = 0.75 + y0 * Math.cos(crank) + 0.06;
      const pz = 0.3 + y0 * Math.sin(crank) - 0.04;
      ik2(pz - hipZ, py - hipY, 0.5, 0.5, 1, IK);
      const L = s > 0 ? 'L' : 'R';
      B[`th${L}`].rotation.x = -IK.a;
      B[`sh${L}`].rotation.x = -IK.b;
    }
    const torso = 0.12 + lean + 0.02 * Math.sin(crank * 2);
    B.torso.rotation.x = torso;
    B.head.rotation.x = -torso * 0.8;
    // Grips on the handlebar (it turns with the steer bone about the head tube at (0, 1.55, 0.2)).
    const cs = Math.cos(steer), sn = Math.sin(steer);
    for (const s of [1, -1]) {
      const gx0 = 0.3 * s, gz0 = 0.07;
      const gx = gx0 * cs + gz0 * sn;
      const gz = 0.2 - gx0 * sn + gz0 * cs;
      const gy = 1.66;
      // Shoulder after the torso lean about the torso pivot (0, 1.61, -0.02).
      const sy = 1.61 + 0.41 * Math.cos(torso) - 0.04 * Math.sin(torso);
      const sz = -0.02 + 0.41 * Math.sin(torso) + 0.04 * Math.cos(torso);
      const sx = 0.19 * s;
      const dx = gx - sx, dy = gy - sy, dz = gz - sz;
      ik2(dz, -Math.hypot(dy, dx), 0.3, 0.3, -1, IK);
      const L = s > 0 ? 'L' : 'R';
      B[`ua${L}`].rotation.set(-IK.a - torso, 0, Math.atan2(dx, -dy) * 0.9);
      B[`fa${L}`].rotation.set(-IK.b, 0, 0);
    }
  }

  walk(r, ds, dt, vVis, lapse) {
    const L = r.loco;
    const g = L.gait;
    if (!g) return;
    const plants = stepGait(g, ds, dt, { vReal: r.info.vReal, lapse });
    this.poseWalker(r, dt, vVis);
    if (plants && !this.animator.finishing && this.audio?.footstep) {
      const t = this.animator.time;
      const quad = g.legs === 4;
      if ((quad ? plants & 3 : plants) && t - r.lastStep >= 0.085) {
        r.lastStep = t;
        const p = r.root.position;
        r.stepPos.copy(p);
        try { this.audio.footstep(r.stepPos, surfaceAt(p.x, p.z), r.tokenId); } catch (err) { report('footstep', err); }
      }
    }
  }

  /** Legs from the gait (IK), body bob / rock / flex, tail and ear springs, arms. */
  poseWalker(r, dt, vVis) {
    const L = r.loco;
    const g = L.gait;
    const B = r.bones;
    const rig = r.rig;
    const sc = r.scale;
    const bob = g.bob / sc;
    const run = clamp(vVis / Math.max(0.5, r.info.vReal), 0, 1);
    if (rig.gait === 'biped') {
      B.pelvis.position.y = r.rest.pelvis.y + bob;
      const barrow = r.tokenId === 'wheelbarrow';
      const lean = g.lean + (barrow ? 0.08 * L.ikW : 0);
      B.torso.rotation.x = lean;
      B.head.rotation.x = -lean * 0.6;
      for (let i = 0; i < 2; i++) {
        const [up, lo, hip, l1, l2, bend, footY] = rig.legs[i];
        const fwd = g.feet[i * 2] / sc;
        const lift = g.feet[i * 2 + 1] / sc;
        ik2(fwd, footY + lift - (hip[1] + bob), l1, l2, bend, IK);
        B[up].rotation.x = -IK.a;
        B[lo].rotation.x = -IK.b;
      }
      if (barrow) this.poseBarrow(r, dt, vVis, lean);
      else {
        for (let i = 0; i < 2; i++) {
          const [up, lo] = rig.arms[i];
          const opp = g.feet[(1 - i) * 2] / sc;
          B[up].rotation.set(-1.1 * opp, 0, (i ? -1 : 1) * 0.06);
          B[lo].rotation.set(-(0.2 + 1.0 * clamp(g.lean / 0.12, 0, 1)), 0, 0);
        }
      }
      return;
    }
    // Quadrupeds.
    B.body.position.y = r.rest.body.y + bob;
    B.body.rotation.x = g.rock;
    B.chest.rotation.x = -g.flex;
    for (let i = 0; i < 4; i++) {
      const [up, lo, hip, l1, l2, bend, footY] = rig.legs[i];
      const parentPitch = i < 2 ? g.rock - g.flex : g.rock;
      const fwd = g.feet[i * 2] / sc;
      const lift = g.feet[i * 2 + 1] / sc;
      ik2(fwd, footY + lift - (hip[1] + bob), l1, l2, bend, IK);
      B[up].rotation.x = -IK.a - parentPitch;
      B[lo].rotation.x = -IK.b;
    }
    B.head.rotation.x = -(g.rock - g.flex) * 0.8 + 0.1 * run;
    const tail = stepSpring(L.tail, -0.55 * run, dt);
    if (B.tail1) B.tail1.rotation.x = tail;
    if (B.tail2) B.tail2.rotation.x = tail * 0.6 + 0.15 * Math.sin(g.phase * TAU * 2) * run;
    if (B.tail3) B.tail3.rotation.x = tail * 0.4;
    if (B.tail4) B.tail4.rotation.x = tail * 0.3;
    const ears = stepSpring(L.ears, -0.45 * run, dt);
    if (B.earL) B.earL.rotation.x = ears;
    if (B.earR) B.earR.rotation.x = ears;
  }

  /** The gardener lifts the barrow onto its wheel and holds the grips (arm IK); the tub bounces on joints. */
  poseBarrow(r, dt, vVis, lean) {
    const L = r.loco;
    const B = r.bones;
    const moving = vVis > 0.15 || r.acts > 0;
    L.ikW += ((moving ? 1 : 0) - L.ikW) * (1 - Math.exp(-Math.max(0, dt) * 10));
    const lift = stepSpring(L.lift, moving ? 0.22 : 0, dt);
    const w = L.wheels[0];
    if (w) {
      B.bwheel.rotation.x = w.w.angle;
    }
    const bounce = stepSpring(L.tub, 0, dt);
    B.barrow.rotation.x = lift + bounce;
    B.flowers.position.y = r.rest.flowers.y + Math.max(0, -bounce) * 0.4;
    // Grips follow the barrow's tilt about its axle (0, 0.2, 1.0).
    const th = lift + bounce;
    const ct = Math.cos(th), st = Math.sin(th);
    for (let i = 0; i < 2; i++) {
      const [up, lo, sh, l1, l2] = r.rig.arms[i];
      const [gx, gy0, gz0] = r.rig.grips[i];
      const ry = gy0 - 0.2, rz = gz0 - 1.0;
      const gy = 0.2 + ry * ct - rz * st;
      const gz = 1.0 + ry * st + rz * ct;
      // Shoulder after the torso lean (torso pivot at (0, 0.97, -0.98)).
      const sy = 0.97 + (sh[1] - 0.97) * Math.cos(lean) - (sh[2] + 0.98) * Math.sin(lean);
      const sz = -0.98 + (sh[1] - 0.97) * Math.sin(lean) + (sh[2] + 0.98) * Math.cos(lean);
      const dx = gx - sh[0], dy = gy - sy, dz = gz - sz;
      ik2(dz, -Math.hypot(dy, dx), l1, l2, -1, IK);
      const k = L.ikW;
      B[up].rotation.set((-IK.a - lean) * k, 0, Math.atan2(dx, -dy) * 0.9 * k);
      B[lo].rotation.set(-IK.b * k - 0.12 * (1 - k), 0, 0);
    }
  }

  /** After a move: wheels / gait back to rest (angles kept), springs settled. */
  endLoco(r) {
    const L = r.loco;
    for (const wh of L.wheels) stopWheel(wh.w);
    if (L.gait) resetGait(L.gait);
    restSpring(L.pitch); restSpring(L.roll); restSpring(L.heave); restSpring(L.lean); restSpring(L.tail); restSpring(L.ears); restSpring(L.tub); restSpring(L.lift);
    L.vPrev = 0;
    L.kappa = 0;
    L.ikW = 0;
    L.steer = 0;
    r.c.material.userData.uBlur.value = 0;
  }

  /** Every bone back at rest (the rider's feet on the pedals); model unscaled and level. */
  restPose(r) {
    for (const [bone, rest] of r.restList) {
      bone.position.copy(rest);
      bone.rotation.set(0, 0, 0);
      bone.scale.set(1, 1, 1);
    }
    r.c.model.position.set(0, 0, 0);
    r.c.model.rotation.set(0, 0, 0);
    r.c.model.scale.setScalar(r.scale);
    r.root.rotation.x = 0;
    r.root.rotation.z = 0;
    if (r.bones.dove) r.bones.dove.scale.setScalar(0.001);
    if (r.tokenId === 'hat') {
      for (const wh of r.loco.wheels) wh.bone.rotation.x = wh.w.angle;
      this.poseRider(r, r.loco.wheels[0].w.angle, 0, 0);
    } else for (const wh of r.loco.wheels) wh.bone.rotation.x = wh.w.angle;
  }

  // ---- reactions --------------------------------------------------------------------------------------

  /**
   * A short emotive performance `delay` s from now (REACTIONS + 'wake'). victory repeats (opts.loops,
   * default 16) until the state moves on; returns ONE bounce's length. Returns 0 when not on the board.
   */
  react(id, kind, opts = {}) {
    try {
      const r = this.map.get(id);
      if (!r || !r.visible || r.exited || !Object.hasOwn(REACTIONS, kind)) return 0;
      const speed = opts.speed > 0 ? opts.speed : 1;
      const dur = REACTIONS[kind] / speed;
      const delay = Math.max(0, Number(opts.delay) || 0);
      if (kind === 'victory') {
        const token = {};
        r.reaction = token;
        this.victoryBounce(r, token, 0, Math.max(1, opts.loops ?? 16), dur, delay, opts);
        return dur;
      }
      r.acts++;
      let peaked = false;
      const sig = SIGNATURES[r.tokenId] ?? {};
      const snd = kind === 'celebrate' || kind === 'goJump' ? sig.happy : kind === 'wake' ? sig.wake : sig.sad;
      this.animator.add({
        delay,
        duration: dur,
        start: () => {
          this.restPose(r);
          if (!this.animator.finishing) {
            this.play(snd, r);
            if (kind === 'wake' && r.kind === 'vehicle') this.puff(r, 0.5);
            if (kind === 'sad' && (r.tokenId === 'car' || r.tokenId === 'thimble')) this.puff(r, 0.9);
          }
        },
        update: (p) => {
          this.restPose(r);
          perform(r, kind, p, dur);
          if (!peaked && p >= 0.5) {
            peaked = true;
            if (!this.animator.finishing) safe(opts.onPeak, { playerId: r.id, tokenId: r.tokenId, kind });
          }
          this.refreshHalos();
          this.markShadows();
        },
        end: () => {
          this.restPose(r);
          r.acts = Math.max(0, r.acts - 1);
          safe(opts.onDone, { playerId: id, kind, skipped: this.animator.finishing, sound: snd ? { name: snd[0], rate: snd[1], volume: snd[2] } : null });
          this.markShadows();
        },
      });
      return dur;
    } catch (err) {
      report('react', err);
      return 0;
    }
  }

  victoryBounce(r, token, k, loops, dur, delay, opts) {
    r.acts++;
    this.animator.add({
      delay,
      duration: dur,
      update: (p) => {
        this.restPose(r);
        perform(r, 'victory', p, dur, k);
        this.markShadows();
      },
      end: () => {
        this.restPose(r);
        r.acts = Math.max(0, r.acts - 1);
        const more = !this.animator.finishing && r.reaction === token && r.visible && k + 1 < loops;
        if (more) this.victoryBounce(r, token, k + 1, loops, dur, 0.04, opts);
        else {
          if (r.reaction === token) r.reaction = null;
          safe(opts.onDone, { playerId: r.id, kind: 'victory', skipped: this.animator.finishing });
        }
      },
    });
  }

  /** Stops a looping reaction (victory) after its current bounce. */
  stopReaction(id) {
    const r = this.map.get(id);
    if (r) r.reaction = null;
  }

  /** Legacy alias: the bankrupt slump. */
  sink(id, delay = 0, opts = {}) {
    return this.react(id, 'bankrupt', { ...opts, delay });
  }

  /** Halo flash (auction bids). */
  pulse(id, delay = 0) {
    try {
      const r = this.map.get(id);
      if (!r) return;
      this.animator.at(Math.max(0, Number(delay) || 0), () => { if (!this.animator.finishing) r.pulseAt = nowMs(); });
    } catch (err) { report('pulse', err); }
  }

  setCurrent(id) {
    this.currentId = id ?? null;
    this.refreshHalos();
  }

  // ---- halos, trails, idle life ----------------------------------------------------------------------

  refreshHalos() {
    const mesh = this.halos;
    let n = 0;
    for (const r of this.map.values()) {
      if (!r.visible || r.exited || !r.root.visible || n >= MAX_HALOS) continue;
      const p = r.root.position;
      const rad = 0.6 * r.info.length + 2;
      V1.set(p.x, p.y + 0.06, p.z);
      S1.set(rad, 1, rad);
      M1.compose(V1, Q1.identity(), S1);
      mesh.setMatrixAt(n, M1);
      mesh.setColorAt(n, COL.set(r.color));
      this.haloPulse.array[n] = r.haloPulse ?? 0;
      r.haloIndex = n;
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.haloPulse.needsUpdate = true;
  }

  claimTrail(r) {
    const slots = this.trails.slots;
    let k = slots.findIndex((s) => s.owner === r.id);
    if (k < 0) k = slots.findIndex((s) => !s.moving && nowMs() - s.end > TRAIL_LIFE * 1000);
    if (k < 0) {
      let best = -1, end = Infinity;
      slots.forEach((s, i) => { if (!s.moving && s.end < end) { end = s.end; best = i; } });
      k = best >= 0 ? best : 0;
    }
    const s = slots[k];
    s.owner = r.id;
    s.moving = true;
    r.trail = k;
    const u = this.trails.uniforms;
    u.uTrailColor.value[k].set(r.color);
    u.uTrail.value[k].set(0, 1, 0, 0);
    this.trails.mesh.visible = true;
  }

  trailHead(r, s, dir) {
    if (r.trail < 0) return;
    const v = this.trails.uniforms.uTrail.value[r.trail];
    v.set(mod(s, LOOP), dir < 0 ? -1 : 1, 1, 0);
  }

  endTrail(r) {
    if (r.trail < 0) return;
    const s = this.trails.slots[r.trail];
    s.moving = false;
    s.end = this.animator.finishing ? -1e9 : nowMs();
    if (this.animator.finishing) this.trails.uniforms.uTrail.value[r.trail].z = 0;
    r.trail = -1;
  }

  releaseTrail(r) {
    if (r.trail >= 0) {
      const s = this.trails.slots[r.trail];
      s.owner = null;
      s.moving = false;
      s.end = -1e9;
      this.trails.uniforms.uTrail.value[r.trail].z = 0;
      r.trail = -1;
    }
  }

  /** Per drawn frame (bus 'frame') and on idle ticks: trail fades, halo pulses. */
  frame(now = nowMs()) {
    try {
      if (now === this.lastFrame) return;
      this.lastFrame = now;
      let anyTrail = false;
      const u = this.trails.uniforms.uTrail.value;
      this.trails.slots.forEach((s, k) => {
        if (s.moving) { anyTrail = true; return; }
        const a = 1 - (now - s.end) / (TRAIL_LIFE * 1000);
        u[k].z = a > 0 ? a : 0;
        if (a > 0) anyTrail = true;
        else if (s.owner !== null && a <= 0) s.owner = null;
      });
      this.trails.mesh.visible = anyTrail;
      let dirty = false;
      for (const r of this.map.values()) {
        if (r.haloIndex === undefined || !r.visible) continue;
        let pulse = 0;
        if (r.id === this.currentId) pulse = 0.5 + 0.5 * Math.sin(now / 260);
        const f = (now - r.pulseAt) / 600;
        if (f >= 0 && f < 1) pulse = Math.max(pulse, Math.sin(Math.PI * f));
        if (Math.abs((r.haloPulse ?? 0) - pulse) > 1e-3) {
          r.haloPulse = pulse;
          if (r.haloIndex < this.halos.count) this.haloPulse.array[r.haloIndex] = pulse;
          dirty = true;
        }
      }
      if (dirty) this.haloPulse.needsUpdate = true;
      return anyTrail;
    } catch (err) {
      report('frame', err);
      return false;
    }
  }

  /**
   * Idle life (ambient ticks): engines shimmy, the dog sniffs and wags, the cat grooms, the gardener shifts
   * his weight, the magician balances, the duck boat bobs, the thimble car's door opens now and then.
   * Bones only (shadows are not re-rendered). Returns true while something is on the board.
   */
  ambient(now = nowMs()) {
    try {
      const trails = this.frame(now);
      let any = !!trails;
      const s = now / 1000;
      for (const r of this.map.values()) {
        if (!r.visible || r.exited || !r.root.visible) continue;
        any = true;
        if (r.acts || r.popping) continue;
        idle(r, s + r.phase, r.id === this.currentId ? 1.5 : 1, this);
      }
      return any || this.actors.ambient();
    } catch (err) {
      report('ambient', err);
      return false;
    }
  }

  // ---- sound / effects helpers --------------------------------------------------------------------------

  startEngine(r) {
    if (r.loco.engine || this.animator.finishing) return;
    try { r.loco.engine = this.audio?.engine?.(r.id, r.tokenId) ?? null; } catch (err) { report('engine', err); r.loco.engine = null; }
  }

  stopEngine(r) {
    const e = r.loco.engine;
    r.loco.engine = null;
    try { e?.stop?.(0.35); } catch (err) { report('engine', err); }
  }

  /** Plays [name, rate, volume] positionally through setSfx's sfx (or the audio scene's sfx), if any. */
  play(snd, r, volume = null) {
    if (!snd || this.animator.finishing) return;
    const sfx = this.sfx ?? this.audio?.sfx ?? null;
    if (!sfx?.play) return;
    const [name, rate, vol] = typeof snd === 'string' ? [snd, 1, volume ?? 0.5] : snd;
    try {
      const p = r?.root?.position;
      sfx.play(name, { rate, volume: volume ?? vol, pos: p ? { x: p.x, y: p.y + 1, z: p.z } : undefined, priority: 1 });
    } catch (err) { report('play', err); }
  }

  puff(r, size = 0.8) {
    const fx = this.fx ?? this.scene?.userData?.fx;
    if (!fx?.puff) return;
    try {
      const h = r.root.rotation.y;
      const back = r.info.length / 2;
      V1.set(r.root.position.x - Math.sin(h) * back, r.root.position.y + 0.4, r.root.position.z - Math.cos(h) * back);
      fx.puff(V1.clone(), 0, size);
    } catch (err) { report('puff', err); }
  }

  dust(pos, size = 1) {
    const fx = this.fx ?? this.scene?.userData?.fx;
    try { fx?.dust?.(pos.clone ? pos.clone() : pos, { size }); } catch (err) { report('dust', err); }
  }
}

// ---- performances (reactions) ---------------------------------------------------------------------------

/**
 * Applies reaction `kind` at progress p (0..1) on top of the rest pose. Uses the model group for whole-body
 * hops / spins (world metres) and bones for the character's own gestures.
 */
function perform(r, kind, p, dur, loop = 0) {
  const B = r.bones;
  const m = r.c.model;
  const tok = r.tokenId;
  const sc = r.scale;
  const arc = (a, b) => (p >= a && p <= b ? Math.sin((Math.PI * (p - a)) / (b - a)) : 0);
  const env = (a, b, c, d) => sstep(a, b, p) * (1 - sstep(c, d, p));
  const happy = kind === 'celebrate' || kind === 'victory' || kind === 'goJump';
  const sad = kind === 'sad' || kind === 'jail' || kind === 'bankrupt';
  const deep = kind === 'bankrupt' ? 1.4 : kind === 'jail' ? 1.15 : 1;
  switch (tok) {
    case 'car':
    case 'boot':
    case 'thimble':
    case 'ship': {
      const body = B.body;
      if (kind === 'wake') {
        // Engine start: a shudder, then settles.
        const sh = env(0, 0.08, 0.5, 0.9);
        body.rotation.z = 0.025 * sh * Math.sin(p * dur * 70);
        body.position.y = r.rest.body.y + 0.02 * sh * Math.abs(Math.sin(p * dur * 50));
        if (tok === 'thimble' && B.door) B.door.rotation.y = 1.1 * env(0.05, 0.3, 0.6, 0.95);
        if (tok === 'boot' && B.tongue) B.tongue.rotation.x = -0.25 * arc(0.1, 0.7);
        break;
      }
      if (happy) {
        if (tok === 'boot') {
          // Triple hydraulic hop (one per victory bounce / goJump).
          const hops = kind === 'celebrate' ? 3 : 1;
          const q = (p * hops) % 1;
          m.position.y = 0.55 * Math.sin(Math.PI * q) ** 1.5;
          body.rotation.x = -0.12 * Math.sin(TAU * q);
        } else if (tok === 'ship') {
          body.rotation.x = -0.14 * arc(0.05, 0.9);
          body.position.y = r.rest.body.y + 0.12 * arc(0.05, 0.9);
          body.rotation.z = 0.04 * Math.sin(p * TAU * 2);
          if (B.pennant) B.pennant.rotation.z = 0.08 * Math.sin(p * TAU * 4);
        } else if (tok === 'thimble' && kind !== 'goJump') {
          m.rotation.y = TAU * ease.inOutCubic(clamp(p / 0.85, 0, 1)) * (kind === 'victory' ? 0.25 : 1) + (kind === 'victory' ? loop * Math.PI / 2 : 0);
          m.position.y = 0.18 * arc(0, 0.85);
        } else {
          // Wheel-hop.
          m.position.y = (kind === 'goJump' ? 0.25 : 0.4) * arc(0.1, 0.7);
          body.rotation.x = -0.1 * arc(0.05, 0.4) + 0.06 * arc(0.65, 0.9);
        }
        if (B.head) B.head.rotation.y = 0.5 * Math.sin(p * TAU);
        break;
      }
      // Sad / jail / bankrupt.
      const slump = env(0, 0.25, 0.8, 1) * deep;
      if (tok === 'ship') {
        body.rotation.z = 0.14 * slump; // lists 8°
        body.position.y = r.rest.body.y - 0.08 * slump;
      } else if (tok === 'boot') {
        body.rotation.x = 0.06 * slump;
        body.rotation.y = 0.12 * Math.sin(p * TAU * 2.5) * env(0.1, 0.25, 0.6, 0.8); // toe scuff
        body.position.y = r.rest.body.y - 0.05 * slump;
      } else {
        body.rotation.z = 0.02 * Math.sin(p * dur * 60) * env(0, 0.05, 0.2, 0.3); // backfire shudder / stall cough
        body.position.y = r.rest.body.y - 0.05 * slump;
        body.rotation.x = 0.03 * slump;
        if (tok === 'thimble' && B.door) B.door.rotation.y = 0.5 * slump;
      }
      if (B.head) B.head.rotation.x = 0.45 * slump;
      break;
    }
    case 'hat': {
      if (kind === 'wake') {
        B.torso.rotation.x = 0.12 - 0.15 * arc(0, 0.6);
        B.head.rotation.y = 0.4 * arc(0.2, 0.9);
        break;
      }
      if (happy && kind !== 'goJump') {
        // Hat flip-and-catch; a dove pops out.
        const up = arc(0.1, 0.8);
        B.hat.position.y = r.rest.hat.y + 0.7 * up;
        B.hat.rotation.x = -TAU * ease.inOutSine(clamp((p - 0.1) / 0.7, 0, 1));
        const dv = env(0.25, 0.45, 0.85, 1);
        B.dove.scale.setScalar(Math.max(0.001, dv));
        B.dove.position.y = r.rest.dove.y + 0.5 * dv;
        B.dove.rotation.z = 0.4 * Math.sin(p * 40) * dv;
        B.uaR.rotation.set(-2.4 * env(0.05, 0.25, 0.75, 0.95), 0, -0.3);
        if (kind === 'victory') B.hat.rotation.y = loop * 0.6;
      } else if (kind === 'goJump') {
        m.position.y = 0.18 * arc(0.1, 0.6);
        B.head.rotation.x = -0.2 * arc(0.1, 0.6);
      } else {
        // The hat droops over the eyes.
        const s = env(0, 0.3, 0.8, 1) * deep;
        B.hat.position.y = r.rest.hat.y - 0.07 * s;
        B.hat.position.z = r.rest.hat.z + 0.03 * s;
        B.hat.rotation.x = 0.35 * s;
        B.head.rotation.x = 0.35 * s;
        B.torso.rotation.x = 0.12 + 0.2 * s;
      }
      break;
    }
    case 'dog':
    case 'cat': {
      const cat = tok === 'cat';
      if (kind === 'wake') {
        // Stand up and shake (dog) / a stretch (cat).
        if (cat) {
          B.body.rotation.x = -0.2 * arc(0, 0.7);
          B.chest.position.y = r.rest.chest.y - 0.04 * arc(0, 0.7);
        } else {
          B.body.rotation.z = 0.12 * Math.sin(p * dur * 38) * env(0.2, 0.3, 0.7, 0.95);
          B.head.rotation.z = 0.2 * Math.sin(p * dur * 38) * env(0.2, 0.3, 0.7, 0.95);
        }
        break;
      }
      if (happy) {
        if (kind === 'goJump') {
          m.position.y = 0.3 * arc(0.1, 0.7);
          B.body.rotation.x = -0.25 * arc(0.05, 0.5) + 0.2 * arc(0.5, 0.8);
        } else if (cat) {
          // Crouch-and-pounce with a spin.
          const crouch = arc(0, 0.3);
          B.body.position.y = r.rest.body.y - 0.05 * crouch;
          B.body.rotation.z = 0.08 * Math.sin(p * 60) * crouch;
          m.position.y = 0.5 * arc(0.3, 0.85);
          m.rotation.y = (kind === 'victory' ? loop * Math.PI / 2 : 0) + TAU * ease.inOutCubic(clamp((p - 0.3) / 0.55, 0, 1)) * (kind === 'victory' ? 0.25 : 1);
          if (B.tail1) B.tail1.rotation.x = 0.3;
        } else {
          // Zoomies: a fast spin in place with gallop-like bounces, then a bark (head up).
          m.rotation.y = (kind === 'victory' ? loop * Math.PI / 2 : 0) + TAU * ease.inOutSine(clamp(p / 0.8, 0, 1)) * (kind === 'victory' ? 0.25 : 1);
          m.position.y = 0.12 * Math.abs(Math.sin(p * Math.PI * 6));
          B.body.rotation.x = 0.15 * Math.sin(p * Math.PI * 6);
          B.head.rotation.x = -0.3 * arc(0.75, 1);
        }
        const wag = Math.sin(p * dur * 30);
        if (B.tail1) B.tail1.rotation.z = 0.5 * wag;
        if (B.tail2) B.tail2.rotation.z = 0.3 * wag;
        break;
      }
      // Lies down (dog, whimper) / ears flat (cat).
      const down = env(0, 0.3, 0.82, 1) * Math.min(1.2, deep);
      const drop = (cat ? 0.07 : 0.1) * down;
      B.body.position.y = r.rest.body.y - drop;
      for (let i = 0; i < 4; i++) {
        const [up, lo, hip, l1, l2, bend, footY] = r.rig.legs[i];
        const fwd = (i < 2 ? 0.07 : -0.06) * down;
        ik2(fwd, footY - (hip[1] - drop), l1, l2, bend, IK);
        B[up].rotation.x = -IK.a;
        B[lo].rotation.x = -IK.b;
      }
      B.head.rotation.x = 0.35 * down;
      B.head.position.y = r.rest.head.y - 0.02 * down;
      if (B.earL) B.earL.rotation.x = (cat ? -1.0 : -0.5) * down;
      if (B.earR) B.earR.rotation.x = (cat ? -1.0 : -0.5) * down;
      if (B.tail1) B.tail1.rotation.x = -0.8 * down;
      break;
    }
    case 'wheelbarrow': {
      if (kind === 'wake') {
        B.torso.rotation.x = 0.2 * arc(0, 1);
        B.head.rotation.y = 0.3 * Math.sin(p * TAU);
        break;
      }
      if (happy) {
        // Flowers fly up; arms up.
        const up = arc(0.05, 0.8);
        B.flowers.position.y = r.rest.flowers.y + 0.9 * up;
        B.flowers.rotation.y = 1.2 * up;
        B.flowers.scale.setScalar(1 + 0.25 * up);
        const arms = env(0, 0.2, 0.75, 1);
        B.uaL.rotation.set(-2.7 * arms, 0, 0.25 * arms);
        B.uaR.rotation.set(-2.7 * arms, 0, -0.25 * arms);
        m.position.y = (kind === 'goJump' ? 0.2 : 0.12) * arc(0.15, 0.6);
        break;
      }
      // The barrow tips over; head in hands.
      const tip = env(0, 0.3, 0.75, 1) * Math.min(1.2, deep);
      B.barrow.rotation.z = 1.25 * tip;
      B.barrow.position.y = r.rest.barrow.y + 0.2 * tip;
      B.torso.rotation.x = 0.35 * tip;
      B.head.rotation.x = 0.4 * tip;
      B.uaL.rotation.set(-1.9 * tip, 0, 0.4 * tip);
      B.uaR.rotation.set(-1.9 * tip, 0, -0.4 * tip);
      B.faL.rotation.set(-1.8 * tip, 0, 0);
      B.faR.rotation.set(-1.8 * tip, 0, 0);
      break;
    }
    default: {
      // The pedestrian.
      if (kind === 'wake') {
        const s = arc(0, 1);
        B.uaL.rotation.set(-2.8 * s, 0, 0.2 * s);
        B.uaR.rotation.set(-2.8 * s, 0, -0.2 * s);
        break;
      }
      if (happy) {
        m.position.y = (kind === 'goJump' ? 0.22 : 0.35) * arc(0.15, 0.7);
        const arms = env(0, 0.2, 0.75, 1);
        B.uaL.rotation.set(-2.8 * arms, 0, 0.3 * arms);
        B.uaR.rotation.set(-2.8 * arms, 0, -0.3 * arms);
        if (kind === 'victory') m.rotation.y = loop * Math.PI / 2 + Math.PI / 2 * ease.inOutSine(p);
        break;
      }
      const s = env(0, 0.3, 0.8, 1) * deep;
      B.torso.rotation.x = 0.3 * s;
      B.head.rotation.x = 0.4 * s;
      B.head.rotation.y = 0.35 * Math.sin(p * TAU * 3) * env(0.3, 0.4, 0.7, 0.8);
      B.pelvis.position.y = r.rest.pelvis.y - 0.05 * s;
    }
  }
  void sc;
}

/** Idle motion at time s (seconds, phase-shifted per character), amplitude a. Bones only. */
function idle(r, s, a, layer) {
  const B = r.bones;
  for (const [bone, rest] of r.restList) {
    bone.position.copy(rest);
    bone.rotation.set(0, 0, 0);
  }
  for (const wh of r.loco.wheels) wh.bone.rotation.x = wh.w.angle;
  if (B.dove) B.dove.scale.setScalar(0.001);
  const breathe = Math.sin(s * 2.4);
  switch (r.tokenId) {
    case 'car':
    case 'boot':
      B.body.position.y = r.rest.body.y + 0.004 * a * Math.abs(Math.sin(s * 23));
      B.body.rotation.z = 0.003 * a * Math.sin(s * 17);
      if (B.head) B.head.rotation.y = 0.5 * Math.sin(s * 0.4) ** 3;
      if (B.tongue) B.tongue.rotation.x = -0.03 * Math.sin(s * 1.3);
      break;
    case 'ship':
      B.body.position.y = r.rest.body.y + 0.02 * a * Math.sin(s * TAU * 0.25);
      B.body.rotation.z = 0.02 * a * Math.sin(s * TAU * 0.6 * 0.5);
      B.body.rotation.x = 0.01 * a * Math.sin(s * 1.1);
      if (B.pennant) B.pennant.rotation.z = 0.04 * Math.sin(s * 5);
      break;
    case 'thimble': {
      B.body.position.y = r.rest.body.y + 0.003 * a * Math.abs(Math.sin(s * 30));
      const cyc = s % 9;
      B.door.rotation.y = 1.0 * sstep(5.5, 6.3, cyc) * (1 - sstep(7.6, 8.4, cyc));
      if (B.head) B.head.rotation.y = 0.4 * sstep(6, 6.5, cyc) * (1 - sstep(7.3, 7.8, cyc));
      break;
    }
    case 'hat': {
      // Balancing on the big wheel: the pedals rock, the frame leans a little.
      const rock = 0.12 * Math.sin(s * 1.7) * a;
      for (const wh of r.loco.wheels) wh.bone.rotation.x = wh.w.angle + rock;
      B.frame.rotation.z = 0.025 * Math.sin(s * 1.3 + 0.5) * a;
      layer.poseRider(r, r.loco.wheels[0].w.angle + rock, 0.15 * Math.sin(s * 1.3), 0);
      B.head.rotation.y = 0.3 * Math.sin(s * 0.5);
      break;
    }
    case 'dog':
      if (B.tail1) B.tail1.rotation.z = 0.45 * a * Math.sin(s * 9);
      B.head.rotation.x = 0.35 * Math.max(0, Math.sin(s * 0.7)) ** 6; // sniffs the ground now and then
      B.chest.position.y = r.rest.chest.y + 0.003 * breathe;
      if (B.earL) B.earL.rotation.z = 0.15 * Math.max(0, Math.sin(s * 1.9)) ** 8;
      break;
    case 'cat': {
      const groom = Math.max(0, Math.sin(s * 0.45)) ** 6;
      B.head.rotation.y = 0.9 * groom;
      B.head.rotation.x = 0.4 * groom;
      if (B.tail2) B.tail2.rotation.z = 0.35 * Math.sin(s * 1.3);
      if (B.tail3) B.tail3.rotation.z = 0.45 * Math.sin(s * 1.3 - 0.6);
      if (B.tail4) B.tail4.rotation.z = 0.5 * Math.sin(s * 1.3 - 1.2);
      B.chest.position.y = r.rest.chest.y + 0.003 * breathe;
      break;
    }
    case 'wheelbarrow':
      B.pelvis.position.x = 0.03 * Math.sin(s * 0.6);
      B.torso.rotation.z = 0.04 * Math.sin(s * 0.6 + 0.4);
      B.head.rotation.y = 0.45 * Math.sin(s * 0.3);
      B.torso.rotation.x = 0.03 * breathe;
      B.flowers.rotation.y = 0.04 * Math.sin(s * 0.8);
      break;
    default:
      B.torso.rotation.x = 0.015 * breathe;
      B.head.rotation.y = 0.4 * Math.sin(s * 0.35);
      B.pelvis.position.x = 0.02 * Math.sin(s * 0.5);
  }
}

export { CHARACTER_INFO, infoOf };
