// textures.js — loads the scanned (CC0) textures the world is made of.
//
// Does: reads assets/textures/manifest.json, packs the ground materials
// (grass, dry grass, forest floor, rock, sand, mud, snow, meadow) into three
// texture arrays (colour, normal, ARM = occlusion/roughness/metalness) so the
// terrain shader can blend them in one draw, and builds ready-to-use PBR
// materials for runway, buildings and props, whose textures are read at a
// random offset per patch so long surfaces show no repeating pattern.
// Reports progress for the loading screen.
// Does NOT: download anything at runtime from third parties; every file is in
// this repository (fetched once by tools/fetch-assets.mjs).

import * as THREE from 'three';

export const GROUND_LAYERS = ['grass', 'grassDry', 'forest', 'rock', 'sand', 'dirt', 'snow', 'meadow'];

// Texture reads without a visible repeat: each patch of a few tiles uses its
// own random offset and neighbouring patches blend (Quilez, "texture
// repetition"). Every map of the material uses the same offsets, so colour,
// normals and roughness stay together.
const NO_TILE_GLSL = /* glsl */ `
float dwNtHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dwNtNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dwNtHash(i), dwNtHash(i + vec2(1.0, 0.0)), u.x), mix(dwNtHash(i + vec2(0.0, 1.0)), dwNtHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec4 dwNoTile(sampler2D s, vec2 uv) {
  float k = dwNtNoise(uv * 0.31) * 5.0;
  float i = floor(k);
  float f = smoothstep(0.25, 0.75, fract(k));
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  return mix(textureGrad(s, uv + sin(vec2(3.0, 7.0) * i) * 2.3, gx, gy), textureGrad(s, uv + sin(vec2(3.0, 7.0) * (i + 1.0)) * 2.3, gx, gy), f);
}`;

function noTile(material) {
  const swap = (chunk, from, to) => THREE.ShaderChunk[chunk].split(from).join(to);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NO_TILE_GLSL}`)
      .replace('#include <map_fragment>', swap('map_fragment', 'texture2D( map, vMapUv )', 'dwNoTile( map, vMapUv )'))
      .replace('#include <normal_fragment_maps>', swap('normal_fragment_maps', 'texture2D( normalMap, vNormalMapUv )', 'dwNoTile( normalMap, vNormalMapUv )'))
      .replace('#include <roughnessmap_fragment>', swap('roughnessmap_fragment', 'texture2D( roughnessMap, vRoughnessMapUv )', 'dwNoTile( roughnessMap, vRoughnessMapUv )'))
      .replace('#include <metalnessmap_fragment>', swap('metalnessmap_fragment', 'texture2D( metalnessMap, vMetalnessMapUv )', 'dwNoTile( metalnessMap, vMetalnessMapUv )'))
      .replace('#include <aomap_fragment>', swap('aomap_fragment', 'texture2D( aoMap, vAoMapUv )', 'dwNoTile( aoMap, vAoMapUv )'));
  };
  material.customProgramCacheKey = () => 'dw-notile';
  return material;
}
const BASE = new URL('../assets/textures/', import.meta.url);

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

// Draw every bitmap into one RGBA array, bottom row first (like flipY).
function packArray(bitmaps, size, srgb) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = new Uint8Array(size * size * 4 * bitmaps.length);
  bitmaps.forEach((bmp, layer) => {
    ctx.save();
    ctx.translate(0, size);
    ctx.scale(1, -1);
    ctx.drawImage(bmp, 0, 0, size, size);
    ctx.restore();
    data.set(ctx.getImageData(0, 0, size, size).data, layer * size * size * 4);
  });
  const tex = new THREE.DataArrayTexture(data, size, size, bitmaps.length);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class TextureLibrary {
  constructor(renderer) {
    this.renderer = renderer;
    this.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.loader = new THREE.TextureLoader();
    this.pending = [];
  }

  // TextureLoader.load, remembering the promise so settle() can wait for it.
  loadTex(url) {
    let tex;
    this.pending.push(new Promise((resolve) => {
      tex = this.loader.load(url, resolve, undefined, () => {
        console.warn(`Texture failed: ${url}`);
        resolve();
      });
    }));
    return tex;
  }

  /** size: 512 or 1024 texels per ground layer. onProgress(0..1). */
  async load(size = 1024, onProgress = () => {}) {
    this.manifest = await (await fetch(new URL('manifest.json', BASE))).json();
    const slots = this.manifest.slots;
    const jobs = [];
    for (const name of GROUND_LAYERS) {
      for (const kind of ['diff', 'nor_gl', 'arm']) jobs.push([name, kind]);
    }
    let done = 0;
    const bitmaps = {};
    await Promise.all(jobs.map(async ([name, kind]) => {
      bitmaps[`${name}.${kind}`] = await loadBitmap(new URL(slots[name].files[kind], BASE));
      onProgress((++done / jobs.length) * 0.8);
    }));
    const layer = (kind) => GROUND_LAYERS.map((n) => bitmaps[`${n}.${kind}`]);
    this.ground = {
      albedo: packArray(layer('diff'), size, true),
      normal: packArray(layer('nor_gl'), size, false),
      arm: packArray(layer('arm'), size, false),
      // Real-world size of one tile in metres, from Poly Haven's metadata.
      tile: GROUND_LAYERS.map((n) => (slots[n].dimensionsMm ? slots[n].dimensionsMm[0] / 1000 : 2)),
    };
    for (const t of [this.ground.albedo, this.ground.normal, this.ground.arm]) t.anisotropy = this.anisotropy;
    Object.values(bitmaps).forEach((b) => b.close?.());
    onProgress(0.9);
    return this;
  }

  // One texture from the manifest, repeated `repeat` times over the UVs.
  tex(slot, kind, repeat = [1, 1]) {
    const t = this.loadTex(new URL(this.manifest.slots[slot].files[kind], BASE).href);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = this.anisotropy;
    t.colorSpace = kind === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  }

  /** PBR material for a slot. UVs are expected in metres; the tile size is applied here. */
  material(slot, opts = {}) {
    const tileM = (this.manifest.slots[slot].dimensionsMm?.[0] ?? 2000) / 1000;
    const rep = 1 / tileM;
    const arm = this.tex(slot, 'arm', [rep, rep]);
    return noTile(new THREE.MeshStandardMaterial({
      map: this.tex(slot, 'diff', [rep, rep]),
      normalMap: this.tex(slot, 'nor_gl', [rep, rep]),
      aoMap: arm,
      roughnessMap: arm,
      metalnessMap: arm,
      roughness: 1,
      metalness: 1, // scaled by the ARM map's blue channel
      ...opts,
    }));
  }

  treeTexture(path, srgb) {
    const t = this.loadTex(new URL(`../assets/trees/${path}`, import.meta.url).href);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = this.anisotropy;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  }

  /** Resolves when every texture created through this library so far has arrived. */
  settle() {
    return Promise.all(this.pending);
  }
}
