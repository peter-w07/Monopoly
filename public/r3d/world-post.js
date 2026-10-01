// public/r3d/world-post.js — optional postprocessing for the 'high' quality tier (desktop only):
// a tilt-shift blur that turns the table into a miniature diorama, and soft bloom on the bright
// things (string lights, lit windows, hotel crowns, the candle).
//
// The tilt-shift is screen-space and never blurs what the camera is looking at: every frame the
// stage passes the screen rows of a "focus region" around the camera target (the whole board in
// the overview, the tile and its neighbourhood in a close-up); above it (farther away) the blur
// ramps up to full, below it (nearer) to half.
//
// A lean chain instead of EffectComposer (whose two ping-pong targets would both be multisampled,
// paying an MSAA resolve on every pass). All in linear HDR:
//   scene → sceneRT (4× MSAA) → tilt H → rtA → tilt V + vignette → rtB → bloom (added into rtB)
//   → OutputPass (tone mapping + sRGB) → screen

import * as THREE from './three.js';

const BLOOM = { strength: 0.5, radius: 0.45, threshold: 1.6 }; // linear HDR: lit surfaces reach ~1.2, the dusk glows ~2.6
const TILT_PX = 2.6; // blur step at full strength, in CSS px (scaled by the pixel ratio)

const TiltShiftShader = {
  name: 'TiltShiftShader',
  uniforms: {
    tDiffuse: { value: null },
    uDir: { value: new THREE.Vector2(1, 0) },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uLo: { value: 0.2 }, // screen v (0 = bottom) of the near edge of the sharp band
    uHi: { value: 0.8 }, // … of the far edge
    uRamp: { value: 0.22 }, // how quickly the blur reaches full strength outside the band
    uAmount: { value: TILT_PX },
    uVignette: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uDir;
    uniform vec2 uTexel;
    uniform float uLo;
    uniform float uHi;
    uniform float uRamp;
    uniform float uAmount;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      float above = smoothstep(uHi, uHi + uRamp, vUv.y);
      float below = smoothstep(uLo, uLo - uRamp, vUv.y) * 0.5;
      float blur = max(above, below);
      vec4 c = texture2D(tDiffuse, vUv);
      if (blur > 0.001) {
        // 9-tap Gaussian folded into 5 linear fetches.
        vec2 s = uDir * uTexel * uAmount * blur;
        c = c * 0.2270270270
          + (texture2D(tDiffuse, vUv + s * 1.3846153846) + texture2D(tDiffuse, vUv - s * 1.3846153846)) * 0.3162162162
          + (texture2D(tDiffuse, vUv + s * 3.2307692308) + texture2D(tDiffuse, vUv - s * 3.2307692308)) * 0.0702702703;
      }
      if (uVignette > 0.0) {
        vec2 q = vUv - 0.5;
        c.rgb *= 1.0 - uVignette * smoothstep(0.18, 0.7, dot(q, q) * 2.0);
      }
      gl_FragColor = c;
    }`,
};

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 */
export function createPost(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const hdr = { type: THREE.HalfFloatType };
  const sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { ...hdr, samples: 4 });
  const rtA = new THREE.WebGLRenderTarget(size.x, size.y, { ...hdr, depthBuffer: false });
  const rtB = new THREE.WebGLRenderTarget(size.x, size.y, { ...hdr, depthBuffer: false });
  const makeTilt = () => new THREE.ShaderMaterial({
    name: TiltShiftShader.name,
    uniforms: THREE.UniformsUtils.clone(TiltShiftShader.uniforms),
    vertexShader: TiltShiftShader.vertexShader,
    fragmentShader: TiltShiftShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const tiltH = makeTilt();
  const tiltV = makeTilt();
  tiltV.uniforms.uDir.value.set(0, 1);
  tiltV.uniforms.uVignette.value = 0.28;
  const quad = new THREE.FullScreenQuad(null);
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(size.x, size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  const output = new THREE.OutputPass();
  output.renderToScreen = true;

  function setSize(w, h, dpr) {
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    sceneRT.setSize(W, H);
    rtA.setSize(W, H);
    rtB.setSize(W, H);
    bloom.setSize(W, H);
    for (const m of [tiltH, tiltV]) {
      m.uniforms.uTexel.value.set(1 / W, 1 / H);
      m.uniforms.uAmount.value = TILT_PX * dpr;
    }
  }
  setSize(size.x, size.y, 1);

  const pass = (material, input, target) => {
    material.uniforms.tDiffuse.value = input.texture;
    quad.material = material;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  };

  return {
    /** The multisampled HDR target the scene renders into (shader variants are compiled for it). */
    target: sceneRT,
    bloom,
    passes: { tiltH, tiltV, bloom, output },
    render() {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      pass(tiltH, sceneRT, rtA);
      pass(tiltV, rtA, rtB);
      if (bloom.enabled) bloom.render(renderer, null, rtB, 0, false);
      output.render(renderer, null, rtB);
      renderer.setRenderTarget(prev);
    },
    setSize,
    /** Screen rows (0 = bottom, 1 = top) of the region that must stay sharp. */
    setFocus(lo, hi) {
      for (const m of [tiltH, tiltV]) {
        m.uniforms.uLo.value = lo;
        m.uniforms.uHi.value = hi;
      }
    },
    /** How strongly bright things bloom (default 0.5). */
    setBloom(strength) {
      bloom.strength = strength;
    },
    dispose() {
      sceneRT.dispose();
      rtA.dispose();
      rtB.dispose();
      bloom.dispose();
      output.dispose();
      quad.dispose();
      tiltH.dispose();
      tiltV.dispose();
    },
  };
}
