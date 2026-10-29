// main.js — Drone World in the browser.
//
// Does: loads the textures, builds the world (terrain, forest, grass, lake,
// airfield, farm), the sky, weather and wind, runs the flight model every
// frame with the current sticks and the wind at the drone, resolves
// collisions, moves the cameras, drives the HUD, the gate course and the
// settings, and renders through post-processing.
// Does NOT: compute flight physics (flight.js does), read devices
// (controls.js does) or decide the weather and light (environment.js does).

import * as THREE from 'three';
import { Terrain, WORLD_SIZE } from './terrain.js';
import { TextureLibrary } from './textures.js';
import { Forest } from './forest.js';
import { Grass } from './grass.js';
import { World } from './world.js';
import { LakeReflection } from './water.js';
import { Environment } from './environment.js';
import { PRESETS as WEATHER } from './weather.js';
import { DroneMesh } from './drone-mesh.js';
import { Controls } from './controls.js';
import { Post } from './post.js';
import { QUALITY, loadQualityKey, saveQualityKey } from './quality.js';
import { PAD } from './layout.js';
import {
  FlightModel, Mode, MODES, Vec3, cameraDronePreset, fpv5InchPreset,
  toThreePosition, toThreeQuaternion, fromThreePosition,
} from './flight.js';

// Diffuse light from the sky comes mostly from the hemisphere light; the
// reflection map adds only a share of it, so custom shaders (impostors,
// clouds) that use the hemisphere colours match the standard materials.
THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps.replace(
  'iblIrradiance += getIBLIrradiance( geometryNormal );',
  'iblIrradiance += 0.3 * getIBLIrradiance( geometryNormal );',
);

const PRESETS = {
  camera: { make: cameraDronePreset, size: 0.35, style: 'camera', mode: Mode.HOLD, fpvTiltDeg: 0 },
  fpv: { make: fpv5InchPreset, size: 0.25, style: 'fpv', mode: Mode.ANGLE, fpvTiltDeg: 25 },
};
const START = new THREE.Vector3(PAD.x, 0, PAD.z); // the take-off pad
const PILOT = new THREE.Vector3(PAD.x - 6, 0, PAD.z + 6); // where the ground-view pilot stands
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const $ = (id) => document.getElementById(id);

const qualityKey = loadQualityKey();
const quality = QUALITY[qualityKey];

// --- renderer, scene, camera -------------------------------------------------
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (err) {
  $('loading-text').textContent = 'This browser cannot start WebGL 2, which Drone World needs. Try a current Chrome, Edge, Firefox or Safari.';
  throw err;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false; // counted per frame in frame(), including shadows

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.08, 12000);
camera.layers.enable(1); // layer 1: grass and rain, left out of the lake reflection

