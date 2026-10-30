// grass.js — real blades of grass around the camera, moving in the wind.
//
// Does: draws a square patch of grass tufts (two blades each) centred on the
// camera. Every tuft has a fixed place in the world (the patch repeats like
// a tile as the camera moves, so blades never slide). Height, colour and
// density come from the terrain's grass map; blades lean and sway with the
// same wind (mean profile plus gust waves) the drone and trees feel; tips
// glow a little when the sun shines through them.
// Does NOT: collide with anything or cast shadows (too costly for the
// gain); far away the terrain's grass texture takes over.

import * as THREE from 'three';
import { HALF } from './layout.js';
import { GRID } from './terrain.js';
import { env, NOISE_GLSL, WIND_GLSL, linkEnv } from './shaders.js';
import { palette, TOON } from './palette.js';

// Two blades, each 3 segments: x = side (-0.5..0.5), y = height fraction, z = blade index.
function tuftGeometry() {
  const pos = [];
  const index = [];
  for (let b = 0; b < 2; b++) {
    const base = pos.length / 3;
    const levels = [0, 0.35, 0.7];
    for (const t of levels) pos.push(-0.5, t, b, 0.5, t, b);
    pos.push(0, 1, b);
    for (let l = 0; l < levels.length - 1; l++) {
      const a = base + l * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const top = base + levels.length * 2;
    index.push(top - 2, top - 1, top);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

export class Grass {
  constructor(terrain, textures, { count, patch }, style = 'toon') {
    const pal = palette(style);
    const blade = (pal || TOON).grassBlade;
    this.patch = patch;
    const geo = tuftGeometry();
    const offsets = new Float32Array(count * 3);
    let s = 1234567;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) offsets.set([rnd() * patch, rnd() * patch, rnd()], i * 3);
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geo.instanceCount = count;
    this.count = count;

    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uPatch: { value: patch },
      uHeight: { value: terrain.heightTex },
      uGrassMap: { value: terrain.grassTex },
      uGAlbedo: { value: textures.ground.albedo },
      uHalf: { value: HALF },
      uGridN: { value: GRID },
      uBladeRoot: { value: new THREE.Vector3(...blade[0]) },
      uBladeTip: { value: new THREE.Vector3(...blade[1]) },
    };
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    this.material = mat;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      if (pal) shader.defines = { ...(shader.defines || {}), DW_PAL: '' };
      linkEnv(shader, ['uTime', 'uWindDir', 'uWind10', 'uGustK', 'uGustAmp', 'uGustPhase', 'uSunDir', 'uSunColor', 'uSnow', 'uWetness']);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec3 aOffset;
uniform vec2 uCamXZ;
uniform float uPatch;
uniform sampler2D uHeight;
uniform sampler2D uGrassMap;
uniform sampler2DArray uGAlbedo;
uniform float uHalf;
uniform float uGridN;
uniform vec3 uBladeRoot;
uniform vec3 uBladeTip;
uniform float uSnow;
uniform float uWetness;
varying vec3 vGrassColor;
varying float vGrassT;
varying vec3 vGrassWPos;
varying float vGrassOpen;
${WIND_GLSL}
float dwTerrainH(vec2 xz) {
  vec2 g = clamp((xz + uHalf) / (2.0 * uHalf) * uGridN, vec2(0.0), vec2(uGridN - 0.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  float h00 = texelFetch(uHeight, i, 0).r;
  float h10 = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
  // Same triangle split as the terrain mesh.
  if (f.x + f.y <= 1.0) return h00 + (h10 - h00) * f.x + (h01 - h00) * f.y;
  return h11 + (h01 - h11) * (1.0 - f.x) + (h10 - h11) * (1.0 - f.y);
}`)
        .replace('#include <beginnormal_vertex>', `
vec2 dwLocal = aOffset.xy;
vec2 dwXZ = dwLocal + uPatch * floor((uCamXZ - dwLocal) / uPatch + 0.5);
float dwR = aOffset.z;
vec4 dwMap = texture(uGrassMap, (dwXZ + uHalf) / (2.0 * uHalf));
float dwDist = distance(dwXZ, uCamXZ);
float dwFade = 1.0 - smoothstep(uPatch * 0.3, uPatch * 0.5, dwDist);
float dwKeep = step(0.01, dwMap.r) * smoothstep(dwR - 0.08, dwR, dwMap.r) * dwFade * (1.0 - smoothstep(0.2, 0.6, uSnow));
float dwH = mix(0.22, 0.62, fract(dwR * 7.13)) * (0.55 + 0.5 * dwMap.r) * (1.0 - 0.3 * dwMap.g) * dwKeep;
float dwW = mix(0.03, 0.055, fract(dwR * 3.7)) * (1.0 + dwDist * 0.02);
float dwYaw = dwR * 81.7 + position.z * 2.1;
vec2 dwFwd = vec2(cos(dwYaw), sin(dwYaw));
vec2 dwSide = vec2(-dwFwd.y, dwFwd.x);
float dwT = position.y;
float dwWind = max(dwMeanWind(0.6) + dwGust(dwXZ), 0.0);
float dwFlutter = sin(uTime * (2.3 + dwWind * 0.45) + dot(dwXZ, vec2(0.7, 0.9)) + dwR * 6.2831) * (0.05 + dwWind * 0.012);
vec2 dwLean = dwFwd * (0.22 + 0.2 * fract(dwR * 5.3)) + uWindDir * (clamp(dwWind * 0.075, 0.0, 1.1) + dwFlutter);
float dwBend = min(length(dwLean), 1.3);
vec2 dwOff = dwLean * dwH * dwT * dwT;
float dwY = dwH * dwT * (1.0 - 0.32 * dwBend * dwBend * dwT);
float dwTaper = 1.0 - dwT * 0.88;
vec3 dwPos = vec3(dwXZ.x + dwSide.x * position.x * dwW * dwTaper + dwOff.x,
                  dwTerrainH(dwXZ) + dwY,
                  dwXZ.y + dwSide.y * position.x * dwW * dwTaper + dwOff.y);
vec3 objectNormal = normalize(vec3(dwFwd.x, 0.0, dwFwd.y) * 0.35 + vec3(0.0, 1.0, 0.0));
// Colour: the ground scan under the tuft, darker at the root, lighter and drier at the tip.
vec3 dwGround = mix(textureLod(uGAlbedo, vec3(dwXZ / 2.0, 0.0), 7.0).rgb,
                    textureLod(uGAlbedo, vec3(dwXZ / 2.0, 1.0), 7.0).rgb, dwMap.g);
vec3 dwTipTint = mix(vec3(0.86, 1.08, 0.62), vec3(1.1, 1.05, 0.72), dwMap.g);
vGrassColor = dwGround * mix(vec3(0.55), dwTipTint, dwT) * (0.93 + 0.14 * fract(dwR * 11.3)) * (1.0 - 0.55 * dwMap.b); // darker under trees, like the ground
#ifdef DW_PAL
vGrassColor = mix(uBladeRoot, uBladeTip, dwT) * (0.92 + 0.16 * fract(dwR * 11.3)) * (1.0 - 0.45 * dwMap.b) * mix(1.0, 1.12, dwMap.g);
#endif
// Wet blades: darker and a little more saturated.
vGrassColor *= mix(vec3(1.0), vec3(0.62, 0.7, 0.6), uWetness);
vGrassT = dwT;
vGrassWPos = dwPos;
vGrassOpen = 1.0 - dwMap.b; // under trees the sun rarely shines through
`)
        .replace('#include <begin_vertex>', 'vec3 transformed = dwPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vGrassColor;
varying float vGrassT;
varying vec3 vGrassWPos;
varying float vGrassOpen;`)
        .replace('#include <map_fragment>', 'diffuseColor.rgb = vGrassColor;')
        .replace('#include <emissivemap_fragment>', `
// Light through the blades when looking toward the sun.
vec3 dwView = normalize(vGrassWPos - cameraPosition);
float dwBack = pow(max(dot(dwView, uSunDir), 0.0), 3.0);
totalEmissiveRadiance += vGrassColor * uSunColor * (0.015 + 0.12 * dwBack) * vGrassT * vGrassOpen;`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
#ifdef DW_PAL
gl_FragColor.a = 0.0; // tells the outline pass (post.js) not to ink every blade
#endif`);
    };
    mat.customProgramCacheKey = () => `dw-grass-${pal ? pal.key : 'scan'}`;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'grass';
  }

  /** Draw only a share of the tufts (used when the frame rate is low). */
  setDensity(fraction) {
    const n = Math.round(this.count * fraction);
    if (n === this.mesh.geometry.instanceCount) return false;
    this.mesh.geometry.instanceCount = n;
    return true;
  }

  update(camera, groundBelowCamera) {
    this.uniforms.uCamXZ.value.set(camera.position.x, camera.position.z);
    // High above the ground the blades are smaller than a pixel: skip them.
    this.mesh.visible = camera.position.y - groundBelowCamera < 70;
  }
}
