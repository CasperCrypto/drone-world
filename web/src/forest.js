// forest.js — places and draws the trees.
//
// Does: plants a forest where terrain.forestDensity() says, in stands of
// Scots pine, Norway spruce, oak and birch (birch and oak at the edges),
// several thousand trees; draws each one at one of three levels of detail:
//   near: the full mesh from trees.js (bark, leaf cards, swaying in the wind),
//   mid:  the simpler mesh with the same silhouette,
//   far:  an impostor, a picture of the tree baked at load time from eight
//         directions (colour and normals), turned to face the camera and lit
//         by the sun like the real mesh.
// Keeps simple collision shapes (trunk cylinder, crown cylinder or cone) for
// the drone.
// Does NOT: simulate branches breaking or leaves falling.

import * as THREE from 'three';
import { HALF } from './layout.js';
import { buildTree, SPECIES } from './trees.js';
import { env, WIND_GLSL, linkEnv } from './shaders.js';

const SPECIES_KEYS = ['pine', 'spruce', 'oak', 'birch'];
const VARIANTS_PER_SPECIES = 2;
const ATLAS_VIEWS = 8;
const ATLAS_CELL = 256;
const BAKE_ELEVATION = 18 * Math.PI / 180; // impostors are seen from above more often than from the side

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Shared GLSL: sway a vertex (world space, already moved by instanceMatrix).
const SWAY_GLSL = /* glsl */ `
attribute vec3 aWind; // height fraction, flexibility, phase
uniform float uTreeH;
${WIND_GLSL}
vec3 dwSway(vec3 wp, vec3 base, float scale) {
  float H = uTreeH * scale;
  float wind = max(dwMeanWind(H * 0.75) + dwGust(base.xz), 0.0);
  float hf = clamp(aWind.x, 0.0, 1.2);
  // Whole tree: bends with the drag (grows with wind speed squared) and rocks around it.
  float lean = clamp(0.0006 * wind * wind, 0.0, 0.05) * H;
  float rock = sin(uTime * (0.55 + 0.25 * fract(base.x * 0.013)) + base.z * 0.05) * (0.15 + 0.004 * wind * wind) * 0.12;
  vec2 d = uWindDir * (lean + rock * H * 0.04) * hf * hf;
  // Branches and leaves: quick flutter, more in stronger wind.
  float flex = aWind.y;
  float f = sin(uTime * (2.2 + wind * 0.35) + aWind.z * 6.2831 + dot(wp.xz, vec2(0.37, 0.23)));
  float g = sin(uTime * (3.7 + wind * 0.2) + aWind.z * 12.0 + wp.y * 0.5);
  float amp = flex * (0.015 + 0.01 * wind) * min(scale, 1.3);
  vec3 off = vec3(d.x, 0.0, d.y);
  off += vec3(uWindDir.x * f, 0.4 * g, uWindDir.y * f) * amp;
  off += vec3(-uWindDir.y, 0.0, uWindDir.x) * g * amp * 0.6;
  return off;
}`;

const PROJECT_WITH_SWAY = /* glsl */ `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  vec3 dwBase = instanceMatrix[3].xyz;
  float dwScale = length(instanceMatrix[1].xyz);
  mvPosition = instanceMatrix * mvPosition;
#else
  vec3 dwBase = vec3(0.0);
  float dwScale = 1.0;
#endif
mvPosition.xyz += dwSway(mvPosition.xyz, dwBase, dwScale);
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

function addSway(material, treeH, cacheKey, extraFragment) {
  material.customProgramCacheKey = () => cacheKey;
  material.onBeforeCompile = (shader) => {
    linkEnv(shader, ['uTime', 'uWindDir', 'uWind10', 'uGustK', 'uGustAmp', 'uGustPhase', 'uSunDir', 'uSunColor', 'uSnow']);
    shader.uniforms.uTreeH = { value: treeH };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SWAY_GLSL}\nvarying float vSnowUp;`)
      .replace('#include <project_vertex>', `${PROJECT_WITH_SWAY}\nvSnowUp = normalize(mat3(modelMatrix) * normal).y;`);
    // Snow settles on the upper side of branches and leaves.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSnow;\nvarying float vSnowUp;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.85, 0.9), uSnow * 0.75 * smoothstep(0.15, 0.7, vSnowUp));');
    if (extraFragment) extraFragment(shader);
  };
}

