// shaders.js — GLSL pieces and uniforms shared by the terrain, grass, trees,
// water and sky, so they all see the same time, wind, wetness and light.
//
// Does: holds `env`, one set of uniform objects every custom material links
// to (updating env.x.value updates every shader), and the GLSL that reads
// them: hash noise, value noise and the wind (mean profile plus the same
// gust waves wind.js uses for the drone).
// Does NOT: decide any values; environment.js sets them every frame.

import * as THREE from 'three';
import { SHADER_MODES } from './wind.js';

export const env = {
  uTime: { value: 0 }, // seconds, wrapped to keep float precision
  uWindDir: { value: new THREE.Vector2(1, 0) }, // where the air goes, x/z
  uWind10: { value: 0 }, // m/s at 10 m over open ground
  uGustK: { value: Array.from({ length: SHADER_MODES }, () => new THREE.Vector2()) },
  uGustAmp: { value: new Float32Array(SHADER_MODES) },
  uGustPhase: { value: new Float32Array(SHADER_MODES) }, // already advanced in time on the CPU
  uWetness: { value: 0 }, // 0 dry .. 1 soaked
  uSnow: { value: 0 }, // 0 none .. 1 full cover
  uRain: { value: 0 }, // rain intensity now, for ripples
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, // toward the key light (sun or moon)
  uSunColor: { value: new THREE.Color(1, 1, 1) }, // key light colour x intensity
  uAmbient: { value: new THREE.Color(0.3, 0.35, 0.4) }, // sky light on an upward surface
  uGroundAmbient: { value: new THREE.Color(0.1, 0.1, 0.08) },
  uFogColor: { value: new THREE.Color(0.7, 0.8, 0.9) },
  uFogDensity: { value: 0.0006 },
  uNight: { value: 0 }, // 0 day .. 1 full night (for lit windows, star fade)
};

export const NOISE_GLSL = /* glsl */ `
float dwHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dwHash12(i), dwHash12(i + vec2(1.0, 0.0)), u.x),
             mix(dwHash12(i + vec2(0.0, 1.0)), dwHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float dwFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * dwNoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
`;

export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind10;
uniform vec2 uGustK[${SHADER_MODES}];
uniform float uGustAmp[${SHADER_MODES}];
uniform float uGustPhase[${SHADER_MODES}];

// Along-wind gust (m/s) at a horizontal position, as wind.js computes it.
float dwGust(vec2 xz) {
  float s = 0.0;
  for (int i = 0; i < ${SHADER_MODES}; i++) s += uGustAmp[i] * cos(dot(uGustK[i], xz) + uGustPhase[i]);
  return s;
}
// Mean wind (m/s) at height h above open ground: power law, exponent 1/7.
float dwMeanWind(float h) {
  return uWind10 * pow(max(h, 0.5) / 10.0, 0.142857);
}
`;

// Link the shared uniforms into a shader inside onBeforeCompile.
export function linkEnv(shader, names = Object.keys(env)) {
  for (const n of names) shader.uniforms[n] = env[n];
}
