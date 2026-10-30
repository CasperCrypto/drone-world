// probe.js — what the drone's paint reflects.
//
// Does: a small cube camera that follows the drone and renders the world
// around it (sky, clouds, terrain, trees, buildings; not the grass or the
// rain, not the drone itself), one cube face per frame, then pre-filters
// the cube for rough and glossy reflections (PMREM), about four times a
// second. The drone's materials use it as their environment map, so the
// clear-coat paint shows the real runway, trees and sunset around it.
// Does NOT: reflect moving things between updates, or the drone in itself.

import * as THREE from 'three';

export class ReflectionProbe {
  constructor(renderer, size = 128) {
    this.renderer = renderer;
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.camera = new THREE.CubeCamera(0.5, 3000, this.cubeTarget);
    this.camera.layers.set(0); // grass and rain live on layer 1
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = null;
    this.face = 0;
    this.wait = 0;
    this.started = false;
  }

  /** The pre-filtered environment map, or null before the first update. */
  get texture() {
    return this.envTarget ? this.envTarget.texture : null;
  }

  update(dt, scene, position, hidden) {
    const r = this.renderer;
    this.wait -= dt;
    if (this.face === 0 && this.wait > 0 && this.started) return false;
    if (this.face === 0) {
      this.camera.position.copy(position);
      this.camera.updateMatrixWorld(true);
    }
    hidden.visible = false;
    if (!this.started) {
      // The first time all six faces at once (also sets up the cube cameras).
      this.camera.update(r, scene);
      this.face = 6;
      this.started = true;
    } else {
      const prevTarget = r.getRenderTarget();
      r.setRenderTarget(this.cubeTarget, this.face);
      r.render(scene, this.camera.children[this.face]);
      r.setRenderTarget(prevTarget);
      this.face++;
    }
    hidden.visible = true;
    if (this.face >= 6) {
      this.envTarget = this.pmrem.fromCubemap(this.cubeTarget.texture, this.envTarget);
      this.face = 0;
      this.wait = 0.25;
      return true;
    }
    return false;
  }
}
