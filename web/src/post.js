// post.js — the final image: anti-aliasing, glow, tone mapping.
//
// Does: renders the scene into a high-dynamic-range buffer (with hardware
// multisampling where the preset asks for it), adds bloom so lamps, the
// navigation lights, the sun and its glints glow, then tone-maps to the
// screen (ACES filmic) with the exposure the sky sets. SMAA anti-aliasing is
// used on the Low preset instead of multisampling.
// Does NOT: depth of field, motion blur or screen-space reflections.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export class Post {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: quality.msaa });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    if (quality.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.28, 0.55, 1.6);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    if (quality.smaa) {
      this.smaa = new SMAAPass(size.x, size.y);
      this.composer.addPass(this.smaa);
    }
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(dt) {
    this.composer.render(dt);
  }
}
