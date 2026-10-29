// weather.js — clouds, fog, rain, snow, lightning, wet ground and snow cover.
//
// Does: holds the weather you choose (clear, partly cloudy, overcast, fog,
// rain, storm, snow) and the air temperature; blends smoothly between
// presets; decides whether precipitation falls as rain or snow from the
// temperature; lets the ground get wet in rain and dry afterwards, and lets
// snow settle below freezing and melt above; draws falling rain streaks and
// snowflakes around the camera, drifting with the wind; makes lightning
// flashes in storms.
// Does NOT: affect the flight physics yet (rain load, icing, air density
// from temperature come with the battery and air model in a later
// milestone), or play sound.
//
// Rain falls at about 7 m/s (2-3 mm drops), snow at about 1 m/s; terminal
// velocities after Gunn & Kinzer (1949) and common snowflake measurements.
// Wetting, drying and snow rates are game estimates, sped up to be visible.

import * as THREE from 'three';

export const PRESETS = {
  clear: { label: 'Clear', cloudCover: 0.04, cloudDark: 0, fog: 0.00028, precip: 0, turbidity: 2.2, gust: 1 },
  partly: { label: 'Partly cloudy', cloudCover: 0.42, cloudDark: 0.05, fog: 0.00036, precip: 0, turbidity: 3.5, gust: 1 },
  overcast: { label: 'Overcast', cloudCover: 0.93, cloudDark: 0.35, fog: 0.0006, precip: 0, turbidity: 6, gust: 1.1 },
  fog: { label: 'Fog', cloudCover: 0.85, cloudDark: 0.2, fog: 0.0105, precip: 0, turbidity: 9, gust: 0.4 },
  rain: { label: 'Rain', cloudCover: 1, cloudDark: 0.6, fog: 0.0019, precip: 0.6, turbidity: 8, gust: 1.25 },
  storm: { label: 'Thunderstorm', cloudCover: 1, cloudDark: 0.88, fog: 0.0026, precip: 1, turbidity: 10, gust: 1.9, lightning: true },
  snow: { label: 'Snow', cloudCover: 1, cloudDark: 0.4, fog: 0.0024, precip: 0.55, turbidity: 8, gust: 1, wantsCold: true },
};

const BOX = 36; // metres around the camera filled with rain or snow
const BOX_H = 22;

export class Weather {
  constructor(scene, quality) {
    this.scene = scene;
    this.preset = 'clear';
    this.temperature = 18; // degrees C
    this.cur = { ...PRESETS.clear };
    this.target = PRESETS.clear;
    this.wetness = 0;
    this.snowCover = 0;
    this.lightning = 0;
    this.nextFlash = 8;
    this.flashT = -1;
    this.time = 0;
    this.particles = this.makeParticles(quality.rainDrops);
    scene.add(this.particles);
  }

  set(presetKey) {
    this.preset = presetKey;
    this.target = PRESETS[presetKey];
    if (this.target.wantsCold && this.temperature > 0) this.temperature = -3;
  }

  get precipType() {
    if (this.temperature <= 0.5) return 'snow';
    if (this.temperature <= 1.5) return 'sleet';
    return 'rain';
  }

  makeParticles(count) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    let s = 77;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) seeds.set([rnd() * BOX, rnd() * BOX_H, rnd() * BOX, rnd()], i * 4);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;
    this.maxDrops = count;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3() },
        uSnow: { value: 0 }, // 0 rain .. 1 snow
        uLight: { value: new THREE.Color(1, 1, 1) },
        uFlash: { value: 0 },
      },
      vertexShader: /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uWind;
