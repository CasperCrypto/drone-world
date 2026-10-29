// terrain.js — the free 1 x 1 km practice area.
//
// Does: builds a procedural landscape (hills, a ring of higher ground at the
// edge, a flat airfield in the middle, a lake) as a three.js mesh, and answers
// "how high is the ground here?" exactly as the mesh draws it, so the drone
// lands on what you see.
// Does NOT: load real places. Real terrain (3D Tiles, open elevation data) is
// the next milestone; this area works offline and costs nothing to host.
//
// Coordinates are three.js world metres: x east, y up, z south.

import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

export const WORLD_SIZE = 1024; // metres per side
export const GRID = 256; // cells per side, 4 m each
export const WATER_LEVEL = -4.0;
export const AIRFIELD_RADIUS = 70;
export const LAKE = { x: 260, z: 190, r: 95 };

const HALF = WORLD_SIZE / 2;
const CELL = WORLD_SIZE / GRID;
const smooth = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export class Terrain {
  constructor(seed = 7) {
    this.seed = seed;
    this.noise = new ImprovedNoise();
    this.heights = new Float32Array((GRID + 1) * (GRID + 1));
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        this.heights[j * (GRID + 1) + i] = this.shape(-HALF + i * CELL, -HALF + j * CELL);
      }
    }
  }

  fbm(x, z, octaves, freq, amp) {
    let sum = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise.noise(x * freq, z * freq, this.seed + o * 11.3) * amp;
      freq *= 2.03;
      amp *= 0.48;
    }
    return sum;
  }

  // Height before sampling onto the grid.
  shape(x, z) {
    let h = this.fbm(x, z, 5, 1 / 320, 26);
    h += Math.abs(this.fbm(x + 500, z - 300, 3, 1 / 140, 7)); // ridges
    const edge = smooth(330, HALF, Math.max(Math.abs(x), Math.abs(z)));
    h += edge * 55; // higher ground closes the area visually
    const r = Math.hypot(x, z);
    h *= smooth(AIRFIELD_RADIUS, AIRFIELD_RADIUS + 70, r); // flat airfield at height 0
    const d = Math.hypot(x - LAKE.x, z - LAKE.z);
    h -= 16 * (1 - smooth(0, LAKE.r, d)); // the lake basin
    return h;
  }

  // Exact height of the drawn triangles at (x, z).
  heightAt(x, z) {
    const gx = Math.min(Math.max((x + HALF) / CELL, 0), GRID - 1e-6);
    const gz = Math.min(Math.max((z + HALF) / CELL, 0), GRID - 1e-6);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const u = gx - i;
    const w = gz - j;
    const row = GRID + 1;
    const h00 = this.heights[j * row + i];
    const h10 = this.heights[j * row + i + 1];
    const h01 = this.heights[(j + 1) * row + i];
    const h11 = this.heights[(j + 1) * row + i + 1];
    // Same diagonal as the mesh: from (i+1, j) to (i, j+1).
    if (u + w <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * w;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - w);
  }

  normalAt(x, z) {
    const e = 0.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return new THREE.Vector3(-dx, 2 * e, -dz).normalize();
  }

  inside(x, z) {
    return Math.abs(x) < HALF && Math.abs(z) < HALF;
  }

  buildMesh() {
    const row = GRID + 1;
    const positions = new Float32Array(row * row * 3);
    const colors = new Float32Array(row * row * 3);
    const uvs = new Float32Array(row * row * 2);
    const grass = new THREE.Color(0x4f6b2c);
    const meadow = new THREE.Color(0x6f8a3a);
    const dirt = new THREE.Color(0x7a6a4c);
    const rock = new THREE.Color(0x77736c);
    const sand = new THREE.Color(0xb8a77e);
    const mown = new THREE.Color(0x5f8a35);
    const c = new THREE.Color();
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const k = j * row + i;
        const x = -HALF + i * CELL;
        const z = -HALF + j * CELL;
        const y = this.heights[k];
        positions.set([x, y, z], k * 3);
        uvs.set([i / GRID, j / GRID], k * 2);
        const n = this.normalAt(x, z);
        const patch = this.fbm(x + 77, z + 13, 2, 1 / 60, 1);
        c.copy(grass).lerp(meadow, smooth(-0.3, 0.5, patch));
        c.lerp(dirt, smooth(0.93, 0.82, n.y));
        c.lerp(rock, smooth(0.8, 0.62, n.y));
        c.lerp(sand, smooth(WATER_LEVEL + 2.5, WATER_LEVEL + 0.5, y));
        c.lerp(mown, 1 - smooth(AIRFIELD_RADIUS - 10, AIRFIELD_RADIUS + 25, Math.hypot(x, z)));
        colors.set([c.r, c.g, c.b], k * 3);
      }
    }
    const index = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * row + i; // (i, j)
        const b = a + 1; // (i+1, j)
        const d = a + row; // (i, j+1)
        const e = d + 1; // (i+1, j+1)
        index.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: grainTexture(),
      roughness: 0.95,
      metalness: 0,
    });
    mat.map.repeat.set(GRID / 2, GRID / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }
}

// Fine grass/soil grain so the ground does not look flat-shaded up close.
function grainTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let p = 0; p < size * size; p++) {
    const v = 205 + rnd() * 50;
    img.data[p * 4] = v;
    img.data[p * 4 + 1] = v;
    img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
