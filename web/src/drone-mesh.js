// drone-mesh.js — what the drone looks like.
//
// Does: builds one of two quadcopters at the size of the chosen preset:
//   camera drone: rounded grey body, gimbal camera with a glass lens,
//     two-blade propellers, landing feet;
//   FPV 5-inch: carbon frame, battery strapped on top, tilted camera,
//     antenna, three-blade propellers;
// with navigation lights as on aircraft (red left, green right, white strobe
// at the back), propellers that blur into discs when they spin fast, and a
// headlight that can be switched on for night flying. Swaps in a user's own
// .glb/.gltf model on request.
// Does NOT: change the flight physics. An uploaded model is only the look;
// the builder (next milestone) will set mass and thrust from its parts.
//
// Local frame: +x forward, +y up, +z right (three.js, right-handed).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

function blurTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  grad.addColorStop(0, 'rgba(40,40,40,0.0)');
  grad.addColorStop(0.15, 'rgba(40,40,40,0.55)');
  grad.addColorStop(0.85, 'rgba(60,60,60,0.35)');
  grad.addColorStop(1, 'rgba(60,60,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function carbonTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  for (let y = 0; y < 64; y += 8) {
    for (let x = 0; x < 64; x += 8) {
      const odd = ((x + y) / 8) % 2;
      g.fillStyle = odd ? '#1a1b1d' : '#26282b';
      g.fillRect(x, y, 8, 8);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class DroneMesh {
  constructor() {
    this.root = new THREE.Group();
    this.visual = new THREE.Group();
    this.root.add(this.visual);
    this.props = [];
    this.discs = [];
    this.spin = 0;
    this.time = 0;
    this.blurTex = blurTexture();
    this.carbonTex = carbonTexture();
    // Headlight, off until switched on.
    this.headlight = new THREE.SpotLight(0xf2f5ff, 0, 80, 0.55, 0.45, 1.5);
    this.headlight.target.position.set(10, -3, 0);
    this.root.add(this.headlight, this.headlight.target);
    this.headlightOn = false;
    this.build(0.35, 'camera');
  }

  clear() {
    this.visual.clear();
    this.props = [];
    this.discs = [];
    this.leds = [];
  }

  // diagonal: motor-to-motor distance in metres.
  build(diagonal, style = 'camera') {
    this.clear();
    this.style = style;
    const s = diagonal;
    const arm = s / 2;
    const fpv = style === 'fpv';
    const shell = new THREE.MeshPhysicalMaterial({ color: 0x8e9398, roughness: 0.42, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.55, metalness: 0.15 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.carbonTex, roughness: 0.35, metalness: 0.3 });
    const bell = new THREE.MeshStandardMaterial({ color: fpv ? 0xd9542b : 0x2a2c2f, roughness: 0.3, metalness: 0.85 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02 });
    const propMat = new THREE.MeshStandardMaterial({ color: fpv ? 0xff7a1a : 0x2b2d30, roughness: 0.45, metalness: 0.05, transparent: fpv, opacity: fpv ? 0.85 : 1 });

    if (fpv) {
      const plate = new THREE.Mesh(new RoundedBoxGeometry(s * 0.34, s * 0.025, s * 0.16, 2, s * 0.01), carbon);
      plate.castShadow = true;
      this.visual.add(plate);
      const top = plate.clone();
      top.position.y = s * 0.11;
      this.visual.add(top);
      for (const [x, z] of [[0.13, 0.06], [0.13, -0.06], [-0.13, 0.06], [-0.13, -0.06]]) {
        const standoff = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.008, s * 0.008, s * 0.11, 6), bell);
        standoff.position.set(x * s, s * 0.055, z * s);
        this.visual.add(standoff);
      }
      const battery = new THREE.Mesh(new RoundedBoxGeometry(s * 0.3, s * 0.11, s * 0.14, 3, s * 0.015),
        new THREE.MeshStandardMaterial({ color: 0x2f6fd6, roughness: 0.5, metalness: 0.1 }));
      battery.position.y = s * 0.18;
      battery.castShadow = true;
      this.visual.add(battery);
      const strap = new THREE.Mesh(new THREE.BoxGeometry(s * 0.05, s * 0.12, s * 0.15), dark);
      strap.position.y = s * 0.18;
      this.visual.add(strap);
      const camBody = new THREE.Mesh(new RoundedBoxGeometry(s * 0.07, s * 0.07, s * 0.07, 2, s * 0.01), dark);
      camBody.position.set(s * 0.17, s * 0.06, 0);
      camBody.rotation.z = THREE.MathUtils.degToRad(25);
      this.visual.add(camBody);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.022, s * 0.026, s * 0.03, 16), glass);
      lens.rotation.z = -Math.PI / 2 + THREE.MathUtils.degToRad(25);
      lens.position.set(s * 0.21, s * 0.075, 0);
      this.visual.add(lens);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.006, s * 0.006, s * 0.25, 6), dark);
      ant.position.set(-s * 0.17, s * 0.2, 0);
      ant.rotation.z = THREE.MathUtils.degToRad(40);
      this.visual.add(ant);
    } else {
      const body = new THREE.Mesh(new RoundedBoxGeometry(s * 0.46, s * 0.15, s * 0.24, 4, s * 0.05), shell);
      body.castShadow = true;
      this.visual.add(body);
      const topCover = new THREE.Mesh(new RoundedBoxGeometry(s * 0.32, s * 0.05, s * 0.17, 3, s * 0.02), dark);
      topCover.position.set(-s * 0.03, s * 0.085, 0);
      this.visual.add(topCover);
      // Gimbal and camera under the nose.
      const yoke = new THREE.Mesh(new THREE.BoxGeometry(s * 0.04, s * 0.06, s * 0.1), dark);
      yoke.position.set(s * 0.22, -s * 0.06, 0);
      this.visual.add(yoke);
      const camBody = new THREE.Mesh(new RoundedBoxGeometry(s * 0.09, s * 0.075, s * 0.085, 3, s * 0.02), shell);
      camBody.position.set(s * 0.25, -s * 0.095, 0);
      this.visual.add(camBody);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.026, s * 0.03, s * 0.02, 20), glass);
      lens.rotation.z = -Math.PI / 2;
      lens.position.set(s * 0.3, -s * 0.095, 0);
      this.visual.add(lens);
      // Obstacle sensors on the nose.
      for (const z of [-0.05, 0.05]) {
        const eye = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.012, s * 0.012, s * 0.01, 12), glass);
        eye.rotation.z = -Math.PI / 2;
        eye.position.set(s * 0.232, s * 0.02, z * s);
        this.visual.add(eye);
      }
    }

    const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]]; // front-left, front-right, back-right, back-left (z right)
    corners.forEach(([fx, fz], i) => {
      const x = (fx * arm) / Math.SQRT2;
      const z = (fz * arm) / Math.SQRT2;
      const len = Math.hypot(x, z);
      const armGeo = fpv
        ? new THREE.BoxGeometry(len, s * 0.03, s * 0.055)
        : new RoundedBoxGeometry(len, s * 0.045, s * 0.06, 2, s * 0.015);
      const a = new THREE.Mesh(armGeo, fpv ? carbon : shell);
      a.position.set(x / 2, fpv ? 0 : -s * 0.01, z / 2);
      a.rotation.y = -Math.atan2(z, x);
      a.castShadow = true;
      this.visual.add(a);
      const stator = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.04, s * 0.04, s * 0.035, 18), dark);
      stator.position.set(x, s * 0.02, z);
      this.visual.add(stator);
      const b = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.043, s * 0.045, s * 0.04, 20), bell);
      b.position.set(x, s * 0.055, z);
      b.castShadow = true;
      this.visual.add(b);
      if (!fpv) {
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.012, s * 0.018, s * 0.09, 8), dark);
        foot.position.set(x * 0.92, -s * 0.06, z * 0.92);
        this.visual.add(foot);
      }
      // Propeller: two or three blades, and a blur disc for high rpm.
      const prop = new THREE.Group();
      prop.position.set(x, s * 0.08, z);
      const radius = fpv ? s * 0.25 : s * 0.3;
      const blades = fpv ? 3 : 2;
      for (let k = 0; k < blades; k++) {
        const blade = new THREE.Mesh(new RoundedBoxGeometry(radius, s * 0.006, s * (fpv ? 0.045 : 0.035), 1, s * 0.002), propMat);
        blade.geometry.translate(radius / 2, 0, 0);
        blade.rotation.y = (k / blades) * Math.PI * 2;
        blade.rotation.x = 0.18 * (i % 2 === 0 ? 1 : -1);
        blade.castShadow = true;
        prop.add(blade);
      }
      prop.userData.dir = i % 2 === 0 ? 1 : -1;
      this.visual.add(prop);
      this.props.push(prop);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: this.blurTex, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide }));
      disc.position.copy(prop.position);
      this.visual.add(disc);
      this.discs.push(disc);
    });

    // Navigation lights: red on the left arm, green on the right, white strobe at the back.
    const led = (color, x, y, z, kind) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(s * 0.016, 10, 6), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 4 }));
      m.position.set(x, y, z);
      m.userData.kind = kind;
      this.visual.add(m);
      this.leds.push(m);
    };
    led(0xff2020, arm * 0.62, -s * 0.01, -arm * 0.62, 'nav');
    led(0x20ff50, arm * 0.62, -s * 0.01, arm * 0.62, 'nav');
    led(0xffffff, -s * (fpv ? 0.18 : 0.24), s * 0.02, 0, 'strobe');
    this.headlight.position.set(s * 0.25, -s * 0.05, 0);
    this.size = diagonal;
  }

  setHeadlight(on) {
    this.headlightOn = on;
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

  update(dt, thrustFraction, night) {
    this.time += dt;
    const rate = thrustFraction > 0.01 ? 25 + thrustFraction * 160 : 0; // rad/s, for the look only
    this.spin += dt * rate;
    const blur = THREE.MathUtils.clamp((rate - 30) / 60, 0, 1);
    this.props.forEach((p, i) => {
      p.rotation.y = this.spin * p.userData.dir;
      p.visible = blur < 0.95;
      this.discs[i].material.opacity = blur * 0.9;
      this.discs[i].visible = blur > 0.02;
    });
    for (const m of this.leds || []) {
      if (m.userData.kind === 'strobe') {
        const phase = this.time % 1.2;
        m.material.emissiveIntensity = phase < 0.06 || (phase > 0.16 && phase < 0.22) ? 40 : 0.2;
      } else {
        m.material.emissiveIntensity = 3 + 6 * night;
      }
    }
    this.headlight.intensity = this.headlightOn ? 60 : 0;
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
