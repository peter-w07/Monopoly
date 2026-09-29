// public/r3d/fx.js — small one-shot effects on the shared Animator: dust puffs when something is
// built, and a confetti burst for the winner. Pooled and cheap; nothing here casts shadows.

import * as THREE from './three.js';

const PUFF_POOL = 30;
const PUFF_BITS = 6;
const PUFF_TIME = 0.55;
const CONFETTI = 180;
const CONFETTI_TIME = 3.2;
const CONFETTI_COLORS = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#ffffff', '#e67e22'];

export class Fx {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./tween.js').Animator} animator
   */
  constructor(scene, animator) {
    this.animator = animator;
    this.group = new THREE.Group();
    this.group.name = 'fx';
    scene.add(this.group);

    // Dust puffs: soft round sprites, each with its own material (per-sprite opacity).
    this.puffTex = softDot();
    this.puffs = [];
    for (let k = 0; k < PUFF_POOL; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, color: '#f2ece0', transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      this.group.add(s);
      this.puffs.push(s);
    }
    this.nextPuff = 0;

    // Confetti: one InstancedMesh of small paper squares.
    this.confetti = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.075, 0.045),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }),
      CONFETTI,
    );
    this.confetti.count = 0;
    this.confetti.frustumCulled = false;
    const c = new THREE.Color();
    for (let k = 0; k < CONFETTI; k++) this.confetti.setColorAt(k, c.set(CONFETTI_COLORS[k % CONFETTI_COLORS.length]));
    this.group.add(this.confetti);
    this.dummy = new THREE.Object3D();
  }

  /**
   * A little cloud of dust at `pos` (world), `delay` seconds from now. `size` scales it.
   * @param {THREE.Vector3} pos
   */
  puff(pos, delay = 0, size = 1) {
    if (!pos) return;
    const bits = [];
    for (let k = 0; k < PUFF_BITS; k++) {
      const s = this.puffs[this.nextPuff];
      this.nextPuff = (this.nextPuff + 1) % PUFF_POOL;
      const a = (k / PUFF_BITS) * Math.PI * 2 + Math.random() * 0.6;
      bits.push({ s, dx: Math.cos(a), dz: Math.sin(a), up: 0.05 + Math.random() * 0.08 });
    }
    this.animator.add({
      delay,
      duration: PUFF_TIME,
      start: () => {
        for (const b of bits) {
          b.s.visible = true;
          b.s.position.copy(pos);
        }
      },
      update: (p) => {
        const out = (1 - (1 - p) ** 2) * 0.28 * size;
        for (const b of bits) {
          b.s.position.set(pos.x + b.dx * out, pos.y + b.up * p * size, pos.z + b.dz * out);
          b.s.scale.setScalar((0.12 + 0.2 * p) * size);
          b.s.material.opacity = 0.85 * (1 - p) * Math.min(1, p * 6);
        }
      },
      end: () => {
        for (const b of bits) {
          b.s.visible = false;
          b.s.material.opacity = 0;
        }
      },
    });
  }

  /** Confetti raining down around `pos` (world) for a few seconds. */
  confettiAt(pos, delay = 0) {
    if (!pos) return;
    const bits = [];
    for (let k = 0; k < CONFETTI; k++) {
      const r = Math.sqrt(Math.random()) * 1.8;
      const a = Math.random() * Math.PI * 2;
      bits.push({
        x: pos.x + Math.cos(a) * r,
        z: pos.z + Math.sin(a) * r,
        y: 2.2 + Math.random() * 1.6,
        fall: 0.8 + Math.random() * 0.7,
        sway: 0.08 + Math.random() * 0.12,
        phase: Math.random() * 6.3,
        spin: 3 + Math.random() * 6,
      });
    }
    const m = this.confetti;
    const d = this.dummy;
    this.animator.add({
      delay,
      duration: CONFETTI_TIME,
      start: () => {
        m.count = CONFETTI;
        m.instanceColor.needsUpdate = true;
      },
      update: (p) => {
        const t = p * CONFETTI_TIME;
        bits.forEach((b, k) => {
          const y = Math.max(0.01, b.y - b.fall * t);
          d.position.set(b.x + Math.sin(t * 2 + b.phase) * b.sway, y, b.z + Math.cos(t * 1.7 + b.phase) * b.sway);
          d.rotation.set(t * b.spin, t * b.spin * 0.7, b.phase);
          d.scale.setScalar(y <= 0.011 ? 0.8 : 1);
          d.updateMatrix();
          m.setMatrixAt(k, d.matrix);
        });
        m.instanceMatrix.needsUpdate = true;
      },
      end: () => { m.count = 0; },
    });
  }

  /** Hides everything (reset / skip-safe). */
  clear() {
    for (const s of this.puffs) {
      s.visible = false;
      s.material.opacity = 0;
    }
    this.confetti.count = 0;
  }
}

/** A soft white dot (radial gradient) for puffs. */
function softDot() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