export class Forest {
  constructor(scene, terrain, textures, quality) {
    this.scene = scene;
    this.terrain = terrain;
    this.textures = textures;
    this.quality = quality;
    this.trees = [];
    this.grid = new Map();
    this.lastBucket = new THREE.Vector3(1e9, 0, 0);
    this.dir = new THREE.Vector3();
    this.lastDir = new THREE.Vector3();
  }

  /** Builds geometry and materials, plants the trees, bakes impostors. */
  async build(renderer, onProgress = () => {}) {
    const tx = this.textures;
    this.variants = [];
    let v = 0;
    for (const key of SPECIES_KEYS) {
      const sp = SPECIES[key];
      const barkMat = new THREE.MeshStandardMaterial({
        map: tx.treeTexture(`bark/${sp.bark}_color_1k.jpg`, true),
        normalMap: tx.treeTexture(`bark/${sp.bark}_normal_1k.jpg`, false),
        roughnessMap: tx.treeTexture(`bark/${sp.bark}_roughness_1k.jpg`, false),
        aoMap: tx.treeTexture(`bark/${sp.bark}_ao_1k.jpg`, false),
        roughness: 1,
        metalness: 0,
      });
      const leafTex = tx.treeTexture(`leaves/${sp.leaf}_color.png`, true);
      const tint = new THREE.Color(...sp.leaves.tint);
      for (let i = 0; i < VARIANTS_PER_SPECIES; i++) {
        const seed = 1000 + v * 7919;
        const lod0 = buildTree(key, seed, 0);
        const lod1 = buildTree(key, seed, 1);
        this.variants.push({ key, index: v, lod0, lod1, barkMat, leafTex, tint, conifer: key === 'spruce' || key === 'pine' });
        v++;
        onProgress((v / (SPECIES_KEYS.length * VARIANTS_PER_SPECIES)) * 0.4);
        await new Promise((r) => setTimeout(r, 0)); // let the loading screen draw
      }
    }
    for (const variant of this.variants) this.makeMaterials(variant);
    this.plant();
    onProgress(0.6);
    await tx.settle();
    this.bakeImpostors(renderer);
    onProgress(0.9);
    this.makeInstances();
    onProgress(1);
  }

