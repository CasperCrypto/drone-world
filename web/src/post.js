// post.js — the final image: anti-aliasing, air, glow, tone mapping, grade.
//
// Does: renders the scene into a high-dynamic-range buffer, then:
//   in the Cinematic style (realistic textures): haze with a sun glow and a
//     lens flare, camera motion blur and a soft depth of field, filmic tone
//     mapping (AgX) and a film-like finish (cinematic.js);
//   in the Stylized and Dark studio styles: contact shadows and ink
//     outlines from the depth buffer (below), ACES tone mapping and a
//     colour grade from the style's palette;
// and in every style temporal anti-aliasing (TAA): the camera moves by a
// fraction of a pixel each frame and the frames are blended, so edges,
// grass and leaves stay smooth instead of flickering; and bloom so lamps,
// the drone's lights, the sun and its glints glow.
// Does NOT: screen-space reflections or volumetric clouds.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { palette } from './palette.js';
import { FrameContext, DepthTap, AtmospherePass, TAAPass, LensPass, FinalPass } from './cinematic.js';

export class Post {
  constructor(renderer, scene, camera, quality, style = 'realistic') {
    this.renderer = renderer;
    this.camera = camera;
    const pal = palette(style);
    this.cinematic = !pal;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // No hardware multisampling: TAA smooths the edges instead.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    // The passes read the scene's depth. Each buffer gets its own depth
    // texture: a cloned one would share the GPU texture, and a pass would
    // read the depth it is writing to.
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
      rt.depthTexture.type = THREE.FloatType;
    }
    this.ctx = new FrameContext(camera);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new DepthTap(this.ctx));
    if (pal) {
      this.stylize = new StylizePass(camera, pal, quality.ao);
      this.composer.addPass(this.stylize);
    } else {
      this.atmosphere = new AtmospherePass(this.ctx);
      this.composer.addPass(this.atmosphere);
    }
    this.taa = new TAAPass(this.ctx);
    this.composer.addPass(this.taa);
    if (this.cinematic && (quality.motionBlur || quality.dof)) {
      this.lens = new LensPass(this.ctx, { motionBlur: quality.motionBlur, dof: quality.dof });
      this.composer.addPass(this.lens);
    }
    if (quality.bloom) {
      const b = pal ? pal.bloom : { strength: 0.32, radius: 0.6, threshold: 4 }; // the sky stays below the threshold
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), b.strength, b.radius, b.threshold);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    if (this.cinematic) {
      this.final = new FinalPass(this.ctx);
      this.composer.addPass(this.final);
    } else {
      this.grade = new ShaderPass(GRADE);
      const g = pal.grade;
      const u = this.grade.uniforms;
      u.uSat.value = g.sat;
      u.uLift.value.set(...g.lift);
      u.uSplit.value = g.split;
      u.uCurve.value = g.curve;
      u.uVignette.value = g.vignette;
      this.composer.addPass(this.grade);
    }
    this.pixelRatio = renderer.getPixelRatio();
    this.lastCamPos = new THREE.Vector3(1e9, 0, 0);
    this.bufferSize = size.clone();
  }

  /** Switch the contact shadows off (used when the frame rate is low). */
  disableAO() {
    if (!this.stylize || !this.stylize.aoOn) return false;
    this.stylize.aoOn = false;
    return true;
  }

  /** Switch motion blur and depth of field off (used when the frame rate is low). */
  disableLens() {
    if (!this.lens || !this.lens.enabled) return false;
    this.lens.enabled = false;
    return true;
  }

  /** What the camera looks at: focus distance (m), whether it follows the drone, depth of field 0..1. */
  setView(focus, follow, dof) {
    this.ctx.focus = focus;
    this.ctx.droneFollow = follow;
    this.ctx.dof = dof;
  }

  /** Haze: extinction at the base height (1/m), its scale height (m) and the base height (m). */
  setAtmosphere(density, scaleHeight, base) {
    if (!this.atmosphere) return;
    this.atmosphere.density = density;
    this.atmosphere.scaleHeight = scaleHeight;
    this.atmosphere.base = base;
  }

  setSize(width, height, pixelRatio) {
    this.pixelRatio = pixelRatio;
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.stylize?.setPixelRatio(pixelRatio);
    this.renderer.getDrawingBufferSize(this.bufferSize);
  }

  render(dt) {
    const cam = this.camera;
    const ctx = this.ctx;
    ctx.dt = dt;
    ctx.time += dt;
    // A jump (reset, teleport) starts the blending afresh.
    if (cam.position.distanceTo(this.lastCamPos) > 25) ctx.historyValid = false;
    this.lastCamPos.copy(cam.position);
    cam.updateMatrixWorld();
    ctx.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // Sub-pixel jitter for TAA, only while drawing this frame.
    const [jx, jy] = TAAPass.jitter(ctx.frame++);
    const e = cam.projectionMatrix.elements;
    const ox = (2 * jx) / this.bufferSize.x;
    const oy = (2 * jy) / this.bufferSize.y;
    e[8] += ox;
    e[9] += oy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    ctx.invViewProj.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    this.composer.render(dt);
    e[8] -= ox;
    e[9] -= oy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    ctx.prevViewProj.copy(ctx.viewProj);
  }
}

