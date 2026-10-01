// public/r3d/city-life.js — the ambient life of the board and the table (driven by city.js):
//
//   * TrainLine: a toy railway round the board on the table — rails, sleepers and ballast, four
//     little stations (one beside each railroad tile) and a steam train that loops the board and
//     pauses at every station, puffing smoke.
//   * Traffic: cars in two lanes on the ring road.     * Walkers: tiny people on the sidewalks
//     and waiting on the station platforms.             * Birds: a small flock circling above.
//   * StreetLamps: posts along the ring road whose lamps light up at dusk.
//   * Particles: pooled soft points (steam, chimney smoke, firework sparks) — one draw call each.
//
// Everything here is instanced or merged, never casts shadows (so it never forces a shadow-map
// update) and moves from absolute time; update(now) is cheap and allocation-free.

import * as THREE from './three.js';
import { ROAD_R, ROAD_W, ROAD_CORNER, sideOf, tileCenter } from './layout.js';
import { Kit, loopPath, sweepLoop, rng, softDotTexture, nearFade } from './world-geo.js';
import { TABLE_Y } from './world-env.js';
import { carGeometry, personGeometry, personHeadGeometry, birdGeometry, lampPostGeometry, lampGlowGeometry } from './city-kit.js';

export const TRACK_HALF = 7.35; // the railway loop round the board (world units from the centre)
const TRACK_CORNER = 1.9;
const STATION_OUT = 8.4; // station buildings, outside the track
const TRAIN_VMAX = 1.1;
const TRAIN_ACCEL = 0.35;
const TRAIN_DECEL = 0.45;
const TRAIN_DWELL = 2.4;
const CAR_GAP = 1.02; // distance between carriage centres
const CARS = 3;

// ---- particles ----------------------------------------------------------------------------------

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  vAlpha = aAlpha;
  vColor = aColor;
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const tmpV2 = new THREE.Vector2();

/** A pool of soft round particles (smoke, steam, sparks). */
export class Particles {
  constructor(max, { additive = false, name = 'particles' } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.p = Array.from({ length: max }, () => ({ age: 1, life: 0, vx: 0, vy: 0, vz: 0, s0: 0, s1: 0, a0: 0, g: 0, drag: 0 }));
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.uniforms = { uMap: { value: softDotTexture(64, 1.2) }, uScale: { value: 500 } };
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      name,
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.name = name;
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(tmpV2);
      const view = camera.view?.enabled ? camera.view.fullHeight / camera.view.height : 1;
      this.uniforms.uScale.value = (tmpV2.y / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * view;
    };
    this.live = 0;
  }

  /**
   * Emits one particle.
   * @param {number} x @param {number} y @param {number} z  world position
   * @param {object} o { vx, vy, vz, life, s0, s1 (world size), a0 (alpha), color (THREE.Color), g (gravity), drag }
   */
  emit(x, y, z, o) {
    const k = this.next;
    this.next = (this.next + 1) % this.max;
    const p = this.p[k];
    p.age = 0;
    p.life = o.life ?? 1;
    p.vx = o.vx ?? 0;
    p.vy = o.vy ?? 0;
    p.vz = o.vz ?? 0;
    p.s0 = o.s0 ?? 0.1;
    p.s1 = o.s1 ?? p.s0;
    p.a0 = o.a0 ?? 1;
    p.g = o.g ?? 0;
    p.drag = o.drag ?? 0;
    this.pos[k * 3] = x;
    this.pos[k * 3 + 1] = y;
    this.pos[k * 3 + 2] = z;
    const c = o.color;
    this.color[k * 3] = c ? c.r : 1;
    this.color[k * 3 + 1] = c ? c.g : 1;
    this.color[k * 3 + 2] = c ? c.b : 1;
  }

