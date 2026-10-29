// world.js — everything on the terrain: lake, runway, buildings, forest, gates.
//
// Does: builds the meshes and keeps simple collision shapes for them (tree
// trunks and crowns as cylinders, buildings as boxes, the lake surface), plus
// the gate course with lap timing.
// Does NOT: simulate physics itself; main.js asks collide() and passes the
// answer to the flight model.

import * as THREE from 'three';
import { WATER_LEVEL, LAKE, AIRFIELD_RADIUS, WORLD_SIZE } from './terrain.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class World {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.trees = [];
    this.treeGrid = new Map();
    this.boxes = [];
    this.gates = [];
    this.addWater();
    this.addRunway();
    this.addBuildings();
    this.addForest();
    this.addGates();
  }

  addWater() {
    const geo = new THREE.CircleGeometry(LAKE.r * 1.15, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f3d4c, roughness: 0.35, metalness: 0.05, envMapIntensity: 0.35, transparent: true, opacity: 0.92 });
    const water = new THREE.Mesh(geo, mat);
    water.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
    water.receiveShadow = true;
    this.scene.add(water);
  }

  addRunway() {
    const group = new THREE.Group();
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 18),
      new THREE.MeshStandardMaterial({ color: 0x3b3d40, roughness: 0.9 }),
    );
    strip.rotation.x = -Math.PI / 2;
    strip.receiveShadow = true;
    group.add(strip);
    const markMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.8 });
    for (let x = -80; x <= 80; x += 16) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.6), markMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, 0);
      group.add(m);
    }
    // Take-off pad: an H on a square.
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0xc8a032, roughness: 0.8 }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(-60, 0.02, 0);
    group.add(pad);
    group.position.y = this.terrain.heightAt(0, 0) + 0.03;
    this.scene.add(group);
  }

  addBox(x, z, w, h, d, color, rotY = 0) {
    const y = this.terrain.heightAt(x, z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    // Collision box: axis-aligned only, so rotations are multiples of 90 degrees.
    const sw = Math.abs(Math.cos(rotY)) > 0.5 ? w : d;
    const sd = Math.abs(Math.cos(rotY)) > 0.5 ? d : w;
    this.boxes.push({ min: new THREE.Vector3(x - sw / 2, y - 2, z - sd / 2), max: new THREE.Vector3(x + sw / 2, y + h, z + sd / 2) });
    return mesh;
  }

  addRoof(x, z, w, d, baseY, color) {
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, w * 0.75, 3, 4, 1), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, d / w);
    roof.position.set(x, baseY + 1.5, z);
    roof.castShadow = true;
    this.scene.add(roof);
  }

  addBuildings() {
    // Hangar by the runway.
    this.addBox(20, -40, 34, 11, 22, 0x8d9296);
    // A small farm.
    const r = rng(42);
    const spots = [[-150, 120], [-170, 150], [-130, 160], [160, -150], [185, -130], [-210, -170]];
    for (const [x, z] of spots) {
      const w = 8 + r() * 6;
      const d = 7 + r() * 5;
      const h = 4 + r() * 3;
      const rot = r() > 0.5 ? Math.PI / 2 : 0;
      const house = this.addBox(x, z, w, h, d, r() > 0.5 ? 0xd9d2c3 : 0xc9b79c, rot);
      this.addRoof(x, z, rot ? d : w, rot ? w : d, house.position.y + h / 2, 0x8a3b2c);
    }
  }

  addForest() {
    const r = rng(9001);
    const trunks = [];
    const crowns = [];
    const half = WORLD_SIZE / 2 - 20;
    for (let n = 0; n < 9000 && trunks.length < 2600; n++) {
      const x = (r() * 2 - 1) * half;
      const z = (r() * 2 - 1) * half;
      const dense = this.terrain.fbm(x - 40, z + 90, 3, 1 / 160, 1);
      if (dense < 0.05 + r() * 0.35) continue; // forest patches, open fields between
      if (Math.hypot(x, z) < AIRFIELD_RADIUS + 40) continue;
      if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 8) continue;
      if (this.boxes.some((b) => x > b.min.x - 8 && x < b.max.x + 8 && z > b.min.z - 8 && z < b.max.z + 8)) continue;
      const y = this.terrain.heightAt(x, z);
      if (this.terrain.normalAt(x, z).y < 0.82) continue;
      const height = 9 + r() * 14;
      const conifer = r() > 0.45;
      const crownR = conifer ? height * (0.17 + r() * 0.05) : height * (0.24 + r() * 0.06);
      const tree = { x, z, y, height, crownR, conifer, trunkR: 0.25 + height * 0.012 };
      trunks.push(tree);
      crowns.push(tree);
      this.trees.push(tree);
      const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
      if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
      this.treeGrid.get(key).push(tree);
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.7, 1, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 1 }),
      trunks.length,
    );
    const conifers = crowns.filter((t) => t.conifer);
    const broad = crowns.filter((t) => !t.conifer);
    const coniferMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 7),
      new THREE.MeshStandardMaterial({ color: 0x2f4a26, roughness: 0.95 }),
      conifers.length,
    );
    const broadMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0x46622b, roughness: 0.95, flatShading: true }),
      broad.length,
    );
    const tint = new THREE.Color();
    trunks.forEach((t, i) => {
      const trunkH = t.conifer ? t.height * 0.35 : t.height * 0.45;
      m.compose(p.set(t.x, t.y + trunkH / 2, t.z), q.identity(), s.set(t.trunkR, trunkH, t.trunkR));
      trunkMesh.setMatrixAt(i, m);
    });
    conifers.forEach((t, i) => {
      const crownH = t.height * 0.8;
      m.compose(p.set(t.x, t.y + t.height - crownH / 2, t.z), q.identity(), s.set(t.crownR, crownH, t.crownR));
      coniferMesh.setMatrixAt(i, m);
      coniferMesh.setColorAt(i, tint.setHSL(0.3 + (i % 7) * 0.006, 0.35, 0.18 + (i % 5) * 0.015));
    });
    broad.forEach((t, i) => {
      const rr = t.crownR;
      m.compose(p.set(t.x, t.y + t.height - rr, t.z), q.setFromAxisAngle(p.clone().set(0, 1, 0), i), s.set(rr, rr * 0.85, rr));
      broadMesh.setMatrixAt(i, m);
      broadMesh.setColorAt(i, tint.setHSL(0.24 + (i % 9) * 0.008, 0.42, 0.24 + (i % 4) * 0.02));
    });
    for (const mesh of [trunkMesh, coniferMesh, broadMesh]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  addGates() {
    const points = [
      [40, 0, 6], [120, -40, 9], [150, -120, 12], [60, -170, 8], [-40, -130, 14],
      [-120, -60, 7], [-130, 40, 10], [-60, 100, 6], [30, 80, 9],
    ];
    const ringGeo = new THREE.TorusGeometry(2.6, 0.18, 10, 40);
    points.forEach(([x, z, alt], i) => {
      const next = points[(i + 1) % points.length];
      const prev = points[(i + points.length - 1) % points.length];
      const dir = new THREE.Vector3(next[0] - prev[0], 0, next[1] - prev[1]).normalize();
      const ground = this.terrain.heightAt(x, z);
      const center = new THREE.Vector3(x, ground + alt, z);
      const mat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0x000000, roughness: 0.5 });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.position.copy(center);
      ring.lookAt(center.clone().add(dir));
      ring.castShadow = true;
      this.scene.add(ring);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, alt - 2.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2a }),
      );
      pole.position.set(x, ground + (alt - 2.6) / 2, z);
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
    g.mesh.material.emissive.set(active ? 0x0b4d1f : 0x000000);
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

  // Collision against trees, buildings, gates' poles are ignored (thin).
  // Returns null or { point, normal, kind } in three coordinates.
  collide(pos, radius) {
    const cx = Math.floor(pos.x / 16);
    const cz = Math.floor(pos.z / 16);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = this.treeGrid.get(`${cx + dx},${cz + dz}`);
        if (!cell) continue;
        for (const t of cell) {
          if (pos.y > t.y + t.height || pos.y < t.y) continue;
          const crownBottom = t.y + t.height * (t.conifer ? 0.2 : 0.4);
          const along = Math.min(Math.max((t.y + t.height - pos.y) / (t.y + t.height - crownBottom), 0), 1);
          const r = pos.y > crownBottom ? (t.conifer ? t.crownR * along : t.crownR) : t.trunkR;
          const hx = pos.x - t.x;
          const hz = pos.z - t.z;
          const d = Math.hypot(hx, hz);
          if (d < r + radius) {
            const n = d > 1e-6 ? new THREE.Vector3(hx / d, 0, hz / d) : new THREE.Vector3(1, 0, 0);
            return { point: new THREE.Vector3(t.x + n.x * (r + radius), pos.y, t.z + n.z * (r + radius)), normal: n, kind: 'tree' };
          }
        }
      }
    }
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
    if (Math.hypot(pos.x - LAKE.x, pos.z - LAKE.z) < LAKE.r * 1.15 && pos.y < WATER_LEVEL + radius &&
        this.terrain.heightAt(pos.x, pos.z) < WATER_LEVEL) {
      return { point: pos.clone(), normal: new THREE.Vector3(0, 1, 0), kind: 'water' };
    }
    return null;
  }
}
