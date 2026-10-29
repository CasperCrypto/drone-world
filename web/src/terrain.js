// terrain.js — the ground of the free 1 x 1 km area and the land beyond it.
//
// Does: generates the landscape (hills, higher ground at the edge, a flat
// airfield, a lake basin), answers "how high is the ground here?" exactly as
// the mesh draws it (so the drone lands on what you see), decides which
// ground material lies where (grass, dry grass, forest floor, rock, sand,
// mud tracks and yards), bakes ambient occlusion, and builds:
//   - the detailed 1 km mesh (2 m grid) with a shader that blends eight
//     scanned materials, wetness, puddles and snow,
//   - a low-detail landscape out to 4 km, with forests drawn as a raised
//     canopy, so the horizon is hills and woods instead of an edge,
//   - data textures (height, grass density) for the grass and the water.
// Does NOT: load real places (real terrain is the next milestone) or place
// trees (forest.js does, using forestDensity()).
//
// Coordinates are three.js world metres: x east, y up, z south.

import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import {
  WORLD_SIZE, HALF, WATER_LEVEL, AIRFIELD_RADIUS, LAKE, HOUSES, YARDS, TRACK_WIDTH,
  trackDistance, onHardSurface,
} from './layout.js';
import { env, NOISE_GLSL, linkEnv } from './shaders.js';

export { WORLD_SIZE, WATER_LEVEL, AIRFIELD_RADIUS, LAKE };
export const GRID = 512; // cells per side, 2 m each
const CELL = WORLD_SIZE / GRID;
const FAR_SIZE = 8192; // metres, the landscape beyond the free area
const FAR_GRID = 160;

const smooth = (e0, e1, x) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

// Per-layer colour correction (linear RGB multipliers) for the scans.
const TINTS = [
  [0.74, 1.06, 0.52], // grass: the scan is half brown; push it toward a summer green
  [0.95, 0.98, 0.72], // dry grass
  [0.95, 0.92, 0.88], // forest floor
  [0.8, 0.8, 0.82], // rock (the scan is reddish; pull it toward grey)
  [1.0, 0.98, 0.94], // sand
  [0.95, 0.92, 0.9], // mud
  [1.0, 1.0, 1.0], // snow
  [1.0, 1.0, 1.0], // meadow (only used as large-scale variation)
];