function progress(fraction, text) {
  $('loading-bar').style.width = `${Math.round(fraction * 100)}%`;
  if (text) $('loading-text').textContent = text;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// --- state filled in by start() -------------------------------------------------
let terrain;
let forest;
let world;
let grass;
let envr;
let post;
let reflection = null;
const drone = new DroneMesh();
const controls = new Controls($('touch'));
const model = new FlightModel();
let presetKey = 'camera';
let camMode = 'chase';
let paused = true;
const origin = new THREE.Vector3();
const dronePos = new THREE.Vector3();
const prevPos = new THREE.Vector3();
const droneQuat = new THREE.Quaternion();
const camPos = new THREE.Vector3();
let simTime = 0;
let windAtDrone = { x: 0, y: 0, z: 0, speed: 0, mean: 0, gust: 0 };

function radius() {
  return PRESETS[presetKey].size * 0.45;
}

function resetFlight() {
  origin.set(START.x, terrain.heightAt(START.x, START.z) + 0.11 + radius(), START.z);
  model.reset(new Vec3(0, 0, 0), 0); // heading 0 = east, along the runway
  controls.resetKeyThrottle(-1);
  syncDrone();
  prevPos.copy(dronePos);
  camPos.copy(dronePos).add(new THREE.Vector3(-4, 1.6, 0));
  world.resetCourse();
  show(`${model.p.name} on the pad. ${modeHint()}`);
}

function applyPreset(key) {
  presetKey = key;
  const p = PRESETS[key];
  model.setParams(p.make());
  model.setMode(p.mode);
  drone.build(p.size, p.style);
  $('model-info').textContent = 'Changes only the look. The flight physics stays the chosen preset.';
  updateButtons();
  resetFlight();
}

function setMode(mode) {
  model.setMode(mode);
  if (mode !== Mode.HOLD && model.state.onGround) controls.resetKeyThrottle(-1);
  else controls.resetKeyThrottle(model.hoverStick());
  controls.touchKeepsThrottle = mode !== Mode.HOLD;
  updateButtons();
  show(`${mode} mode. ${modeHint()}`);
}

function modeHint() {
  if (model.mode === Mode.HOLD) return 'Hold W to climb; release the sticks and it hovers.';
  if (model.mode === Mode.ANGLE) return 'You hold the throttle: W/S set it, it stays where you leave it.';
  return 'Acro: sticks set rotation speed. Practise high up.';
}

function syncDrone() {
  const p = toThreePosition(model.state.position);
  dronePos.set(origin.x + p[0], origin.y + p[1], origin.z + p[2]);
  const q = toThreeQuaternion(model.state.attitude);
  droneQuat.set(q[0], q[1], q[2], q[3]);
  drone.root.position.copy(dronePos);
  drone.root.quaternion.copy(droneQuat);
}

// --- collisions ----------------------------------------------------------------
function resolveCollisions() {
  const r = radius();
  let hit = null;
  const ground = terrain.heightAt(dronePos.x, dronePos.z);
  if (dronePos.y < ground + r) {
    hit = { point: new THREE.Vector3(dronePos.x, ground + r, dronePos.z), normal: terrain.normalAt(dronePos.x, dronePos.z), kind: 'ground' };
  } else {
    hit = world.collide(dronePos, r);
  }
  const half = WORLD_SIZE / 2 - 2;
  if (!hit && (Math.abs(dronePos.x) > half || Math.abs(dronePos.z) > half)) {
    const n = Math.abs(dronePos.x) > half ? new THREE.Vector3(-Math.sign(dronePos.x), 0, 0) : new THREE.Vector3(0, 0, -Math.sign(dronePos.z));
    const p = dronePos.clone();
    p.x = Math.max(-half, Math.min(half, p.x));
    p.z = Math.max(-half, Math.min(half, p.z));
    hit = { point: p, normal: n, kind: 'edge' };
    show('Edge of the free 1 × 1 km area.');
  }
  if (!hit) return;
  const speedKmh = model.state.velocity.length() * 3.6;
  const wasCrashed = model.state.crashed;
  if (hit.kind === 'water') {
    model.state.crashed = true;
    model.state.velocity = new Vec3();
    model.state.bodyRates = new Vec3();
    if (!wasCrashed) show('Splash: the drone went into the lake. Press R.');
  } else {
    const local = hit.point.clone().sub(origin);
    model.contact(fromThreePosition(local.x, local.y, local.z), fromThreePosition(hit.normal.x, hit.normal.y, hit.normal.z));
    if (!wasCrashed && model.state.crashed) show(`Crash: hit the ${hit.kind} at ${speedKmh.toFixed(0)} km/h. Press R.`);
  }
  syncDrone();
}

// --- cameras -----------------------------------------------------------------
const tmp = new THREE.Vector3();
function updateCamera(dt) {
  if (camMode === 'fpv') {
    const tilt = THREE.MathUtils.degToRad(PRESETS[presetKey].fpvTiltDeg);
    const fwd = new THREE.Vector3(Math.cos(tilt), Math.sin(tilt), 0).applyQuaternion(droneQuat);
    const up = new THREE.Vector3(-Math.sin(tilt), Math.cos(tilt), 0).applyQuaternion(droneQuat);
    camera.position.copy(dronePos).add(new THREE.Vector3(PRESETS[presetKey].size * 0.34, 0.02, 0).applyQuaternion(droneQuat));
    camera.up.copy(up);
    camera.lookAt(tmp.copy(camera.position).add(fwd));
    camera.fov = 100;
  } else if (camMode === 'ground') {
    const ground = terrain.heightAt(PILOT.x, PILOT.z);
    camera.position.set(PILOT.x, ground + 1.7, PILOT.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(dronePos);
    camera.fov = THREE.MathUtils.clamp(70 - camera.position.distanceTo(dronePos) * 0.12, 18, 70);
  } else {
    const h = model.heading();
    const fwd = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
    const dist = presetKey === 'fpv' ? 1.6 : 2.2;
    const want = dronePos.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, 0.7, 0));
    camPos.lerp(want, 1 - Math.exp(-dt * 6));
    camPos.y = Math.max(camPos.y, terrain.heightAt(camPos.x, camPos.z) + 0.6);
    // Keep trunks, crowns and walls out from between the camera and the drone.
    for (let k = 0; k < 6 && world.collide(camPos, 0.25); k++) camPos.lerp(dronePos, 0.35);
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmp.copy(dronePos).addScaledVector(fwd, 2));
    camera.fov = 70;
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

// --- HUD -----------------------------------------------------------------------
let msgTimer = null;
function show(text, ms = 3500) {
  const el = $('msg');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.hidden = true; }, ms);
}
const fmtTime = (s) => (s === null || s === undefined ? '—' : `${s.toFixed(2)} s`);
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
let hudClock = 0;
let frames = 0;
let fps = 0;
function updateHud(dt) {
  hudClock += dt;
  frames++;
  if (hudClock < 0.25) return;
  fps = frames / hudClock;
  hudClock = 0;
  frames = 0;
  const s = model.state;
  $('hud-drone').textContent = model.p.name;
  $('hud-mode').textContent = model.mode;
  $('hud-speed').textContent = `${(s.velocity.length() * 3.6).toFixed(0)} km/h`;
  $('hud-agl').textContent = `${(dronePos.y - terrain.heightAt(dronePos.x, dronePos.z) - radius()).toFixed(1)} m`;
  $('hud-home').textContent = `${Math.hypot(dronePos.x - START.x, dronePos.z - START.z).toFixed(0)} m`;
  $('hud-thr').style.width = `${(s.thrustFraction * 100).toFixed(0)}%`;
  const ws = Math.hypot(windAtDrone.x, windAtDrone.z);
  // Bearing the air moves toward (clockwise from north = -z), turned around.
  const from = (Math.atan2(windAtDrone.x, -windAtDrone.z) * 180) / Math.PI + 180;
  $('hud-wind').textContent = ws < 0.3 ? 'calm' : `${ws.toFixed(1)} m/s from ${compass(from)}`;
  $('hud-input').textContent = controls.source;
  $('hud-time').textContent = `${envr.clock}${envr.timeScale ? ' ▸' : ''}`;
  $('hud-weather').textContent = `${envr.weatherLabel}, ${envr.weather.temperature.toFixed(0)} °C`;
  $('hud-fps').textContent = `${fps.toFixed(0)} fps · ${quality.label}`;
  $('hud-gate').textContent = `${world.nextGate + 1} / ${world.gates.length}`;
  $('hud-lap').textContent = world.lapStart === null ? '—' : fmtTime(simTime - world.lapStart);
  $('hud-last').textContent = fmtTime(world.lastLap);
  $('hud-best').textContent = fmtTime(world.bestLap);
}

