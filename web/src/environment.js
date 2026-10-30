// environment.js — time, weather, wind and light, kept in step every frame.
//
// Does: holds the date and Polish clock time (time can stand still or run
// faster), the weather and temperature, and the wind settings; each frame
// it advances them, moves the sun and moon (sky.js), updates the weather
// (weather.js), samples the wind field (wind.js) for the drone and the
// windsock, sets fog and exposure, and feeds the shared shader uniforms so
// grass, trees, water and ground all move and look the same. In the
// Cinematic style the haze is drawn by post.js instead of the materials'
// fog; this file works out its density and height from the weather.
// Does NOT: run the flight model; main.js asks windAt() and passes it on.

import * as THREE from 'three';
import { SkySystem } from './sky.js';
import { Weather, PRESETS } from './weather.js';
import { WindField, GUSTINESS, SHADER_MODES } from './wind.js';
import { polandClockToUtc } from './solar.js';
import { env } from './shaders.js';
import { WINDSOCK, WATER_LEVEL } from './layout.js';

export class Environment {
  constructor({ renderer, scene, terrain, forest, world, quality, style = 'realistic' }) {
    this.renderer = renderer;
    this.cinematic = style === 'realistic';
    this.exposureScale = 1;
    this.atmosphere = { density: 0, scaleHeight: 1000, base: WATER_LEVEL };
    this.scene = scene;
    this.terrain = terrain;
    this.world = world;
    this.sky = new SkySystem(renderer, scene, style);
    this.sky.shadowSize = quality.shadowSize;
    this.sky.key.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    this.weather = new Weather(scene, quality);
    this.wind = new WindField({
      groundHeight: (x, z) => terrain.heightAt(x, z),
      canopyHeight: (x, z) => forest.canopyHeightAt(x, z),
      buildings: world.windObstacles,
    }, 7);
    const now = new Date();
    this.date = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
    this.hours = 11.0;
    this.timeScale = 0; // 0 = time stands still, 1 = real time, 60 = a minute per second
    this.windSpeed = 3;
    this.windFrom = 270;
    this.gustKey = 'normal';
    this.time = 0;
    scene.fog = new THREE.FogExp2(0xb8c6d4, 0.0003);
    this.fogColor = new THREE.Color();
  }

  setTime(hours) { this.hours = ((hours % 24) + 24) % 24; }
  setDate(y, m, d) { this.date = { y, m, d }; }
  setTimeScale(s) { this.timeScale = s; }
  setWeather(key) { this.weather.set(key); }
  setTemperature(c) { this.weather.temperature = c; }
  setWind(speed, fromDeg, gustKey) {
    this.windSpeed = speed;
    this.windFrom = fromDeg;
    this.gustKey = gustKey;
  }

  get utc() {
    return polandClockToUtc(this.date.y, this.date.m, this.date.d, this.hours);
  }

  get clock() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  get weatherLabel() {
    const w = PRESETS[this.weather.preset].label;
    const p = this.weather.cur.precip > 0.15 ? this.weather.precipType : null;
    return p && p !== 'rain' && this.weather.preset !== 'snow' ? `${w} (${p})` : w;
  }

  /** Apply the wind settings (made gustier by stormy weather) and move the gusts on. */
  updateWind(dt) {
    this.wind.configure({ speed10: this.windSpeed, fromDeg: this.windFrom, gustiness: GUSTINESS[this.gustKey] * this.weather.cur.gust });
    this.wind.advance(dt);
  }

  /** Wind (m/s, three.js axes) at a world position. */
  windAt(p) {
    return this.wind.sample(p.x, p.y, p.z);
  }

