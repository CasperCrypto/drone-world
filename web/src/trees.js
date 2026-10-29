// trees.js — grows tree meshes: trunk and branches as bark tubes, leaves and
// needles as textured cards.
//
// Does: builds a tree of a species (Norway spruce, Scots pine, oak, birch)
// from a seed, at two levels of detail with the same silhouette (each branch
// draws its own random numbers, so dropping the finest branches does not
// move the others). Every vertex carries wind data: how high up the tree it
// is, how flexible it is, and a phase, which forest.js's shader uses to sway.
// Leaf normals point out from the crown centre, so a crown shades like a
// volume rather than a pile of flat cards.
// Does NOT: draw anything or place trees (forest.js does).
//
// Units are metres; +y up; the trunk base is at the origin.

import * as THREE from 'three';

// Per species: bark and leaf textures, nominal height, and branch levels.
// Level fields: n = children per parent (per lod), start..end = where on the
// parent they grow, angle (deg from parent), len (fraction of parent or of
// tree height for level 1), rad (fraction of parent radius at that point),
// sec/seg = sections along / around (per lod), gnarl, tropism (+ up, - down).
export const SPECIES = {
  spruce: {
    bark: 'pine', leaf: 'pine', height: 24, trunkRadius: 0.024, trunkSec: [10, 5], trunkSeg: [8, 5], trunkGnarl: 0.015,
    levels: [
      { n: [44, 24], start: 0.1, end: 0.98, angle: [92, 104], len: 0.3, shape: 'cone', rad: 0.32, sec: [4, 2], seg: [4, 3], gnarl: 0.12, tropism: -0.22 },
    ],
    leaves: { onLevel: 1, from: 0.12, perMetre: [2.0, 0.9], size: [1.05, 1.7], style: 'spray', tint: [0.75, 0.85, 0.75] },
  },
  pine: {
    bark: 'pine', leaf: 'pine', height: 22, trunkRadius: 0.022, trunkSec: [10, 5], trunkSeg: [8, 5], trunkGnarl: 0.05,
    levels: [
      { n: [13, 9], start: 0.56, end: 0.97, angle: [52, 72], len: 0.3, shape: 'umbrella', rad: 0.4, sec: [5, 3], seg: [5, 3], gnarl: 0.25, tropism: 0.12 },
      { n: [5, 0], start: 0.3, end: 0.95, angle: [38, 55], len: 0.45, rad: 0.55, sec: [3, 2], seg: [3, 3], gnarl: 0.3, tropism: 0.18 },
    ],
    leaves: { onLevel: 2, from: 0.35, perMetre: [1.6, 0.8], size: [1.0, 1.9], style: 'clump', tint: [0.85, 0.95, 0.8] },
  },
  oak: {
    bark: 'oak', leaf: 'oak', height: 18, trunkRadius: 0.034, trunkLength: 0.42, trunkSec: [8, 4], trunkSeg: [9, 6], trunkGnarl: 0.12,
    levels: [
      { n: [6, 6], start: 0.55, end: 1.0, angle: [35, 62], len: 0.55, shape: 'flat', rad: 0.55, sec: [7, 4], seg: [6, 4], gnarl: 0.3, tropism: 0.06 },
      { n: [6, 4], start: 0.25, end: 0.98, angle: [38, 58], len: 0.5, rad: 0.5, sec: [4, 2], seg: [4, 3], gnarl: 0.35, tropism: 0.04 },
      { n: [5, 0], start: 0.3, end: 0.98, angle: [35, 55], len: 0.45, rad: 0.55, sec: [2, 2], seg: [3, 3], gnarl: 0.35, tropism: 0 },
    ],
    leaves: { onLevel: 3, from: 0.15, perMetre: [2.6, 1.1], size: [0.95, 1.8], style: 'spray', tint: [0.9, 0.95, 0.85] },
  },
  birch: {
    bark: 'birch', leaf: 'ash', height: 17, trunkRadius: 0.013, trunkSec: [10, 5], trunkSeg: [7, 5], trunkGnarl: 0.03,
    levels: [
      { n: [20, 12], start: 0.33, end: 0.97, angle: [30, 45], len: 0.36, shape: 'taper', rad: 0.42, sec: [5, 3], seg: [4, 3], gnarl: 0.15, tropism: -0.06 },
      { n: [4, 0], start: 0.3, end: 0.95, angle: [35, 50], len: 0.45, rad: 0.55, sec: [3, 2], seg: [3, 3], gnarl: 0.2, tropism: -0.28 },
    ],
    leaves: { onLevel: 2, from: 0.2, perMetre: [3.0, 1.2], size: [0.75, 1.4], style: 'hang', tint: [0.95, 1.0, 0.85] },
  },
};

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const hash = (a, b) => (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35)) >>> 0;

