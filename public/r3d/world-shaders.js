// public/r3d/world-shaders.js — small shader patches shared by the world's materials (city design
// §11.5, §13, §15.2). Any lane may use them on its own MeshStandardMaterials:
//
//   weatherPatch(material, bus.uniforms, opts)  wet roads (darker, glossy), snow on up-facing
//       surfaces, the map view's desaturation. Reads uWet / uSnow / uMapMode.
//   facadePatch(material, bus.uniforms, opts)   procedural, anti-aliased windows (fwidth) in facade
//       space — from a per-vertex `aFacade` (u, v metres on the wall, style, seed) or, for instanced
//       unit boxes, computed from the instance's scale — lit at night by uLights.
//
// Patterns are computed from local / facade coordinates, never from world xz (§15.2).

import * as THREE from './three.js';

export const GLSL_HASH = /* glsl */ `
float cityHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float cityNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cityHash(i), cityHash(i + vec2(1.0, 0.0)), f.x), mix(cityHash(i + vec2(0.0, 1.0)), cityHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

/** Chains an onBeforeCompile patch and makes the program key unique. */
export function chainPatch(material, key, fn) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    fn(shader, renderer);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|${key}`;
  return material;
}

/**
 * Wet roads, snow and the map view's desaturation for a MeshStandardMaterial.
 * opts: { wet = 1, snow = 1, desat = 0.35 } — how strongly each applies to this material.
 */
export function weatherPatch(material, uniforms, { wet = 1, snow = 1, desat = 0.35 } = {}) {
  const f = (x) => Number(x).toFixed(3);
  return chainPatch(material, `weather-${f(wet)}-${f(snow)}-${f(desat)}`, (shader) => {
    shader.uniforms.uWet = uniforms.uWet;
    shader.uniforms.uSnow = uniforms.uSnow;
    shader.uniforms.uMapMode = uniforms.uMapMode;
    if (!shader.fragmentShader.includes('cityHash(')) shader.fragmentShader = shader.fragmentShader.replace('void main() {', `${GLSL_HASH}\nvoid main() {`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uWet;\nuniform float uSnow;\nuniform float uMapMode;\nvoid main() {')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), uMapMode * ${f(desat)});`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float cityUp = dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
          float wt = uWet * ${f(wet)} * smoothstep(0.5, 0.92, cityUp);
          diffuseColor.rgb *= 1.0 - 0.4 * wt;
          roughnessFactor = mix(roughnessFactor, 0.14, wt);
          float sn = uSnow * ${f(snow)} * smoothstep(0.42, 0.8, cityUp);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.98), sn * 0.92);
          roughnessFactor = mix(roughnessFactor, 0.85, sn);
        }`);
  });
}

/**
 * Procedural windows. Styles: 0 none (roofs, plinths), 1 residential (2.6 × 3.2 m cells), 2 office
 * glass (1.6 × 3.6), 3 old town (2.2 × 3.0, small), 4 tower curtain wall (1.5 × 3.6, tall).
 * opts: { instanced: false } — true: the mesh is an InstancedMesh of a unit box (±0.5) whose
 *   facade coordinates come from the instance scale; `aFacade` is not needed then (style from
 *   opts.style, seed from the instance id). { saturation = 1 } scales the colour's saturation
 *   (background buildings at 60 %).
 */
export function facadePatch(material, uniforms, { instanced = false, style = 2, saturation = 1, glow = 1.6 } = {}) {
  const f = (x) => Number(x).toFixed(3);
  return chainPatch(material, `facade-${instanced ? 'i' : 'a'}-${style}-${f(saturation)}-${f(glow)}`, (shader) => {
    shader.uniforms.uLights = uniforms.uLights;
    shader.uniforms.uMapMode = uniforms.uMapMode;
    if (instanced) {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec4 vFacade;\nvoid main() {')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec3 sc = vec3(1.0);
            #ifdef USE_INSTANCING
              sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
            #endif
            vec3 n = abs(normal);
            float v = (position.y + 0.5) * sc.y;
            float u = n.x > 0.5 ? position.z * sc.z : position.x * sc.x;
            float st = n.y > 0.5 ? 0.0 : ${f(style)};
            float seed = 0.0;
            #ifdef USE_INSTANCING
              seed = float(gl_InstanceID) * 0.618;
            #endif
            vFacade = vec4(u + (n.x > 0.5 ? 37.0 : 0.0), v, st, seed);
          }`);
    } else {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute vec4 aFacade;\nvarying vec4 vFacade;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = aFacade;');
    }
    if (!shader.fragmentShader.includes('cityHash(')) shader.fragmentShader = shader.fragmentShader.replace('void main() {', `${GLSL_HASH}\nvoid main() {`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uLights;\nuniform float uMapMode;\nvarying vec4 vFacade;\nvec3 cityWinGlow = vec3(0.0);\nvoid main() {')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          ${saturation < 0.999 ? `diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), diffuseColor.rgb, ${f(saturation)});` : ''}
          float st = floor(vFacade.z + 0.5);
          if (st > 0.5) {
            vec2 cell = st < 1.5 ? vec2(2.6, 3.2) : st < 2.5 ? vec2(1.6, 3.6) : st < 3.5 ? vec2(2.2, 3.0) : vec2(1.5, 3.6);
            vec2 win = st < 1.5 ? vec2(1.25, 1.55) : st < 2.5 ? vec2(1.3, 2.7) : st < 3.5 ? vec2(0.9, 1.6) : vec2(1.36, 3.0);
            vec2 g = vFacade.xy / cell;
            vec2 id = floor(g);
            vec2 q = abs(fract(g) - 0.5);
            vec2 w = fwidth(g);
            vec2 hw = win / cell * 0.5;
            vec2 m = vec2(1.0) - smoothstep(hw - w, hw + w, q);
            float far = smoothstep(0.25, 0.6, max(w.x, w.y));
            float area = hw.x * hw.y * 4.0;
            float ground = step(1.0, id.y); // no windows on the first 1 m band below the first row
            float wm = mix(m.x * m.y, area, far) * ground;
            float r = cityHash(id + vec2(vFacade.w * 13.1, vFacade.w * 7.3));
            vec3 glass = mix(vec3(0.07, 0.09, 0.12), vec3(0.16, 0.2, 0.26), r);
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, wm * 0.85);
            float lit = step(r, 0.25 + 0.6 * uLights) * uLights;
            cityWinGlow = wm * lit * mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.9, 0.7), cityHash(id.yx + 3.1)) * ${f(glow)};
          }
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cityWinGlow;');
  });
}

/** A MeshStandardMaterial with vertex colours, weather and (optionally) windows. */
export function cityMaterial(uniforms, { name = 'city', roughness = 0.85, metalness = 0, windows = false, instanced = false, style = 2, saturation = 1, wet = 1, snow = 1, desat = 0.35, side = THREE.FrontSide } = {}) {
  const m = new THREE.MeshStandardMaterial({ name, vertexColors: true, roughness, metalness, side });
  if (windows) facadePatch(m, uniforms, { instanced, style, saturation });
  weatherPatch(m, uniforms, { wet, snow, desat });
  return m;
}
