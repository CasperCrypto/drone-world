// cinematic.js — the camera look: smooth edges, air, sun glare, lens.
//
// Does, as post-processing passes on the high-dynamic-range image:
//   DepthTap: remembers the scene's depth for the passes after it;
//   AtmospherePass: haze that thins with height (exact integral of an
//     exponential height fog along each view ray), lit by the sky and by
//     the sun with a forward-scattering glow (Henyey-Greenstein phase), so
//     distant hills fade into warm air and the sun blooms through it; and
//     a lens flare (starburst and ghosts) when the sun is on screen and
//     not hidden;
//   TAAPass: temporal anti-aliasing: the camera is shifted by a fraction
//     of a pixel every frame and the frames are blended, with reprojection
//     from the depth buffer and neighbourhood clipping against ghosts, so
//     edges, grass and leaves stop flickering;
//   LensPass: camera motion blur (from the same reprojection) and a soft
//     depth of field focused on the drone;
//   FinalPass (after tone mapping): sharpening, colour grade, chromatic
//     aberration at the edges, vignette and a faint film grain.
// The drone's own materials write alpha 0.5 (drone-mesh.js), so it is
// never smeared by motion blur and keeps less history in TAA.
// Does NOT: volumetric clouds, screen-space reflections, real bokeh shapes.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { env } from './shaders.js';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Draws a full-screen pass without clearing first: clearing would also wipe
// the depth buffer the later passes still read.
function draw(renderer, target, quad) {
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.autoClear = autoClear;
}

// Shared between the passes of one frame: depth, matrices, camera.
export class FrameContext {
  constructor(camera) {
    this.camera = camera;
    this.depth = null;
    this.invViewProj = new THREE.Matrix4(); // current, jittered (matches the depth buffer)
    this.viewProj = new THREE.Matrix4(); // current, without jitter
    this.prevViewProj = new THREE.Matrix4(); // previous frame, without jitter
    this.historyValid = false;
    this.droneFollow = true; // the camera moves with the drone (chase view)
    this.focus = 2.3; // metres, depth of field
    this.dof = 0;
    this.dt = 1 / 60;
    this.time = 0;
    this.jitter = new THREE.Vector2();
    this.frame = 0;
  }
}

/** Records the depth texture of the buffer the scene was just drawn into. */
export class DepthTap extends Pass {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.ctx.depth = readBuffer.depthTexture;
  }
}

// Reconstructing a world position from a depth sample, shared GLSL.
const WORLD_POS = /* glsl */ `
vec3 worldPos(vec2 uv, float d, mat4 invVP) {
  vec4 p = invVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}`;

// ---------------------------------------------------------------------------
export class AtmospherePass extends Pass {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.density = 0.0004;
    this.scaleHeight = 900;
    this.base = 0;
    this.flare = 1;
    this.visTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.visMaterial = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uSunUv: { value: new THREE.Vector2() }, uRadius: { value: new THREE.Vector2() } },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uSunUv;
uniform vec2 uRadius;
varying vec2 vUv;
void main() {
  // How much of a small disc around the sun is open sky (depth at the far plane).
  float open = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / 16.0);
    vec2 uv = uSunUv + vec2(cos(a), sin(a)) * r * uRadius;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    open += inside * step(0.99999, texture2D(tDepth, uv).x);
  }
  gl_FragColor = vec4(vec3(open / 16.0), 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    });
    this.visQuad = new FullScreenQuad(this.visMaterial);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tVis: { value: this.visTarget.texture },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uDensity: { value: 0 },
        uScaleH: { value: 900 },
        uBase: { value: 0 },
        uAmbient: env.uAmbient,
        uSunColor: env.uSunColor,
        uSunDir: env.uSunDir,
        uSunUv: { value: new THREE.Vector2() },
        uSunOnScreen: { value: 0 },
        uAspect: { value: 1 },
        uFlare: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tVis;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform float uDensity;