export class Terrain {
  constructor(seed = 7) {
    this.seed = seed;
    this.noise = new ImprovedNoise();
    const row = GRID + 1;
    this.heights = new Float32Array(row * row);
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        this.heights[j * row + i] = this.shape(-HALF + i * CELL, -HALF + j * CELL);
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

  // Height before sampling onto the grid. Valid everywhere, also outside.
  shape(x, z) {
    let h = this.fbm(x, z, 5, 1 / 320, 26);
    h += Math.abs(this.fbm(x + 500, z - 300, 3, 1 / 140, 7)); // ridges
    const edgeD = Math.max(Math.abs(x), Math.abs(z));
    h += smooth(330, HALF, edgeD) * 55; // higher ground closes the area
    // Beyond the area: broad rolling country that sinks back toward the horizon.
    const out = smooth(HALF, HALF + 600, edgeD);
    if (out > 0) {
      const far = 25 + this.fbm(x - 1300, z + 900, 5, 1 / 1100, 70) + Math.abs(this.fbm(x, z, 3, 1 / 420, 14));
      h = h * (1 - out) + far * out;
    }
    const r = Math.hypot(x, z);
    h *= smooth(AIRFIELD_RADIUS, AIRFIELD_RADIUS + 70, r); // flat airfield at height 0
    const d = Math.hypot(x - LAKE.x, z - LAKE.z);
    h -= 16 * (1 - smooth(0, LAKE.r, d)); // the lake basin
    // Level the ground under the houses.
    for (const b of HOUSES) {
      const q = smooth(Math.max(b.w, b.d) * 0.9, Math.max(b.w, b.d) * 1.8, Math.hypot(x - b.x, z - b.z));
      if (q < 1) h = h * q + this.baseHeight(b.x, b.z) * (1 - q);
    }
    return h;
  }

  // Height at a house centre without the levelling (avoids recursion).
  baseHeight(x, z) {
    let h = this.fbm(x, z, 5, 1 / 320, 26) + Math.abs(this.fbm(x + 500, z - 300, 3, 1 / 140, 7));
    h += smooth(330, HALF, Math.max(Math.abs(x), Math.abs(z))) * 55;
    h *= smooth(AIRFIELD_RADIUS, AIRFIELD_RADIUS + 70, Math.hypot(x, z));
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

  // 0..1: how much forest grows here. Shared by the forest, the ground
  // textures and the wind (canopy shelter).
  forestDensity(x, z) {
    const n = this.fbm(x - 40, z + 90, 3, 1 / 160, 1);
    let d = smooth(0.02, 0.32, n);
    d *= smooth(AIRFIELD_RADIUS + 30, AIRFIELD_RADIUS + 70, Math.hypot(x, z));
    d *= smooth(LAKE.r + 4, LAKE.r + 18, Math.hypot(x - LAKE.x, z - LAKE.z));
    d *= smooth(TRACK_WIDTH + 2, TRACK_WIDTH + 8, trackDistance(x, z));
    for (const y of YARDS) d *= smooth(y.r + 6, y.r + 16, Math.hypot(x - y.x, z - y.z));
    return d;
  }

  // Approximate tree-top height (m) for the wind's canopy shelter.
  canopyHeight(x, z) {
    return this.forestDensity(x, z) > 0.45 ? 18 : 0;
  }

  // Ground material weights at a point: [grass, dry, forest, rock, sand, dirt].
  splat(x, z, y, ny) {
    const rock = smooth(0.84, 0.72, ny);
    const sand = smooth(WATER_LEVEL + 2.6, WATER_LEVEL + 0.6, y) * (1 - rock);
    const forest = this.forestDensity(x, z) * (1 - rock) * (1 - sand);
    let dirt = smooth(0.42, 0.62, this.fbm(x + 300, z - 120, 3, 1 / 38, 1) + 0.5) * 0.35;
    dirt = Math.max(dirt, smooth(TRACK_WIDTH * 0.8, TRACK_WIDTH * 0.35, trackDistance(x, z)));
    for (const yd of YARDS) dirt = Math.max(dirt, 0.75 * smooth(yd.r, yd.r * 0.4, Math.hypot(x - yd.x, z - yd.z)));
    dirt *= (1 - rock) * (1 - sand);
    const open = Math.max(0, 1 - rock - sand - forest - dirt);
    const airfield = 1 - smooth(AIRFIELD_RADIUS - 5, AIRFIELD_RADIUS + 30, Math.hypot(x, z));
    const dryNoise = smooth(-0.15, 0.35, this.fbm(x - 90, z + 210, 2, 1 / 110, 1));
    const dry = open * dryNoise * (1 - airfield) * 0.55;
    const grass = open - dry;
    return [grass, dry, forest * 0.85, rock, sand, dirt + forest * 0.15]; // a little mud under trees
  }

  // Horizon-based ambient occlusion from the height grid (0 dark .. 1 open).
  bakeOcclusion(i, j) {
    const row = GRID + 1;
    const h0 = this.heights[j * row + i];
    let occ = 0;
    const dirs = 8;
    for (let k = 0; k < dirs; k++) {
      const a = (k / dirs) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let maxSlope = 0;
      for (const step of [2, 5, 12, 28]) {
        const ii = Math.round(i + dx * step);
        const jj = Math.round(j + dz * step);
        if (ii < 0 || jj < 0 || ii > GRID || jj > GRID) continue;
        const dh = this.heights[jj * row + ii] - h0;
        maxSlope = Math.max(maxSlope, dh / (step * CELL));
      }
      occ += Math.sin(Math.atan(maxSlope));
    }
    return 1 - 0.85 * (occ / dirs);
  }

  buildMesh(textures) {
    const row = GRID + 1;
    // One extra ring of "skirt" vertices hangs down at the edge so no gap
    // shows against the far landscape.
    const count = row * row + 4 * GRID;
    const positions = new Float32Array(count * 3);
    const splat0 = new Float32Array(count * 4);
    const splat1 = new Float32Array(count * 4);
    const normals = this.gridNormals();
    this.splats = new Float32Array(row * row * 6); // reused by buildDataTextures
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const k = j * row + i;
        const x = -HALF + i * CELL;
        const z = -HALF + j * CELL;
        const y = this.heights[k];
        positions.set([x, y, z], k * 3);
        const w = this.splat(x, z, y, normals[k * 3 + 1]);
        this.splats.set(w, k * 6);
        const ao = this.bakeOcclusion(i, j) * (1 - 0.4 * this.forestDensity(x, z));
        splat0.set([w[0], w[1], w[2], w[3]], k * 4);
        splat1.set([w[4], w[5], ao, 0], k * 4);
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
    // Skirt: for each edge vertex pair, a quad down 25 m.
    let s = row * row;
    const edge = [];
    for (let i = 0; i < GRID; i++) edge.push([i, 0], [i + 1, 0]);
    for (let j = 0; j < GRID; j++) edge.push([GRID, j], [GRID, j + 1]);
    for (let i = GRID; i > 0; i--) edge.push([i, GRID], [i - 1, GRID]);
    for (let j = GRID; j > 0; j--) edge.push([0, j], [0, j - 1]);
    const skirtOf = new Map();
    const skirtVertex = (i, j) => {
      const key = j * row + i;
      if (skirtOf.has(key)) return skirtOf.get(key);
      const v = s++;
      positions.set([positions[key * 3], positions[key * 3 + 1] - 25, positions[key * 3 + 2]], v * 3);
      splat0.set(splat0.subarray(key * 4, key * 4 + 4), v * 4);
      splat1.set(splat1.subarray(key * 4, key * 4 + 4), v * 4);
      skirtOf.set(key, v);
      return v;
    };
    for (let e = 0; e < edge.length; e += 2) {
      const [i0, j0] = edge[e];
      const [i1, j1] = edge[e + 1];
      const a = j0 * row + i0;
      const b = j1 * row + i1;
      index.push(a, skirtVertex(i0, j0), b, b, skirtVertex(i0, j0), skirtVertex(i1, j1));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, s * 3), 3));
    geo.setAttribute('aSplat0', new THREE.BufferAttribute(splat0.subarray(0, s * 4), 4));
    geo.setAttribute('aSplat1', new THREE.BufferAttribute(splat1.subarray(0, s * 4), 4));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, terrainMaterial(textures));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'terrain';
    this.buildDataTextures();
    return mesh;
  }

  // Smooth vertex normals of the grid (for splat rules).
  gridNormals() {
    const row = GRID + 1;
    const n = new Float32Array(row * row * 3);
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const hl = this.heights[j * row + Math.max(i - 1, 0)];
        const hr = this.heights[j * row + Math.min(i + 1, GRID)];
        const hd = this.heights[Math.max(j - 1, 0) * row + i];
        const hu = this.heights[Math.min(j + 1, GRID) * row + i];
        const v = new THREE.Vector3(hl - hr, 4 * CELL, hd - hu).normalize();
        n.set([v.x, v.y, v.z], (j * row + i) * 3);
      }
    }
    return n;
  }

  // Height (float) and grass (density, dryness) textures for other shaders.
  buildDataTextures() {
    const row = GRID + 1;
    this.heightTex = new THREE.DataTexture(this.heights, row, row, THREE.RedFormat, THREE.FloatType);
    this.heightTex.needsUpdate = true;
    const grass = new Uint8Array(row * row * 4);
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const k = j * row + i;
        const x = -HALF + i * CELL;
        const z = -HALF + j * CELL;
        const w = this.splats.subarray(k * 6, k * 6 + 6);
        let density = w[0] + w[1] * 0.9 + w[2] * 0.12;
        if (onHardSurface(x, z, 1.5) || this.heights[k] < WATER_LEVEL + 0.3) density = 0;
        const dry = w[1] / Math.max(w[0] + w[1], 1e-3);
        grass[k * 4] = Math.round(Math.min(1, density) * 255);
        grass[k * 4 + 1] = Math.round(dry * 255);
        grass[k * 4 + 2] = Math.round(Math.min(1, w[2]) * 255);
        grass[k * 4 + 3] = 255;
      }
    }
    this.grassTex = new THREE.DataTexture(grass, row, row, THREE.RGBAFormat);
    this.grassTex.magFilter = THREE.LinearFilter;
    this.grassTex.needsUpdate = true;
  }

  // The land beyond the free area, out to 4 km: coarse, with a canopy over forests.
  buildFarMesh(textures) {
    const row = FAR_GRID + 1;
    const cell = FAR_SIZE / FAR_GRID;
    const positions = new Float32Array(row * row * 3);
    const splat0 = new Float32Array(row * row * 4);
    const splat1 = new Float32Array(row * row * 4);
    for (let j = 0; j <= FAR_GRID; j++) {
      for (let i = 0; i <= FAR_GRID; i++) {
        const k = j * row + i;
        const x = -FAR_SIZE / 2 + i * cell;
        const z = -FAR_SIZE / 2 + j * cell;
        const inside = Math.max(Math.abs(x), Math.abs(z)) < HALF - 1;
        let y = this.shape(x, z);
        const wood = inside ? 0 : smooth(0.0, 0.25, this.fbm(x + 700, z - 200, 3, 1 / 700, 1));
        y += wood * 17; // tree tops
        if (inside) y -= 30; // hidden under the detailed terrain
        positions.set([x, y, z], k * 3);
        const dry = smooth(-0.2, 0.3, this.fbm(x - 90, z + 210, 2, 1 / 600, 1)) * 0.6;
        splat0.set([(1 - wood) * (1 - dry), (1 - wood) * dry, 0, 0], k * 4);
        splat1.set([0, 0, 1, wood], k * 4);
      }
    }
    const index = [];
    for (let j = 0; j < FAR_GRID; j++) {
      for (let i = 0; i < FAR_GRID; i++) {
        const a = j * row + i;
        index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSplat0', new THREE.BufferAttribute(splat0, 4));
    geo.setAttribute('aSplat1', new THREE.BufferAttribute(splat1, 4));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, terrainMaterial(textures, true));
    mesh.receiveShadow = false;
    mesh.name = 'far-terrain';
    return mesh;
  }
}

