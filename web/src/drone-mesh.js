// drone-mesh.js — what the drone looks like.
//
// Does: builds a simple quadcopter (body, X arms, motors, spinning
// propellers, a camera and navigation lights) at a size that matches the
// chosen preset, and swaps in a user's own .glb/.gltf model.
// Does NOT: change the flight physics. An uploaded model is only the look;
// the builder (next milestone) will set mass and thrust from its parts.
//
// Local frame: +x forward, +y up, +z right (three.js, right-handed).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class DroneMesh {
  constructor() {
    this.root = new THREE.Group();
    this.visual = new THREE.Group();
    this.root.add(this.visual);
    this.props = [];
    this.spin = 0;
    this.build(0.35);
  }

  clear() {
    this.visual.clear();
    this.props = [];
  }

  // diagonal: motor-to-motor distance in metres.
  build(diagonal) {
    this.clear();
    const arm = diagonal / 2;
    const dark = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.6, metalness: 0.2 });
    const shell = new THREE.MeshStandardMaterial({ color: 0xd8dadc, roughness: 0.45, metalness: 0.1 });
    const motorMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 0.8 });
    const propMat = new THREE.MeshStandardMaterial({ color: 0x111111, transparent: true, opacity: 0.55, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(diagonal * 0.42, diagonal * 0.14, diagonal * 0.28), shell);
    body.castShadow = true;
    this.visual.add(body);
    const cam = new THREE.Mesh(new THREE.SphereGeometry(diagonal * 0.05, 12, 8), dark);
    cam.position.set(diagonal * 0.24, -diagonal * 0.02, 0);
    this.visual.add(cam);

    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    corners.forEach(([fx, fz], i) => {
      const x = (fx * arm) / Math.SQRT2;
      const z = (fz * arm) / Math.SQRT2;
      const a = new THREE.Mesh(new THREE.BoxGeometry(arm, diagonal * 0.035, diagonal * 0.05), dark);
      a.position.set(x / 2, 0, z / 2);
      a.rotation.y = -Math.atan2(z, x);
      a.castShadow = true;
      this.visual.add(a);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(diagonal * 0.045, diagonal * 0.045, diagonal * 0.06, 14), motorMat);
      motor.position.set(x, diagonal * 0.03, z);
      motor.castShadow = true;
      this.visual.add(motor);
      const prop = new THREE.Mesh(new THREE.CylinderGeometry(diagonal * 0.2, diagonal * 0.2, 0.002, 24), propMat);
      prop.position.set(x, diagonal * 0.07, z);
      prop.userData.dir = i % 2 === 0 ? 1 : -1;
      this.visual.add(prop);
      this.props.push(prop);
      // Navigation lights: green front, red back.
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(diagonal * 0.018, 6, 4),
        new THREE.MeshBasicMaterial({ color: fx > 0 ? 0x30ff70 : 0xff3030 }),
      );
      led.position.set(x, -diagonal * 0.03, z);
      this.visual.add(led);
    });
    this.size = diagonal;
  }

  // Replace the look with a user's model, scaled to the current size.
  async loadModel(arrayBuffer) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const dims = box.getSize(new THREE.Vector3());
    const largest = Math.max(dims.x, dims.y, dims.z) || 1;
    const scale = (this.size * 1.2) / largest;
    model.scale.setScalar(scale);
    const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
    model.position.sub(center);
    model.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.clear();
    this.visual.add(model);
    return { triangles: countTriangles(model), originalSizeM: largest };
  }

  // Turn an uploaded model a quarter turn if its front faces the wrong way.
  rotateQuarter() {
    this.visual.rotation.y += Math.PI / 2;
  }

  update(dt, thrustFraction) {
    this.spin += dt * (25 + thrustFraction * 160);
    for (const p of this.props) p.rotation.y = this.spin * p.userData.dir;
  }
}

function countTriangles(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      n += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  return Math.round(n);
}
