// main.js — Drone World in the browser.
//
// Does: sets up the three.js scene (sky, sun, terrain, world), runs the
// flight model every frame with the current sticks, resolves collisions with
// the ground, trees, buildings and the lake, moves the cameras, drives the
// HUD, the gate course and the settings.
// Does NOT: compute flight physics (flight.js does) or read devices
// (controls.js does).

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Terrain, WORLD_SIZE } from './terrain.js';
import { World } from './world.js';
import { DroneMesh } from './drone-mesh.js';
import { Controls } from './controls.js';
import {
  FlightModel, Mode, MODES, Vec3, cameraDronePreset, fpv5InchPreset,
  toThreePosition, toThreeQuaternion, fromThreePosition,
} from './flight.js';

const PRESETS = {
  camera: { make: cameraDronePreset, size: 0.35, mode: Mode.HOLD, fpvTiltDeg: 0 },
  fpv: { make: fpv5InchPreset, size: 0.25, mode: Mode.ANGLE, fpvTiltDeg: 25 },
};
const START = new THREE.Vector3(-60, 0, 0); // the take-off pad
const PILOT = new THREE.Vector3(-66, 0, 6); // where the ground-view pilot stands
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// --- renderer, scene, camera -------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 6000);

// --- sky and light -----------------------------------------------------------
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 36), THREE.MathUtils.degToRad(145));
function makeSky() {
  const sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  u.turbidity.value = 5.5;
  u.rayleigh.value = 1.4;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(sunDir);
  return sky;
}
scene.add(makeSky());
{
  const envScene = new THREE.Scene();
  envScene.add(makeSky());
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene).texture;
}
scene.fog = new THREE.Fog(0xc4d2dc, 300, 2200);
scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x4a5a32, 0.55));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 600 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// --- world -------------------------------------------------------------------
const terrain = new Terrain(7);
scene.add(terrain.buildMesh());
const world = new World(scene, terrain);
const drone = new DroneMesh();
scene.add(drone.root);

// Drone shadow blob so height is readable even with shadows off.
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(0.3, 24),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
);
blob.rotation.x = -Math.PI / 2;
scene.add(blob);

// --- flight state ------------------------------------------------------------
const controls = new Controls(document.getElementById('touch'));
const model = new FlightModel();
let presetKey = 'camera';
let camMode = 'chase';
let paused = true;
const origin = new THREE.Vector3();
const dronePos = new THREE.Vector3();
const prevPos = new THREE.Vector3();
const droneQuat = new THREE.Quaternion();
const camPos = new THREE.Vector3();
let windSpeed = 0;
let windFrom = 270;
let simTime = 0;

function radius() {
  return PRESETS[presetKey].size * 0.45;
}

function resetFlight() {
  origin.set(START.x, terrain.heightAt(START.x, START.z) + radius(), START.z);
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
  drone.build(p.size);
  document.getElementById('model-info').textContent = 'Changes only the look. The flight physics stays the chosen preset.';
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

function setWind() {
  const toward = THREE.MathUtils.degToRad(windFrom + 180);
  const v3 = new THREE.Vector3(Math.sin(toward), 0, -Math.cos(toward)).multiplyScalar(windSpeed);
  model.setWind(fromThreePosition(v3.x, v3.y, v3.z));
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
    camera.position.copy(dronePos).add(new THREE.Vector3(PRESETS[presetKey].size * 0.32, 0.01, 0).applyQuaternion(droneQuat));
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
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmp.copy(dronePos).addScaledVector(fwd, 2));
    camera.fov = 70;
  }
  camera.updateProjectionMatrix();
}

// --- HUD -----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let msgTimer = null;
function show(text, ms = 3500) {
  const el = $('msg');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.hidden = true; }, ms);
}
const fmtTime = (s) => (s === null || s === undefined ? '—' : `${s.toFixed(2)} s`);
let hudClock = 0;
function updateHud(dt) {
  hudClock += dt;
  if (hudClock < 0.1) return;
  hudClock = 0;
  const s = model.state;
  $('hud-drone').textContent = model.p.name;
  $('hud-mode').textContent = model.mode;
  $('hud-speed').textContent = `${(s.velocity.length() * 3.6).toFixed(0)} km/h`;
  $('hud-agl').textContent = `${(dronePos.y - terrain.heightAt(dronePos.x, dronePos.z) - radius()).toFixed(1)} m`;
  $('hud-home').textContent = `${Math.hypot(dronePos.x - START.x, dronePos.z - START.z).toFixed(0)} m`;
  $('hud-thr').style.width = `${(s.thrustFraction * 100).toFixed(0)}%`;
  $('hud-wind').textContent = windSpeed > 0 ? `${windSpeed.toFixed(1)} m/s from ${COMPASS[Math.round(windFrom / 45) % 8]}` : 'calm';
  $('hud-input').textContent = controls.source;
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

function wireUi() {
  $('btn-start').addEventListener('click', closeSheets);
  $('btn-close').addEventListener('click', closeSheets);
  $('btn-settings').addEventListener('click', () => openSheet('settings'));
  $('btn-help').addEventListener('click', () => openSheet('help'));
  $('preset-camera').addEventListener('click', () => applyPreset('camera'));
  $('preset-fpv').addEventListener('click', () => applyPreset('fpv'));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('wind-speed').addEventListener('input', (e) => {
    windSpeed = Number(e.target.value);
    $('wind-speed-out').textContent = `${windSpeed} m/s`;
    setWind();
  });
  $('wind-dir').addEventListener('input', (e) => {
    windFrom = Number(e.target.value);
    $('wind-dir-out').textContent = COMPASS[Math.round(windFrom / 45) % 8];
    setWind();
  });
  $('opt-shadows').addEventListener('change', (e) => {
    sun.castShadow = e.target.checked;
  });
  $('opt-hires').addEventListener('change', () => resize());
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
}

function resize() {
  const hi = $('opt-hires').checked;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? 1.5 : 0.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// --- main loop -----------------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
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
  drone.update(dt, model.state.thrustFraction);
  const ground = terrain.heightAt(dronePos.x, dronePos.z);
  blob.position.set(dronePos.x, ground + 0.05, dronePos.z);
  blob.material.opacity = THREE.MathUtils.clamp(0.4 - (dronePos.y - ground) * 0.02, 0, 0.4);
  sun.position.copy(dronePos).addScaledVector(sunDir, 250);
  sun.target.position.copy(dronePos);
  updateCamera(dt);
  updateHud(dt);
  updateRadioPanel();
  renderer.render(scene, camera);
}

wireUi();
resize();
applyPreset('camera');
setWind();
frame();

// For tests and for people poking at the sandbox from the console.
window.droneWorld = {
  ready: true,
  model,
  terrain,
  world,
  get position() { return dronePos.clone(); },
  start: closeSheets,
  setMode,
  applyPreset,
};
