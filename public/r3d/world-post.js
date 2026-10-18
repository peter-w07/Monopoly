// public/r3d/world-post.js — optional postprocessing for the 'high' quality tier (desktop only): soft
// bloom on the bright things (street lamps, lit windows, neon, owner-colour hotel crowns, the
// lighthouse beam). No tilt-shift: the city is life-size, not a miniature (city design §15.1).
//
// A lean chain instead of EffectComposer (whose ping-pong targets would both be multisampled,
// paying an MSAA resolve on every pass). All in linear HDR:
//   scene → sceneRT (4× MSAA) → bloom (added into sceneRT's resolve) → OutputPass (tone mapping +
//   sRGB) → screen

import * as THREE from './three.js';

const BLOOM = { strength: 0.42, radius: 0.5, threshold: 1.4 }; // linear HDR: lit surfaces reach ~1.2, night glows ~2.5

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 */
export function createPost(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  const output = new THREE.OutputPass();
  output.renderToScreen = true;

  function setSize(w, h, dpr) {
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    sceneRT.setSize(W, H);
    bloom.setSize(W, H);
  }
  setSize(size.x, size.y, 1);

  return {
    /** The multisampled HDR target the scene renders into (shader variants are compiled for it). */
    target: sceneRT,
    bloom,
    passes: { bloom, output },
    render() {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      if (bloom.enabled) bloom.render(renderer, null, sceneRT, 0, false);
      output.render(renderer, null, sceneRT);
      renderer.setRenderTarget(prev);
    },
    setSize,
    /** Legacy no-op (the tilt-shift focus band is gone). */
    setFocus() {},
    /** How strongly bright things bloom (default 0.42). */
    setBloom(strength) {
      if (Number.isFinite(strength)) bloom.strength = strength;
    },
    dispose() {
      sceneRT.dispose();
      bloom.dispose();
      output.dispose();
    },
  };
}
