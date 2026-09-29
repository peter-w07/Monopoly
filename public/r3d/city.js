// public/r3d/city.js — the living centre of the board (the Monopoly Plus signature, bare-bones).
//
// * One district per colour group, just inside its tiles (layout.districts). Each property owns two
//   building plots; they rise when the property is bought and grow with every house, and a hotel
//   turns the front plot into a tower. Mortgaged → greyed. Heights ease in over ~0.6 s with a puff.
// * A ferris wheel turns in the Free Parking corner, cars drive round the ring road, trees in the
//   other inner corners. These move only while the board is "awake" (the ambient loop in stage.js),
//   and never cast shadows, so they never force a shadow-map update.
// * The dice plaza in the middle stays clear.

import * as THREE from './three.js';
import { districts, districtPoint, ROAD_R, ROAD_CORNER, DISTRICT_IN, DISTRICT_OUT } from './layout.js';
import { mergeParts } from './token-models.js';
import { ease } from './tween.js';

const OUTER_R = DISTRICT_OUT - 0.25; // front row of plots (next to the tiles)
const INNER_R = DISTRICT_IN + 0.22; // back row (next to the road)
const GROW_TIME = 0.6;
const WHEEL_TURN_S = 20; // one turn of the ferris wheel
const CAR_SPEEDS = [0.55, 0.5, 0.62, 0.47];
const CAR_COLORS = ['#d23a2e', '#f2c230', '#2f6fd0', '#f4f1ea'];
const GREY = new THREE.Color('#9a9d9b');
const WHITE = new THREE.Color('#ffffff');

/** Building heights for a property: [front, back] (0 = no building). */
export function plotHeights(owned, houses) {
  if (!owned) return [0, 0];
  if (houses >= 5) return [1.05, 0.62];
  return [0.32 + 0.1 * houses, houses ? 0.2 + 0.09 * houses : 0];
}

export class City {
  /**
   * @param {THREE.Scene} scene
   * @param {object} BOARD parsed board.json
   * @param {object} deps { animator, markShadows, fx }
   */
  constructor(scene, BOARD, { animator, markShadows, fx = null }) {
    this.animator = animator;
    this.markShadows = markShadows;
    this.fx = fx;
    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);

