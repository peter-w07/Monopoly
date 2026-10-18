// public/r3d/world-quality.js — the 3D graphics quality tiers (city design §15.1) and the "world
// bus" (§17.2) that tells every layer of the city when the tier, the time of day, the weather or the
// map view changes, and shares the uniforms every city material reads.
//
// Tiers (stage.setQuality('auto'|'low'|'medium'|'high')):
//   low     phones / weak GPUs: DPR 1.0, no shadow map, sparse life, 1.5 km far plane, no clouds
//   medium  mid laptops: DPR 1.25, 2048 shadow map fitted to the shot, 3 km far plane
//   high    desktop GPUs: DPR 2, 2048 shadow map (softer), tree shadows, 5 km, soft bloom (never on
//           touch devices). A 4096 shadow map measured ~25 ms/frame to sample on an RTX 4060
//           (ANGLE/D3D11), so no tier goes above 2048.
// 'auto' picks by device (touch phone → low, known strong GPU → high, else medium) and steps down
// one tier when the GPU stays slow while animating (stage.js: GPU timer samples, taken only after
// 2 s of continuous animation, median > 16 ms).

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const K = 1000;
/**
 * §15.1. `boardTex` / `density` are kept for the retired tabletop modules (board.js / city.js) that
 * still read them; nothing in the city uses them.
 */
export const TIERS = {
  low: {
    name: 'low', dpr: 1.0, shadowMap: 0, shadowRadius: 0, treeShadows: false,
    peds: 60, crowd: 16, cars: 24, trees: 300, outskirts: 150, skyline: 20, boats: 2, birds: 12, weatherParticles: 400,
    lotDetail: 120, far: 1500, fogDensity: 0.0016, clouds: false, post: false, ambientFps: 20,
    budget: { calls: 70, shadowCalls: 0, triangles: 250 * K },
    boardTex: 2048, density: 0.34,
  },
  medium: {
    name: 'medium', dpr: 1.25, shadowMap: 2048, shadowRadius: 3, treeShadows: false,
    peds: 300, crowd: 32, cars: 60, trees: 900, outskirts: 500, skyline: 40, boats: 6, birds: 24, weatherParticles: 800,
    lotDetail: 220, far: 3000, fogDensity: 0.0010, clouds: true, post: false, ambientFps: 30,
    budget: { calls: 120, shadowCalls: 25, triangles: 600 * K },
    boardTex: 3072, density: 0.67,
  },
  high: {
    name: 'high', dpr: 2.0, shadowMap: 2048, shadowRadius: 4, treeShadows: true,
    peds: 900, crowd: 48, cars: 120, trees: 1600, outskirts: 900, skyline: 60, boats: 12, birds: 40, weatherParticles: 1200,
    lotDetail: Infinity, far: 5000, fogDensity: 0.0008, clouds: true, post: 'bloom', ambientFps: 40,
    budget: { calls: 170, shadowCalls: 35, triangles: 1200 * K },
    boardTex: 4096, density: 1,
  },
};

export const QUALITY_NAMES = ['auto', 'low', 'medium', 'high'];
export const WEATHER_KINDS = ['clear', 'overcast', 'rain', 'storm', 'snow'];

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
  const t = { ...TIERS[name], budget: { ...TIERS[name].budget } };
  const maxTex = renderer?.capabilities?.maxTextureSize ?? 4096;
  t.boardTex = Math.min(t.boardTex, maxTex);
  if (COARSE) t.post = false; // never on touch devices
  t.requested = requested;
  return t;
}

// ---- the world bus ------------------------------------------------------------------------------
// One per WebGLRenderer (one 3D view at a time). Writers: the stage (tier, dayPhase, lights, weather,
// mapMode and their uniforms) and the city clock (uCityTime, lane D). Everyone else listens. Keyed by
// renderer so a disposed view's listeners can never leak into the next one.
//
// events: 'tier' (tier) · 'dayPhase' (phase) · 'weather' (weather) · 'mapMode' (k) · 'frame' (nowMs,
//         every drawn frame) · 'lightning' (0..1) — plus the legacy 'dusk' (0..1) for old modules.

const buses = new WeakMap();

/** The §17.2 bus of a renderer. */
export function worldBus(renderer) {
  let bus = buses.get(renderer);
  if (!bus) {
    const listeners = new Map();
    bus = {
      tier: TIERS.medium,
      /** −0.3 (dawn) … 0 morning … 0.35 afternoon … 0.7 golden hour … 1.0 blue hour … 1.2 night. */
      dayPhase: 0.35,
      /** 0..1: windows, street lamps, headlights (smoothstep(0.75, 1.0, phase), also before sunrise). */
      lights: 0,
      /** { kind, rain, snow, wet, cloud } (each 0..1; cloud = overcast amount). */
      weather: { kind: 'clear', rain: 0, snow: 0, wet: 0, cloud: 0 },
      /** 0..1: the north-up map view (bays glow, the city desaturates). */
      mapMode: 0,
      /** Legacy (tabletop modules): 0 afternoon … 1 dusk. */
      dusk: 0,
      /** { value } objects shared by every material (never replaced, only written). */
      uniforms: {
        uCityTime: { value: 0 },
        uLights: { value: 0 },
        uDay: { value: 0.35 },
        uSnow: { value: 0 },
        uWet: { value: 0 },
        uMapMode: { value: 0 },
      },
      on(event, fn) {
        if (typeof fn !== 'function') return () => {};
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      emit(event, value) {
        const set = listeners.get(event);
        if (!set || !set.size) return;
        for (const fn of set) {
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