// Outlines and contact shadows from the depth buffer.
class StylizePass extends Pass {
  constructor(camera, pal, aoSamples) {
    super();
    this.camera = camera;
    this.aoOn = aoSamples > 0;
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.aoTarget.texture.generateMipmaps = false;
    this.aoMaterial = new THREE.ShaderMaterial({
      defines: { AO_SAMPLES: Math.max(1, aoSamples) },
      uniforms: {
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uProjInv: { value: new THREE.Matrix4() },
        uRadius: { value: pal.ao.radius },
        uFocalPx: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: AO_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.aoQuad = new FullScreenQuad(this.aoMaterial);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tAO: { value: this.aoTarget.texture },
        uAOTexel: { value: new THREE.Vector2() },
        uAOStrength: { value: 0 },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFocalPx: { value: 1 },
        uThick: { value: 1 },
        uInk: { value: new THREE.Vector3(...pal.outline.color) },
        uInkStrength: { value: pal.outline.strength },
      },
      vertexShader: VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.aoStrength = pal.ao.strength;
    this.pixelRatio = 1;
  }

  setPixelRatio(r) {
    this.pixelRatio = r;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.aoTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    const focal = (0.5 * this.height) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2); // pixels
    const depth = readBuffer.depthTexture;
    if (this.aoOn) {
      const a = this.aoMaterial.uniforms;
      a.tDepth.value = depth;
      a.uTexel.value.set(1 / this.width, 1 / this.height);
      a.uProjInv.value.copy(cam.projectionMatrixInverse);
      a.uFocalPx.value = focal;
      renderer.setRenderTarget(this.aoTarget);
      this.aoQuad.render(renderer);
    }
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = depth;
    u.uAOTexel.value.set(1 / this.aoTarget.width, 1 / this.aoTarget.height);
    u.uAOStrength.value = this.aoOn ? this.aoStrength : 0;
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uFocalPx.value = focal;
    // About one screen pixel thick, whatever the render resolution.
    u.uThick.value = Math.max(1, this.pixelRatio);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false; // keep the depth buffer for the passes after this one
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.aoTarget.dispose();
    this.aoMaterial.dispose();
    this.material.dispose();
    this.aoQuad.dispose();
    this.quad.dispose();
  }
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Scalable ambient obscurance (McGuire et al. 2012) with normals rebuilt
// from depth. A 4 x 4 pattern of rotations, averaged away by the 4 x 4
// blur in the composite, so there is no grain. Every depth read is snapped
// to a full-resolution pixel centre: this pass runs at half resolution, so
// its own pixel centres fall exactly between depth pixels, and a rounding
// coin-flip there gave wrong normals along whole rows.
const AO_FRAGMENT = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform mat4 uProjInv;
uniform float uRadius;
uniform float uFocalPx;
varying vec2 vUv;

vec2 snapUv(vec2 uv) {
  return (floor(uv / uTexel) + 0.5) * uTexel;
}

// View-space position of the depth pixel at a snapped uv.
vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 p = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec2 uv = snapUv(vUv - 0.25 * uTexel);
  float d = texture2D(tDepth, uv).x;
  if (d > 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(uv);
  vec3 Pr = viewPos(uv + vec2(uTexel.x, 0.0));
  vec3 Pl = viewPos(uv - vec2(uTexel.x, 0.0));
  vec3 Pu = viewPos(uv + vec2(0.0, uTexel.y));
  vec3 Pd = viewPos(uv - vec2(0.0, uTexel.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  float z = -P.z;
  float rPix = min(uRadius * uFocalPx / z, 56.0);
  if (rPix < 1.5) { gl_FragColor = vec4(1.0); return; }
  vec2 fc = floor(mod(gl_FragCoord.xy, 4.0));
  float spin = (fc.x * 4.0 + mod(fc.y * 3.0 + fc.x, 4.0)) / 16.0 * 6.2831853;
  float r2 = uRadius * uRadius;
  float sum = 0.0;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(AO_SAMPLES);
    float a = spin + t * 6.2831853 * 2.618;
    vec2 off = vec2(cos(a), sin(a)) * t * rPix * uTexel;
    vec3 v = viewPos(snapUv(uv + off)) - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - 0.012 * z) / (vv + 0.01), 0.0);
  }
  float ao = max(0.0, 1.0 - sum * 5.0 / (r2 * r2 * r2 * float(AO_SAMPLES)));
  ao = mix(ao, 1.0, smoothstep(160.0, 420.0, z));
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

const COMPOSITE_FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform vec2 uAOTexel;
uniform float uAOStrength;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocalPx;
uniform float uThick;
uniform vec3 uInk;
uniform float uInkStrength;
varying vec2 vUv;

float invZ(vec2 uv) {
  return -1.0 / perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = c.rgb;
  float d = texture2D(tDepth, vUv).x;
  if (d < 0.99999) {
    if (uAOStrength > 0.0) {
      // Four bilinear taps on texel corners: an even 4 x 4 box over the
      // half-resolution buffer, which holds each of the 16 rotations once.
      vec2 corner = floor(vUv / uAOTexel + 0.5) * uAOTexel;
      float ao = 0.25 * (texture2D(tAO, corner + uAOTexel * vec2(-1.0, -1.0)).r
                       + texture2D(tAO, corner + uAOTexel * vec2(1.0, -1.0)).r
                       + texture2D(tAO, corner + uAOTexel * vec2(-1.0, 1.0)).r
                       + texture2D(tAO, corner + uAOTexel * vec2(1.0, 1.0)).r);
      col *= mix(1.0, ao, uAOStrength * (0.5 + 0.5 * c.a)); // half as much on grass blades
    }
    // 1/z is linear across any flat surface on screen, so its second
    // difference is zero there and large at silhouettes and outer creases.
    vec2 o = uTexel * uThick;
    float w0 = invZ(vUv);
    float lap = invZ(vUv - vec2(o.x, 0.0)) + invZ(vUv + vec2(o.x, 0.0))
              + invZ(vUv - vec2(0.0, o.y)) + invZ(vUv + vec2(0.0, o.y)) - 4.0 * w0;
    // Scaled so the measure is the change of surface slope (tan) as seen
    // from the camera: about 2 at a box corner, huge at a silhouette.
    float crease = -lap / w0 * uFocalPx / uThick;
    float z = 1.0 / w0;
    float edge = smoothstep(0.7, 1.6, crease) * (1.0 - smoothstep(110.0, 380.0, z));
    edge *= c.a; // grass writes alpha 0: no ink on every blade
    vec3 ink = min(uInk + col * 0.18, col * 0.6); // never lighter than the surface (night)
    col = mix(col, ink, edge * uInkStrength);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// Colour grade in display space (after tone mapping).
const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    uSat: { value: 1 },
    uLift: { value: new THREE.Vector3() },
    uSplit: { value: 0 },
    uCurve: { value: 0 },
    uVignette: { value: 0 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uSat;
uniform vec3 uLift;
uniform float uSplit;
uniform float uCurve;
uniform float uVignette;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = c.rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  // Cool shadows, slightly warm highlights.
  col += uSplit * (vec3(-0.012, -0.004, 0.018) * (1.0 - l) + vec3(0.016, 0.008, -0.01) * l);
  // S-curve for contrast, then lift the blacks so dark areas stay readable.
  col = clamp(col, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), uCurve);
  col = uLift + col * (1.0 - uLift);
  vec2 d = vUv - 0.5;
  col *= 1.0 - uVignette * dot(d, d) * 1.5;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`,
};