    // ---- building plots ---------------------------------------------------------------------------
    this.plots = []; // { tile, row, x, z, w, d, yaw, base (colour), h (current), target, var }
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const d of districts(BOARD)) {
      const n = d.tiles.length;
      const tiles = d.tiles.slice().sort((a, b) => a - b);
      const step = (d.a1 - d.a0) / n;
      // Tiles are numbered clockwise; along the axis that is + for right/top… keep plots in board order.
      const alongSign = d.side === 'bottom' || d.side === 'left' ? -1 : 1;
      tiles.forEach((tile, k) => {
        const a = alongSign > 0 ? d.a0 + (k + 0.5) * step : d.a1 - (k + 0.5) * step;
        const tint = new THREE.Color(d.color).lerp(WHITE, 0.22);
        for (const [row, r, w, dep] of [[0, OUTER_R, Math.min(0.42, step * 0.72), 0.36], [1, INNER_R, Math.min(0.34, step * 0.6), 0.3]]) {
          const jitter = (rnd() - 0.5) * 0.08;
          const p = districtPoint(d, a + jitter, r);
          this.plots.push({
            tile,
            row,
            x: p.x,
            z: p.z,
            w,
            d: dep,
            yaw: d.horizontal ? 0 : Math.PI / 2,
            base: tint.clone(),
            color: tint.clone(),
            h: 0,
            target: 0,
            var: 0.88 + rnd() * 0.24,
            mortgaged: false,
          });
        }
      });
    }
    // One material (one draw call): windows on the sides; the roof (+y / -y faces, 4 vertices each
    // in BoxGeometry order [+x, -x, +y, -y, +z, -z]) samples a plain corner of the same texture.
    const wallMat = new THREE.MeshStandardMaterial({ map: windowTexture(), roughness: 0.7 });
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const uv = box.attributes.uv;
    for (let k = 8; k < 16; k++) uv.setXY(k, 0.04, 0.985);
    box.clearGroups();
    this.buildings = new THREE.InstancedMesh(box, wallMat, Math.max(1, this.plots.length));
    this.buildings.castShadow = true;
    this.buildings.receiveShadow = true;
    this.buildings.frustumCulled = false;
    this.buildings.setColorAt(0, WHITE);
    this.group.add(this.buildings);
    this.dummy = new THREE.Object3D();
    this.plots.forEach((_, k) => this.writePlot(k));

    // ---- ferris wheel (Free Parking corner) -------------------------------------------------------
    this.wheel = buildWheel();
    this.wheel.root.position.set(-3.92, 0, -3.92);
    this.wheel.root.rotation.y = Math.PI / 4; // faces the middle of the board
    this.group.add(this.wheel.root);

    // ---- trees in the other inner corners --------------------------------------------------------
    this.group.add(buildTrees([[3.92, 3.92], [-3.92, 3.92], [3.92, -3.92]]));

    // ---- cars on the ring road -------------------------------------------------------------------
    const carGroup = new THREE.Group();
    const add = (geo, x, y, z) => {
      const m = new THREE.Mesh(geo);
      m.position.set(x, y, z);
      carGroup.add(m);
    };
    add(new THREE.BoxGeometry(0.24, 0.06, 0.12), 0, 0.045, 0);
    add(new THREE.BoxGeometry(0.12, 0.05, 0.1), -0.02, 0.1, 0);
    for (const [x, z] of [[0.08, 0.06], [0.08, -0.06], [-0.08, 0.06], [-0.08, -0.06]]) add(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 10).rotateX(Math.PI / 2), x, 0.025, z);
    this.cars = new THREE.InstancedMesh(mergeParts(carGroup), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }), CAR_SPEEDS.length);
    this.cars.frustumCulled = false;
    const c = new THREE.Color();
    CAR_SPEEDS.forEach((_, k) => this.cars.setColorAt(k, c.set(CAR_COLORS[k % CAR_COLORS.length])));
    this.group.add(this.cars);
    this.road = roadPath();
    this.carPhase = CAR_SPEEDS.map((_, k) => (k / CAR_SPEEDS.length) * this.road.length);
    this.ambient(0);
  }

  writePlot(k) {
    const p = this.plots[k];
    const d = this.dummy;
    d.position.set(p.x, 0, p.z);
    d.rotation.set(0, p.yaw, 0);
    const h = p.h * p.var;
    d.scale.set(p.w, h > 1e-4 ? h : 0, h > 1e-4 ? p.d : 0);
    if (h <= 1e-4) d.scale.set(0, 0, 0);
    d.updateMatrix();
    this.buildings.setMatrixAt(k, d.matrix);
    this.buildings.setColorAt(k, p.color);
    this.buildings.instanceMatrix.needsUpdate = true;
    this.buildings.instanceColor.needsUpdate = true;
  }

  /** Reconciles every plot with the state (animated: grows / shrinks with a puff). */
  sync(ctx, animate) {
    let changed = false;
    this.plots.forEach((p, k) => {
      const ts = ctx.tileState.get(p.tile);
      const owner = ts?.ownerId && ctx.byId.has(ts.ownerId) ? ts.ownerId : null;
      const houses = owner ? Math.max(0, Math.min(5, Number(ts.houses) | 0)) : 0;
      const target = plotHeights(!!owner, houses)[p.row];
      const mortgaged = !!(owner && ts.mortgaged);
      if (mortgaged !== p.mortgaged) {
        p.mortgaged = mortgaged;
        p.color.copy(p.base);
        if (mortgaged) p.color.lerp(GREY, 0.7);
        this.writePlot(k);
        changed = true;
      }
      if (Math.abs(target - p.target) < 1e-6) return;
      changed = true;
      const from = p.h;
      p.target = target;
      if (!animate) {
        p.h = target;
        this.writePlot(k);
        return;
      }
      const growing = target > from;
      if (growing && from < 1e-3) this.fx?.puff(new THREE.Vector3(p.x, 0.05, p.z), 0.05, 0.9);
      this.animator.add({
        delay: p.row * 0.12,
        duration: growing ? GROW_TIME : 0.3,
        easing: growing ? ease.outBack : ease.inQuad,
        update: (e) => {
          p.h = Math.max(0, from + (target - from) * e);
          this.writePlot(k);
          this.markShadows();
        },
        end: () => {
          p.h = target;
          this.writePlot(k);
          this.markShadows();
        },
      });
    });
    if (changed) this.markShadows();
    return changed;
  }

  /** Snaps everything flat (a different game). */
  reset() {
    this.plots.forEach((p, k) => {
      p.h = p.target = 0;
      p.mortgaged = false;
      p.color.copy(p.base);
      this.writePlot(k);
    });
    this.markShadows();
  }

  /** Idle motion: the wheel turns, cars drive. Returns true (always something to animate). */
  ambient(now) {
    const t = now / 1000;
    this.wheel.spin(-(t / WHEEL_TURN_S) * Math.PI * 2);
    const d = this.dummy;
    CAR_SPEEDS.forEach((v, k) => {
      const s = (this.carPhase[k] + t * v) % this.road.length;
      const { x, z, heading } = this.road.at(s);
      d.position.set(x, 0, z);
      d.rotation.set(0, heading, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this.cars.setMatrixAt(k, d.matrix);
    });
    this.cars.instanceMatrix.needsUpdate = true;
    return true;
  }

  /** Visual state for tests: [{ tile, row, h, target }]. */
  inspect() {
    return this.plots.map((p) => ({ tile: p.tile, row: p.row, h: p.h, target: p.target, mortgaged: p.mortgaged }));
  }
}

