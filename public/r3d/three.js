// public/r3d/three.js — the ONE import point for three.js and its addons.
//
// Every r3d module does `import * as THREE from './three.js'`. Keeping a single URL for
// three.module.js guarantees a single THREE instance (the vendored addons import
// '../three.module.js' themselves). See public/vendor/three/README.md.
export * from '../vendor/three/three.module.js';
export { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
export { RoundedBoxGeometry } from '../vendor/three/addons/RoundedBoxGeometry.js';
export { RoomEnvironment } from '../vendor/three/addons/RoomEnvironment.js';
// Postprocessing (used only on the 'high' quality tier: tilt-shift + soft bloom, see world-post.js).
export { FullScreenQuad } from '../vendor/three/addons/Pass.js';
export { OutputPass } from '../vendor/three/addons/OutputPass.js';
export { UnrealBloomPass } from '../vendor/three/addons/UnrealBloomPass.js';
