// world.js — everything built on the terrain: lake, airfield, buildings,
// windsock, lights and the gate course.
//
// Does: builds the runway (scanned asphalt with painted markings and edge
// lights), the take-off pad, the concrete apron, a corrugated-metal hangar
// with a curved roof, farm houses and barns (plaster or brick walls, tiled
// or metal gable roofs, windows that light up at night), a windsock that
// shows the wind at the airfield, the lake (water.js) and the gate course
// with lap timing. Hard surfaces darken and shine when wet and turn white
// under snow. Keeps collision boxes for the buildings; trees collide
// through forest.js.
// Does NOT: simulate physics itself; main.js asks collide() and passes the
// answer to the flight model.
//
// The windsock follows the usual airfield standard: fully extended at
// 15 knots (7.7 m/s), five stripes of 3 knots each (FAA AC 150/5345-27).

import * as THREE from 'three';
import {
  WATER_LEVEL, LAKE, RUNWAY, PAD, HANGAR, APRON, HOUSES, WINDSOCK,
} from './layout.js';
import { env, linkEnv } from './shaders.js';
import { makeLake } from './water.js';
import { palette } from './palette.js';

const KNOTS = 0.514444;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// UVs in metres on a box, so textures keep their real size on every face.
function metreUVs(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    if (ny > 0.5) uv.setXY(i, pos.getX(i), pos.getZ(i));
    else if (nx > 0.5) uv.setXY(i, pos.getZ(i), pos.getY(i));
    else uv.setXY(i, pos.getX(i), pos.getY(i));
  }
  uv.needsUpdate = true;
  return geo;
}

// Wet surfaces get darker and glossier; upward faces go white under snow.
function weatherproof(material, porosity = 0.6) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    prev?.(shader, r);
    linkEnv(shader, ['uWetness', 'uSnow']);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUpW;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvUpW = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWetness;\nuniform float uSnow;\nvarying vec3 vUpW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= mix(1.0, 0.6, uWetness * ${porosity.toFixed(2)});
float dwSnowHere = uSnow * smoothstep(0.55, 0.9, vUpW.y);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.87, 0.9), dwSnowHere);`)
      // After the roughness and metalness maps (which textures.js may rewrite), before the normals.
      .replace('#include <normal_fragment_begin>', `roughnessFactor = mix(roughnessFactor, 0.12, uWetness * 0.85 * (1.0 - dwSnowHere));
roughnessFactor = mix(roughnessFactor, 0.8, dwSnowHere);
#include <normal_fragment_begin>`);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|wet${porosity}`;
  return material;
}