// ---- pieces -------------------------------------------------------------------------------------

/** A window grid on white walls (instance colour tints it). */
function windowTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 128);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 3; c++) {
      const lit = (r * 7 + c * 3) % 5 === 0;
      g.fillStyle = lit ? '#ffe7a3' : '#46586a';
      g.fillRect(8 + c * 18, 10 + r * 19, 11, 12);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Ferris wheel: static legs + a turning rim with spokes; cabins hang level. */
function buildWheel() {
  const root = new THREE.Group();
  root.name = 'ferris-wheel';
  const R = 0.45;
  const HUB_Y = 0.6;
  const steel = new THREE.MeshStandardMaterial({ color: '#f3f1ec', roughness: 0.45, metalness: 0.3 });
  const legs = new THREE.Group();
  const legGeo = (x0, x1) => {
    const len = Math.hypot(x1 - x0, HUB_Y);
    const geo = new THREE.CylinderGeometry(0.018, 0.022, len, 8);
    const m = new THREE.Mesh(geo);
    m.position.set((x0 + x1) / 2, HUB_Y / 2, 0);
    m.rotation.z = Math.atan2(x0 - x1, HUB_Y);
    return m;
  };
  for (const z of [-0.09, 0.09]) {
    for (const x0 of [-0.3, 0.3]) {
      const m = legGeo(x0, 0);
      m.position.z = z;
      legs.add(m);
    }
  }
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 10).rotateX(Math.PI / 2));
  axle.position.y = HUB_Y;
  legs.add(axle);
  const legMesh = new THREE.Mesh(mergeParts(legs), steel);
  legMesh.castShadow = true;
  root.add(legMesh);

  const rimParts = new THREE.Group();
  rimParts.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.016, 8, 48)));
  const inner = new THREE.Mesh(new THREE.TorusGeometry(R * 0.55, 0.01, 6, 32));
  rimParts.add(inner);
  for (let k = 0; k < 8; k++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(R, 0.012, 0.012));
    const a = (k / 8) * Math.PI * 2;
    s.position.set(Math.cos(a) * R / 2, Math.sin(a) * R / 2, 0);
    s.rotation.z = a;
    rimParts.add(s);
  }
  const rim = new THREE.Mesh(mergeParts(rimParts), new THREE.MeshStandardMaterial({ color: '#d8423a', roughness: 0.4, metalness: 0.2 }));
  rim.position.y = HUB_Y;
  root.add(rim);

  const cabins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.08, 0.08), new THREE.MeshStandardMaterial({ roughness: 0.5 }), 8);
  const colors = ['#f1c40f', '#3498db', '#2ecc71', '#e67e22', '#9b59b6', '#1abc9c', '#e84393', '#ecf0f1'];
  const c = new THREE.Color();
  colors.forEach((col, k) => cabins.setColorAt(k, c.set(col)));
  cabins.frustumCulled = false;
  root.add(cabins);
  const d = new THREE.Object3D();
  return {
    root,
    spin(angle) {
      rim.rotation.z = angle;
      for (let k = 0; k < 8; k++) {
        const a = angle + (k / 8) * Math.PI * 2;
        d.position.set(Math.cos(a) * R, HUB_Y + Math.sin(a) * R - 0.05, 0);
        d.updateMatrix();
        cabins.setMatrixAt(k, d.matrix);
      }
      cabins.instanceMatrix.needsUpdate = true;
    },
  };
}

