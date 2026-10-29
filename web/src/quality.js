// quality.js — graphics presets, from phones to gaming PCs.
//
// Does: one table of settings per quality level (render resolution,
// anti-aliasing, bloom, shadow detail, grass and tree detail, texture size,
// rain particles, lake reflections) and remembers the viewer's choice in this browser.
// Does NOT: measure the GPU; the default is High on computers and Low on
// touch devices, and the viewer can change it in Settings.

export const QUALITY = {
  low: { label: 'Low', pixelRatio: 0.75, msaa: 0, smaa: true, bloom: false, shadowMap: 1024, shadowSize: 55, grass: 25000, grassPatch: 46, treeNear: 28, treeMid: 80, groundTex: 512, rainDrops: 5000, reflections: false },
  medium: { label: 'Medium', pixelRatio: 1, msaa: 2, smaa: false, bloom: true, shadowMap: 2048, shadowSize: 75, grass: 70000, grassPatch: 66, treeNear: 42, treeMid: 120, groundTex: 1024, rainDrops: 12000, reflections: false },
  high: { label: 'High', pixelRatio: 1.25, msaa: 4, smaa: false, bloom: true, shadowMap: 4096, shadowSize: 95, grass: 140000, grassPatch: 88, treeNear: 60, treeMid: 170, groundTex: 1024, rainDrops: 20000, reflections: true },
  ultra: { label: 'Ultra', pixelRatio: 1.75, msaa: 4, smaa: false, bloom: true, shadowMap: 4096, shadowSize: 130, grass: 260000, grassPatch: 118, treeNear: 90, treeMid: 240, groundTex: 1024, rainDrops: 32000, reflections: true },
};

const KEY = 'droneworld.quality.v1';

export function loadQualityKey() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && QUALITY[saved]) return saved;
  } catch {
    // Storage blocked: use the default.
  }
  return window.matchMedia?.('(pointer: coarse)').matches ? 'low' : 'high';
}

export function saveQualityKey(key) {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
