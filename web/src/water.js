// water.js — the lake.
//
// Does: a water surface that reflects the sky (and clouds) through the
// environment map with the right reflectance for water (index of refraction
// 1.33), small waves from two layers of scrolling normals whose size and
// speed follow the wind, colour and see-through depth from the real depth to
// the lake bed (shallows show the bottom), a soft shore line, and rain rings.
// Does NOT: reflect trees or buildings (that needs a second render of the
// scene each frame) or simulate water flow.

import * as THREE from 'three';
import { LAKE, WATER_LEVEL, HALF } from './layout.js';
import { GRID } from './terrain.js';
import { env, NOISE_GLSL, linkEnv } from './shaders.js';

// A tiling normal map of small waves, drawn once on a canvas.
function waveNormals(size = 256) {
  const heights = new Float32Array(size * size);
  let s = 99;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const waves = Array.from({ length: 24 }, () => ({
    kx: Math.round((rnd() * 2 - 1) * 9), ky: Math.round((rnd() * 2 - 1) * 9), a: rnd(), p: rnd() * Math.PI * 2,
  }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const w of waves) {
        const k = Math.hypot(w.kx, w.ky) || 1;
        h += (w.a / k) * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.p);
      }
      heights[y * size + x] = h;
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hx = heights[y * size + ((x + 1) % size)] - heights[y * size + ((x - 1 + size) % size)];
      const hy = heights[((y + 1) % size) * size + x] - heights[((y - 1 + size) % size) * size + x];
      const n = new THREE.Vector3(-hx * 1.6, -hy * 1.6, 1).normalize();
      data.set([(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function makeLake(terrain) {
  const geo = new THREE.CircleGeometry(LAKE.r * 1.2, 96);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x0b2a2e,
    roughness: 0.06,
    metalness: 0,
    ior: 1.333,
    transparent: true,
    normalMap: waveNormals(),
  });
  const uniforms = {
    uHeight: { value: terrain.heightTex },
    uHalf: { value: HALF },
    uGridN: { value: GRID },
    uLevel: { value: WATER_LEVEL },
    uReflection: { value: null },
    uReflMatrix: { value: new THREE.Matrix4() },
    uReflOn: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    linkEnv(shader, ['uTime', 'uWindDir', 'uWind10', 'uRain']);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uHeight;
uniform float uHalf;
uniform float uGridN;
uniform float uLevel;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind10;
uniform float uRain;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform float uReflOn;
varying vec3 vWaterPos;
float dwDepth;
${NOISE_GLSL}
float dwBed(vec2 xz) {
  vec2 g = clamp((xz + uHalf) / (2.0 * uHalf) * uGridN, vec2(0.0), vec2(uGridN - 0.001));
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  float a = mix(texelFetch(uHeight, i, 0).r, texelFetch(uHeight, i + ivec2(1, 0), 0).r, f.x);
  float b = mix(texelFetch(uHeight, i + ivec2(0, 1), 0).r, texelFetch(uHeight, i + ivec2(1, 1), 0).r, f.x);
  return mix(a, b, f.y);
}
// Expanding rings from raindrops on a 1.5 m grid.
vec2 dwRipples(vec2 p, float t) {
  vec2 cell = floor(p / 1.5);
  vec2 sum = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    float h = dwHash12(c);
    vec2 center = (c + vec2(dwHash12(c + 7.1), dwHash12(c + 3.3))) * 1.5;
    float age = fract(t * 0.9 + h);
    vec2 d = p - center;
    float r = length(d);
    float ring = sin((r - age * 1.2) * 28.0) * exp(-abs(r - age * 1.2) * 9.0) * (1.0 - age);
    sum += normalize(d + 1e-4) * ring;
  }
  return sum;
}`)
      .replace('#include <normal_fragment_maps>', `
{
  float wind = max(uWind10, 0.3);
  vec2 flow = uWindDir * (0.02 + wind * 0.012) * uTime;
  float scale = mix(0.55, 0.28, clamp(wind / 12.0, 0.0, 1.0));
  vec3 n1 = texture2D(normalMap, vWaterPos.xz * scale * 0.18 + flow).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(normalMap, vWaterPos.xz * scale * 0.47 - flow.yx * 1.7 + 0.3).xyz * 2.0 - 1.0;
  float strength = 0.12 + clamp(wind * 0.045, 0.0, 0.6);
  vec2 slope = (n1.xy + n2.xy * 0.6) * strength;
  slope += dwRipples(vWaterPos.xz, uTime) * 0.25 * uRain;
  vec3 nw = normalize(vec3(-slope.x, 1.0, -slope.y));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
if (uReflOn > 0.5) {
  vec4 rp = uReflMatrix * vec4(vWaterPos, 1.0);
  // Distort only by how much the waves tilt the surface away from flat.
  vec3 flatN = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec2 ruv = rp.xy / rp.w + (normal.xy - flatN.xy) * 0.12;
  radiance = texture2D(uReflection, clamp(ruv, vec2(0.001), vec2(0.999))).rgb;
}
#endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
dwDepth = max(uLevel - dwBed(vWaterPos.xz), 0.0);
// Shallow water shows the bottom; deeper water turns dark green-blue.
diffuseColor.rgb = mix(vec3(0.06, 0.09, 0.05), diffuseColor.rgb, smoothstep(0.0, 3.5, dwDepth));
diffuseColor.a = smoothstep(0.0, 0.35, dwDepth) * mix(0.55, 0.96, smoothstep(0.3, 4.0, dwDepth));`);
  };
  mat.customProgramCacheKey = () => 'dw-water';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.name = 'lake';
  mesh.userData.uniforms = uniforms;
  return mesh;
}

// Planar reflection of the scene in the lake (High and Ultra presets): the
// scene is rendered from the camera mirrored in the water surface, at half
// resolution, without grass and rain (layer 1), with an oblique near plane
// so nothing under the water shows. Same method as three.js's Reflector.
export class LakeReflection {
  constructor(lake, scale = 0.5) {
    this.lake = lake;
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType });
    this.camera = new THREE.PerspectiveCamera();
    this.camera.layers.set(0);
    this.u = lake.userData.uniforms;
    this.u.uReflection.value = this.target.texture;
    this.u.uReflOn.value = 1;
    this.sphere = new THREE.Sphere(new THREE.Vector3(LAKE.x, WATER_LEVEL, LAKE.z), LAKE.r * 1.2);
    this.frustum = new THREE.Frustum();
    this.tmp = new THREE.Matrix4();
  }

  setSize(width, height) {
    this.target.setSize(Math.max(16, Math.round(width * this.scale)), Math.max(16, Math.round(height * this.scale)));
  }

  render(renderer, scene, camera) {
    const cam = camera.position;
    this.frustum.setFromProjectionMatrix(this.tmp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const visible = cam.y > WATER_LEVEL + 0.05 && this.frustum.intersectsSphere(this.sphere) &&
      cam.distanceTo(this.sphere.center) < 900;
    this.u.uReflOn.value = visible ? 1 : 0;
    if (!visible) return;
    const n = new THREE.Vector3(0, 1, 0);
    const p0 = this.sphere.center;
    const v = this.camera;
    // Mirror the camera position and its view direction in the plane y = WATER_LEVEL.
    v.position.set(cam.x, 2 * WATER_LEVEL - cam.y, cam.z);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(cam);
    look.y = 2 * WATER_LEVEL - look.y;
    v.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    v.lookAt(look);
    v.near = camera.near;
    v.far = camera.far;
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);
    // Texture matrix: world -> reflection texture coordinates.
    this.u.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);
    // Oblique near plane at the water surface (Lengyel).
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0).applyMatrix4(v.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = v.projectionMatrix.elements;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm[8]) / pm[0],
      (Math.sign(clip.y) + pm[9]) / pm[5],
      -1,
      (1 + pm[10]) / pm[14],
    );
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1 - 0.003;
    pm[14] = clip.w;
    v.projectionMatrixInverse.copy(v.projectionMatrix).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.lake.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, v);
    this.lake.visible = true;
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadow;
  }
}