uniform float uScaleH;
uniform float uBase;
uniform vec3 uAmbient;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec2 uSunUv;
uniform float uSunOnScreen;
uniform float uAspect;
uniform float uFlare;
varying vec2 vUv;
${WORLD_POS}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float d = texture2D(tDepth, vUv).x;
  bool sky = d > 0.99999;
  vec3 wp = worldPos(vUv, sky ? 0.5 : d, uInvViewProj);
  vec3 rd = wp - uCamPos;
  float L = length(rd);
  rd /= max(L, 1e-4);
  // Optical depth of a haze whose density falls off exponentially with
  // height: the exact integral along the ray (to infinity for the sky).
  float h = uDensity * exp(-(uCamPos.y - uBase) / uScaleH);
  float vy = rd.y;
  float tau;
  if (sky) {
    tau = vy > 0.002 ? h * uScaleH / vy : 60.0;
  } else if (abs(vy) < 1e-4) {
    tau = h * L;
  } else {
    tau = h * uScaleH * (1.0 - exp(clamp(-L * vy / uScaleH, -60.0, 60.0))) / vy;
  }
  float T = exp(-min(tau, 60.0));
  // Light scattered towards the eye: sky light all round, sunlight mostly
  // forward (Henyey-Greenstein, g = 0.72), which makes the glow round the sun.
  float cosT = dot(rd, uSunDir);
  const float g = 0.72;
  float hg = (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * cosT, 1.5));
  vec3 col;
  if (sky) {
    // The sky already holds its own haze: keep its colour, add only the
    // warm glow round the sun.
    col = c.rgb + uSunColor * hg * 1.2 * (1.0 - exp(-min(tau, 60.0) * 0.5));
  } else {
    vec3 inscatter = uAmbient * 1.1 + uSunColor * hg * 1.6;
    col = c.rgb * T + inscatter * (1.0 - T);
  }

  // Lens flare: a starburst and a few ghosts while the sun is visible.
  float vis = texture2D(tVis, vec2(0.5)).r * uSunOnScreen * uFlare;
  if (vis > 0.001) {
    vec2 dv = (vUv - uSunUv) * vec2(uAspect, 1.0);
    float r = length(dv);
    float ang = atan(dv.y, dv.x);
    float star = (pow(max(0.0, cos(ang * 3.0 + 0.4)), 60.0) + 0.7 * pow(max(0.0, cos(ang * 5.0 + 1.9)), 90.0)) * exp(-r * 6.0);
    float halo = exp(-r * 22.0) * 0.6 + smoothstep(0.02, 0.0, abs(r - 0.32)) * 0.04;
    vec3 ghosts = vec3(0.0);
    vec2 axis = vec2(0.5) - uSunUv;
    for (int i = 0; i < 4; i++) {
      float s = 0.45 + float(i) * 0.42;
      float rad = 0.025 + float(i) * 0.03;
      vec2 gp = uSunUv + axis * s * 2.0;
      float gd = length((vUv - gp) * vec2(uAspect, 1.0));
      vec3 tint = i == 0 ? vec3(0.5, 0.8, 1.0) : i == 1 ? vec3(1.0, 0.6, 0.3) : i == 2 ? vec3(0.5, 1.0, 0.6) : vec3(0.8, 0.5, 1.0);
      ghosts += tint * smoothstep(rad, rad * 0.55, gd) * 0.05;
    }
    col += uSunColor * vis * (star * 0.45 + halo + ghosts);
  }
  gl_FragColor = vec4(col, c.a);
}`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.sunNdc = new THREE.Vector3();
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
  }

  render(renderer, writeBuffer, readBuffer) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    // Where the sun is on screen.
    this.sunNdc.copy(env.uSunDir.value).multiplyScalar(5000).add(cam.position).project(cam);
    const camDir = cam.getWorldDirection(new THREE.Vector3());
    const facing = camDir.dot(env.uSunDir.value);
    const onScreen = facing > 0 && Math.abs(this.sunNdc.x) < 1.3 && Math.abs(this.sunNdc.y) < 1.3 && env.uSunDir.value.y > -0.02;
    const sunUv = new THREE.Vector2(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
    if (onScreen) {
      const v = this.visMaterial.uniforms;
      v.tDepth.value = ctx.depth;
      v.uSunUv.value.copy(sunUv);
      v.uRadius.value.set(10 / this.width, 10 / this.height);
      renderer.setRenderTarget(this.visTarget);
      this.visQuad.render(renderer);
    }
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = ctx.depth;
    u.uInvViewProj.value.copy(ctx.invViewProj);
    u.uCamPos.value.copy(cam.position);
    u.uDensity.value = this.density;
    u.uScaleH.value = this.scaleHeight;
    u.uBase.value = this.base;
    u.uSunUv.value.copy(sunUv);
    u.uSunOnScreen.value = onScreen ? Math.min(1, facing * 3) * THREE.MathUtils.smoothstep(env.uSunDir.value.y, -0.02, 0.04) : 0;
    u.uAspect.value = this.width / Math.max(1, this.height);
    u.uFlare.value = this.flare;
    draw(renderer, this.renderToScreen ? null : writeBuffer, this.quad);
  }
}

// ---------------------------------------------------------------------------
// Halton (2, 3) sub-pixel offsets, eight of them, centred on zero.
const JITTER = Array.from({ length: 8 }, (_, i) => {
  const halton = (n, b) => {
    let f = 1;
    let r = 0;
    for (let k = n; k > 0; k = Math.floor(k / b)) {
      f /= b;
      r += f * (k % b);
    }
    return r;
  };
  return [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5];
});

export class TAAPass extends Pass {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.history = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];
    this.index = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCurViewProj: { value: new THREE.Matrix4() },
        uHistoryValid: { value: 0 },
        uDroneFollow: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform mat4 uCurViewProj;
uniform float uHistoryValid;
uniform float uDroneFollow;
varying vec2 vUv;
${WORLD_POS}

// Clipping is done on tone-mapped colours (Karis), so bright pixels do not dominate.
vec3 tm(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c) { return c / max(1e-4, 1.0 - max(c.r, max(c.g, c.b))); }
vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

// Catmull-Rom history sample from five bilinear taps: stays sharp over time.
vec3 sampleHistory(vec2 uv) {
  vec2 size = 1.0 / uTexel;
  vec2 p = uv * size;
  vec2 c = floor(p - 0.5) + 0.5;
  vec2 f = p - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0 = (c - 1.0) * uTexel;
  vec2 t3 = (c + 2.0) * uTexel;
  vec2 t12 = (c + o12) * uTexel;
  vec3 r = texture2D(tHistory, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture2D(tHistory, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture2D(tHistory, t12).rgb * (w12.x * w12.y)
         + texture2D(tHistory, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture2D(tHistory, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, 0.0);
}

void main() {
  vec4 cur = texture2D(tColor, vUv);
  float d = texture2D(tDepth, vUv).x;
  vec4 wp = vec4(worldPos(vUv, d, uInvViewProj), 1.0);
  vec4 pc = uPrevViewProj * wp;
  vec4 cc = uCurViewProj * wp;
  vec2 vel = cc.xy / cc.w * 0.5 - pc.xy / pc.w * 0.5;
  bool drone = cur.a > 0.3 && cur.a < 0.7;
  if (drone) vel *= 1.0 - uDroneFollow; // the chase camera moves with it
  vec2 hUv = vUv - vel;

  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 mn = vec3(1e5);
  vec3 mx = vec3(-1e5);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = toYCoCg(tm(texture2D(tColor, vUv + vec2(float(x), float(y)) * uTexel).rgb));
      m1 += s;
      m2 += s * s;
      mn = min(mn, s);
      mx = max(mx, s);
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sd = sqrt(abs(m2 / 9.0 - mean * mean));
  vec3 bmin = max(mn, mean - 1.25 * sd);
  vec3 bmax = min(mx, mean + 1.25 * sd);
  vec3 now = toYCoCg(tm(cur.rgb));
  vec3 hist = toYCoCg(tm(sampleHistory(hUv)));
  // Pull the history into the colour range of this frame's neighbourhood.
  vec3 centre = 0.5 * (bmax + bmin);
  vec3 ext = 0.5 * (bmax - bmin) + 1e-4;
  vec3 v = hist - centre;
  vec3 a = abs(v / ext);
  float m = max(a.x, max(a.y, a.z));
  if (m > 1.0) hist = centre + v / m;
  float w = 0.9;
  if (uHistoryValid < 0.5 || hUv.x < 0.0 || hUv.y < 0.0 || hUv.x > 1.0 || hUv.y > 1.0) w = 0.0;
  if (drone) w = min(w, 0.6);
  w *= clamp(1.0 - length(vel / uTexel) * 0.015, 0.7, 1.0); // less history when the view moves fast
  vec3 outc = itm(fromYCoCg(mix(now, hist, w)));
  gl_FragColor = vec4(outc, cur.a);
}`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VERTEX,
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }',
      depthTest: false,
      depthWrite: false,
    });
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
  }

  /** The sub-pixel offset for this frame, in pixels. */
  static jitter(frame) {
    return JITTER[frame % JITTER.length];
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    for (const rt of this.history) rt.setSize(width, height);
    this.ctx.historyValid = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const ctx = this.ctx;
    const u = this.material.uniforms;
    const prev = this.history[this.index];
    const next = this.history[1 - this.index];
    u.tColor.value = readBuffer.texture;
    u.tHistory.value = prev.texture;
    u.tDepth.value = ctx.depth;
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    u.uInvViewProj.value.copy(ctx.invViewProj);
    u.uPrevViewProj.value.copy(ctx.prevViewProj);
    u.uCurViewProj.value.copy(ctx.viewProj);
    u.uHistoryValid.value = ctx.historyValid ? 1 : 0;
    u.uDroneFollow.value = ctx.droneFollow ? 1 : 0;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.copyMaterial.uniforms.tDiffuse.value = next.texture;
    draw(renderer, this.renderToScreen ? null : writeBuffer, this.copyQuad);
    this.index = 1 - this.index;
    ctx.historyValid = true;
  }
}