/** A few round trees around each point (two InstancedMeshes: crowns and trunks). */
function buildTrees(corners) {
  const spots = [];
  for (const [x, z] of corners) {
    const sx = Math.sign(x);
    const sz = Math.sign(z);
    spots.push([x, z, 1.1], [x - sx * 0.34, z + sz * 0.05, 0.85], [x + sx * 0.05, z - sz * 0.34, 0.9]);
  }
  const grp = new THREE.Group();
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.15, 1), new THREE.MeshStandardMaterial({ color: '#3f8f4a', roughness: 0.85, flatShading: true }), spots.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.035, 0.16, 6).translate(0, 0.08, 0), new THREE.MeshStandardMaterial({ color: '#6b4a2b', roughness: 0.9 }), spots.length);
  const d = new THREE.Object3D();
  spots.forEach(([x, z, s], k) => {
    d.position.set(x, 0, z);
    d.scale.setScalar(s);
    d.rotation.set(0, k, 0);
    d.updateMatrix();
    trunks.setMatrixAt(k, d.matrix);
    d.position.y = 0.26 * s;
    d.scale.set(s, s * 1.15, s);
    d.updateMatrix();
    crowns.setMatrixAt(k, d.matrix);
  });
  crowns.castShadow = trunks.castShadow = true;
  grp.add(crowns, trunks);
  return grp;
}

/**
 * The square ring road with rounded corners, driven clockwise (the way tokens travel):
 * at(s) → { x, z, heading } for arc length s in [0, length).
 */
function roadPath() {
  const R = ROAD_R;
  const rc = ROAD_CORNER;
  const L = 2 * (R - rc); // straight part of one side
  const arc = (Math.PI / 2) * rc;
  const seg = L + arc;
  // Side k starts at a corner end; directions: bottom → -x, left → -z, top → +x, right → +z.
  const sides = [
    { sx: R - rc, sz: R, dx: -1, dz: 0 },
    { sx: -R, sz: R - rc, dx: 0, dz: -1 },
    { sx: -R + rc, sz: -R, dx: 1, dz: 0 },
    { sx: R, sz: -R + rc, dx: 0, dz: 1 },
  ];
  return {
    length: 4 * seg,
    at(s) {
      const k = Math.floor(s / seg) % 4;
      const u = s - Math.floor(s / seg) * seg;
      const side = sides[k];
      if (u <= L) {
        return { x: side.sx + side.dx * u, z: side.sz + side.dz * u, heading: Math.atan2(-side.dz, side.dx) };
      }
      // Quarter turn to the next side's direction, around the corner centre.
      const next = sides[(k + 1) % 4];
      const ex = side.sx + side.dx * L; // end of the straight
      const ez = side.sz + side.dz * L;
      const cx = ex + next.dx * rc; // corner centre: one radius toward the next direction
      const cz = ez + next.dz * rc;
      const a = ((u - L) / arc) * (Math.PI / 2);
      // Start vector from the centre to the start point, rotated toward the end point.
      const vx = ex - cx;
      const vz = ez - cz;
      const turn = side.dx * next.dz - side.dz * next.dx; // sign of the turn in the x-z plane
      const ca = Math.cos(a * turn);
      const sa = Math.sin(a * turn);
      const x = cx + vx * ca - vz * sa;
      const z = cz + vx * sa + vz * ca;
      const dirx = side.dx * Math.cos(a) + next.dx * Math.sin(a);
      const dirz = side.dz * Math.cos(a) + next.dz * Math.sin(a);
      return { x, z, heading: Math.atan2(-dirz, dirx) };
    },
  };
}

export { roadPath as _roadPath };