  /** Advances every live particle by dt seconds. Returns true while any is alive. */
  update(dt) {
    let live = 0;
    for (let k = 0; k < this.max; k++) {
      const p = this.p[k];
      if (p.age >= p.life) {
        this.alpha[k] = 0;
        this.size[k] = 0;
        continue;
      }
      p.age += dt;
      const t = Math.min(1, p.age / p.life);
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vz *= damp;
      p.vy = p.vy * damp - p.g * dt;
      this.pos[k * 3] += p.vx * dt;
      this.pos[k * 3 + 1] += p.vy * dt;
      this.pos[k * 3 + 2] += p.vz * dt;
      this.size[k] = p.s0 + (p.s1 - p.s0) * t;
      this.alpha[k] = p.a0 * (1 - t) * Math.min(1, t * 8);
      live++;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    this.live = live;
    return live > 0;
  }

  clear() {
    for (const p of this.p) p.age = p.life = 0;
    this.alpha.fill(0);
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

// ---- train line ----------------------------------------------------------------------------------

/** Where each railroad's station stands: [{ tile, x, z, yaw (local +z → the track), s (arc length at its middle) }]. */
export function stationSpots(board, path) {
  const rails = (board?.tiles ?? []).filter((t) => t.type === 'railroad').map((t) => t.index);
  const out = [];
  for (const tile of rails) {
    const side = sideOf(tile);
    if (side === 'corner') continue;
    const c = tileCenter(tile);
    const along = side === 'bottom' || side === 'top' ? c.x : c.z;
    const spot = {
      bottom: { x: along, z: STATION_OUT, yaw: Math.PI, k: 0 },
      left: { x: -STATION_OUT, z: along, yaw: Math.PI / 2, k: 1 },
      top: { x: along, z: -STATION_OUT, yaw: 0, k: 2 },
      right: { x: STATION_OUT, z: along, yaw: -Math.PI / 2, k: 3 },
    }[side];
    // Arc length of the station's middle on the loop (sides: 0 bottom → -x, 1 left → -z, 2 top → +x, 3 right → +z).
    const seg = path.length / 4;
    const L = seg - (Math.PI / 2) * TRACK_CORNER;
    const half = L / 2;
    const u = { 0: half - along, 1: half - along, 2: half + along, 3: half + along }[spot.k];
    out.push({ tile, x: spot.x, z: spot.z, yaw: spot.yaw, s: spot.k * seg + Math.min(L, Math.max(0, u)) });
  }
  return out;
}

export class TrainLine {
  /**
   * @param {THREE.Group} group   parent
   * @param {object} board        board.json
   * @param {Particles} smoke
   */
  constructor(group, board, smoke) {
    this.smoke = smoke;
    this.path = loopPath(TRACK_HALF, TRACK_CORNER);
    this.stations = stationSpots(board, this.path);
    const y = TABLE_Y;

    // Track: ballast bed + sleepers (one vertex-coloured mesh), rails (one metal mesh).
    const kit = new Kit();
    kit.add(sweepLoop(this.path, { w: 0.66, h: 0.03, y, step: 0.2 }), { color: '#9c9185' });
    const p = { x: 0, z: 0, heading: 0 };
    const n = Math.round(this.path.length / 0.26);
    for (let k = 0; k < n; k++) {
      this.path.at((k / n) * this.path.length, p);
      kit.add(new THREE.BoxGeometry(0.1, 0.03, 0.52), { x: p.x, y: y + 0.045, z: p.z, ry: p.heading, color: '#5e4633' });
    }
    // Stations.
    for (const st of this.stations) kit.addKit(stationKit(), { x: st.x, y, z: st.z, ry: st.yaw });
    // Stations and the train dissolve when a low camera shot passes right by them (nearFade).
    const track = new THREE.Mesh(kit.build(), nearFade(new THREE.MeshStandardMaterial({ name: 'railway', vertexColors: true, roughness: 0.85 })));
    track.name = 'railway';
    track.receiveShadow = false;
    const rails = new Kit();
    for (const off of [-0.16, 0.16]) rails.add(sweepLoop(this.path, { w: 0.035, h: 0.04, offset: off, y: y + 0.06, step: 0.12 }), { color: '#c9ccd0' });
    const railMesh = new THREE.Mesh(rails.build(), new THREE.MeshStandardMaterial({ name: 'rails', vertexColors: true, metalness: 0.85, roughness: 0.3 }));
    railMesh.name = 'rails';
    group.add(track, railMesh);

    // The train: engine + carriages (two InstancedMeshes), soft shadows under them.
    this.engine = new THREE.InstancedMesh(engineGeometry(), nearFade(new THREE.MeshStandardMaterial({ name: 'engine', vertexColors: true, roughness: 0.4, metalness: 0.25 })), 1);
    this.cars = new THREE.InstancedMesh(carriageGeometry(), nearFade(new THREE.MeshStandardMaterial({ name: 'carriage', vertexColors: true, roughness: 0.55 })), CARS);
    this.blobs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.25, 0.62).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ name: 'train-shadow', map: softDotTexture(64, 1), color: '#1a0f08', transparent: true, opacity: 0.45, depthWrite: false }),
      CARS + 1,
    );
    for (const m of [this.engine, this.cars, this.blobs]) {
      m.frustumCulled = false;
      group.add(m);
    }
    this.blobs.renderOrder = 1;
    this.dummy = new THREE.Object3D();
    this.s = this.stations.length ? this.stations[0].s + 1.6 : 0;
    this.v = 0;
    this.dwell = 1.5;
    this.nextStop = 0;
    this.lastPuff = 0;
    this.last = 0;
    this.smokeColor = new THREE.Color('#f4f1ec');
    this.pickNextStop();
    this.place();
  }

  /** The stop point (arc length of the engine) after the current position. */
  pickNextStop() {
    if (!this.stations.length) {
      this.nextStop = null;
      return;
    }
    const L = this.path.length;
    let best = null;
    let bestD = Infinity;
    for (const st of this.stations) {
      const stop = (st.s + 1.6) % L;
      const d = (((stop - this.s) % L) + L) % L;
      if (d > 0.05 && d < bestD) {
        bestD = d;
        best = stop;
      }
    }
    this.nextStop = best;
  }

  place() {
    const d = this.dummy;
    const p = { x: 0, z: 0, heading: 0 };
    const put = (mesh, k, s, blob) => {
      this.path.at(s, p);
      d.position.set(p.x, TABLE_Y + 0.075, p.z);
      d.rotation.set(0, p.heading, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      mesh.setMatrixAt(k, d.matrix);
      d.position.y = TABLE_Y + 0.005;
      d.updateMatrix();
      this.blobs.setMatrixAt(blob, d.matrix);
    };
    put(this.engine, 0, this.s, 0);
    for (let k = 0; k < CARS; k++) put(this.cars, k, this.s - (k + 1) * CAR_GAP - 0.08, k + 1);
    this.engine.instanceMatrix.needsUpdate = true;
    this.cars.instanceMatrix.needsUpdate = true;
    this.blobs.instanceMatrix.needsUpdate = true;
  }

  /** Advances the train to time `now` (ms). */
  update(now) {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (dt <= 0) return;
    const L = this.path.length;
    if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.dwell <= 0) this.pickNextStop();
    } else {
      const dist = this.nextStop === null ? Infinity : (((this.nextStop - this.s) % L) + L) % L;
      const vStop = Math.sqrt(2 * TRAIN_DECEL * Math.max(0, dist));
      this.v = Math.min(this.v + TRAIN_ACCEL * dt, TRAIN_VMAX, Math.max(0.05, vStop));
      const step = Math.min(this.v * dt, dist);
      this.s = (this.s + step) % L;
      if (dist - step < 0.004) {
        this.v = 0;
        this.dwell = TRAIN_DWELL;
      }
    }
    this.place();
    // Steam from the chimney: brisk while running, lazy while waiting.
    const every = this.dwell > 0 ? 0.7 : 0.18 / Math.max(0.3, this.v / TRAIN_VMAX);
    if (now / 1000 - this.lastPuff > every) {
      this.lastPuff = now / 1000;
      const p = this.path.at(this.s + 0.36, { x: 0, z: 0, heading: 0 });
      this.smoke.emit(p.x, TABLE_Y + 0.68, p.z, {
        vx: (Math.random() - 0.5) * 0.08,
        vy: 0.32 + Math.random() * 0.1,
        vz: (Math.random() - 0.5) * 0.08,
        life: 1.8,
        s0: 0.16,
        s1: 0.62,
        a0: 0.55,
        drag: 0.4,
        color: this.smokeColor,
      });
    }
  }

  /** World position of a station's flag pole (for owner flags). */
  flagSpot(st) {
    const c = Math.cos(st.yaw);
    const s = Math.sin(st.yaw);
    // Local (x = -0.75, z = 0.05) → world, on the platform's end.
    const lx = -0.75;
    const lz = 0.05;
    return { x: st.x + lx * c + lz * s, y: TABLE_Y + 0.6, z: st.z - lx * s + lz * c };
  }
}