uniform float uSnow;
varying vec2 vUv;
varying float vFade;
void main() {
  float speed = mix(6.5 + aSeed.w * 2.0, 0.8 + aSeed.w * 0.5, uSnow);
  float fall = uTime * speed;
  // Position in a box that repeats around the camera; drift with the wind.
  vec3 p = aSeed.xyz - vec3(uWind.x, -fall, uWind.z) * 0.0;
  p.x += uWind.x * uTime * mix(0.9, 1.0, uSnow) + sin(uTime * 1.3 + aSeed.w * 40.0) * uSnow * 0.6;
  p.z += uWind.z * uTime * mix(0.9, 1.0, uSnow) + cos(uTime * 1.1 + aSeed.w * 30.0) * uSnow * 0.6;
  p.y -= fall;
  vec3 box = vec3(${BOX.toFixed(1)}, ${BOX_H.toFixed(1)}, ${BOX.toFixed(1)});
  vec3 origin = uCam - box * vec3(0.5, 0.45, 0.5);
  p = origin + mod(p - origin, box);
  // Streak along the fall direction (rain), small round flake (snow).
  vec3 vel = normalize(vec3(uWind.x, -speed, uWind.z));
  vec3 toCam = normalize(uCam - p);
  vec3 side = normalize(cross(vel, toCam));
  float len = mix(0.55, 0.05, uSnow);
  float width = mix(0.011, 0.05, uSnow);
  vec3 up = mix(vel * -1.0, normalize(cross(toCam, side)), uSnow);
  vec3 world = p + side * position.x * width + up * (position.y - 0.5) * len;
  vUv = vec2(position.x + 0.5, position.y);
  float d = distance(p, uCam);
  vFade = smoothstep(0.4, 2.0, d) * (1.0 - smoothstep(${(BOX * 0.38).toFixed(1)}, ${(BOX * 0.5).toFixed(1)}, d));
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform float uSnow;
uniform vec3 uLight;
uniform float uFlash;
varying vec2 vUv;
varying float vFade;
void main() {
  vec2 c = vUv - 0.5;
  float rain = (1.0 - abs(c.x) * 2.0) * (1.0 - abs(c.y) * 2.0);
  float flake = smoothstep(0.5, 0.15, length(c));
  float a = mix(rain * 0.35, flake * 0.9, uSnow) * vFade;
  vec3 col = mix(vec3(0.75, 0.8, 0.85), vec3(1.0), uSnow) * (uLight + uFlash * 4.0);
  gl_FragColor = vec4(col, a);
}`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.name = 'precipitation';
    return mesh;
  }

  /** dt in seconds; wind {x, z} near the camera; light = ambient colour for the drops. */
  update(dt, camera, wind, light, sunUp) {
    this.time += dt;
    // Blend toward the chosen preset over a few seconds.
    const k = 1 - Math.exp(-dt / 2.5);
    for (const key of ['cloudCover', 'cloudDark', 'fog', 'precip', 'turbidity', 'gust']) {
      this.cur[key] += (this.target[key] - this.cur[key]) * k;
    }
    const type = this.precipType;
    const snowing = type === 'snow' ? 1 : type === 'sleet' ? 0.5 : 0;
    const p = this.cur.precip;

    // Ground: wet in rain, dries in warm air and sun; snow settles below 0.5 C.
    const rainOnGround = p * (1 - snowing);
    if (rainOnGround > 0.05) this.wetness = Math.min(1, this.wetness + rainOnGround * dt * 0.08);
    else this.wetness = Math.max(0, this.wetness - dt * 0.004 * (1 + Math.max(this.temperature, 0) / 15) * (1 + sunUp));
    if (p * snowing > 0.05 && this.temperature <= 0.5) this.snowCover = Math.min(1, this.snowCover + p * snowing * dt * 0.03);
    else if (this.temperature > 0.5) this.snowCover = Math.max(0, this.snowCover - dt * 0.002 * (this.temperature + 1));

    // Lightning in storms: a few quick flickers every 6-20 s.
    this.lightning = 0;
    if (this.target.lightning && p > 0.7) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flashT = 0;
        this.nextFlash = 6 + Math.random() * 14;
      }
    }
    if (this.flashT >= 0) {
      this.flashT += dt;
      const t = this.flashT;
      this.lightning = (t < 0.08 ? 1 : 0) + (t > 0.14 && t < 0.2 ? 0.6 : 0) + (t > 0.3 && t < 0.42 ? 0.8 : 0);
      if (t > 0.5) this.flashT = -1;
    }

    // Falling rain and snow around the camera.
    const u = this.particles.material.uniforms;
    u.uTime.value = this.time % 1000;
    u.uCam.value.copy(camera.position);
    u.uWind.value.set(wind.x, 0, wind.z);
    u.uSnow.value = snowing;
    u.uLight.value.copy(light);
    u.uFlash.value = this.lightning;
    const drops = Math.round(this.maxDrops * Math.min(1, p * (snowing ? 0.8 : 1.1)));
    this.particles.geometry.instanceCount = drops;
    this.particles.visible = drops > 0;
  }
}