// ---------------------------------------------------------------------------
export class LensPass extends Pass {
  constructor(ctx, { motionBlur = true, dof = true } = {}) {
    super();
    this.ctx = ctx;
    this.motionBlur = motionBlur;
    this.dofOn = dof;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.blurA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.blurB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  // Nine-tap Gaussian from five bilinear fetches.
  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270;
  c += texture2D(tDiffuse, vUv + uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(tDiffuse, vUv - uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(tDiffuse, vUv + uDir * 3.2307692).rgb * 0.0702703;
  c += texture2D(tDiffuse, vUv - uDir * 3.2307692).rgb * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    });
    this.blurQuad = new FullScreenQuad(this.blurMaterial);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tBlur: { value: this.blurA.texture },
        uTexel: { value: new THREE.Vector2() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCurViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uShutter: { value: 0 },
        uFocus: { value: 2.3 },
        uDof: { value: 0 },
        uDroneFollow: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
uniform vec2 uTexel;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform mat4 uCurViewProj;
uniform vec3 uCamPos;
uniform float uShutter;
uniform float uFocus;
uniform float uDof;
uniform float uDroneFollow;
varying vec2 vUv;
${WORLD_POS}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = c.rgb;
  float d = texture2D(tDepth, vUv).x;
  bool sky = d > 0.99999;
  bool drone = c.a > 0.3 && c.a < 0.7;
  vec3 wp = worldPos(vUv, d, uInvViewProj);
  if (uShutter > 0.0 && !(drone && uDroneFollow > 0.5)) {
    vec4 pc = uPrevViewProj * vec4(wp, 1.0);
    vec4 cc = uCurViewProj * vec4(wp, 1.0);
    vec2 vel = (cc.xy / cc.w - pc.xy / pc.w) * 0.5 * uShutter;
    float px = length(vel / uTexel);
    if (px > 1.0) {
      vel *= min(1.0, 32.0 / px);
      vec3 acc = col;
      float n = 1.0;
      for (int i = 1; i < 8; i++) {
        float t = float(i) / 7.0 - 0.5;
        vec4 s = texture2D(tDiffuse, vUv - vel * t);
        if (!(s.a > 0.3 && s.a < 0.7)) { acc += s.rgb; n += 1.0; } // the drone does not smear into the background
      }
      col = acc / n;
    }
  }
  if (uDof > 0.0) {
    // Soft background and very near foreground, sharp round the drone.
    float z = sky ? 1e5 : length(wp - uCamPos);
    // Subtle: a flying game must still show where you are going.
    float coc = 0.55 * smoothstep(uFocus * 10.0, uFocus * 90.0, z) + smoothstep(uFocus * 0.55, uFocus * 0.25, z);
    col = mix(col, texture2D(tBlur, vUv).rgb, clamp(coc, 0.0, 1.0) * uDof);
  }
  gl_FragColor = vec4(col, c.a);
}`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    const w = Math.max(1, Math.ceil(width / 2));
    const h = Math.max(1, Math.ceil(height / 2));
    this.blurA.setSize(w, h);
    this.blurB.setSize(w, h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const ctx = this.ctx;
    const dof = this.dofOn ? ctx.dof : 0;
    if (dof > 0) {
      // Half-resolution blur: downsample with a horizontal pass, then vertical, twice.
      const b = this.blurMaterial.uniforms;
      const tw = 1 / this.blurA.width;
      const th = 1 / this.blurA.height;
      b.tDiffuse.value = readBuffer.texture;
      b.uDir.value.set(tw, 0);
      renderer.setRenderTarget(this.blurB);
      this.blurQuad.render(renderer);
      b.tDiffuse.value = this.blurB.texture;
      b.uDir.value.set(0, th);
      renderer.setRenderTarget(this.blurA);
      this.blurQuad.render(renderer);
      b.tDiffuse.value = this.blurA.texture;
      b.uDir.value.set(tw * 2, 0);
      renderer.setRenderTarget(this.blurB);
      this.blurQuad.render(renderer);
      b.tDiffuse.value = this.blurB.texture;
      b.uDir.value.set(0, th * 2);
      renderer.setRenderTarget(this.blurA);
      this.blurQuad.render(renderer);
    }
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = ctx.depth;
    u.uTexel.value.set(1 / this.width, 1 / this.height);
    u.uInvViewProj.value.copy(ctx.invViewProj);
    u.uPrevViewProj.value.copy(ctx.prevViewProj);
    u.uCurViewProj.value.copy(ctx.viewProj);
    u.uCamPos.value.copy(ctx.camera.position);
    // A film camera's 180° shutter: the blur covers half the frame time, as seen at 60 Hz.
    u.uShutter.value = this.motionBlur && ctx.historyValid ? Math.min(1, (0.5 / 60) / Math.max(ctx.dt, 1 / 240)) : 0;
    u.uFocus.value = ctx.focus;
    u.uDof.value = dof;
    u.uDroneFollow.value = ctx.droneFollow ? 1 : 0;
    draw(renderer, this.renderToScreen ? null : writeBuffer, this.quad);
  }
}

// ---------------------------------------------------------------------------
// After tone mapping: display-space finishing.
export class FinalPass extends Pass {
  constructor(ctx, look = {}) {
    super();
    this.ctx = ctx;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uSharpen: { value: look.sharpen ?? 0.35 },
        uSat: { value: look.sat ?? 1.18 },
        uContrast: { value: look.contrast ?? 0.18 },
        uSplit: { value: look.split ?? 1 },
        uCA: { value: look.ca ?? 0.0035 },
        uVignette: { value: look.vignette ?? 0.32 },
        uGrain: { value: look.grain ?? 0.012 },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uTime;
uniform float uSharpen;
uniform float uSat;
uniform float uContrast;
uniform float uSplit;
uniform float uCA;
uniform float uVignette;
uniform float uGrain;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  // Lens colour fringes, only towards the corners.
  vec2 off = d * r2 * uCA * 4.0;
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 col = vec3(texture2D(tDiffuse, vUv - off).r, c.g, texture2D(tDiffuse, vUv + off).b);
  // Light sharpening: TAA softens a little.
  vec3 nb = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
          + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
  col = max(col + (col - nb * 0.25) * uSharpen, 0.0);
  // Grade: saturation, a gentle S-curve, teal shadows and warm highlights.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = clamp(col, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
  col += uSplit * (vec3(-0.018, 0.004, 0.022) * (1.0 - l) * (1.0 - l) + vec3(0.03, 0.012, -0.022) * l * l);
  // Vignette and a faint, moving film grain.
  col *= 1.0 - uVignette * smoothstep(0.08, 0.6, r2 * 1.8);
  col += (hash(vUv / uTexel + fract(uTime) * 1000.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.uTime.value = this.ctx.time;
    draw(renderer, this.renderToScreen ? null : writeBuffer, this.quad);
  }
}
