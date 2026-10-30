// props.js — real 3D models placed in the world.
//
// Does: loads the CC0 models in assets/models (scanned by Poly Haven,
// simplified for the browser by tools/fetch-models.mjs) and places them by
// fixed rules with a seeded random generator: rock faces on the steepest
// slopes, boulders in open meadows, mossy rock sets, stumps, fallen logs,
// dry branches and ferns in the forest, barrels, a generator, utility boxes
// and lamps at the hangar, concrete barriers at the runway ends, a covered
// car and barrels at the farm. Each model is drawn as instanced meshes in
// 160 m chunks, so chunks off screen or beyond the model's view distance
// (small things like ferns only within about 120 m) are not drawn; the big
// ones get collision boxes. How many are placed follows the quality preset.
// In the Stylized and Dark studio styles they take plain colours from the
// palette.
// Does NOT: sway in the wind, or load or unload by distance.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { palette } from './palette.js';
import { HANGAR, HOUSES, RUNWAY, LAKE, onHardSurface, trackDistance } from './layout.js';

const BASE = new URL('../assets/models/', import.meta.url);
const HALF = 480; // stay inside the 1 km square
const CHUNK = 160; // metres

// How far away (m) each model is still drawn; small things fade out of view early.
const VIEW = {
  rock_face_01: 700, rock_face_02: 700, rock_moss_set_01: 450, rock_moss_set_02: 450,
  tree_stump_01: 220, tree_stump_02: 220, dead_tree_trunk: 220, dry_branches_medium_01: 120, fern_02: 120,
};
// Small things do not cast shadows: they are mostly in the trees' shade anyway.
const NO_SHADOW = new Set(['fern_02', 'dry_branches_medium_01']);