/** A small station: brick building with a gable roof, a platform with a canopy, a clock and lamps. Local +z faces the track. */
function stationKit() {
  const kit = new Kit();
  const brick = '#b4573f';
  const cream = '#f1e6cf';
  kit.add(new THREE.BoxGeometry(1.2, 0.5, 0.56), { y: 0.25, z: -0.15, color: brick });
  kit.add(new THREE.BoxGeometry(1.26, 0.05, 0.62), { y: 0.02, z: -0.15, color: cream });
  kit.add(new THREE.BoxGeometry(1.24, 0.04, 0.6), { y: 0.5, z: -0.15, color: cream });
  const roof = new THREE.Shape();
  roof.moveTo(-0.36, 0);
  roof.lineTo(0.36, 0);
  roof.lineTo(0, 0.26);
  roof.closePath();
  const r = new THREE.ExtrudeGeometry(roof, { depth: 1.34, bevelEnabled: false }).translate(0, 0, -0.67).rotateY(Math.PI / 2);
  kit.add(r, { y: 0.52, z: -0.15, color: '#4d5a66' });
  for (const x of [-0.4, 0, 0.4]) {
    kit.add(new THREE.BoxGeometry(0.16, 0.24, 0.02), { x, y: 0.26, z: 0.135, color: x === 0 ? '#5a3a26' : '#2e3b48' });
    kit.add(new THREE.BoxGeometry(0.2, 0.04, 0.03), { x, y: 0.4, z: 0.135, color: cream });
  }
  // Clock gable.
  kit.add(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 16).rotateX(Math.PI / 2), { y: 0.62, z: 0.2, color: '#fbf8f0' });
  kit.add(new THREE.BoxGeometry(0.008, 0.05, 0.006), { y: 0.635, z: 0.212, color: '#222' });
  kit.add(new THREE.BoxGeometry(0.04, 0.008, 0.006), { x: 0.015, y: 0.62, z: 0.212, color: '#222' });
  // Platform, canopy and posts.
  kit.add(new THREE.BoxGeometry(2.4, 0.09, 0.42), { y: 0.045, z: 0.33, color: '#cfc8ba' });
  kit.add(new THREE.BoxGeometry(2.4, 0.012, 0.04), { y: 0.092, z: 0.52, color: '#f2d24a' });
  kit.add(new THREE.BoxGeometry(1.9, 0.03, 0.4), { y: 0.46, z: 0.33, color: '#3f6b4f' });
  for (const x of [-0.85, -0.3, 0.3, 0.85]) kit.add(new THREE.CylinderGeometry(0.014, 0.014, 0.37, 6), { x, y: 0.27, z: 0.46, color: '#2f3a34' });
  // Benches and a name board.
  for (const x of [-0.55, 0.55]) kit.add(new THREE.BoxGeometry(0.22, 0.04, 0.06), { x, y: 0.12, z: 0.2, color: '#7b5a3c' });
  kit.add(new THREE.BoxGeometry(0.5, 0.1, 0.02), { x: 0, y: 0.38, z: 0.51, color: '#fbf8f0' });
  return kit;
}