// --- settings ------------------------------------------------------------------
function updateButtons() {
  $('preset-camera').setAttribute('aria-pressed', String(presetKey === 'camera'));
  $('preset-fpv').setAttribute('aria-pressed', String(presetKey === 'fpv'));
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === model.mode)));
}

function openSheet(id) {
  paused = true;
  $('help').hidden = id !== 'help';
  $('settings').hidden = id !== 'settings';
}
function closeSheets() {
  $('help').hidden = true;
  $('settings').hidden = true;
  paused = false;
  canvas.focus?.();
}

const STICKS = ['throttle', 'yaw', 'pitch', 'roll'];
function buildRadioTable() {
  const table = $('radio-table');
  STICKS.forEach((stick) => {
    const tr = document.createElement('tr');
    const inv = 'inv' + stick[0].toUpperCase() + stick.slice(1);
    tr.innerHTML = `<td>${stick[0].toUpperCase() + stick.slice(1)}</td>
      <td><select id="axis-${stick}" aria-label="${stick} axis">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<option value="${i}">Axis ${i + 1}</option>`).join('')}</select></td>
      <td><input type="checkbox" id="inv-${stick}" aria-label="Invert ${stick}"></td>
      <td><span class="live"><i id="live-${stick}"></i></span></td>
      <td><button type="button" class="btn" id="learn-${stick}">Learn</button></td>`;
    table.appendChild(tr);
    const sel = tr.querySelector('select');
    const chk = tr.querySelector('input');
    sel.value = String(controls.radio[stick]);
    chk.checked = controls.radio[inv];
    sel.addEventListener('change', () => { controls.radio[stick] = Number(sel.value); controls.saveRadio(); });
    chk.addEventListener('change', () => { controls.radio[inv] = chk.checked; controls.saveRadio(); });
    tr.querySelector('button').addEventListener('click', () => {
      controls.learn(stick);
      $('radio-status').textContent = `Move the ${stick} stick fully, end to end…`;
    });
  });
  controls.on('learned', () => {
    STICKS.forEach((s) => { $(`axis-${s}`).value = String(controls.radio[s]); });
    $('radio-status').textContent = 'Saved. Check the live bars, then fly.';
  });
}

function updateRadioPanel() {
  if ($('settings').hidden) return;
  const radio = controls.gamepads().find((p) => p.radio);
  if (!radio) return;
  if (!controls.learning) $('radio-status').textContent = `Connected: ${radio.pad.id}`;
  STICKS.forEach((stick) => {
    const inv = 'inv' + stick[0].toUpperCase() + stick.slice(1);
    let v = radio.pad.axes[controls.radio[stick]] ?? 0;
    if (controls.radio[inv]) v = -v;
    $(`live-${stick}`).style.left = `${50 + v * 48}%`;
  });
}

function fmtHours(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

function wireWorldSettings() {
  const d = envr.date;
  $('opt-date').value = `${d.y}-${String(d.m + 1).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  $('opt-time').value = String(envr.hours);
  $('opt-time-out').textContent = fmtHours(envr.hours);
  $('opt-time').addEventListener('input', (e) => {
    envr.setTime(Number(e.target.value));
    $('opt-time-out').textContent = fmtHours(envr.hours);
  });
  $('opt-date').addEventListener('change', (e) => {
    const [y, m, dd] = e.target.value.split('-').map(Number);
    if (y && m && dd) envr.setDate(y, m - 1, dd);
  });
  $('opt-timescale').addEventListener('change', (e) => envr.setTimeScale(Number(e.target.value)));
  const wsel = $('opt-weather');
  for (const [key, p] of Object.entries(WEATHER)) wsel.add(new Option(p.label, key));
  wsel.value = envr.weather.preset;
  wsel.addEventListener('change', () => {
    envr.setWeather(wsel.value);
    $('opt-temp').value = String(envr.weather.temperature);
    $('opt-temp-out').textContent = `${envr.weather.temperature} °C`;
  });
  $('opt-temp').value = String(envr.weather.temperature);
  $('opt-temp-out').textContent = `${envr.weather.temperature} °C`;
  $('opt-temp').addEventListener('input', (e) => {
    envr.setTemperature(Number(e.target.value));
    $('opt-temp-out').textContent = `${e.target.value} °C`;
  });
  const setWind = () => envr.setWind(Number($('wind-speed').value), Number($('wind-dir').value), $('wind-gust').value);
  $('wind-speed').value = String(envr.windSpeed);
  $('wind-speed-out').textContent = `${envr.windSpeed} m/s`;
  $('wind-speed').addEventListener('input', (e) => { $('wind-speed-out').textContent = `${e.target.value} m/s`; setWind(); });
  $('wind-dir').addEventListener('input', (e) => { $('wind-dir-out').textContent = compass(Number(e.target.value)); setWind(); });
  $('wind-gust').addEventListener('change', setWind);
  const qsel = $('opt-quality');
  for (const [key, q] of Object.entries(QUALITY)) qsel.add(new Option(q.label, key));
  qsel.value = qualityKey;
  qsel.addEventListener('change', () => {
    saveQualityKey(qsel.value);
    $('quality-note').textContent = 'Saved. Reload the page to apply.';
    $('btn-reload').hidden = false;
  });
  $('btn-reload').addEventListener('click', () => location.reload());
}

function wireUi() {
  $('btn-start').addEventListener('click', closeSheets);
  $('btn-close').addEventListener('click', closeSheets);
  $('btn-settings').addEventListener('click', () => openSheet('settings'));
  $('btn-help').addEventListener('click', () => openSheet('help'));
  $('preset-camera').addEventListener('click', () => applyPreset('camera'));
  $('preset-fpv').addEventListener('click', () => applyPreset('fpv'));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('opt-shadows').addEventListener('change', (e) => { envr.sky.shadowsOn = e.target.checked; });
  $('opt-light').addEventListener('change', (e) => drone.setHeadlight(e.target.checked));
  $('model-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const info = await drone.loadModel(await file.arrayBuffer());
      $('model-info').textContent = `${file.name}: ${info.triangles.toLocaleString()} triangles, scaled from ${info.originalSizeM.toFixed(2)} units to ${PRESETS[presetKey].size} m. Physics unchanged.`;
    } catch (err) {
      $('model-info').textContent = `Could not read ${file.name}: ${err.message || err}. Use a .glb file, or a .gltf with its textures embedded.`;
    }
  });
  $('model-rotate').addEventListener('click', () => drone.rotateQuarter());
  $('model-reset').addEventListener('click', () => applyPreset(presetKey));
  buildRadioTable();
  wireWorldSettings();

  controls.on('mode', () => setMode(MODES[(MODES.indexOf(model.mode) + 1) % MODES.length]));
  controls.on('camera', () => {
    camMode = { chase: 'fpv', fpv: 'ground', ground: 'chase' }[camMode];
    show({ chase: 'Chase camera', fpv: 'FPV camera', ground: 'Pilot view from the ground' }[camMode], 1500);
  });
  controls.on('reset', resetFlight);
  controls.on('preset', () => applyPreset(presetKey === 'camera' ? 'fpv' : 'camera'));
  controls.on('course', () => { world.resetCourse(); show('Gate course restarted. Fly through the green gate.'); });
  controls.on('settings', () => ($('settings').hidden ? openSheet('settings') : closeSheets()));
  controls.on('help', () => ($('help').hidden ? openSheet('help') : closeSheets()));
  controls.on('light', () => {
    drone.setHeadlight(!drone.headlightOn);
    $('opt-light').checked = drone.headlightOn;
    show(drone.headlightOn ? 'Headlight on' : 'Headlight off', 1200);
  });
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, quality.pixelRatio);
  renderer.setPixelRatio(ratio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  post?.setSize(window.innerWidth, window.innerHeight, ratio);
  reflection?.setSize(window.innerWidth * ratio, window.innerHeight * ratio);
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// --- main loop -----------------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  windAtDrone = envr.windAt(dronePos);
  model.setWind(fromThreePosition(windAtDrone.x, windAtDrone.y, windAtDrone.z));
  if (!paused) {
    const sticks = controls.poll(dt, model.mode === Mode.HOLD, model.hoverStick());
    prevPos.copy(dronePos);
    model.step(sticks, dt);
    simTime += dt;
    syncDrone();
    resolveCollisions();
    if (!model.state.crashed && world.updateCourse(prevPos, dronePos, simTime)) {
      const g = world.nextGate;
      show(g === 1 && world.lastLap !== null ? `Lap ${fmtTime(world.lastLap)}` : `Gate ${g === 0 ? world.gates.length : g} ✓`, 1200);
    }
  } else {
    controls.poll(0, true, 0); // keep gamepad buttons and radio learning live in menus
  }
  updateCamera(dt);
  const light = envr.update(dt, camera, dronePos);
  drone.update(dt, model.state.thrustFraction, light.night);
  forest.update(camera);
  grass.update(camera, terrain.heightAt(camera.position.x, camera.position.z));
  updateHud(dt);
  updateRadioPanel();
  renderer.info.reset();
  reflection?.render(renderer, scene, camera);
  post.render(dt);
}