  update(dt, camera, focus) {
    this.time += dt;
    // Clock.
    this.hours += (dt * this.timeScale) / 3600;
    if (this.hours >= 24) {
      this.hours -= 24;
      const next = new Date(Date.UTC(this.date.y, this.date.m, this.date.d + 1));
      this.date = { y: next.getUTCFullYear(), m: next.getUTCMonth(), d: next.getUTCDate() };
    }

    this.updateWind(dt);
    const near = this.wind.sample(camera.position.x, camera.position.y, camera.position.z);

    // Weather, then sky and light.
    const w = this.weather;
    const lightPrev = this.light;
    w.update(dt, camera, near, env.uAmbient.value.clone().multiplyScalar(0.3).addScalar(0.02), lightPrev ? lightPrev.day : 1);
    const cur = w.cur;
    this.sky.lightning = w.lightning;
    this.light = this.sky.update(this.utc, {
      cloudCover: cur.cloudCover,
      cloudDark: cur.cloudDark,
      turbidity: cur.turbidity,
      haze: THREE.MathUtils.clamp(0.45 + cur.fog * 120, 0.45, 1),
      windX: this.wind.dirX * this.windSpeed * 1.6,
      windZ: this.wind.dirZ * this.windSpeed * 1.6,
    }, camera, focus, dt);
    this.renderer.toneMappingExposure = this.light.exposure * this.exposureScale;

    // Fog: the colour of the horizon sky, thicker in fog and rain.
    const sunTint = env.uSunColor.value.clone().multiplyScalar(0.04 * (1 - cur.cloudCover));
    this.fogColor.copy(env.uAmbient.value).multiplyScalar(0.34).add(sunTint);
    if (cur.cloudCover > 0.5) {
      const grey = (env.uAmbient.value.r + env.uAmbient.value.g + env.uAmbient.value.b) / 3 * 0.36;
      this.fogColor.lerp(new THREE.Color(grey, grey * 1.02, grey * 1.05), (cur.cloudCover - 0.5) * 2);
    }
    if (this.cinematic) {
      // The sky blends into a bright, bluish horizon; post.js draws the haze over the land.
      this.fogColor.copy(env.uAmbient.value).multiplyScalar(0.9).add(sunTint.multiplyScalar(4));
    }
    if (this.sky.stylized) {
      // Fog blends into the designed sky's horizon, greyer in thick weather.
      this.fogColor.copy(this.sky.horizonColor).lerp(new THREE.Color(0.2, 0.21, 0.22), Math.min(1, cur.fog * 150) * 0.5);
    }
    this.scene.fog.color.copy(this.fogColor);
    env.uFogColor.value.copy(this.fogColor);
    if (this.cinematic) {
      // Haze drawn in post.js: denser and lower in fog, a deep thin layer on clear days.
      this.scene.fog.density = 0;
      env.uFogDensity.value = 0;
      this.atmosphere.density = cur.fog * 0.85;
      this.atmosphere.scaleHeight = THREE.MathUtils.lerp(1200, 150, THREE.MathUtils.smoothstep(cur.fog, 0.0008, 0.006));
    } else {
      this.scene.fog.density = cur.fog;
      env.uFogDensity.value = cur.fog;
    }

    // Shared shader uniforms.
    env.uTime.value = this.time % 3600;
    env.uWindDir.value.set(this.wind.dirX, this.wind.dirZ);
    env.uWind10.value = this.windSpeed;
    const modes = this.wind.shaderModes();
    const t = this.wind.time;
    const s = this.wind.speed10;
    for (let i = 0; i < SHADER_MODES; i++) {
      const kx = modes.k[i * 2];
      const kz = modes.k[i * 2 + 1];
      env.uGustK.value[i].set(kx, kz);
      env.uGustAmp.value[i] = modes.amp[i];
      // Phase advanced on the CPU in double precision (gusts travel downwind).
      const ph = modes.phase[i] + modes.drift[i] * t - (kx * modes.dirX + kz * modes.dirZ) * s * t;
      env.uGustPhase.value[i] = ph % (Math.PI * 2);
    }
    env.uWetness.value = w.wetness;
    env.uSnow.value = w.snowCover;
    env.uRain.value = cur.precip * (w.precipType === 'rain' ? 1 : 0);

    // Windsock and night lights.
    const sockY = this.terrain.heightAt(WINDSOCK.x, WINDSOCK.z) + 5.7;
    this.world.update(dt, this.light.night, this.wind.sample(WINDSOCK.x, sockY, WINDSOCK.z), this.time);
    return this.light;
  }
}