/** The steam engine, facing +x, ~1.1 long, rails at y = 0. */
function engineGeometry() {
  const kit = new Kit();
  const red = '#b8322a';
  const dark = '#2a2a2a';
  const gold = '#d8b25a';
  kit.add(new THREE.BoxGeometry(1.05, 0.08, 0.34), { y: 0.1, color: dark });
  kit.add(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 16).rotateZ(Math.PI / 2), { x: 0.14, y: 0.3, color: red });
  kit.add(new THREE.CylinderGeometry(0.157, 0.157, 0.1, 16).rotateZ(Math.PI / 2), { x: 0.47, y: 0.3, color: dark });
  for (const x of [-0.04, 0.2, 0.38]) kit.add(new THREE.CylinderGeometry(0.155, 0.155, 0.02, 16).rotateZ(Math.PI / 2), { x, y: 0.3, color: gold });
  kit.add(new THREE.CylinderGeometry(0.06, 0.045, 0.2, 10), { x: 0.36, y: 0.52, color: dark });
  kit.add(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 10), { x: 0.36, y: 0.625, color: dark });
  kit.add(new THREE.SphereGeometry(0.065, 10, 6), { x: 0.1, y: 0.45, color: gold });
  kit.add(new THREE.BoxGeometry(0.34, 0.36, 0.36), { x: -0.3, y: 0.34, color: red });
  kit.add(new THREE.BoxGeometry(0.42, 0.04, 0.42), { x: -0.3, y: 0.53, color: dark });
  kit.add(new THREE.BoxGeometry(0.2, 0.12, 0.37), { x: -0.3, y: 0.4, color: '#2e3b48' });
  kit.add(new THREE.BoxGeometry(0.06, 0.1, 0.36), { x: 0.53, y: 0.14, color: red });
  const cow = new THREE.Shape();
  cow.moveTo(0, 0);
  cow.lineTo(0.12, 0);
  cow.lineTo(0, 0.12);
  cow.closePath();
  kit.add(new THREE.ExtrudeGeometry(cow, { depth: 0.3, bevelEnabled: false }).translate(0, 0, -0.15), { x: 0.55, y: 0.02, color: dark });
  for (const x of [-0.3, -0.05, 0.2]) {
    for (const z of [-0.18, 0.18]) {
      kit.add(new THREE.CylinderGeometry(0.085, 0.085, 0.04, 14).rotateX(Math.PI / 2), { x, y: 0.085, z, color: dark });
      kit.add(new THREE.CylinderGeometry(0.04, 0.04, 0.045, 10).rotateX(Math.PI / 2), { x, y: 0.085, z, color: red });
    }
  }
  kit.add(new THREE.SphereGeometry(0.035, 8, 6), { x: 0.53, y: 0.3, color: '#fff2b0' });
  return kit.build();
}