async function start() {
  progress(0.02, 'Loading scanned ground, rock and building textures…');
  const textures = await new TextureLibrary(renderer).load(quality.groundTex, (f) => progress(0.02 + f * 0.3));
  await nextFrame();
  progress(0.34, 'Shaping the landscape…');
  await nextFrame();
  terrain = new Terrain(7);
  scene.add(terrain.buildMesh(textures));
  scene.add(terrain.buildFarMesh(textures));
  progress(0.48, 'Growing the forest…');
  await nextFrame();
  forest = new Forest(scene, terrain, textures, quality);
  await forest.build(renderer, (f) => progress(0.48 + f * 0.32, f < 0.6 ? 'Growing the forest…' : 'Planting and baking distant trees…'));
  progress(0.82, 'Building the airfield and the farm…');
  await nextFrame();
  world = new World(scene, terrain, textures, forest);
  grass = new Grass(terrain, textures, { count: quality.grass, patch: quality.grassPatch });
  grass.mesh.layers.set(1);
  scene.add(grass.mesh);
  envr = new Environment({ renderer, scene, terrain, forest, world, quality });
  envr.weather.particles.layers.set(1);
  if (quality.reflections) reflection = new LakeReflection(world.lake, 0.5);
  scene.add(drone.root);
  post = new Post(renderer, scene, camera, quality);
  wireUi();
  resize();
  applyPreset('camera');
  updateCamera(0.016);
  envr.update(0.016, camera, dronePos);
  forest.update(camera, true);
  await textures.settle();
  progress(0.95, 'Preparing shaders…');
  await nextFrame();
  renderer.compile(scene, camera);
  progress(1, 'Ready');
  $('loading').hidden = true;
  $('help').hidden = false;
  clock.getDelta();
  frame();

  // For tests and for people poking at the sandbox from the console.
  window.droneWorld = {
    ready: true,
    model,
    terrain,
    world,
    forest,
    env: envr,
    renderer,
    get position() { return dronePos.clone(); },
    start: closeSheets,
    setMode,
    applyPreset,
    setCamera(mode) { camMode = mode; },
    // Put the drone at (x, height above ground, z) facing heading (radians, 0 = east).
    teleport(x, h, z, heading = 0) {
      origin.set(x, terrain.heightAt(x, z) + h, z);
      model.reset(new Vec3(0, 0, 0), heading);
      model.state.onGround = false;
      syncDrone();
      camPos.copy(dronePos).add(new THREE.Vector3(-Math.cos(heading) * 2.2, 0.7, Math.sin(heading) * 2.2));
    },
    pause(on = true) { paused = on; },
    get stats() {
      const r = renderer.info.render;
      return { triangles: r.triangles, calls: r.calls, fps, trees: forest.counts };
    },
  };
}

start().catch((err) => {
  console.error(err);
  $('loading-text').textContent = `Could not start: ${err.message || err}`;
});