// Plain colours for the palette styles: which palette entry each model takes.
const PALETTE_SLOT = {
  rock_face_01: 'rock', rock_face_02: 'rock', rock_moss_set_01: 'rock', rock_moss_set_02: 'rock',
  tree_stump_01: 'bark', tree_stump_02: 'bark', dead_tree_trunk: 'bark', dry_branches_medium_01: 'bark',
  fern_02: 'leaves', Barrel_01: 'metal', barrel_03: 'roof', covered_car: 'roof', old_tyre: 'asphalt',
  utility_box_01: 'concrete', portable_generator: 'roof', street_lamp_01: 'metal', concrete_road_barrier_02: 'concrete',
};

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class Props {
  constructor(scene, terrain, forest, world, quality, style = 'realistic') {
    this.scene = scene;
    this.terrain = terrain;
    this.forest = forest;
    this.world = world;
    this.pal = palette(style);
    // How many natural props: fewer on weak presets (they are dense scans).
    this.density = { Low: 0.35, Medium: 0.6, High: 1, Ultra: 1.3 }[quality.label] ?? 0.6;
    this.group = new THREE.Group();
    this.group.name = 'props';
    scene.add(this.group);
    this.count = 0;
  }

  async load(onProgress = () => {}) {
    let manifest;
    try {
      const r = await fetch(new URL('manifest.json', BASE));
      if (!r.ok) return;
      manifest = await r.json();
    } catch {
      return; // no models in this copy: the world works without them
    }
    const loader = new GLTFLoader();
    const ids = Object.keys(manifest.models);
    const models = {};
    let done = 0;
    await Promise.all(ids.map(async (id) => {
      try {
        const gltf = await loader.loadAsync(new URL(manifest.models[id].file, BASE).href);
        gltf.scene.updateMatrixWorld(true);
        const parts = [];
        gltf.scene.traverse((o) => {
          if (o.isMesh) parts.push({ geometry: o.geometry, material: o.material, matrix: o.matrixWorld.clone() });
        });
        models[id] = { parts, box: new THREE.Box3().setFromObject(gltf.scene) };
      } catch (err) {
        console.warn(`Model ${id} did not load:`, err.message);
      }
      onProgress(++done / ids.length);
    }));
    this.place(models);
  }

  // Ground height and steepness (rise per metre) at a point.
  ground(x, z) {
    const h = this.terrain.heightAt(x, z);
    const dx = this.terrain.heightAt(x + 1, z) - this.terrain.heightAt(x - 1, z);
    const dz = this.terrain.heightAt(x, z + 1) - this.terrain.heightAt(x, z - 1);
    return { h, slope: Math.hypot(dx, dz) / 2 };
  }

  free(x, z, margin = 4) {
    if (Math.abs(x) > HALF || Math.abs(z) > HALF) return false;
    if (onHardSurface(x, z, margin)) return false;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r * 1.25) return false;
    return trackDistance(x, z) > 3;
  }

  place(models) {
    const r = rng(20261030);
    const n = (k) => Math.max(1, Math.round(k * this.density));
    const spots = {}; // id -> [{ x, z, yaw, scale, sink, tilt }]
    const add = (id, s) => {
      if (!models[id]) return;
      (spots[id] ||= []).push({ yaw: r() * Math.PI * 2, scale: 1, sink: 0, tilt: 0, ...s });
    };
    // Search random points until a rule accepts enough of them.
    const scatter = (id, count, accept, extra) => {
      for (let tries = 0, got = 0; got < count && tries < count * 400; tries++) {
        const x = (r() * 2 - 1) * HALF;
        const z = (r() * 2 - 1) * HALF;
        if (!this.free(x, z) || !accept(x, z)) continue;
        add(id, { x, z, ...extra() });
        got++;
      }
    };
    const inForest = (x, z) => this.forest.canopyHeightAt(x, z) > 4;
    // Near a tree, but clear of its trunk.
    const nearTrees = (id, count, extra, within = HALF) => {
      const trees = this.forest.trees.filter((t) => Math.hypot(t.x, t.z) < within);
      for (let got = 0, tries = 0; got < count && tries < count * 50 && trees.length; tries++) {
        const t = trees[Math.floor(r() * trees.length)];
        const a = r() * Math.PI * 2;
        const d = t.trunkR + 1.2 + r() * 3.5;
        const x = t.x + Math.cos(a) * d;
        const z = t.z + Math.sin(a) * d;
        if (!this.free(x, z)) continue;
        add(id, { x, z, ...extra() });
        got++;
      }
    };

    // Rocks.
    for (const id of ['rock_face_01', 'rock_face_02']) scatter(id, n(8), (x, z) => this.ground(x, z).slope > 0.32, () => ({ scale: 0.7 + r() * 0.6, sink: 0.35 }));
    for (const id of ['rock_moss_set_01', 'rock_moss_set_02']) scatter(id, n(6), inForest, () => ({ scale: 0.8 + r() * 0.4, sink: 0.15 }));
    // Forest floor.
    for (const id of ['tree_stump_01', 'tree_stump_02']) nearTrees(id, n(10), () => ({ scale: 0.8 + r() * 0.4, sink: 0.05 }));
    nearTrees('dead_tree_trunk', n(10), () => ({ scale: 0.9 + r() * 0.5, sink: 0.08 }));
    nearTrees('dry_branches_medium_01', n(12), () => ({ scale: 0.8 + r() * 0.5 }));
    nearTrees('fern_02', n(40), () => ({ scale: 0.6 + r() * 0.5 }), 320);

    // The hangar (door to the south, +z): barrels, tyres, generator, utility boxes, lamps on the apron.
    const hx = HANGAR.x + HANGAR.w / 2; // east wall
    const hz = HANGAR.z;
    for (const [dx, dz] of [[2.4, -6], [3.1, -5.3], [2.5, -4.5]]) add('Barrel_01', { x: hx + dx, z: hz + dz });
    for (const [dx, dz] of [[2.6, -8], [3.4, -7.3]]) add('barrel_03', { x: hx + dx, z: hz + dz });
    add('old_tyre', { x: hx + 3.2, z: hz - 9.6, yaw: 0.3 });
    add('old_tyre', { x: hx + 2.4, z: hz - 9.9, yaw: 1.1 });
    add('portable_generator', { x: hx - 1.5, z: HANGAR.z + HANGAR.d / 2 + 1.6, yaw: 0.2 });
    for (const dz of [3, 4.2]) add('utility_box_01', { x: hx + 0.35, z: hz + dz, yaw: Math.PI / 2 });
    for (const x of [HANGAR.x - 22, HANGAR.x, HANGAR.x + 22]) add('street_lamp_01', { x, z: HANGAR.z + HANGAR.d / 2 + 18, yaw: Math.PI });
    // Concrete barriers past both runway ends.
    for (const end of [-1, 1]) {
      for (const dz of [-4.5, -1.5, 1.5, 4.5]) add('concrete_road_barrier_02', { x: RUNWAY.x + end * (RUNWAY.length / 2 + 6), z: RUNWAY.z + dz, yaw: Math.PI / 2 });
    }
    // The farm: a covered car by the first house, barrels by the barn.
    const home = HOUSES[0];
    add('covered_car', { x: home.x + home.w / 2 + 4, z: home.z + 2, yaw: 0.25 });
    const barn = HOUSES.find((h) => h.barn) || home;
    for (const [dx, dz] of [[0, 0], [0.75, 0.5]]) add('Barrel_01', { x: barn.x + barn.w / 2 + 1.6 + dx, z: barn.z - 2 + dz });

    // Build instanced meshes and collision boxes.
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const [id, list] of Object.entries(spots)) {
      const model = models[id];
      const size = model.box.getSize(new THREE.Vector3());
      const placements = list.map((s) => {
        const g = this.ground(s.x, s.z);
        const y = g.h - model.box.min.y * s.scale - s.sink * size.y * s.scale;
        e.set(0, s.yaw, 0);
        q.setFromEuler(e);
        return new THREE.Matrix4().compose(new THREE.Vector3(s.x, y, s.z), q, new THREE.Vector3(s.scale, s.scale, s.scale));
      });
      // One instanced mesh per chunk, so frustum and distance culling work per chunk.
      const chunks = new Map();
      list.forEach((s, i) => {
        const key = `${Math.floor(s.x / CHUNK)},${Math.floor(s.z / CHUNK)}`;
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push(placements[i]);
      });
      const mats = model.parts.map((part) => (this.pal ? this.paletteMaterial(id, part.material) : part.material));
      for (const chunk of chunks.values()) {
        model.parts.forEach((part, k) => {
          const mesh = new THREE.InstancedMesh(part.geometry, mats[k], chunk.length);
          chunk.forEach((p, i) => mesh.setMatrixAt(i, m.multiplyMatrices(p, part.matrix)));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
          mesh.castShadow = !NO_SHADOW.has(id);
          mesh.receiveShadow = true;
          mesh.name = `prop-${id}`;
          mesh.userData.viewDistance = (VIEW[id] ?? 450) + mesh.boundingSphere.radius;
          this.group.add(mesh);
        });
      }
      this.count += placements.length;
      // Big things are solid: a box a little smaller than the model.
      if (size.y * Math.max(...list.map((s) => s.scale)) > 0.5 && id !== 'fern_02' && id !== 'dry_branches_medium_01') {
        for (const p of placements) {
          const b = model.box.clone().applyMatrix4(p);
          const c = b.getCenter(new THREE.Vector3());
          const half = b.getSize(new THREE.Vector3()).multiplyScalar(0.4);
          this.world.boxes.push({ min: c.clone().sub(half), max: c.clone().add(half) });
        }
      }
    }
  }

  /** Hide the chunks beyond their view distance. */
  update(camera) {
    for (const mesh of this.group.children) {
      mesh.visible = mesh.boundingSphere.center.distanceTo(camera.position) < mesh.userData.viewDistance;
    }
  }

  paletteMaterial(id, original) {
    const slot = PALETTE_SLOT[id] || 'rock';
    const p = this.pal;
    let color;
    if (slot === 'rock') color = new THREE.Color(...p.ground.rock).multiplyScalar(1.5);
    else if (slot === 'bark') color = new THREE.Color(...p.bark);
    else if (slot === 'leaves') color = new THREE.Color(...p.leaves.oak);
    else color = new THREE.Color(p.surfaces[slot] ?? p.surfaces.concrete);
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: slot === 'metal' ? 0.3 : 0,
      // Keep the cut-out of leaves (ferns) so they are not solid sheets.
      map: original.alphaTest > 0 ? original.map : null,
      alphaTest: original.alphaTest || 0,
      side: original.side,
    });
  }
}