/** A carriage, facing +x, ~0.95 long. */
function carriageGeometry() {
  const kit = new Kit();
  kit.add(new THREE.BoxGeometry(0.95, 0.07, 0.32), { y: 0.1, color: '#2a2a2a' });
  kit.add(new THREE.BoxGeometry(0.9, 0.14, 0.38), { y: 0.21, color: '#2f6b4a' });
  kit.add(new THREE.BoxGeometry(0.9, 0.16, 0.38), { y: 0.36, color: '#f1e6c8' });
  kit.add(new THREE.BoxGeometry(0.78, 0.09, 0.385), { y: 0.37, color: '#2e3b48' });
  for (const x of [-0.26, 0, 0.26]) kit.add(new THREE.BoxGeometry(0.02, 0.09, 0.39), { x, y: 0.37, color: '#f1e6c8' });
  kit.add(new THREE.CylinderGeometry(0.21, 0.21, 0.94, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).scale(1, 0.35, 1), { y: 0.44, color: '#2f6b4a' });
  for (const x of [-0.3, 0.3]) {
    for (const z of [-0.17, 0.17]) kit.add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12).rotateX(Math.PI / 2), { x, y: 0.075, z, color: '#2a2a2a' });
  }
  return kit.build();
}

// ---- traffic ------------------------------------------------------------------------------------

const CAR_COLORS = ['#d23a2e', '#f2c230', '#2f6fd0', '#f4f1ea', '#27ae60', '#8e44ad', '#e67e22', '#34495e', '#16a085', '#c0392b', '#7f8c8d', '#e84393'];

