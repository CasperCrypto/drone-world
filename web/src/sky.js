// sky.js — sky, sun, moon, stars, clouds and the outdoor light.
//
// Does: puts the sun and the moon where solar.js says for the chosen date,
// clock time and place; draws the daytime sky (three.js Preetham sky), a
// cloud layer whose cover and darkness follow the weather, the stars
// (turning around the celestial pole) and the moon with its phase; sets the
// key light (sun by day, moon by night, with shadows), the sky light and the
// exposure, and keeps a reflection map of the sky up to date.
// Does NOT: simulate the atmosphere physically. Sunlight colour uses air
// mass and a simple per-colour extinction; light levels are tuned so day,
// dusk and night read correctly on screen, not measured in lux.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { sunPosition, moonPosition, POLAND } from './solar.js';
import { env, NOISE_GLSL } from './shaders.js';

const RAD = Math.PI / 180;
const DOME = 8500;
const CLOUD_ALTITUDE = 1600;

// Direction (three.js: x east, y up, z south) from elevation/azimuth in degrees.
export function directionFromAngles(elevation, azimuth, target = new THREE.Vector3()) {
  const el = elevation * RAD;
  const az = azimuth * RAD;
  return target.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

// Kasten & Young (1989) relative air mass.
function airMass(elevationDeg) {
  const e = Math.max(elevationDeg, -0.5);
  return 1 / (Math.sin(e * RAD) + 0.50572 * Math.pow(e + 6.07995, -1.6364));
}

// The cloud shader's noise, in JavaScript, so the light can tell whether a
// visible cloud is in front of the sun. Same formulas as NOISE_GLSL.
const fract = (x) => x - Math.floor(x);
function hash12(x, y) {
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d; b += d; c += d;
  return fract((a + b) * c);
}
function noise2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy) + (hash12(ix + 1, iy) - hash12(ix, iy)) * ux;
  const b = hash12(ix, iy + 1) + (hash12(ix + 1, iy + 1) - hash12(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}
function fbm2(x, y) {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < 4; i++) {
    sum += amp * noise2(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}
export function cloudDensityAt(px, py, cover) {
  const n = fbm2(px, py) * 0.75 + noise2(px * 4.1 + 3, py * 4.1 + 3) * 0.25;
  const e0 = 1 - cover - 0.08;
  const e1 = 1 - cover + 0.32;
  const t = Math.min(Math.max((n - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

const smooth = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export class SkySystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.cloudCover = 0.1;
    this.cloudDark = 0;
    this.lightning = 0;
    this.cloudOffset = new THREE.Vector2();

    this.sky = this.makeSky();
    scene.add(this.sky);

    this.clouds = this.makeClouds();
    scene.add(this.clouds);
    this.stars = this.makeStars();
    scene.add(this.stars);
    this.moon = this.makeMoon();
    scene.add(this.moon);

    this.key = new THREE.DirectionalLight(0xffffff, 3);
    this.key.castShadow = true;
    this.key.shadow.bias = -0.0003;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key, this.key.target);
    this.hemi = new THREE.HemisphereLight(0xbcd2ff, 0x4a4632, 0.6);
    scene.add(this.hemi);

    // Reflection map: the sky (with clouds) rendered into a cube and pre-filtered.
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(this.sky.geometry, this.sky.material);
    this.envSky.scale.setScalar(1000);
    this.envClouds = new THREE.Mesh(this.clouds.geometry, this.clouds.material);
    this.envClouds.scale.setScalar(900 / DOME);
    this.envScene.add(this.envSky, this.envClouds);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.lastEnv = { el: 999, az: 999, cover: -1, t: -1 };
  }

  makeSky() {
    const sky = new Sky();
    sky.scale.setScalar(20000);
    // Blend the sky into the fog colour near the horizon, so distant hills
    // and the sky meet without a seam.
    const m = sky.material;
    m.uniforms.uHazeColor = env.uFogColor;
    m.uniforms.uHaze = { value: 0.5 };
    m.fragmentShader = m.fragmentShader
      .replace('void main() {', 'uniform vec3 uHazeColor;\nuniform float uHaze;\nvoid main() {')
      .replace('gl_FragColor = vec4( retColor, 1.0 );',
        'retColor = mix(retColor, uHazeColor, uHaze * (1.0 - smoothstep(-0.03, 0.22, direction.y)));\n\t\t\tgl_FragColor = vec4( retColor, 1.0 );');
    return sky;
  }

  makeClouds() {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uCover: { value: 0.1 },
        uDark: { value: 0 },
        uOffset: { value: new THREE.Vector2() },
        uSunDir: env.uSunDir,
        uSunColor: env.uSunColor,
        uAmbient: env.uAmbient,
        uFogColor: env.uFogColor,
        uLightning: { value: 0 },
      },
      vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w * 0.99999;
}`,
      fragmentShader: /* glsl */ `
uniform float uCover;
uniform float uDark;
uniform vec2 uOffset;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uLightning;
varying vec3 vDir;
${NOISE_GLSL}
float cloudDensity(vec2 p) {
  float n = dwFbm(p) * 0.75 + dwNoise(p * 4.1 + 3.0) * 0.25;
  return smoothstep(1.0 - uCover - 0.08, 1.0 - uCover + 0.32, n);
}
void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.005) discard;
  // Where the view ray meets the cloud layer.
  vec2 p = d.xz / d.y * ${CLOUD_ALTITUDE.toFixed(1)} / 2600.0 + uOffset;
  float dens = cloudDensity(p);
  // Light: how much cloud lies between this point and the sun.
  vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.05;
  float shade = cloudDensity(p + toSun) * 0.6 + cloudDensity(p + toSun * 2.2) * 0.4;
  float lit = clamp(1.0 - shade * 0.85, 0.0, 1.0) * (1.0 - uDark * 0.75);
  vec3 sun = uSunColor * 0.23 * max(uSunDir.y + 0.15, 0.0);
  vec3 col = uAmbient * (0.55 + 0.45 * (1.0 - uDark)) * 0.42 + sun * lit;
  col *= 1.0 - 0.35 * dens * uDark;
  col += vec3(0.75, 0.8, 1.0) * uLightning * 2.5 * dens;
  float horizon = smoothstep(0.0, 0.18, d.y);
  col = mix(uFogColor, col, smoothstep(0.0, 0.3, d.y) * 0.7 + 0.3);
  float alpha = dens * horizon * mix(0.92, 1.0, uCover);
  gl_FragColor = vec4(col, alpha);
}`,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME, 48, 24), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    mesh.name = 'clouds';
    return mesh;
  }

  makeStars() {
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const bright = new Float32Array(n);
    let s = 2024;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(a) * DOME * 0.95, u * DOME * 0.95, r * Math.sin(a) * DOME * 0.95], i * 3);
      bright[i] = Math.pow(rnd(), 6) * 3 + 0.25;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: `attribute float aBright; varying float vB;
        void main() { vB = aBright; gl_PointSize = 1.2 + aBright * 0.9;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }`,
      fragmentShader: `uniform float uOpacity; varying float vB;
        void main() { vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(vec3(0.9, 0.93, 1.0) * vB * uOpacity * a, 1.0); }`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -2;
    const group = new THREE.Group();
    group.add(pts);
    group.name = 'stars';
    return group;
  }

  makeMoon() {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uPhase: { value: 1 }, uWaxing: { value: 1 }, uBright: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99998; }`,
      fragmentShader: `uniform float uPhase; uniform float uWaxing; uniform float uBright; varying vec2 vUv;
        ${NOISE_GLSL}
        void main() {
          float r = length(vUv);
          float glow = exp(-r * 3.2) * 0.12;
          if (r > 1.0) { gl_FragColor = vec4(vec3(0.7, 0.75, 0.85) * glow * uBright, glow); return; }
          // Sphere point, lit from a direction set by the phase.
          vec3 n = vec3(vUv, sqrt(1.0 - r * r));
          float ang = acos(clamp(1.0 - 2.0 * uPhase, -1.0, 1.0));
          vec3 l = vec3(sin(ang) * uWaxing, 0.0, -cos(ang));
          float lit = smoothstep(-0.05, 0.12, dot(n, l));
          float maria = 0.75 + 0.25 * dwFbm(vUv * 3.0 + 7.0);
          vec3 c = vec3(1.0, 0.97, 0.9) * maria * (lit * 2.6 + 0.02);
          gl_FragColor = vec4(c * uBright, 1.0);
        }`,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.frustumCulled = false;
    m.renderOrder = -1;
    m.name = 'moon';
    return m;
  }

  /**
   * date: UTC instant. weather: { cloudCover, cloudDark, turbidity, lightning }.
   * Sets lights, sky, clouds, stars, moon, env uniforms; returns light info.
   */
  update(date, weather, camera, focus, dt) {
    const sun = sunPosition(date, POLAND.lat, POLAND.lon);
    const moon = moonPosition(date, POLAND.lat, POLAND.lon);
    directionFromAngles(sun.elevation, sun.azimuth, this.sunDir);
    directionFromAngles(moon.elevation, moon.azimuth, this.moonDir);
    this.cloudCover = weather.cloudCover;
    this.cloudDark = weather.cloudDark;

    // Sunlight: extinction through the air mass, warmer near the horizon.
    const m = airMass(sun.elevation);
    const ext = [0.09, 0.17, 0.37]; // per-colour optical depth, tuned (R, G, B)
    const above = smooth(-1.5, 2.5, sun.elevation);
    // Is a cloud in front of the sun? Same place the cloud shader draws it.
    let inShade = 1;
    if (this.sunDir.y > 0.02) {
      const k = CLOUD_ALTITUDE / 2600 / this.sunDir.y;
      inShade = cloudDensityAt(this.sunDir.x * k + this.cloudOffset.x, this.sunDir.z * k + this.cloudOffset.y, this.cloudCover);
    } else {
      inShade = smooth(0.3, 0.95, this.cloudCover);
    }
    this.sunShade = this.sunShade === undefined ? inShade : this.sunShade + (inShade - this.sunShade) * Math.min(1, dt * 1.5);
    const clouds = 1 - 0.85 * this.sunShade;
    const sunColor = new THREE.Color(Math.exp(-ext[0] * m), Math.exp(-ext[1] * m), Math.exp(-ext[2] * m));
    const sunIntensity = 3.3 * above * clouds;

    // Twilight and night: how dark it is (civil to astronomical twilight).
    const day = smooth(-7, 4, sun.elevation);
    const night = 1 - smooth(-14, -3, sun.elevation);
    const moonUp = smooth(-1, 4, moon.elevation);
    const moonIntensity = 0.11 * moon.illumination * moonUp * (1 - 0.75 * this.cloudCover) * night;

    // Key light: the sun by day, the moon by night.
    const useMoon = sunIntensity < 0.05 && moonIntensity > 0;
    if (useMoon) {
      this.key.color.setRGB(0.62, 0.72, 1.0);
      this.key.intensity = moonIntensity;
      this.keyDir = this.moonDir;
    } else {
      this.key.color.copy(sunColor);
      this.key.intensity = sunIntensity;
      this.keyDir = this.sunDir;
    }

    // Sky light (hemisphere): blue by day, grey under clouds, orange at dusk, deep blue at night.
    const dusk = smooth(-6, 2, sun.elevation) * (1 - smooth(4, 14, sun.elevation));
    const skyDay = new THREE.Color(0.55, 0.68, 0.95).lerp(new THREE.Color(0.75, 0.78, 0.82), this.cloudCover);
    const skyDusk = new THREE.Color(0.75, 0.55, 0.5);
    const skyNight = new THREE.Color(0.08, 0.11, 0.2);
    const sky = skyNight.clone().lerp(skyDay, day).lerp(skyDusk, dusk * 0.45 * (1 - this.cloudCover));
    const skyLevel = (0.03 + 0.97 * day) * (1.05 - 0.25 * this.cloudDark) * (1 + this.lightning * 6);
    const hemiIntensity = (0.95 + 0.35 * this.cloudCover) * skyLevel + night * 0.02;
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(sky).multiply(new THREE.Color(0.42, 0.4, 0.32));
    this.hemi.intensity = hemiIntensity;

    // Exposure: like eyes adapting, so night is dark but readable.
    this.exposure = THREE.MathUtils.lerp(2.6, 0.82, smooth(-12, 8, sun.elevation)) * (1 + 0.25 * this.cloudCover * day);

    // Shared uniforms for custom shaders.
    env.uSunDir.value.copy(this.keyDir);
    env.uSunColor.value.copy(this.key.color).multiplyScalar(this.key.intensity);
    env.uAmbient.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity);
    env.uGroundAmbient.value.copy(this.hemi.groundColor).multiplyScalar(this.hemi.intensity);
    env.uNight.value = night;

    // Sky dome.
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = weather.turbidity;
    u.rayleigh.value = THREE.MathUtils.lerp(1.2, 2.6, this.cloudCover);
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.82;
    u.uHaze.value = weather.haze;

    // Clouds drift with the wind high up (stronger than at the ground).
    const cu = this.clouds.material.uniforms;
    this.cloudOffset.x += (weather.windX * 2.2 * dt) / 2600;
    this.cloudOffset.y += (weather.windZ * 2.2 * dt) / 2600;
    cu.uOffset.value.copy(this.cloudOffset);
    cu.uCover.value = this.cloudCover;
    cu.uDark.value = this.cloudDark;
    cu.uLightning.value = this.lightning;
    this.clouds.position.copy(camera.position);

    // Stars: visible in the dark, hidden by clouds, turning with the sky.
    this.stars.position.copy(camera.position);
    this.stars.children[0].material.uniforms.uOpacity.value = night * (1 - this.cloudCover) * 1.2;
    const lst = ((date.getTime() / 86400000) * 360.9856 + POLAND.lon) * RAD;
    this.stars.rotation.set(0, 0, 0);
    this.stars.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), -(90 - POLAND.lat) * RAD);
    this.stars.rotateY(-lst);

    // Moon, with its phase.
    // 0.0091 rad is the moon's apparent diameter; drawn 1.8 times larger.
    this.moon.position.copy(camera.position).addScaledVector(this.moonDir, DOME * 0.9);
    this.moon.scale.setScalar(DOME * 0.9 * 0.0091 * 1.8);
    this.moon.lookAt(camera.position);
    const mu = this.moon.material.uniforms;
    mu.uPhase.value = moon.illumination;
    mu.uWaxing.value = moon.waxing ? 1 : -1;
    mu.uBright.value = (0.25 + 0.75 * night) * (1 - 0.9 * this.cloudCover);
    this.moon.visible = moon.elevation > -2;

    // Shadow box follows the focus point (the drone).
    const shadowSize = this.shadowSize || 90;
    const cam = this.key.shadow.camera;
    if (cam.right !== shadowSize) {
      Object.assign(cam, { left: -shadowSize, right: shadowSize, top: shadowSize, bottom: -shadowSize, near: 1, far: 900 });
      cam.updateProjectionMatrix();
    }
    this.key.position.copy(focus).addScaledVector(this.keyDir, 400);
    this.key.target.position.copy(focus);
    // Kept on day and night: switching it would recompile every shader at dusk.
    this.key.castShadow = this.shadowsOn !== false;

    this.maybeUpdateEnvironment(sun, weather);
    return { sun, moon, night, day, exposure: this.exposure };
  }

  maybeUpdateEnvironment(sun, weather) {
    const l = this.lastEnv;
    const now = performance.now();
    const changed = Math.abs(sun.elevation - l.el) > 0.8 || Math.abs(sun.azimuth - l.az) > 2 || Math.abs(this.cloudCover - l.cover) > 0.04;
    if (!changed || now - l.t < 400) return;
    Object.assign(l, { el: sun.elevation, az: sun.azimuth, cover: this.cloudCover, t: now });
    const prevTone = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    this.renderer.toneMapping = prevTone;
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
  }
}
