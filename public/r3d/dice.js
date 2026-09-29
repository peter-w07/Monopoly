// public/r3d/dice.js — two ivory dice that are thrown across the centre of the board and always
// come to rest showing the server's roll (the result is never simulated, only presented).

import * as THREE from './three.js';
import { PIP_ORDER, faceUpQuaternion, tumbleQuaternion, seeded } from './dice-math.js';
import { ease } from './tween.js';

const SIZE = 0.44;
const REST_Y = SIZE / 2;
const THROW_TIME = 1.0; // from the hand to rest
const START_R = 4.8; // thrown from just inside the thrower's edge of the board…
const FALL_END = 0.4; // …high over the city, first touching down in the plaza at this fraction
const BOUNCES = [[0.4, 0.7, 0.3], [0.7, 0.88, 0.09]]; // [from, to, height] of the two bounces
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.28, 0.22], [0.72, 0.22], [0.28, 0.5], [0.72, 0.5], [0.28, 0.78], [0.72, 0.78]],
};

export class Dice {
  constructor(scene, animator, markShadows, maxAniso = 4) {
    this.animator = animator;
    this.markShadows = markShadows;
    this.group = new THREE.Group();
    this.group.name = 'dice';
    // One atlas (3 × 2 faces) and one material: a single draw call per die.
    const mat = new THREE.MeshStandardMaterial({ map: pipAtlas(maxAniso), roughness: 0.32, metalness: 0 });
    const geo = new THREE.RoundedBoxGeometry(SIZE, SIZE, SIZE, 4, 0.07);
    const uv = geo.attributes.uv;
    const per = uv.count / 6; // faces in material-group order [+X, -X, +Y, -Y, +Z, -Z] (PIP_ORDER)
    for (let k = 0; k < uv.count; k++) {
      const f = Math.floor(k / per);
      uv.setXY(k, ((f % 3) + uv.getX(k)) / 3, (Math.floor(f / 3) + uv.getY(k)) / 2);
    }
    geo.clearGroups();
    this.dice = [0, 1].map(() => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    });
    scene.add(this.group);
    this.values = [5, 2];
    this.rest([5, 2], 1);
  }

  /** Where the dice rest after a throw (seeded jitter around the middle of the board). */
  restPose(k, rnd) {
    const x = (k ? 0.42 : -0.42) + (rnd() - 0.5) * 0.25;
    const z = 0.15 + (rnd() - 0.5) * 0.5;
    return { pos: new THREE.Vector3(x, REST_Y, z), yaw: rnd() * Math.PI * 2 };
  }

  /** Snaps the dice to rest showing `values` (no animation). */
  rest(values, seed = 1) {
    const rnd = seeded(seed);
    this.values = values.slice();
    this.dice.forEach((d, k) => {
      const { pos, yaw } = this.restPose(k, rnd);
      d.position.copy(pos);
      faceUpQuaternion(values[k], yaw, d.quaternion);
      d.scale.setScalar(1);
    });
    this.markShadows();
  }

  /**
   * Schedules a throw that lands on `values`, starting `delay` seconds from now.
   * The dice fly in high over the centre city (clear of the buildings), touch down in the plaza,
   * bounce twice and roll to rest — always showing `values` (tumbleQuaternion ends on the rest pose).
   * @param {number[]} values  [d1, d2] from dice_rolled
   * @param {{x:number, z:number}} from  unit direction (from the board centre) the dice come from
   * @param {number} seed      same seed → same throw on every client
   * @param {number} delay
   * @returns {number} seconds until the dice rest
   */
  schedule(values, from, seed, delay = 0, { small = false } = {}) {
    const rnd = seeded(seed);
    const scale = small ? 0.8 : 1;
    this.values = values.slice();
    this.dice.forEach((d, k) => {
      const { pos: to, yaw } = this.restPose(k, rnd);
      const final = faceUpQuaternion(values[k], yaw);
      const side = new THREE.Vector3(-from.z, 0, from.x).multiplyScalar(k ? 0.3 : -0.3);
      const start = new THREE.Vector3(from.x * START_R, 0, from.z * START_R).add(side);
      const peak = 1.9 + rnd() * 0.35;
      const axis = new THREE.Vector3().subVectors(to, start).setY(0).normalize().cross(THREE.Object3D.DEFAULT_UP); // tumble() spins about −axis = up × dir: rolls forward
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
      axis.applyAxisAngle(THREE.Object3D.DEFAULT_UP, (rnd() - 0.5) * 0.6).normalize();
      const spin = 4 * Math.PI + rnd() * 2 * Math.PI;
      const dur = THROW_TIME + k * 0.06;
      const restY = REST_Y * scale;
      this.animator.add({
        delay: delay + k * 0.04,
        duration: dur,
        start: () => d.scale.setScalar(scale),
        update: (t) => {
          const s = 1 - (1 - t) ** 3; // fast out of the hand, rolling slowly at the end
          d.position.lerpVectors(start, to, s);
          let y = 0;
          if (t < FALL_END) y = peak * (1 - (t / FALL_END) ** 2);
          else for (const [a, b, h] of BOUNCES) if (t >= a && t < b) y = h * 4 * ((t - a) / (b - a)) * (1 - (t - a) / (b - a));
          d.position.y = restY + y;
          tumbleQuaternion(final, axis, spin, ease.outQuad(t), d.quaternion);
          this.markShadows();
        },
        end: () => {
          d.position.copy(to);
          d.position.y = restY;
          d.quaternion.copy(final);
        },
      });
    });
    return THROW_TIME + 0.1;
  }

  /** World position above the dice (for the total / "Doubles!" label). */
  labelPos(out = new THREE.Vector3()) {
    out.addVectors(this.dice[0].position, this.dice[1].position).multiplyScalar(0.5);
    out.y = 0.75;
    return out;
  }
}

/** All six faces in one texture: face f (PIP_ORDER index) in column f % 3, row ⌊f / 3⌋ (row 0 at the bottom). */
function pipAtlas(aniso) {
  const cv = document.createElement('canvas');
  cv.width = 384;
  cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#f5f1e6';
  g.fillRect(0, 0, 384, 256);
  PIP_ORDER.forEach((v, f) => {
    const ox = (f % 3) * 128;
    const oy = Math.floor(f / 3) === 0 ? 128 : 0; // canvas y runs down; texture v runs up
    g.fillStyle = v === 1 ? '#b3122a' : '#141414';
    const r = v === 1 ? 15 : 11;
    for (const [x, y] of PIPS[v]) {
      g.beginPath();
      g.arc(ox + x * 128, oy + y * 128, r, 0, Math.PI * 2);
      g.fill();
    }
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}