export class Traffic {
  constructor(group, max = 12) {
    this.path = loopPath(ROAD_R, ROAD_CORNER);
    this.max = max;
    this.mesh = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ name: 'cars', vertexColors: true, roughness: 0.35, metalness: 0.25 }), max);
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    for (let k = 0; k < max; k++) this.mesh.setColorAt(k, c.set(CAR_COLORS[k % CAR_COLORS.length]));
    group.add(this.mesh);
    const rnd = rng(17);
    // Even lanes: cars alternate lanes; within a lane they are evenly spaced and share a speed.
    this.cars = Array.from({ length: max }, (_, k) => ({ lane: k % 2, phase: (Math.floor(k / 2) / Math.ceil(max / 2)) * this.path.length + rnd() * 0.3 }));
    this.speed = [0.5, 0.42];
    this.dummy = new THREE.Object3D();
    this.p = { x: 0, z: 0, heading: 0 };
    this.setCount(max);
  }

  setCount(n) {
    this.count = Math.max(0, Math.min(this.max, n));
    this.mesh.count = this.count;
  }

  update(now) {
    const t = now / 1000;
    const d = this.dummy;
    const L = this.path.length;
    const off = ROAD_W * 0.24;
    for (let k = 0; k < this.count; k++) {
      const car = this.cars[k];
      const dir = car.lane === 0 ? 1 : -1;
      const s = (((car.phase + dir * t * this.speed[car.lane]) % L) + L) % L;
      const p = this.path.at(s, this.p);
      // Left of travel on the loop = outward; lane 0 (clockwise) drives on the outer lane.
      const nx = -Math.sin(p.heading);
      const nz = -Math.cos(p.heading);
      const o = car.lane === 0 ? off : -off;
      d.position.set(p.x + nx * o, 0.002, p.z + nz * o);
      d.rotation.set(0, p.heading + (dir < 0 ? Math.PI : 0), 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.mesh.setMatrixAt(k, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- people ----------------------------------------------------------------------------------------

const SHIRTS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6', '#e67e22', '#ecf0f1', '#1abc9c', '#34495e', '#e84393'];
const SKIN = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#f6d7b8'];

export class Walkers {
  /**
   * @param {THREE.Group} group
   * @param {{x:number,z:number,yaw:number}[]} platforms  station spots (people wait there)
   * @param {number} max walkers on the sidewalks
   */
  constructor(group, platforms, max = 30) {
    const sidewalk = ROAD_R - ROAD_W / 2 - 0.05;
    this.path = loopPath(sidewalk, Math.max(0.05, ROAD_CORNER - 0.18));
    this.walkMax = max;
    const waiting = [];
    for (const st of platforms) {
      const c = Math.cos(st.yaw);
      const s = Math.sin(st.yaw);
      for (const [lx, lz] of [[-0.5, 0.3], [-0.42, 0.26], [0.35, 0.36], [0.62, 0.28]]) {
        waiting.push({ x: st.x + lx * c + lz * s, y: TABLE_Y + 0.09, z: st.z - lx * s + lz * c, yaw: st.yaw + Math.PI / 2 });
      }
    }
    this.waiting = waiting;
    const total = max + waiting.length;
    this.body = new THREE.InstancedMesh(personGeometry(), new THREE.MeshStandardMaterial({ name: 'people', vertexColors: true, roughness: 0.7 }), total);
    this.head = new THREE.InstancedMesh(personHeadGeometry(), new THREE.MeshStandardMaterial({ name: 'heads', roughness: 0.6 }), total);
    const rnd = rng(23);
    const c = new THREE.Color();
    this.people = [];
    for (let k = 0; k < total; k++) {
      this.body.setColorAt(k, c.set(SHIRTS[Math.floor(rnd() * SHIRTS.length)]));
      this.head.setColorAt(k, c.set(SKIN[Math.floor(rnd() * SKIN.length)]));
      this.people.push({ phase: rnd() * this.path.length, speed: 0.05 + rnd() * 0.05, dir: rnd() < 0.5 ? 1 : -1, lat: (rnd() - 0.5) * 0.05, bob: rnd() * 6, scale: 0.85 + rnd() * 0.15 });
    }
    for (const m of [this.body, this.head]) {
      m.frustumCulled = false;
      group.add(m);
    }
    this.dummy = new THREE.Object3D();
    this.p = { x: 0, z: 0, heading: 0 };
    this.cheerUntil = 0;
    this.setCount(max);
  }

  setCount(n) {
    this.walking = Math.max(0, Math.min(this.walkMax, n));
    // Instances: [0, walking) walkers, then the platform waiters packed right after.
    this.body.count = this.head.count = this.walking + this.waiting.length;
  }

  /** Everybody jumps and waves for `seconds` (a completed monopoly, a hotel). */
  cheer(seconds = 1.6) {
    this.cheerUntil = performance.now() + seconds * 1000;
  }

  update(now) {
    const t = now / 1000;
    const d = this.dummy;
    const L = this.path.length;
    const cheering = now < this.cheerUntil;
    const write = (k, x, y, z, yaw, scale) => {
      d.position.set(x, y, z);
      d.rotation.set(0, yaw, 0);
      d.scale.setScalar(scale);
      d.updateMatrix();
      this.body.setMatrixAt(k, d.matrix);
      this.head.setMatrixAt(k, d.matrix);
    };
    for (let k = 0; k < this.walking; k++) {
      const w = this.people[k];
      const s = (((w.phase + w.dir * t * w.speed) % L) + L) % L;
      const p = this.path.at(s, this.p);
      const nx = -Math.sin(p.heading);
      const nz = -Math.cos(p.heading);
      const hop = cheering ? Math.abs(Math.sin(t * 9 + w.bob)) * 0.05 : Math.abs(Math.sin(t * 9 * w.speed * 10 + w.bob)) * 0.006;
      write(k, p.x + nx * w.lat, 0.002 + hop, p.z + nz * w.lat, p.heading + (w.dir < 0 ? Math.PI : 0), w.scale);
    }
    this.waiting.forEach((spot, j) => {
      const w = this.people[this.walkMax + j];
      const hop = cheering ? Math.abs(Math.sin(t * 8 + w.bob)) * 0.08 : Math.max(0, Math.sin(t * 0.7 + w.bob)) * 0.004;
      write(this.walking + j, spot.x, spot.y + hop, spot.z, spot.yaw + Math.sin(t * 0.3 + w.bob) * 0.6, w.scale * 2.1);
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
  }
}

// ---- birds ------------------------------------------------------------------------------------------

export class Birds {
  constructor(group, max = 10) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(birdGeometry(), new THREE.MeshBasicMaterial({ name: 'birds', color: '#3a3330', side: THREE.DoubleSide }), max);
    this.mesh.frustumCulled = false;
    group.add(this.mesh);
    const rnd = rng(5);
    this.birds = Array.from({ length: max }, (_, k) => ({ r: 5 + rnd() * 3.5, y: 3.2 + rnd() * 1.4, w: 0.12 + rnd() * 0.05, a: (k / max) * 1.4 + rnd() * 0.3, flap: rnd() * 6, wob: rnd() * 6 }));
    this.dummy = new THREE.Object3D();
    this.setCount(max);
  }

  setCount(n) {
    this.count = Math.max(0, Math.min(this.max, n));
    this.mesh.count = this.count;
  }

  update(now) {
    const t = now / 1000;
    const d = this.dummy;
    for (let k = 0; k < this.count; k++) {
      const b = this.birds[k];
      const a = b.a + t * b.w;
      const r = b.r + Math.sin(t * 0.3 + b.wob) * 0.6;
      d.position.set(Math.cos(a) * r, b.y + Math.sin(t * 0.5 + b.wob) * 0.25, Math.sin(a) * r);
      d.rotation.set(0, -a, Math.sin(t * 0.4 + b.wob) * 0.2);
      const f = 0.35 + 0.65 * Math.abs(Math.sin(t * 7 + b.flap));
      d.scale.set(1.3, 1.3 * f * 1.6, 1.3);
      d.updateMatrix();
      this.mesh.setMatrixAt(k, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- street lamps -----------------------------------------------------------------------------------

export class StreetLamps {
  constructor(group) {
    const path = loopPath(ROAD_R - ROAD_W / 2 - 0.1, Math.max(0.05, ROAD_CORNER - 0.2));
    const spots = [];
    const n = Math.round(path.length / 1.05);
    const p = { x: 0, z: 0, heading: 0 };
    for (let k = 0; k < n; k++) {
      path.at((k / n) * path.length + 0.3, p);
      spots.push({ x: p.x, z: p.z, yaw: p.heading - Math.PI / 2 }); // arm (+x local) toward the road
    }
    this.posts = new THREE.InstancedMesh(lampPostGeometry(), new THREE.MeshStandardMaterial({ name: 'lamp-posts', vertexColors: true, roughness: 0.5 }), spots.length);
    this.glowMat = new THREE.MeshBasicMaterial({ name: 'lamp-glow', color: '#8a8272' });
    this.glow = new THREE.InstancedMesh(lampGlowGeometry(), this.glowMat, spots.length);
    const d = new THREE.Object3D();
    spots.forEach((s, k) => {
      d.position.set(s.x, 0, s.z);
      d.rotation.set(0, s.yaw, 0);
      d.scale.setScalar(1.25);
      d.updateMatrix();
      this.posts.setMatrixAt(k, d.matrix);
      this.glow.setMatrixAt(k, d.matrix);
    });
    for (const m of [this.posts, this.glow]) group.add(m);
    this.off = new THREE.Color('#8a8272');
    this.on = new THREE.Color('#ffcf85').multiplyScalar(2.4);
  }

  /** 0..1 how brightly the lamps glow. */
  setLights(v) {
    this.glowMat.color.copy(this.off).lerp(this.on, Math.min(1, Math.max(0, v)));
  }
}