// The ground shader: MeshStandardMaterial with the colour, normal,
// roughness and occlusion replaced by a blend of the scanned layers.
function terrainMaterial(textures, far = false) {
  const g = textures.ground;
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    linkEnv(shader, ['uWetness', 'uSnow', 'uTime']);
    shader.uniforms.uGAlbedo = { value: g.albedo };
    shader.uniforms.uGNormal = { value: g.normal };
    shader.uniforms.uGArm = { value: g.arm };
    shader.uniforms.uGTile = { value: g.tile };
    shader.uniforms.uGTint = { value: TINTS.map((t) => new THREE.Vector3(...t)) };
    shader.defines = { ...(shader.defines || {}), ...(far ? { DW_FAR: '' } : {}) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aSplat0;
attribute vec4 aSplat1;
varying vec4 vSplat0;
varying vec4 vSplat1;
varying vec3 vWPos;
varying vec3 vWNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSplat0 = aSplat0;
vSplat1 = aSplat1;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2DArray uGAlbedo;
uniform sampler2DArray uGNormal;
uniform sampler2DArray uGArm;
uniform float uGTile[8];
uniform vec3 uGTint[8];
uniform float uWetness;
uniform float uSnow;
uniform float uTime;
varying vec4 vSplat0;
varying vec4 vSplat1;
varying vec3 vWPos;
varying vec3 vWNormal;
${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `
vec3 tNormalW;
float tRough;
float tAO;
{
  vec3 N = normalize(vWNormal);
  vec2 xz = vWPos.xz;
  float dist = length(vWPos - cameraPosition);
  float w[7];
  w[0] = vSplat0.x; w[1] = vSplat0.y; w[2] = vSplat0.z; w[3] = vSplat0.w;
  w[4] = vSplat1.x; w[5] = vSplat1.y; w[6] = 0.0;
  float snowW = clamp(uSnow * smoothstep(0.5, 0.85, N.y) * (0.7 + 0.6 * dwNoise(xz * 0.13)), 0.0, 1.0);
  for (int i = 0; i < 6; i++) w[i] *= 1.0 - snowW;
  w[6] = snowW;
  float mixA = smoothstep(0.3, 0.7, dwNoise(xz / 19.0));
  float far = smoothstep(80.0, 400.0, dist);
  vec3 col = vec3(0.0);
  vec3 nrm = vec3(0.0);
  vec3 arm = vec3(0.0);
  float tot = 1e-4;
  for (int i = 0; i < 7; i++) {
    if (w[i] < 0.004) continue;
    float layer = float(i);
    vec2 uv = xz / uGTile[i];
    vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.29 + 0.37;
    vec3 c = mix(texture(uGAlbedo, vec3(uv, layer)).rgb, texture(uGAlbedo, vec3(uv2, layer)).rgb, max(mixA * 0.55, far * 0.6));
    vec3 r = texture(uGArm, vec3(uv, layer)).rgb;
    vec3 n = texture(uGNormal, vec3(uv, layer)).xyz * 2.0 - 1.0;
    float hw = w[i] * pow(0.2 + r.r, 4.0);
    col += c * uGTint[i] * hw;
    nrm += n * hw;
    arm += r * hw;
    tot += hw;
  }
  col /= tot;
  nrm /= tot;
  arm /= tot;
  // Fresh snow: brighter and more even than the scan's footprints.
  col = mix(col, vec3(0.8, 0.83, 0.88) * (0.92 + 0.12 * dwNoise(xz * 0.4)), snowW * 0.55);
  // Large-scale variation from an aerial meadow scan, so fields are not one flat colour.
  float m1 = dot(texture(uGAlbedo, vec3(xz / 171.0, 7.0)).rgb, vec3(0.3, 0.59, 0.11));
  float m2 = dot(texture(uGAlbedo, vec3(xz / 47.0 + 0.5, 7.0)).rgb, vec3(0.3, 0.59, 0.11));
  float grassy = (w[0] + w[1]) / (w[0] + w[1] + w[2] + w[3] + w[4] + w[5] + w[6] + 1e-4);
  col *= mix(1.0, 0.62 + 0.85 * (m1 * 0.6 + m2 * 0.4), 0.4 * grassy);
#ifdef DW_FAR
  // Distant forests: a canopy of mottled dark greens on the raised mesh.
  float canopy = vSplat1.w;
  vec3 leaves = mix(vec3(0.028, 0.045, 0.02), vec3(0.06, 0.08, 0.035), dwFbm(xz / 35.0));
  col = mix(col, leaves, canopy);
  arm.g = mix(arm.g, 0.85, canopy);
#endif
  float wet = uWetness * (1.0 - snowW);
  float porous = w[0] + w[1] + w[2] + w[5] + 0.8 * w[4] + 0.35 * w[3];
  col *= mix(1.0, 0.58, wet * porous);
  float rough = mix(arm.g, 0.42, wet * 0.65);
  float flatness = smoothstep(0.975, 0.997, N.y);
  float puddle = wet * flatness * smoothstep(0.6, 0.7, dwNoise(xz * 0.07) * 0.7 + dwNoise(xz * 0.29) * 0.3) * (w[5] + w[0] * 0.5 + w[1] * 0.5);
  col = mix(col, col * 0.3, puddle);
  rough = mix(rough, 0.04, puddle);
  nrm = mix(nrm, vec3(0.0, 0.0, 1.0), puddle);
  float strength = mix(1.0, 0.35, far);
  vec3 nt = normalize(vec3(nrm.xy * strength, max(nrm.z, 0.25)));
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
  vec3 B = normalize(vec3(0.0, 0.0, 1.0) - N * N.z);
  tNormalW = normalize(T * nt.x + B * nt.y + N * nt.z);
  tRough = rough;
  tAO = arm.r * vSplat1.z;
  diffuseColor.rgb = col;
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(tRough, 0.03, 1.0);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tNormalW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', `
reflectedLight.indirectDiffuse *= tAO;
reflectedLight.indirectSpecular *= tAO;`);
  };
  mat.customProgramCacheKey = () => (far ? 'dw-terrain-far' : 'dw-terrain');
  return mat;
}