  makeMaterials(variant) {
    const H = variant.lod0.height;
    const bark = variant.barkMat.clone();
    addSway(bark, H, 'dw-tree-bark');
    const leafMat = new THREE.MeshStandardMaterial({
      map: variant.leafTex,
      alphaTest: 0.42,
      // With multisampling, soft leaf edges instead of hard, flickering cut-outs.
      alphaToCoverage: this.quality.msaa > 0,
      side: THREE.DoubleSide,
      roughness: 0.78,
      metalness: 0,
      color: variant.tint,
    });
    addSway(leafMat, H, 'dw-tree-leaves', (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uSunColor;')
        // Keep the outward crown normals on both faces of a card.
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
        // Sunlight through the leaves when looking toward the sun.
        .replace('#include <emissivemap_fragment>', `
vec3 dwV = normalize(-vViewPosition);
vec3 dwSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
float dwBack = pow(max(dot(-dwV, dwSunV), 0.0), 4.0);
totalEmissiveRadiance += diffuseColor.rgb * uSunColor * (0.04 + 0.22 * dwBack);`);
    });
    const depth = (map) => {
      const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: map ? 0.42 : 0 });
      addSway(m, H, map ? 'dw-tree-depth-leaves' : 'dw-tree-depth-bark');
      return m;
    };
    variant.mat = { bark, leaves: leafMat, barkDepth: depth(null), leafDepth: depth(variant.leafTex) };
  }

  plant() {
    const t = this.terrain;
    const r = rng(9001);
    const spacing = 5.2;
    const half = HALF - 12;
    for (let gz = -half; gz < half; gz += spacing) {
      for (let gx = -half; gx < half; gx += spacing) {
        const x = gx + (r() - 0.5) * spacing * 0.9;
        const z = gz + (r() - 0.5) * spacing * 0.9;
        const density = t.forestDensity(x, z);
        if (r() > density * 1.15) continue;
        const n = t.normalAt(x, z);
        if (n.y < 0.8) continue;
        const y = t.heightAt(x, z);
        // Stands: pine dominates, spruce in cool hollows, oak and birch at the edges.
        const stand = t.fbm(x + 1000, z - 400, 2, 1 / 230, 1);
        let key;
        if (density < 0.55 && r() < 0.65) key = r() < 0.55 ? 'birch' : 'oak';
        else if (stand > 0.12) key = 'pine';
        else if (stand < -0.12) key = 'spruce';
        else key = ['pine', 'oak', 'spruce', 'birch'][Math.floor(r() * 4)];
        const variant = this.variants.filter((vv) => vv.key === key)[Math.floor(r() * VARIANTS_PER_SPECIES)];
        const scale = (0.72 + r() * 0.45) * (0.75 + 0.3 * density);
        const tree = {
          x, y: y - 0.05, z, yaw: r() * Math.PI * 2, scale, variant,
          height: variant.lod0.height * scale,
          crownR: variant.lod0.crownRadius * scale * 0.7,
          crownBase: variant.lod0.crownBase * scale,
          trunkR: variant.lod0.trunkRadius * scale,
          conifer: variant.conifer,
          lod: -1,
        };
        this.trees.push(tree);
        const key2 = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
        if (!this.grid.has(key2)) this.grid.set(key2, []);
        this.grid.get(key2).push(tree);
      }
    }
  }

  // Render every variant from ATLAS_VIEWS directions into a colour and a normal atlas.
  bakeImpostors(renderer) {
    const cols = ATLAS_VIEWS;
    const rows = this.variants.length;
    const w = cols * ATLAS_CELL;
    const h = rows * ATLAS_CELL;
    const make = (srgb) => {
      const rt = new THREE.WebGLRenderTarget(w, h, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      rt.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return rt;
    };
    const colorRT = make(true);
    const normalRT = make(false);
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera();
    // Kept pixels are written fully opaque, so mipmaps average colour and
    // coverage separately and the impostor shader can divide one by the other.
    const albedoMat = (map, alpha, tint = new THREE.Color(1, 1, 1)) => new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { map: { value: map }, useAlpha: { value: alpha ? 1 : 0 }, tint: { value: tint } },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform float useAlpha; uniform vec3 tint; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(map, vUv);
          if (useAlpha > 0.5 && c.a < 0.42) discard;
          gl_FragColor = vec4(c.rgb * tint, 1.0);
        }`,
    });
    const normalMat = (map, alpha) => new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { map: { value: map }, useMap: { value: alpha ? 1 : 0 } },
      vertexShader: `varying vec3 vN; varying vec2 vUv;
        void main() { vUv = uv; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform float useMap; varying vec3 vN; varying vec2 vUv;
        void main() {
          if (useMap > 0.5 && texture2D(map, vUv).a < 0.42) discard;
          gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
        }`,
    });
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    for (const rt of [colorRT, normalRT]) {
      renderer.setRenderTarget(rt);
      renderer.clear();
    }
    this.variants.forEach((variant, row) => {
      const t = variant.lod0;
      const bark = new THREE.Mesh(t.bark);
      const leaves = new THREE.Mesh(t.leaves);
      scene.add(bark, leaves);
      const half = Math.max(t.crownRadius, t.height / 2) * 1.15;
      const centerY = t.height / 2;
      Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 200 });
      cam.updateProjectionMatrix();
      variant.impostor = { width: half * 2, height: half * 2, centerY, row };
      for (let view = 0; view < cols; view++) {
        const a = (view / cols) * Math.PI * 2;
        const ce = Math.cos(BAKE_ELEVATION);
        cam.position.set(Math.sin(a) * 80 * ce, centerY + 80 * Math.sin(BAKE_ELEVATION), Math.cos(a) * 80 * ce);
        cam.lookAt(0, centerY, 0);
        for (const [rt, kind] of [[colorRT, 'color'], [normalRT, 'normal']]) {
          bark.material = kind === 'color' ? albedoMat(variant.barkMat.map, false) : normalMat(null, false);
          leaves.material = kind === 'color' ? albedoMat(variant.leafTex, true, variant.tint) : normalMat(variant.leafTex, true);
          renderer.setRenderTarget(rt);
          rt.viewport.set(view * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL);
          rt.scissor.set(view * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL);
          rt.scissorTest = true;
          renderer.render(scene, cam);
          bark.material.dispose();
          leaves.material.dispose();
        }
      }
      scene.remove(bark, leaves);
    });
    for (const rt of [colorRT, normalRT]) {
      rt.scissorTest = false;
      rt.viewport.set(0, 0, w, h);
      rt.scissor.set(0, 0, w, h);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.toneMapping = prevTone;
    this.atlas = { color: colorRT.texture, normal: normalRT.texture, cols, rows };
  }

  makeInstances() {
    const max = (v) => this.trees.filter((t) => t.variant === v).length;
    for (const v of this.variants) {
      const n = Math.max(1, max(v));
      const mk = (geo, mat, depthMat) => {
        const m = new THREE.InstancedMesh(geo, mat, n);
        m.count = 0;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.customDepthMaterial = depthMat;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(m);
        return m;
      };
      v.near = { bark: mk(v.lod0.bark, v.mat.bark, v.mat.barkDepth), leaves: mk(v.lod0.leaves, v.mat.leaves, v.mat.leafDepth) };
      v.mid = { bark: mk(v.lod1.bark, v.mat.bark, v.mat.barkDepth), leaves: mk(v.lod1.leaves, v.mat.leaves, v.mat.leafDepth) };
    }
    this.makeImpostorMesh();
  }

  makeImpostorMesh() {
    const n = this.trees.length;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.impPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.impParams = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.impPos);
    geo.setAttribute('iParams', this.impParams);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: this.atlas.color },
        uNormal: { value: this.atlas.normal },
        uCols: { value: this.atlas.cols },
        uRows: { value: this.atlas.rows },
        uBakeElev: { value: BAKE_ELEVATION },
        ...pick(env, ['uTime', 'uWindDir', 'uWind10', 'uGustK', 'uGustAmp', 'uGustPhase', 'uSunDir', 'uSunColor', 'uAmbient', 'uGroundAmbient', 'uFogColor', 'uFogDensity', 'uSnow']),
      },
      vertexShader: /* glsl */ `
attribute vec3 iPos;
attribute vec4 iParams; // height, width, yaw, atlas row
uniform float uCols;
uniform float uRows;
${WIND_GLSL}
varying vec2 vUv;
varying vec3 vRight;
varying vec3 vToCam;
varying vec3 vWPos;
void main() {
  vec3 toCam = cameraPosition - iPos;
  toCam.y = 0.0;
  toCam = normalize(toCam);
  vec3 right = vec3(toCam.z, 0.0, -toCam.x);
  float ang = atan(toCam.x, toCam.z) - iParams.z;
  float frame = mod(floor(ang / 6.2831853 * uCols + 0.5), uCols);
  vec3 p = iPos + right * position.x * iParams.y + vec3(0.0, position.y * iParams.x, 0.0);
  float wind = max(dwMeanWind(iParams.x * 0.75) + dwGust(iPos.xz), 0.0);
  float lean = clamp(0.0006 * wind * wind, 0.0, 0.05) * iParams.x * position.y * position.y;
  p.xz += uWindDir * lean;
  vUv = vec2((frame + uv.x) / uCols, (iParams.w + uv.y) / uRows);
  vRight = right;
  vToCam = toCam;
  vWPos = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uNormal;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uBakeElev;
uniform float uSnow;
varying vec2 vUv;
varying vec3 vRight;
varying vec3 vToCam;
varying vec3 vWPos;
void main() {
  vec4 c = texture2D(uColor, vUv);
  if (c.a < 0.35) discard;
  vec3 n = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  // Baked in the view of a camera tilted down by uBakeElev: turn back to world axes.
  float ce = cos(uBakeElev);
  float se = sin(uBakeElev);
  vec3 N = normalize(vRight * n.x + vec3(0.0, 1.0, 0.0) * (ce * n.y + se * n.z) + vToCam * (ce * n.z - se * n.y));
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = mix(uGroundAmbient, uAmbient, 0.5 + 0.5 * N.y);
  // Same units as three.js lights: irradiance times albedo / pi; trees shade themselves a little.
  vec3 albedo = c.rgb / max(c.a, 0.35);
  albedo = mix(albedo, vec3(0.82, 0.85, 0.9), uSnow * 0.75 * smoothstep(0.15, 0.7, N.y));
  // Like the leaf material: direct light, sky light, a share of the sky
  // reflection map, and some light through the leaves.
  vec3 col = albedo * ((uSunColor * ndl * 0.8 + amb * 1.3) * 0.31831 + uSunColor * 0.045);
  float d = distance(vWPos, cameraPosition);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}`,
    });
    this.impostors = new THREE.Mesh(geo, mat);
    this.impostors.frustumCulled = false;
    this.impostors.name = 'tree-impostors';
    this.scene.add(this.impostors);
  }

  /** Re-sort trees into near / mid / far when the camera has moved. */
  update(camera, force = false) {
    const cam = camera.position;
    // Re-sort after moving 6 m or turning 20 degrees (mid trees outside the
    // view are skipped, so turning must bring them back at once).
    camera.getWorldDirection(this.dir);
    const turned = this.dir.dot(this.lastDir) < Math.cos(20 * Math.PI / 180);
    if (!force && !turned && cam.distanceToSquared(this.lastBucket) < 36) return;
    this.lastBucket.copy(cam);
    this.lastDir.copy(this.dir);
    const nearR = this.quality.treeNear;
    const midR = this.quality.treeMid;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    for (const v of this.variants) {
      v.near.bark.count = v.near.leaves.count = 0;
      v.mid.bark.count = v.mid.leaves.count = 0;
    }
    let far = 0;
    const ip = this.impPos.array;
    const pa = this.impParams.array;
    for (const t of this.trees) {
      const d = Math.hypot(t.x - cam.x, t.z - cam.z);
      // A little hysteresis so trees at the boundary do not flicker.
      const near = d < nearR + (t.lod === 0 ? 6 : 0);
      const mid = !near && d < midR + (t.lod === 1 ? 10 : 0);
      if (!near && d > 60) {
        sphere.center.set(t.x, t.y + t.height / 2, t.z);
        sphere.radius = t.height + 25; // margin for turning between re-sorts
        if (!frustum.intersectsSphere(sphere)) { t.lod = -1; continue; }
      }
      if (near || mid) {
        t.lod = near ? 0 : 1;
        m.compose(p.set(t.x, t.y, t.z), q.setFromAxisAngle(yAxis, t.yaw), s.setScalar(t.scale));
        const set = near ? t.variant.near : t.variant.mid;
        set.bark.setMatrixAt(set.bark.count++, m);
        set.leaves.setMatrixAt(set.leaves.count++, m);
      } else {
        t.lod = 2;
        const imp = t.variant.impostor;
        ip[far * 3] = t.x;
        ip[far * 3 + 1] = t.y + imp.centerY * t.scale - (imp.height * t.scale) / 2;
        ip[far * 3 + 2] = t.z;
        pa[far * 4] = imp.height * t.scale;
        pa[far * 4 + 1] = imp.width * t.scale;
        pa[far * 4 + 2] = t.yaw;
        pa[far * 4 + 3] = imp.row;
        far++;
      }
    }
    for (const v of this.variants) {
      for (const set of [v.near, v.mid]) {
        set.bark.instanceMatrix.needsUpdate = true;
        set.leaves.instanceMatrix.needsUpdate = true;
      }
    }
    this.impPos.needsUpdate = true;
    this.impParams.needsUpdate = true;
    this.impostors.geometry.instanceCount = far;
    this.counts = { near: this.trees.filter((t) => t.lod === 0).length, mid: this.trees.filter((t) => t.lod === 1).length, far };
  }

  // Approximate tree-top height (m) at (x, z), for the wind's canopy shelter.
  canopyHeightAt(x, z) {
    const cell = this.grid.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    if (!cell || cell.length < 3) return 0;
    let sum = 0;
    for (const t of cell) sum += t.height;
    return sum / cell.length;
  }

  // Collision with trunks and crowns. Returns null or { point, normal, kind }.
  collide(pos, radius) {
    const cx = Math.floor(pos.x / 16);
    const cz = Math.floor(pos.z / 16);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!cell) continue;
        for (const t of cell) {
          if (pos.y > t.y + t.height || pos.y < t.y) continue;
          let r = t.trunkR;
          if (pos.y > t.y + t.crownBase) {
            const along = Math.min(Math.max((t.y + t.height - pos.y) / (t.height - t.crownBase), 0), 1);
            r = Math.max(t.trunkR, t.conifer ? t.crownR * along : t.crownR);
          }
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
    return null;
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
