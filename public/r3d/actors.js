// public/r3d/actors.js — scripted vehicles for scenes (city design §7.5): the tow truck (flatbed with a
// tilting bed and a red/blue light bar at 4 Hz), a patrol car, an ambulance and a city bus.
//
// Same rig approach as the characters (one SkinnedMesh each, rigid skinning, characters.js material). Built
// lazily on first use, pooled (one of each), hidden when idle; they cast shadows only while shown. The
// motion layer (char-motion.js) moves them along the lane with place() / roll().

import * as THREE from './three.js';
import { CharKit, buildWheel, createCharacterMaterial, profileX, deform, RBOX, BOX, CYL, TOR, cylX, COLORS as C, CHROME, GLASS } from './characters.js';
import { createWheel, stepWheel, steer as steerAngle } from './gait.js';

export const ACTOR_KINDS = Object.freeze(['tow', 'patrol', 'ambulance', 'bus']);

/** Actor sizes (m) and rig facts. bedRest: the tow bed bone's rest local position. */
export const ACTOR_INFO = Object.freeze({
  tow: { length: 8.4, width: 2.45, height: 3.05, wheelbase: 5.2, wheels: [['wheelFL', 0.5], ['wheelFR', 0.5], ['wheelRL', 0.5], ['wheelRR', 0.5], ['wheelSL', 0.5], ['wheelSR', 0.5]], steer: ['steerFL', 'steerFR'], bedTop: 0.09, bedHalf: 2.5 },
  patrol: { length: 4.9, width: 1.85, height: 1.55, wheelbase: 2.8, wheels: [['wheelFL', 0.34], ['wheelFR', 0.34], ['wheelRL', 0.34], ['wheelRR', 0.34]], steer: ['steerFL', 'steerFR'] },
  ambulance: { length: 5.9, width: 2.1, height: 2.75, wheelbase: 3.6, wheels: [['wheelFL', 0.38], ['wheelFR', 0.38], ['wheelRL', 0.38], ['wheelRR', 0.38]], steer: ['steerFL', 'steerFR'] },
  bus: { length: 12, width: 2.55, height: 3.2, wheelbase: 6.6, wheels: [['wheelFL', 0.5], ['wheelFR', 0.5], ['wheelRL', 0.5], ['wheelRR', 0.5]], steer: ['steerFL', 'steerFR'] },
});

const RED = '#ff2a2a';
const BLUE = '#2a5bff';
const HALF_PI = Math.PI / 2;

function axleBones(kit, front, rear, x, y, extra = null) {
  kit.bone('steerFL', 'base', [x, y, front]);
  kit.bone('wheelFL', 'steerFL', [x, y, front]);
  kit.bone('steerFR', 'base', [-x, y, front]);
  kit.bone('wheelFR', 'steerFR', [-x, y, front]);
  kit.bone('wheelRL', 'base', [x, y, rear]);
  kit.bone('wheelRR', 'base', [-x, y, rear]);
  if (extra !== null) {
    kit.bone('wheelSL', 'base', [x, y, extra]);
    kit.bone('wheelSR', 'base', [-x, y, extra]);
  }
}

function wheels(kit, names, opts) {
  for (const n of names) buildWheel(kit, n, kit.bones[kit.index.get(n)].pos, opts);
}

function lightBar(kit, bone, y, z, width = 1.3) {
  kit.add(RBOX(width + 0.08, 0.06, 0.3, 0.02), { at: [0, y - 0.05, z], bone, color: C.black, rough: 0.5 });
  const n = 6;
  for (let k = 0; k < n; k++) {
    const x = (k / (n - 1) - 0.5) * width;
    const red = x > 0;
    kit.add(RBOX(width / n - 0.02, 0.12, 0.26, 0.03), { at: [x, y + 0.04, z], bone, color: red ? RED : BLUE, glow: red ? 2 : 3, rough: 0.2 });
  }
}