function runwayMarkings() {
  const W = 2048;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const px = W / RUNWAY.length; // pixels per metre along
  const pz = H / RUNWAY.width;
  g.fillStyle = '#f2f2ee';
  // Edge lines.
  g.fillRect(0, 0.3 * pz, W, 0.45 * pz);
  g.fillRect(0, H - 0.75 * pz, W, 0.45 * pz);
  // Threshold stripes at both ends.
  for (const end of [0, 1]) {
    const x0 = end === 0 ? 2 * px : W - 2 * px - 12 * px;
    for (let k = 0; k < 8; k++) {
      const z = (1.6 + k * 1.95) * pz;
      g.fillRect(x0, z, 12 * px, 1.1 * pz);
    }
  }
  // Centre line dashes.
  for (let x = 26; x < RUNWAY.length - 26; x += 18) g.fillRect(x * px, H / 2 - 0.25 * pz, 10 * px, 0.5 * pz);
  // Runway numbers: 09 at the west end (heading east), 27 at the east end.
  g.font = `bold ${6.5 * pz}px Arial, Helvetica, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(19 * px, H / 2);
  g.rotate(Math.PI / 2);
  g.scale(1, px / pz * 1.1);
  g.fillText('09', 0, 0);
  g.restore();
  g.save();
  g.translate(W - 19 * px, H / 2);
  g.rotate(-Math.PI / 2);
  g.scale(1, px / pz * 1.1);
  g.fillText('27', 0, 0);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function padMarking() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.strokeStyle = '#f0c419';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(128, 128, 108, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f2f2ee';
  // H with its legs along the runway (east-west) so it reads from the approach.
  g.fillRect(64, 78, 128, 22);
  g.fillRect(64, 156, 128, 22);
  g.fillRect(117, 78, 22, 100);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sockTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const g = c.getContext('2d');
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i % 2 === 0 ? '#ff5a14' : '#f4f4f0';
    g.fillRect((i * 256) / 5, 0, 256 / 5 + 1, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class World {
  constructor(scene, terrain, textures, forest, style = 'toon') {
    this.pal = palette(style);
    this.scene = scene;
    this.terrain = terrain;
    this.tx = textures;
    this.forest = forest;
    this.boxes = [];
    this.gates = [];
    this.nightMaterials = [];
    this.lights = [];
    this.lake = makeLake(terrain, style);
    scene.add(this.lake);
    this.addAirfield();
    this.addHangar();
    this.addHouses();
    this.addWindsock();
    this.addGates();
  }

  // A surface: the scanned material, or in the stylized and dark styles one plain colour.
  surface(slot) {
    if (!this.pal) return this.tx.material(slot);
    const colors = this.pal.surfaces;
    return new THREE.MeshStandardMaterial({ color: colors[slot] ?? colors.plaster, roughness: slot === 'metal' ? 0.55 : 0.88, metalness: slot === 'metal' ? 0.15 : 0 });
  }

  // Wind field description of the buildings (for wakes).
  get windObstacles() {
    return [
      { x: HANGAR.x, z: HANGAR.z, hw: HANGAR.w / 2, hd: HANGAR.d / 2, h: HANGAR.h },
      ...HOUSES.map((b) => ({ x: b.x, z: b.z, hw: b.w / 2, hd: b.d / 2, h: b.h + 2.5 })),
    ];
  }

  addAirfield() {
    const y0 = this.terrain.heightAt(RUNWAY.x, RUNWAY.z) + 0.04;
    const asphalt = weatherproof(this.surface('asphalt'), 0.35);
    const strip = new THREE.Mesh(metreUVs(new THREE.BoxGeometry(RUNWAY.length, 0.08, RUNWAY.width)), asphalt);
    strip.position.set(RUNWAY.x, y0 - 0.03, RUNWAY.z);
    strip.receiveShadow = true;
    this.scene.add(strip);
    const marks = new THREE.Mesh(
      new THREE.PlaneGeometry(RUNWAY.length, RUNWAY.width).rotateX(-Math.PI / 2),
      weatherproof(new THREE.MeshStandardMaterial({ map: runwayMarkings(), transparent: true, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2 }), 0.2),
    );
    marks.position.set(RUNWAY.x, y0 + 0.015, RUNWAY.z);
    marks.receiveShadow = true;
    this.scene.add(marks);

    const concrete = weatherproof(this.surface('concrete'), 0.3);
    const apron = new THREE.Mesh(metreUVs(new THREE.BoxGeometry(APRON.w, 0.1, APRON.d)), concrete);
    apron.position.set(APRON.x, this.terrain.heightAt(APRON.x, APRON.z) + 0.02, APRON.z);
    apron.receiveShadow = true;
    this.scene.add(apron);

    const pad = new THREE.Mesh(metreUVs(new THREE.BoxGeometry(PAD.size, 0.12, PAD.size)), concrete);
    pad.position.set(PAD.x, y0 + 0.02, PAD.z);
    pad.receiveShadow = true;
    this.scene.add(pad);
    const h = new THREE.Mesh(
      new THREE.PlaneGeometry(PAD.size * 0.9, PAD.size * 0.9).rotateX(-Math.PI / 2),
      weatherproof(new THREE.MeshStandardMaterial({ map: padMarking(), transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }), 0.2),
    );
    h.position.set(PAD.x, y0 + 0.085, PAD.z);
    this.scene.add(h);

    // Edge lights every 15 m (white), threshold lights (green / red).
    const lightGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.35, 8);
    const white = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1d6, emissiveIntensity: 0 });
    const green = new THREE.MeshStandardMaterial({ color: 0x113311, emissive: 0x30ff70, emissiveIntensity: 0 });
    const spots = [];
    for (let x = -RUNWAY.length / 2; x <= RUNWAY.length / 2 + 0.1; x += 15) {
      for (const side of [-1, 1]) spots.push([x, side * (RUNWAY.width / 2 + 1)]);
    }
    const edge = new THREE.InstancedMesh(lightGeo, white, spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => edge.setMatrixAt(i, m.makeTranslation(RUNWAY.x + x, this.terrain.heightAt(x, z) + 0.17, RUNWAY.z + z)));
    const ends = [];
    for (let z = -RUNWAY.width / 2; z <= RUNWAY.width / 2; z += 3) ends.push([-RUNWAY.length / 2 - 1.5, z], [RUNWAY.length / 2 + 1.5, z]);
    const thr = new THREE.InstancedMesh(lightGeo, green, ends.length);
    ends.forEach(([x, z], i) => thr.setMatrixAt(i, m.makeTranslation(RUNWAY.x + x, this.terrain.heightAt(x, z) + 0.17, RUNWAY.z + z)));
    this.scene.add(edge, thr);
    this.nightMaterials.push({ mat: white, on: 3 }, { mat: green, on: 3 });
  }

  addHangar() {
    const { x, z, w, d, h } = HANGAR;
    const y = this.terrain.heightAt(x, z);
    const metal = weatherproof(this.surface('metal'), 0.1);
    const wallH = h * 0.45;
    const walls = new THREE.Mesh(metreUVs(new THREE.BoxGeometry(w, wallH, d)), metal);
    walls.position.set(x, y + wallH / 2, z);
    walls.castShadow = walls.receiveShadow = true;
    this.scene.add(walls);
    // Curved roof: half a cylinder along x.
    const roofGeo = new THREE.CylinderGeometry(d / 2, d / 2, w, 32, 1, true, 0, Math.PI);
    roofGeo.rotateZ(Math.PI / 2); // axis along x, the half facing up
    roofGeo.scale(1, (h - wallH) / (d / 2), 1);
    const roofUV = roofGeo.attributes.uv;
    for (let i = 0; i < roofUV.count; i++) roofUV.setXY(i, roofUV.getX(i) * Math.PI * d * 0.5, roofUV.getY(i) * w);
    const roof = new THREE.Mesh(roofGeo, metal);
    roof.position.set(x, y + wallH, z);
    roof.castShadow = roof.receiveShadow = true;
    this.scene.add(roof);
    // End walls of the roof (half discs) and the big door facing the apron (south, +z).
    const endGeo = new THREE.CircleGeometry(d / 2, 32, 0, Math.PI);
    endGeo.scale(1, (h - wallH) / (d / 2), 1);
    for (const side of [-1, 1]) {
      const e = new THREE.Mesh(endGeo, metal);
      e.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      e.position.set(x + (side * w) / 2, y + wallH, z);
      e.castShadow = true;
      this.scene.add(e);
    }
    const doorMat = weatherproof(new THREE.MeshStandardMaterial({ color: 0x5c6166, roughness: 0.55, metalness: 0.6 }), 0.1);
    const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, wallH * 0.92, 0.2), doorMat);
    door.position.set(x, y + (wallH * 0.92) / 2, z + d / 2 + 0.06);
    this.scene.add(door);
    this.boxes.push({ min: new THREE.Vector3(x - w / 2, y - 2, z - d / 2), max: new THREE.Vector3(x + w / 2, y + h, z + d / 2) });

    // Floodlight over the door for night flying.
    const lamp = new THREE.SpotLight(0xffe2b0, 0, 70, 0.9, 0.5, 1.6);
    lamp.position.set(x, y + wallH + 0.5, z + d / 2 + 0.6);
    lamp.target.position.set(x, y, z + d / 2 + 16);
    this.scene.add(lamp, lamp.target);
    this.lights.push({ light: lamp, on: 900 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xffe2b0, emissiveIntensity: 0 });
    const lampBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.4), lampMat);
    lampBox.position.copy(lamp.position);
    this.scene.add(lampBox);
    this.nightMaterials.push({ mat: lampMat, on: 8 });
  }

  addHouses() {
    const r = rng(42);
    const plaster = weatherproof(this.surface('plaster'), 0.5);
    const brick = weatherproof(this.surface('brick'), 0.5);
    const tiles = weatherproof(this.surface('roof'), 0.3);
    const metalRoof = weatherproof(this.surface('metal'), 0.1);
    const wood = weatherproof(this.surface('wood'), 0.6);
    const glassDark = new THREE.MeshStandardMaterial({ color: 0x1b2328, roughness: 0.08, metalness: 0.1 });
    const glassLit = new THREE.MeshStandardMaterial({ color: 0x1b2328, roughness: 0.08, metalness: 0.1, emissive: 0xffc27a, emissiveIntensity: 0 });
    this.nightMaterials.push({ mat: glassLit, on: 2.2 });

    for (const b of HOUSES) {
      const y = this.terrain.heightAt(b.x, b.z);
      const wallMat = b.barn ? wood : (r() > 0.4 ? plaster : brick);
      const walls = new THREE.Mesh(metreUVs(new THREE.BoxGeometry(b.w, b.h, b.d)), wallMat);
      walls.position.set(b.x, y + b.h / 2 - 0.3, b.z);
      walls.castShadow = walls.receiveShadow = true;
      this.scene.add(walls);
      // Gable roof along x, with 0.4 m overhang and gable triangles.
      const pitch = b.barn ? 0.45 : 0.75; // rise per half-width
      const roofH = (b.d / 2) * pitch;
      const roof = new THREE.Mesh(gableRoof(b.w + 0.8, b.d + 0.8, roofH), b.roof === 'metal' ? metalRoof : tiles);
      roof.position.set(b.x, y + b.h - 0.3, b.z);
      roof.castShadow = roof.receiveShadow = true;
      this.scene.add(roof);
      const gable = new THREE.Mesh(gableEnds(b.w, b.d, roofH), wallMat);
      gable.position.copy(roof.position);
      gable.castShadow = true;
      this.scene.add(gable);
      if (!b.barn) {
        const chimney = new THREE.Mesh(metreUVs(new THREE.BoxGeometry(0.6, roofH + 1.2, 0.6)), brick);
        chimney.position.set(b.x + b.w * 0.25, y + b.h - 0.3 + (roofH + 1.2) / 2, b.z - b.d * 0.15);
        chimney.castShadow = true;
        this.scene.add(chimney);
      }
      // Windows on the long walls, some lit at night; a door on the south side.
      const winGeo = new THREE.PlaneGeometry(1.1, 1.3);
      const count = b.barn ? 2 : Math.max(2, Math.floor(b.w / 3));
      for (const side of [-1, 1]) {
        for (let i = 0; i < count; i++) {
          const wx = b.x - b.w / 2 + ((i + 0.5) * b.w) / count;
          const win = new THREE.Mesh(winGeo, !b.barn && r() > 0.45 ? glassLit : glassDark);
          win.position.set(wx, y + (b.barn ? b.h * 0.6 : 1.7), b.z + side * (b.d / 2 + 0.02));
          if (side < 0) win.rotation.y = Math.PI;
          this.scene.add(win);
        }
      }
      const door = new THREE.Mesh(new THREE.PlaneGeometry(b.barn ? 3.2 : 1.0, b.barn ? 3.4 : 2.1), wood);
      door.position.set(b.x - b.w * 0.2, y + (b.barn ? 1.4 : 0.75), b.z + b.d / 2 + 0.03);
      this.scene.add(door);
      this.boxes.push({
        min: new THREE.Vector3(b.x - b.w / 2 - 0.4, y - 2, b.z - b.d / 2 - 0.4),
        max: new THREE.Vector3(b.x + b.w / 2 + 0.4, y + b.h - 0.3 + roofH * 0.8, b.z + b.d / 2 + 0.4),
      });
    }
    // A yard light by the first farm.
    const yard = new THREE.PointLight(0xffd7a0, 0, 45, 1.8);
    yard.position.set(HOUSES[0].x + 8, this.terrain.heightAt(HOUSES[0].x, HOUSES[0].z) + 5, HOUSES[0].z + 7);
    this.scene.add(yard);
    this.lights.push({ light: yard, on: 400 });
  }

  addWindsock() {
    const { x, z } = WINDSOCK;
    const y = this.terrain.heightAt(x, z);
    const poleH = 6;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, poleH, 8), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.4, metalness: 0.7 }));
    pole.position.set(x, y + poleH / 2, z);
    pole.castShadow = true;
    this.scene.add(pole);
    // Sock: an open cone 3.6 m long, 0.9 m mouth at the pole, tail along +x.
    const len = 3.6;
    const geo = new THREE.CylinderGeometry(0.22, 0.45, len, 20, 6, true);
    geo.rotateZ(-Math.PI / 2);
    geo.translate(len / 2, 0, 0);
    const uv = geo.attributes.uv;
    const p = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / len, uv.getX(i));
    this.sockBase = new Float32Array(p.array);
    const sock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: sockTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
    sock.castShadow = true;
    this.sockPivot = new THREE.Group();
    this.sockPivot.position.set(x, y + poleH - 0.3, z);
    this.sockPivot.add(sock);
    this.sock = sock;
    this.scene.add(this.sockPivot);
    this.sockAngle = 0;
    this.sockDroop = 1.2;
    this.boxes.push({ min: new THREE.Vector3(x - 0.2, y - 1, z - 0.2), max: new THREE.Vector3(x + 0.2, y + poleH, z + 0.2) });
  }

  addGates() {
    const points = [
      [40, 0, 6], [120, -40, 9], [150, -120, 12], [60, -170, 8], [-40, -130, 14],
      [-120, -60, 7], [-130, 40, 10], [-60, 100, 6], [30, 80, 9],
    ];
    const ringGeo = new THREE.TorusGeometry(2.6, 0.16, 12, 48);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.5 });
    points.forEach(([x, z, alt], i) => {
      const next = points[(i + 1) % points.length];
      const prev = points[(i + points.length - 1) % points.length];
      const dir = new THREE.Vector3(next[0] - prev[0], 0, next[1] - prev[1]).normalize();
      const ground = this.terrain.heightAt(x, z);
      const center = new THREE.Vector3(x, ground + alt, z);
      const mat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 0.15, roughness: 0.45 });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.position.copy(center);
      ring.lookAt(center.clone().add(dir));
      ring.castShadow = true;
      this.scene.add(ring);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, alt - 2.6, 6), poleMat);
      pole.position.set(x, ground + (alt - 2.6) / 2, z);
      pole.castShadow = true;
      this.scene.add(pole);
      this.gates.push({ center, dir, radius: 2.6, mesh: ring });
    });
    this.resetCourse();
  }

  resetCourse() {
    this.nextGate = 0;
    this.lapStart = null;
    this.lastLap = null;
    this.bestLap = this.bestLap ?? null;
    this.gates.forEach((g, i) => this.paintGate(g, i === 0));
  }

  paintGate(g, active) {
    g.mesh.material.color.set(active ? 0x35e06b : 0xff5a1f);
    g.mesh.material.emissive.set(active ? 0x35e06b : 0xff5a1f);
  }

  // Call every frame with the drone's previous and current position (three).
  updateCourse(prev, cur, time) {
    const g = this.gates[this.nextGate];
    const a = prev.clone().sub(g.center).dot(g.dir);
    const b = cur.clone().sub(g.center).dot(g.dir);
    if (a < 0 && b >= 0) {
      const t = a / (a - b);
      const hit = prev.clone().lerp(cur, t);
      if (hit.distanceTo(g.center) < g.radius) {
        this.paintGate(g, false);
        if (this.nextGate === 0) {
          if (this.lapStart !== null) {
            this.lastLap = time - this.lapStart;
            this.bestLap = this.bestLap === null ? this.lastLap : Math.min(this.bestLap, this.lastLap);
          }
          this.lapStart = time;
        }
        this.nextGate = (this.nextGate + 1) % this.gates.length;
        this.paintGate(this.gates[this.nextGate], true);
        return true;
      }
    }
    return false;
  }

  /** Per frame: night lights and the windsock. wind = wind.sample() at the sock. */
  update(dt, night, wind, time) {
    for (const n of this.nightMaterials) n.mat.emissiveIntensity = n.on * night;
    for (const l of this.lights) l.light.intensity = l.on * night;
    for (const g of this.gates) g.mesh.material.emissiveIntensity = 0.15 + 1.2 * night;

    // Windsock: points downwind, lifts with speed (full at 15 knots), flutters.
    const speed = Math.hypot(wind.x, wind.z);
    if (speed > 0.2) {
      const target = Math.atan2(-wind.z, wind.x);
      let d = target - this.sockAngle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.sockAngle += d * (1 - Math.exp(-dt * 2.5));
    }
    const lift = Math.min(1, speed / (15 * KNOTS));
    const droopTarget = (1 - Math.pow(lift, 0.8)) * 1.35;
    this.sockDroop += (droopTarget - this.sockDroop) * (1 - Math.exp(-dt * 3));
    this.sockPivot.rotation.set(0, this.sockAngle, 0);
    // Bend each ring down by the droop, more toward the tail; ripple in the wind.
    const p = this.sock.geometry.attributes.position;
    const base = this.sockBase;
    for (let i = 0; i < p.count; i++) {
      const bx = base[i * 3];
      const by = base[i * 3 + 1];
      const bz = base[i * 3 + 2];
      const f = bx / 3.6;
      const a = -this.sockDroop * (0.35 + 0.65 * f);
      const flap = Math.sin(time * (6 + speed) - f * 7) * 0.15 * lift * f;
      p.setXYZ(i, bx * Math.cos(a) - by * Math.sin(a), bx * Math.sin(a) + by * Math.cos(a), bz + flap);
    }
    p.needsUpdate = true;
    this.sock.geometry.computeVertexNormals();
  }

  // Collision against trees, buildings and the lake. Returns null or { point, normal, kind }.
  collide(pos, radius) {
    const tree = this.forest ? this.forest.collide(pos, radius) : null;
    if (tree) return tree;
    for (const b of this.boxes) {
      if (pos.x < b.min.x - radius || pos.x > b.max.x + radius) continue;
      if (pos.y < b.min.y - radius || pos.y > b.max.y + radius) continue;
      if (pos.z < b.min.z - radius || pos.z > b.max.z + radius) continue;
      const pens = [
        { d: pos.x - (b.min.x - radius), n: new THREE.Vector3(-1, 0, 0) },
        { d: b.max.x + radius - pos.x, n: new THREE.Vector3(1, 0, 0) },
        { d: b.max.y + radius - pos.y, n: new THREE.Vector3(0, 1, 0) },
        { d: pos.z - (b.min.z - radius), n: new THREE.Vector3(0, 0, -1) },
        { d: b.max.z + radius - pos.z, n: new THREE.Vector3(0, 0, 1) },
      ];
      pens.sort((p1, p2) => p1.d - p2.d);
      const best = pens[0];
      return { point: pos.clone().addScaledVector(best.n, best.d), normal: best.n, kind: 'building' };
    }
    if (Math.hypot(pos.x - LAKE.x, pos.z - LAKE.z) < LAKE.r * 1.2 && pos.y < WATER_LEVEL + radius &&
        this.terrain.heightAt(pos.x, pos.z) < WATER_LEVEL) {
      return { point: pos.clone(), normal: new THREE.Vector3(0, 1, 0), kind: 'water' };
    }
    return null;
  }
}

// Two roof planes over a w x d footprint (ridge along x), UVs in metres.
function gableRoof(w, d, rise) {
  const hw = w / 2;
  const hd = d / 2;
  const slope = Math.hypot(hd, rise);
  const pos = [
    -hw, 0, hd, hw, 0, hd, hw, rise, 0, -hw, rise, 0, // south plane
    hw, 0, -hd, -hw, 0, -hd, -hw, rise, 0, hw, rise, 0, // north plane
  ];
  const uv = [0, 0, w, 0, w, slope, 0, slope, 0, 0, w, 0, w, slope, 0, slope];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  g.computeVertexNormals();
  return g;
}

// The two triangular wall ends under a gable roof.
function gableEnds(w, d, rise) {
  const hw = w / 2;
  const hd = d / 2;
  const pos = [hw, 0, hd, hw, 0, -hd, hw, rise, 0, -hw, 0, -hd, -hw, 0, hd, -hw, rise, 0];
  const uv = [hd, 0, -hd, 0, 0, rise, -hd, 0, hd, 0, 0, rise];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  g.computeVertexNormals();
  return g;
}