// Length of a level-1 branch along the trunk, by crown shape (t = 0 base .. 1 top).
function crownShape(shape, t) {
  switch (shape) {
    case 'cone': return Math.pow(1 - t, 0.85) + 0.05;
    case 'umbrella': return Math.pow(Math.max(Math.sin(Math.PI * Math.min(1, (t - 0.5) / 0.5)), 0.05), 0.6);
    case 'taper': return 1 - 0.6 * t;
    default: return 1 - 0.3 * t;
  }
}

class Arrays {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.wind = [];
    this.idx = [];
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

export function buildTree(speciesKey, seed, lod = 0) {
  const sp = SPECIES[speciesKey];
  const H = sp.height;
  const bark = new Arrays();
  const leaves = new Arrays();
  const crownCenter = new THREE.Vector3(0, H * (speciesKey === 'oak' ? 0.65 : 0.6), 0);
  const leafCfg = sp.leaves;

  // A branch: a polyline grown from (origin, dir), emitted as a tube.
  function grow(origin, dir, length, radius, level, id, cfg) {
    const rand = rng(hash(seed, id));
    const sections = level === 0 ? sp.trunkSec[lod] : cfg.sec[lod];
    const segments = level === 0 ? sp.trunkSeg[lod] : cfg.seg[lod];
    const gnarl = level === 0 ? sp.trunkGnarl : cfg.gnarl;
    const tropism = level === 0 ? 0.02 : cfg.tropism;
    const nodes = [];
    const p = origin.clone();
    const d = dir.clone().normalize();
    const step = length / sections;
    for (let i = 0; i <= sections; i++) {
      const t = i / sections;
      const r = radius * (1 - t * 0.82) + 0.004;
      nodes.push({ p: p.clone(), d: d.clone(), r, t });
      // Bend: random wiggle plus growth toward (or away from) the sky.
      d.x += (rand() * 2 - 1) * gnarl;
      d.y += (rand() * 2 - 1) * gnarl * 0.5 + tropism * 0.6;
      d.z += (rand() * 2 - 1) * gnarl;
      d.normalize();
      p.addScaledVector(d, step);
    }
    tube(nodes, segments, radius, level, rand());

    const child = sp.levels[level];
    if (child && child.n[lod] > 0) {
      const n = child.n[lod];
      const phase = rand() * Math.PI * 2;
      for (let c = 0; c < n; c++) {
        // Children use their own random numbers, keyed by their index.
        const crand = rng(hash(seed, id * 131 + c + 7));
        const t = child.start + (child.end - child.start) * ((c + crand() * 0.6) / n);
        const at = sample(nodes, t);
        const az = phase + c * 2.39996 + (crand() - 0.5) * 0.5; // golden angle
        const angle = THREE.MathUtils.degToRad(child.angle[0] + crand() * (child.angle[1] - child.angle[0]));
        const childDir = deflect(at.d, az, angle);
        let len;
        if (level === 0) len = H * child.len * crownShape(child.shape, t) * (0.8 + crand() * 0.4);
        else len = length * child.len * (1 - t * 0.4) * (0.75 + crand() * 0.5);
        const rad = Math.max(at.r * child.rad, 0.012);
        grow(at.p, childDir, len, rad, level + 1, id * 131 + c + 7, child);
      }
    }
    if (level === leafCfg.onLevel || (lod === 1 && level === leafCfg.onLevel - 1 && !(sp.levels[level] && sp.levels[level].n[1] > 0))) {
      addLeaves(nodes, length, rand);
    }
  }

  // Leaf and needle cards along the outer part of a branch.
  function addLeaves(nodes, length, rand) {
    const count = Math.max(2, Math.round(length * leafCfg.perMetre[lod] * (0.8 + rand() * 0.4)));
    const size = leafCfg.size[lod];
    for (let i = 0; i < count; i++) {
      const t = leafCfg.from + (1 - leafCfg.from) * ((i + rand()) / count);
      const at = sample(nodes, t);
      const az = rand() * Math.PI * 2;
      let up;
      if (leafCfg.style === 'hang') up = deflect(at.d, az, 0.5).add(new THREE.Vector3(0, -0.9, 0)).normalize();
      else if (leafCfg.style === 'clump') up = deflect(at.d, az, 0.35).add(new THREE.Vector3(0, 0.6, 0)).normalize();
      else up = deflect(at.d, az, 0.45);
      const s = size * (0.75 + rand() * 0.5);
      card(at.p, up, az + rand(), s, rand());
      if (leafCfg.style === 'spray' || leafCfg.style === 'clump') card(at.p, up, az + Math.PI / 2 + rand() * 0.4, s * 0.9, rand());
    }
  }

  function card(origin, up, spin, size, phase) {
    // A quad whose bottom edge sits on the branch and whose v axis is `up`.
    const right = new THREE.Vector3().crossVectors(up, Math.abs(up.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    right.applyAxisAngle(up, spin).normalize();
    const n = new THREE.Vector3().crossVectors(right, up).normalize();
    const base = leaves.pos.length / 3;
    const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    for (const [cu, cv] of corners) {
      const p = origin.clone().addScaledVector(right, cu * size).addScaledVector(up, cv * size);
      leaves.pos.push(p.x, p.y, p.z);
      // Normal: mostly outward from the crown centre, a little of the card's own.
      const radial = p.clone().sub(crownCenter);
      radial.y *= 0.6;
      radial.normalize().multiplyScalar(0.75).addScaledVector(n, 0.25).normalize();
      leaves.nor.push(radial.x, radial.y, radial.z);
      leaves.uv.push(cu + 0.5, cv);
      leaves.wind.push(p.y / H, 0.6 + 0.4 * cv, phase);
    }
    leaves.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  function tube(nodes, segments, baseRadius, level, phase) {
    const base = bark.pos.length / 3;
    // Parallel-transport frame along the polyline.
    let normal = new THREE.Vector3().crossVectors(nodes[0].d, Math.abs(nodes[0].d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    const circumference = 2 * Math.PI * Math.max(baseRadius, 0.05);
    let along = 0;
    const flexByLevel = [0, 0.25, 0.55, 0.8];
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      if (i > 0) {
        const q = new THREE.Quaternion().setFromUnitVectors(nodes[i - 1].d, nd.d);
        normal.applyQuaternion(q);
        along += nd.p.distanceTo(nodes[i - 1].p);
      }
      const binormal = new THREE.Vector3().crossVectors(nd.d, normal).normalize();
      for (let s = 0; s <= segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const dirv = normal.clone().multiplyScalar(Math.cos(a)).addScaledVector(binormal, Math.sin(a));
        const p = nd.p.clone().addScaledVector(dirv, nd.r);
        bark.pos.push(p.x, p.y, p.z);
        bark.nor.push(dirv.x, dirv.y, dirv.z);
        bark.uv.push(s / segments, along / circumference);
        bark.wind.push(p.y / H, flexByLevel[level] * nd.t, phase);
      }
    }
    const ring = segments + 1;
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const a = base + i * ring + s;
        const b = a + ring;
        bark.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  const trunkLen = H * (sp.trunkLength ?? 1);
  grow(new THREE.Vector3(0, -0.4, 0), UP.clone(), trunkLen + 0.4, H * sp.trunkRadius, 0, 1, null);

  const barkGeo = bark.geometry();
  const leafGeo = leaves.geometry();
  leafGeo.computeBoundingBox();
  const box = leafGeo.boundingBox;
  return {
    bark: barkGeo,
    leaves: leafGeo,
    height: Math.max(box.max.y, trunkLen),
    crownRadius: Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z),
    crownBase: Math.max(box.min.y, 1.5),
    trunkRadius: H * sp.trunkRadius,
    triangles: (barkGeo.index.count + leafGeo.index.count) / 3,
  };
}

// Point and direction at fraction t along a polyline of nodes.
function sample(nodes, t) {
  const f = Math.min(Math.max(t, 0), 1) * (nodes.length - 1);
  const i = Math.min(Math.floor(f), nodes.length - 2);
  const u = f - i;
  const a = nodes[i];
  const b = nodes[i + 1];
  return {
    p: a.p.clone().lerp(b.p, u),
    d: a.d.clone().lerp(b.d, u).normalize(),
    r: a.r + (b.r - a.r) * u,
  };
}

// Rotate `dir` away from itself by `angle`, around an axis at azimuth `az`.
function deflect(dir, az, angle) {
  const ref = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
  const perp = new THREE.Vector3().crossVectors(dir, ref).normalize();
  perp.applyAxisAngle(dir, az);
  return dir.clone().applyAxisAngle(perp, angle).normalize();
}