const BUILD = {
  /** Flatbed tow truck: white cab with an orange band, a tilting/sliding bed, a winch, a light bar. */
  tow(kit) {
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.9, 0]);
    kit.bone('bed', 'body', [0, 1.22, -1.5]);
    axleBones(kit, 2.75, -2.45, 1.0, 0.5, -3.55);
    kit.add(BOX(1.1, 0.3, 7.6), { at: [0, 0.75, -0.3], bone: 'body', color: '#2a2b2e', rough: 0.6 }); // chassis
    const cab = profileX([['m', 1.45, 0.75], ['l', 4.1, 0.75], ['l', 4.15, 1.55], ['q', 4.1, 2.35, 3.6, 2.75], ['l', 1.5, 2.85], ['l', 1.45, 0.75]], 2.25, { bevel: 0.08, seg: 2, curve: 5 });
    kit.add(cab, {
      bone: 'body', smooth: 40, rough: 0.35, metal: 0.2,
      faceFn: (c, n) => (c.y > 1.7 && c.y < 2.6 && (n.z > 0.45 || Math.abs(n.x) > 0.8) && c.z > 1.9 ? { color: C.glass, metal: 0.3, rough: 0.06 } : c.y > 1.15 && c.y < 1.4 ? { color: '#f07a12' } : { color: '#f5f5f2' }),
    });
    kit.add(BOX(2.1, 0.5, 0.06), { at: [0, 1.1, 4.2], bone: 'body', color: '#2a2b2e', metal: 0.5, rough: 0.4 }); // grille
    kit.add(BOX(2.4, 0.22, 0.18), { at: [0, 0.68, 4.25], bone: 'body', ...CHROME });
    for (const s of [1, -1]) {
      kit.add(CYL(0.14, 0.14, 0.05, 12).rotateX(HALF_PI), { at: [0.85 * s, 1.15, 4.22], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.16, 0.12, 0.06, 0.02), { at: [1.05 * s, 0.85, -4.12], bone: 'bed', color: C.tail, glow: 1, rough: 0.3 });
      const arc = Math.PI * 0.9;
      const f = TOR(0.62, 0.06, 4, 12, arc);
      f.rotateZ((Math.PI - arc) / 2);
      f.scale(1, 1, 3);
      f.rotateY(HALF_PI);
      kit.add(f, { at: [1.0 * s, 0.5, 2.75], bone: 'body', color: '#2a2b2e', rough: 0.5 });
    }
    lightBar(kit, 'body', 2.97, 2.6, 1.6);
    // The bed: deck, side rails, rear ramp lip, winch + hook at its front.
    kit.add(BOX(2.4, 0.16, 5.0), { at: [0, 1.22, -1.5], bone: 'bed', color: '#4b4f56', metal: 0.6, rough: 0.45 });
    for (const s of [1, -1]) kit.add(BOX(0.08, 0.2, 5.0), { at: [1.16 * s, 1.36, -1.5], bone: 'bed', color: '#f07a12', rough: 0.4 });
    kit.add(BOX(2.4, 0.06, 0.4), { at: [0, 1.17, -4.15], rot: [0.25, 0, 0], bone: 'bed', color: '#6a6e75', metal: 0.6, rough: 0.4 });
    kit.add(cylX(0.18, 1.0, 12), { at: [0, 1.5, 0.75], bone: 'bed', color: '#2a2b2e', metal: 0.6, rough: 0.4 });
    kit.add(BOX(1.3, 0.5, 0.12), { at: [0, 1.55, 0.95], bone: 'bed', color: '#f5f5f2', rough: 0.4 }); // headboard
    wheels(kit, ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'wheelSL', 'wheelSR'], { r: 0.5, width: 0.32, spokes: 5, rim: '#c5c9cf', hub: '#8d939b' });
  },

  /** Patrol car: black-and-white sedan with a roof light bar. */
  patrol(kit) {
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.55, 0]);
    axleBones(kit, 1.45, -1.35, 0.8, 0.34);
    const body = profileX([
      ['m', -2.35, 0.32], ['l', 2.3, 0.32], ['q', 2.45, 0.32, 2.45, 0.55], ['l', 2.4, 0.82], ['l', 0.9, 0.95],
      ['l', 0.3, 1.42], ['l', -1.2, 1.44], ['l', -1.8, 0.98], ['l', -2.4, 0.92], ['q', -2.45, 0.32, -2.35, 0.32],
    ], 1.62, { bevel: 0.08, seg: 2, curve: 5 });
    kit.add(body, {
      bone: 'body', smooth: 35, rough: 0.3, metal: 0.4,
      faceFn: (c, n) => (c.y > 1.0 && c.y < 1.38 && n.y < 0.75 ? { color: C.glass, metal: 0.3, rough: 0.06 } : c.y < 0.9 && c.z > -1.0 && c.z < 0.9 && Math.abs(n.x) > 0.5 ? { color: '#f5f5f2' } : { color: '#16171a' }),
    });
    lightBar(kit, 'body', 1.5, -0.4, 1.1);
    for (const s of [1, -1]) {
      kit.add(RBOX(0.3, 0.12, 0.05, 0.02), { at: [0.6 * s, 0.7, 2.44], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.3, 0.12, 0.05, 0.02), { at: [0.6 * s, 0.82, -2.44], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
    }
    kit.add(BOX(1.7, 0.16, 0.12), { at: [0, 0.4, 2.48], bone: 'body', color: '#2a2b2e', rough: 0.5 });
    wheels(kit, ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'], { r: 0.34, width: 0.22, spokes: 5, rim: '#c5c9cf' });
  },

  /** Ambulance: white box van, red band, light bars front and rear. */
  ambulance(kit) {
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 0.8, 0]);
    axleBones(kit, 2.0, -1.6, 0.88, 0.38);
    const cab = profileX([['m', 1.1, 0.42], ['l', 2.85, 0.42], ['q', 2.95, 0.42, 2.95, 0.7], ['l', 2.9, 1.1], ['l', 2.1, 1.9], ['l', 1.1, 1.95], ['l', 1.1, 0.42]], 1.9, { bevel: 0.07, seg: 2, curve: 4 });
    kit.add(cab, { bone: 'body', smooth: 35, rough: 0.35, metal: 0.25, faceFn: (c, n) => (c.y > 1.2 && n.y < 0.8 && (n.z > 0.4 || Math.abs(n.x) > 0.8) ? { color: C.glass, metal: 0.3, rough: 0.06 } : { color: '#f7f7f4' }) });
    kit.add(RBOX(2.05, 2.25, 4.1, 0.08), { at: [0, 1.6, -0.95], bone: 'body', color: '#f7f7f4', rough: 0.35, metal: 0.2, faceFn: (c) => (c.y > 1.15 && c.y < 1.45 ? { color: '#d42a2a' } : null) });
    for (const s of [1, -1]) {
      kit.add(RBOX(0.3, 0.14, 0.05, 0.02), { at: [0.65 * s, 0.75, 2.95], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.18, 0.2, 0.05, 0.02), { at: [0.9 * s, 1.0, -3.02], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
    }
    lightBar(kit, 'body', 2.8, 1.0, 1.7);
    lightBar(kit, 'body', 2.8, -2.9, 1.7);
    wheels(kit, ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'], { r: 0.38, width: 0.25, spokes: 5, rim: '#c5c9cf' });
  },

  /** City bus: green and cream, a dark window band, an amber destination sign. */
  bus(kit) {
    kit.bone('base', null, [0, 0, 0]);
    kit.bone('body', 'base', [0, 1.0, 0]);
    axleBones(kit, 3.9, -2.7, 1.05, 0.5);
    kit.add(RBOX(2.55, 2.75, 12, 0.18, 2), {
      at: [0, 1.75, 0], bone: 'body', rough: 0.35, metal: 0.25,
      faceFn: (c, n) => (c.y > 1.7 && c.y < 2.85 && n.y < 0.7 && !(Math.abs(n.x) > 0.7 && c.z > 4.6 && c.z < 5.6) ? { color: C.glass, metal: 0.3, rough: 0.06 } : c.y > 2.85 ? { color: '#efe6cf' } : { color: '#2f7d4f' }),
    });
    kit.add(BOX(1.6, 0.28, 0.05), { at: [0, 2.95, 6.02], bone: 'body', color: '#ffb42a', glow: 4, rough: 0.3 });
    for (const s of [1, -1]) {
      kit.add(RBOX(0.3, 0.16, 0.05, 0.02), { at: [0.85 * s, 0.85, 6.02], bone: 'body', color: C.lamp, glow: 1, rough: 0.1 });
      kit.add(RBOX(0.2, 0.3, 0.05, 0.02), { at: [1.05 * s, 1.0, -6.02], bone: 'body', color: C.tail, glow: 1, rough: 0.3 });
    }
    wheels(kit, ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'], { r: 0.5, width: 0.3, spokes: 5, rim: '#c5c9cf' });
  },
};

const GEO = new Map();

function actorGeometry(kind) {
  let rec = GEO.get(kind);
  if (rec) return rec;
  const kit = new CharKit();
  BUILD[kind](kit);
  rec = kit.build();
  GEO.set(kind, rec);
  return rec;
}

/** Builds one actor (hidden). */
export function buildActor(kind, { lights = null } = {}) {
  const rec = actorGeometry(kind);
  const info = ACTOR_INFO[kind];
  const material = createCharacterMaterial('#ffffff', { lights });
  const mesh = new THREE.SkinnedMesh(rec.geometry, material);
  mesh.name = `actor-${kind}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const bones = {};
  const rest = {};
  const list = rec.bones.map((b) => { const bone = new THREE.Bone(); bone.name = b.name; bones[b.name] = bone; return bone; });
  rec.bones.forEach((b, i) => {
    const parent = b.parent >= 0 ? rec.bones[b.parent].pos : [0, 0, 0];
    list[i].position.set(b.pos[0] - parent[0], b.pos[1] - parent[1], b.pos[2] - parent[2]);
    rest[b.name] = list[i].position.clone();
    if (b.parent >= 0) list[b.parent].add(list[i]);
    else mesh.add(list[i]);
  });
  mesh.bind(new THREE.Skeleton(list));
  const bs = rec.geometry.boundingSphere;
  mesh.boundingSphere = new THREE.Sphere(bs.center.clone(), bs.radius * 1.1 + 1);
  const root = new THREE.Group();
  root.name = `actor-${kind}`;
  root.rotation.order = 'YXZ';
  root.add(mesh);
  root.visible = false;
  return {
    kind, root, mesh, bones, rest, material, info, triangles: rec.triangles, visible: false, busy: 0,
    wheels: info.wheels.map(([b, r]) => ({ bone: bones[b], w: createWheel(r) })),
    steerBones: info.steer.map((b) => bones[b]),
  };
}

export class Actors {
  /**
   * @param {THREE.Scene|THREE.Object3D} scene
   * @param {import('./tween.js').Animator} animator
   * @param {{ markShadows?: Function, bus?: object, lights?: {value:number} }} [opts]
   */
  constructor(scene, animator, { markShadows = null, bus = null, lights = null } = {}) {
    this.scene = scene;
    this.animator = animator;
    this.markShadows = markShadows ?? (() => {});
    this.lights = lights ?? bus?.uniforms?.uLights ?? null;
    this.group = new THREE.Group();
    this.group.name = 'actors';
    scene?.add?.(this.group);
    this.pool = new Map();
  }

  /** The pooled actor of a kind (built on first use), or null for an unknown kind. */
  get(kind) {
    if (!ACTOR_INFO[kind]) return null;
    let a = this.pool.get(kind);
    if (!a) {
      a = buildActor(kind, { lights: this.lights });
      this.pool.set(kind, a);
      this.group.add(a.root);
    }
    return a;
  }

  show(a) {
    if (!a) return;
    a.visible = a.root.visible = true;
    a.mesh.castShadow = true;
  }

  hide(a) {
    if (!a) return;
    a.visible = a.root.visible = false;
    a.mesh.castShadow = false;
    this.rest(a);
    a.material.userData.uFlash.value.set(0, 0);
    a.material.userData.uBlur.value = 0;
  }

  hideAll() {
    for (const a of this.pool.values()) this.hide(a);
  }

  /** Puts every bone of an actor back at rest. */
  rest(a) {
    for (const [name, bone] of Object.entries(a.bones)) {
      bone.position.copy(a.rest[name]);
      bone.rotation.set(0, 0, 0);
      bone.scale.set(1, 1, 1);
    }
    a.root.rotation.x = 0;
  }

  place(a, x, y, z, heading) {
    a.root.position.set(x, y, z);
    a.root.rotation.y = heading;
  }

  /** Rolls the wheels by ds metres and steers for curvature kappa. */
  roll(a, ds, dt, kappa = 0) {
    let blur = false;
    for (const wh of a.wheels) {
      stepWheel(wh.w, ds, dt, { vReal: 20, lapse: true });
      wh.bone.rotation.x = wh.w.angle;
      blur ||= wh.w.blur;
    }
    const st = steerAngle(a.info.wheelbase, kappa);
    for (const b of a.steerBones) b.rotation.y = st;
    a.material.userData.uBlur.value = blur ? 1 : 0;
  }

  /** Light bar: alternates red / blue at 4 Hz from time t (s); off when on is false. */
  beacon(a, on, t = 0) {
    const ph = Math.floor(t * 8) % 2;
    a.material.userData.uFlash.value.set(on && ph === 0 ? 1 : on ? 0.08 : 0, on && ph === 1 ? 1 : on ? 0.08 : 0);
  }

  /** Tilts the tow truck's bed: k 0 (level) … 1 (slid back and tilted, rear lip on the ground). */
  tilt(a, k) {
    const b = a.bones.bed;
    if (!b) return;
    const kk = Math.min(1, Math.max(0, k));
    b.position.set(a.rest.bed.x, a.rest.bed.y - 0.2 * kk, a.rest.bed.z - 1.2 * kk);
    b.rotation.x = -0.4 * kk;
  }

  ambient() {
    let any = false;
    for (const a of this.pool.values()) any ||= a.visible;
    return any;
  }

  dispose() {
    for (const a of this.pool.values()) {
      a.root.parent?.remove(a.root);
      a.material.dispose();
      a.mesh.skeleton?.dispose?.();
    }
    this.pool.clear();
    for (const rec of GEO.values()) rec.geometry.dispose();
    GEO.clear();
    this.group.parent?.remove(this.group);
  }
}
