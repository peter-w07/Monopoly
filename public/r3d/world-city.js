// public/r3d/world-city.js — Loop City's world (city design §3, §11.1, §13): ground, core, outskirts,
// terrain, water and sky. SKELETON (M0): the full §17.4 API with safe no-op bodies; the real world
// lands in M1.

import * as THREE from './three.js';

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {{ tier: object, bus: object, BOARD: object }} opts
 */
export function createWorld(renderer, scene, { tier, bus, BOARD } = {}) {
  const group = new THREE.Group();
  group.name = 'world';
  scene?.add?.(group);
  return {
    group,
    ground: {
      pulseBay() { return 0; },
      setRoute() { return 0; },
      clearRoute() {},
    },
    anchor() { return null; },
    heightAt() { return 0; },
    setTier() {},
    setDayPhase() {},
    setWeather() {},
    setMapMode() {},
    follow() {},
    ambient() { return false; },
    dispose() { group.removeFromParent(); },
    key: null,
  };
}
