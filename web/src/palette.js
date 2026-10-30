// palette.js — the colours and looks of the two non-photographic art styles.
//
// Does: one place for the colours (linear RGB, before lighting) and look
// switches of
//   'toon' (Stylized, the default): bright saturated colours, banded toon
//     lighting, a colourful sky and ground light, ink outlines, contact
//     shadows and a punchy colour grade;
//   'dark' (Dark studio): calm greys, contour lines and a 50 m grid, soft
//     outlines, a cool low-contrast grade;
// so ground, trees, grass, buildings, water, sky, lights and the final
// image all read as one designed world.
// Does NOT: apply anything; terrain.js, trees.js, forest.js, grass.js,
// world.js, water.js, sky.js, post.js, drone-mesh.js and main.js read it.
// The 'realistic' style has no palette: it uses the scanned textures.

export const DARK = {
  key: 'dark',
  toon: false, // banded lighting
  contours: true, // height lines and grid on the ground
  ground: {
    grass: [0.105, 0.112, 0.108],
    dry: [0.128, 0.128, 0.122],
    forest: [0.07, 0.074, 0.072],
    rock: [0.17, 0.17, 0.175],
    sand: [0.2, 0.198, 0.19],
    dirt: [0.085, 0.082, 0.08],
    snow: [0.62, 0.64, 0.68],
  },
  groundVariation: 0.2, // large soft patches, as a fraction of the colour
  canopy: [[0.045, 0.05, 0.048], [0.075, 0.08, 0.078]], // far forests, dark to light
  contour: 5, // metres between height lines
  grid: 50, // metres between grid lines
  leaves: {
    pine: [0.11, 0.122, 0.116],
    spruce: [0.085, 0.096, 0.092],
    oak: [0.13, 0.14, 0.134],
    birch: [0.16, 0.168, 0.16],
  },
  bark: [0.075, 0.07, 0.068],
  birchBark: [0.42, 0.42, 0.43],
  grassBlade: [[0.07, 0.076, 0.073], [0.15, 0.158, 0.152]], // root, tip
  surfaces: {
    plaster: 0x9a9da2,
    brick: 0x8a8d92,
    roof: 0x4b4f55,
    metal: 0x70757b,
    asphalt: 0x1d1f22,
    concrete: 0x5a5d61,
    wood: 0x5d5853,
  },
  water: 0x090c0f,
  shallow: [0.05, 0.052, 0.055],
  sky: {
    dayZenith: [0.085, 0.1, 0.125],
    dayHorizon: [0.3, 0.32, 0.345],
    nightZenith: [0.003, 0.0035, 0.006],
    nightHorizon: [0.016, 0.018, 0.024],
    duskHorizon: [0.32, 0.25, 0.22],
  },
  // Sky light (hemisphere) by day and at night; ground light = sky x groundTint.
  hemiDay: [0.66, 0.7, 0.78],
  hemiNight: [0.2, 0.22, 0.3],
  groundTint: [0.38, 0.38, 0.38],
  sunTint: [1, 0.98, 0.95], // pulls the sun colour towards this
  sunBoost: 1,
  skyBoost: 1, // sky light strength: higher lifts the shadows
  drone: { shell: 0x8e9398, trim: 0x1d1f22, accent: 0x3a3d42, glow: 0x9fd8ff },
  grade: { sat: 0.92, lift: [0.028, 0.03, 0.036], split: 1, curve: 0.22, vignette: 0.42 },
  bloom: { strength: 0.28, radius: 0.55, threshold: 1.6 },
  outline: { color: [0.0, 0.0, 0.0], strength: 0.45 },
  ao: { radius: 1.6, strength: 0.75 },
};

export const TOON = {
  key: 'toon',
  toon: true,
  contours: false,
  ground: {
    grass: [0.12, 0.3, 0.045],
    dry: [0.34, 0.33, 0.08],
    forest: [0.05, 0.15, 0.035],
    rock: [0.26, 0.25, 0.29],
    sand: [0.62, 0.5, 0.26],
    dirt: [0.3, 0.16, 0.065],
    snow: [0.85, 0.9, 0.98],
  },
  groundVariation: 0.3,
  canopy: [[0.03, 0.1, 0.03], [0.07, 0.2, 0.05]],
  contour: 5,
  grid: 50,
  leaves: {
    pine: [0.05, 0.17, 0.07],
    spruce: [0.035, 0.13, 0.065],
    oak: [0.13, 0.32, 0.05],
    birch: [0.3, 0.45, 0.07],
  },
  bark: [0.2, 0.1, 0.05],
  birchBark: [0.78, 0.76, 0.7],
  grassBlade: [[0.05, 0.15, 0.02], [0.28, 0.5, 0.07]],
  surfaces: {
    plaster: 0xf2e6cf,
    brick: 0xd0754d,
    roof: 0xd04a3a,
    metal: 0xc4ccd4,
    asphalt: 0x41444c,
    concrete: 0xc2beb4,
    wood: 0xa06c3e,
  },
  water: 0x13a6c2,
  shallow: [0.22, 0.6, 0.5],
  sky: {
    dayZenith: [0.07, 0.25, 0.85],
    dayHorizon: [0.5, 0.72, 0.98],
    nightZenith: [0.004, 0.006, 0.035],
    nightHorizon: [0.03, 0.04, 0.12],
    duskHorizon: [1.0, 0.48, 0.28],
  },
  hemiDay: [0.5, 0.7, 1.0],
  hemiNight: [0.18, 0.2, 0.45],
  groundTint: [0.62, 0.48, 0.26], // warm bounce light from the ground
  sunTint: [1, 0.93, 0.8],
  sunBoost: 1.15,
  skyBoost: 1.45, // bright blue shadows, never black
  drone: { shell: 0xf4f6fa, trim: 0x23304a, accent: 0xff7a1a, glow: 0x34e1ff },
  grade: { sat: 1.24, lift: [0.0, 0.004, 0.012], split: 0.6, curve: 0.2, vignette: 0.24 },
  bloom: { strength: 0.42, radius: 0.6, threshold: 1.5 },
  outline: { color: [0.02, 0.03, 0.07], strength: 0.8 },
  ao: { radius: 1.4, strength: 0.9 },
};

const PALETTES = { toon: TOON, dark: DARK };

/** The palette of an art style, or null for 'realistic'. */
export function palette(style) {
  return PALETTES[style] || null;
}
