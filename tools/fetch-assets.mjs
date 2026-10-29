// fetch-assets.mjs — downloads the CC0 textures the world uses.
//
// Does: for each slot below, takes the first Poly Haven asset that exists,
// downloads its colour, normal (OpenGL convention) and ARM (ambient
// occlusion, roughness, metalness) maps at the chosen resolution into
// web/assets/textures/<asset>/, and writes web/assets/textures/manifest.json
// and web/assets/CREDITS.md.
// Does NOT: run in the browser or at build time. It is run once by hand or
// by the "Fetch assets" workflow, and the files are committed, so the site
// and offline copies never depend on Poly Haven being up.
//
// Poly Haven assets are CC0 (public domain): https://polyhaven.com/license
// Usage: node tools/fetch-assets.mjs [resolution]   (default 1k)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'assets', 'textures');
const RES = process.argv[2] || '1k';

// slot -> candidate Poly Haven asset ids, first one found wins.
const SLOTS = {
  grass: ['leafy_grass', 'sparse_grass', 'grass_path_2', 'aerial_grass_rock'],
  meadow: ['aerial_grass_rock', 'sparse_grass', 'leafy_grass'],
  forest: ['forrest_ground_01', 'forest_leaves_02', 'brown_mud_leaves_01', 'forest_floor'],
  rock: ['rocky_terrain_02', 'aerial_rocks_02', 'rock_face', 'rocks_ground_02', 'rocky_terrain'],
  sand: ['coast_sand_01', 'aerial_beach_01', 'sand_01', 'coast_sand_rocks_02'],
  dirt: ['brown_mud_02', 'rocky_trail', 'dry_ground_01', 'aerial_ground_rock', 'gravel_floor_02'],
  snow: ['snow_02', 'snow_field_aerial', 'snow_03', 'snow_01'],
  asphalt: ['asphalt_02', 'asphalt_01', 'asphalt_track', 'rough_asphalt'],
  concrete: ['concrete_floor_02', 'concrete_floor_worn_001', 'concrete_pavement', 'concrete_wall_008'],
  plaster: ['painted_plaster_wall', 'plastered_wall_02', 'beige_wall_001', 'white_plaster_02'],
  brick: ['red_brick_03', 'red_brick', 'brick_wall_02', 'red_bricks_04'],
  roof: ['clay_roof_tiles_02', 'roof_tiles_14', 'clay_roof_tiles', 'roof_tiles'],
  metal: ['corrugated_iron_02', 'corrugated_iron', 'corrugated_iron_03', 'metal_plate'],
  wood: ['wood_planks', 'brown_planks_03', 'weathered_planks', 'wood_planks_grey'],
};
// Poly Haven map names -> our file suffixes.
const MAPS = { Diffuse: 'diff', nor_gl: 'nor_gl', arm: 'arm' };

async function json(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'drone-world-fetch-assets' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function fetchAsset(id) {
  const files = await json(`https://api.polyhaven.com/files/${id}`);
  const info = await json(`https://api.polyhaven.com/info/${id}`);
  const saved = {};
  for (const [key, suffix] of Object.entries(MAPS)) {
    const entry = files[key]?.[RES]?.jpg ?? files[key]?.[RES]?.png;
    if (!entry) throw new Error(`${id}: no ${key} at ${RES}`);
    const ext = entry.url.split('.').pop();
    const rel = `${id}/${id}_${suffix}_${RES}.${ext}`;
    const r = await fetch(entry.url);
    if (!r.ok) throw new Error(`${r.status} ${entry.url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await mkdir(join(OUT, id), { recursive: true });
    await writeFile(join(OUT, rel), buf);
    saved[suffix] = rel;
  }
  return {
    id,
    name: info.name,
    authors: Object.keys(info.authors || {}),
    // Real-world size of one texture tile in metres, if Poly Haven gives it.
    dimensionsMm: info.dimensions || null,
    url: `https://polyhaven.com/a/${id}`,
    files: saved,
  };
}

const manifest = { resolution: RES, source: 'Poly Haven (CC0)', slots: {} };
const credits = [];
for (const [slot, ids] of Object.entries(SLOTS)) {
  let done = null;
  for (const id of ids) {
    try {
      done = await fetchAsset(id);
      break;
    } catch (err) {
      console.log(`  ${slot}: ${id} skipped (${err.message})`);
    }
  }
  if (!done) {
    console.log(`MISSING ${slot}: none of ${ids.join(', ')}`);
    continue;
  }
  console.log(`${slot}: ${done.id} (${done.name})`);
  manifest.slots[slot] = done;
  credits.push(`| ${slot} | [${done.name}](${done.url}) | ${done.authors.join(', ')} | CC0 |`);
}
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(ROOT, 'web', 'assets', 'CREDITS.md'), `# Asset credits

Textures in \`textures/\` come from [Poly Haven](https://polyhaven.com) and are
CC0 (public domain); credit is not required but given gladly. Fetched by
\`tools/fetch-assets.mjs\` at ${RES}.

| Used as | Texture | Authors | Licence |
|---|---|---|---|
${credits.join('\n')}

Tree bark and leaf textures in \`../vendor/ez-tree/assets/\` come with
[EZ-Tree](https://github.com/dgreenheck/ez-tree) (MIT, Daniel Greenheck); its
bark README credits Poly Haven and TextureCan.
`);
console.log(`Wrote ${Object.keys(manifest.slots).length} of ${Object.keys(SLOTS).length} slots.`);
