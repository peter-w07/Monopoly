// public/r3d/world-quality.js — the 3D graphics quality tiers and the little "world bus" that tells
// the board, the city and the environment when the tier or the time of day changes.
//
// Tiers (stage.setQuality('auto'|'low'|'medium'|'high')):
//   low     phones / weak GPUs: DPR ≤ 1.5, 1024 shadow map, 2048 board texture, sparse ambient life
//   medium  laptops: DPR ≤ 1.5, 2048 shadow map, 3072 board texture (2048 on small screens)
//   high    strong desktop GPUs: DPR ≤ 2, 2048 shadow map (softer), 4096 board texture, full ambient
//           life, tilt-shift + soft bloom postprocessing (never on touch devices). A 4096 shadow map
//           measured ~25 ms/frame to sample and ~90 ms to update on an RTX 4060 (ANGLE/D3D11), so no tier
//           goes above 2048.
// 'auto' picks by device (touch phone → low, known strong GPU → high, else medium) and steps down
// one tier if the frame rate stays low while animating (stage.js).

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const TIERS = {
  low: { name: 'low', dpr: 1.5, shadowMap: 1024, shadowRadius: 2, boardTex: 2048, density: 0.34, post: false, ambientFps: 20, clouds: false },
  medium: { name: 'medium', dpr: 1.5, shadowMap: 2048, shadowRadius: 3, boardTex: 3072, density: 0.67, post: false, ambientFps: 30, clouds: true },
  high: { name: 'high', dpr: 2, shadowMap: 2048, shadowRadius: 4, boardTex: 4096, density: 1, post: true, ambientFps: 40, clouds: true },
};

export const QUALITY_NAMES = ['auto', 'low', 'medium', 'high'];

/** The quality the player saved in the settings popover (ui.js owns the key), or 'auto'. */
export function savedQuality() {
  try {
    const q = JSON.parse(localStorage.getItem('monopoly.settings') || 'null')?.quality;
    return QUALITY_NAMES.includes(q) ? q : 'auto';
  } catch {
    return 'auto';
  }
}

/** The GPU's name (unmasked where the browser allows it), for the auto tier. */
export function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

const STRONG_GPU = /\b(RTX|GTX\s?(9[6-8]0|1[0-9]{3}|16[0-9]{2})|Radeon\s?(RX|Pro)\s?[5-9]\d{3}|Radeon RX\s?[6-9]\d{2}\b|Arc\s?A[57]\d{2}|Apple M\d (Pro|Max|Ultra)|Apple M[2-9])/i;
const SOFTWARE_GPU = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;

/** The tier 'auto' resolves to on this device. */
export function detectTier(renderer) {
  const small = typeof screen !== 'undefined' && Math.min(screen.width || 9999, screen.height || 9999) < 700;
  const name = gpuName(renderer);
  if (SOFTWARE_GPU.test(name)) return 'low';
  if (COARSE && small) return 'low'; // phones
  if (COARSE) return 'medium'; // tablets: no postprocessing on touch devices
  if ((renderer.capabilities?.maxTextureSize ?? 0) < 4096) return 'low';
  if (STRONG_GPU.test(name)) return 'high';
  return 'medium';
}

/** Resolves a requested quality to a concrete tier settings object (a copy, adjusted to the device). */
export function resolveTier(requested, renderer) {
  const name = requested === 'auto' || !TIERS[requested] ? detectTier(renderer) : requested;
  const t = { ...TIERS[name] };
  const maxTex = renderer.capabilities?.maxTextureSize ?? 4096;
  t.boardTex = Math.min(t.boardTex, maxTex);
  const bigScreen = typeof screen !== 'undefined' && Math.max(screen.width || 0, screen.height || 0) * (window.devicePixelRatio || 1) >= 1800;
  if (name === 'medium' && !bigScreen) t.boardTex = 2048;
  if (COARSE) t.post = false; // never on touch devices
  t.requested = requested;
  return t;
}

// ---- the world bus ------------------------------------------------------------------------------
// One per WebGLRenderer (one 3D view at a time): stage.js publishes the tier and the time of day,
// board.js / city.js / world-env.js subscribe. Keyed by renderer so a disposed view's listeners
// can never leak into the next one.

const buses = new WeakMap();

/** The bus of a renderer: { tier, dusk, lights, on(event, fn) → off, emit(event, value) }. */
export function worldBus(renderer) {
  let bus = buses.get(renderer);
  if (!bus) {
    const listeners = new Map();
    bus = {
      tier: TIERS.medium,
      dusk: 0,
      /** 0..1: how much the windows / street lamps glow (derived from dusk). */
      lights: 0,
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      emit(event, value) {
        for (const fn of listeners.get(event) ?? []) {
          try {
            fn(value);
          } catch (err) {
            console.error(`[renderer3d] ${event} listener failed:`, err);
          }
        }
      },
      clear() {
        listeners.clear();
      },
    };
    buses.set(renderer, bus);
  }
  return bus;
}
