// fetch-models.mjs — downloads the CC0 3D models the world uses.
//
// Does: with --list, prints Poly Haven's model catalogue (id, categories,
// tags, size) so models can be chosen; with a list of ids, downloads each
// model as glTF with its textures at the chosen resolution, makes it light
// enough for a browser with glTF Transform (simplified mesh, quantized
// vertices, WebP textures, one .glb file) into web/assets/models/<id>.glb,
// and writes web/assets/models/manifest.json and the models section of
// web/assets/CREDITS.md. Needs the gltf-transform command (npm
// @gltf-transform/cli) on the PATH.
// Does NOT: run in the browser or at build time. It is run by hand or by
// the "Fetch models" workflow, and the files are committed, so the site
// never depends on Poly Haven being up.
//
// Poly Haven assets are CC0 (public domain): https://polyhaven.com/license
// Usage: node tools/fetch-models.mjs --list [filter words]
//        node tools/fetch-models.mjs <resolution> <id> [id ...]

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'assets', 'models');
const CREDITS = join(ROOT, 'web', 'assets', 'CREDITS.md');
const HEADERS = { 'User-Agent': 'drone-world-fetch-models (github.com/CasperCrypto/drone-world)' };
// Share of vertices to keep when simplifying (scanned models are dense); 1 = keep all.
const KEEP = {
  rock_moss_set_01: 0.12, rock_moss_set_02: 0.12, rock_face_01: 0.35, rock_face_02: 0.3,
  tree_stump_01: 0.15, tree_stump_02: 0.12, dead_tree_trunk: 0.08, dry_branches_medium_01: 0.4,
  portable_generator: 0.5, street_lamp_01: 0.4, concrete_road_barrier_02: 0.2, metal_trash_can: 0.5,
};
// Allowed shape error when simplifying, as a share of the model's size (default 0.004).
const ERROR = { street_lamp_01: 0.01 };

async function json(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function download(url, path) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await r.arrayBuffer()));
}

async function list(words) {
  const all = await json('https://api.polyhaven.com/assets?t=models');
  const rows = Object.entries(all)
    .map(([id, a]) => ({ id, name: a.name, cats: a.categories || [], tags: a.tags || [], poly: a.polycount ?? '', dims: a.dimensions ?? '' }))
    .filter((r) => !words.length || words.some((w) => [r.id, r.name, ...r.cats, ...r.tags].join(' ').toLowerCase().includes(w)))
    .sort((a, b) => a.id.localeCompare(b.id));
  console.log(`${rows.length} models${words.length ? ` matching ${words.join(', ')}` : ''}:`);
  for (const r of rows) console.log(`${r.id} | ${r.name} | ${r.cats.join(',')} | ${r.tags.slice(0, 8).join(',')} | poly ${r.poly} | dims ${JSON.stringify(r.dims)}`);
  // One sample of the files structure, to check the download format.
  if (rows[0]) console.log('files sample:', JSON.stringify(await json(`https://api.polyhaven.com/files/${rows[0].id}`)).slice(0, 1500));
}

async function fetchModel(id, res) {
  const files = await json(`https://api.polyhaven.com/files/${id}`);
  const info = await json(`https://api.polyhaven.com/info/${id}`);
  const byRes = files.gltf?.[res] ?? files.gltf?.['1k'] ?? Object.values(files.gltf || {})[0];
  const entry = byRes?.gltf;
  if (!entry) throw new Error(`${id}: no glTF download`);
  const dir = join(OUT, '_src', id);
  await rm(dir, { recursive: true, force: true });
  const main = entry.url.split('/').pop();
  await download(entry.url, join(dir, main));
  // The .bin and the textures the .gltf refers to, at their relative paths.
  for (const [rel, f] of Object.entries(entry.include || {})) await download(f.url, join(dir, rel));
  const glb = join(OUT, `${id}.glb`);
  const keep = KEEP[id] ?? 1;
  execFileSync('gltf-transform', [
    'optimize', join(dir, main), glb,
    '--compress', 'quantize', // KHR_mesh_quantization: three.js reads it without a decoder
    '--texture-compress', 'webp',
    '--texture-size', '1024',
    '--simplify', keep < 1 ? 'true' : 'false',
    '--simplify-ratio', String(keep),
    '--simplify-error', String(ERROR[id] ?? 0.004),
    '--palette', 'false',
    '--instance', 'false',
  ], { stdio: 'inherit' });
  await rm(dir, { recursive: true, force: true });
  const bytes = (await stat(glb)).size;
  return {
    id,
    name: info.name,
    authors: Object.keys(info.authors || {}),
    categories: info.categories || [],
    polycount: info.polycount ?? null,
    dimensionsMm: info.dimensions || null,
    url: `https://polyhaven.com/a/${id}`,
    file: `${id}.glb`,
    bytes,
    keptVertices: keep,
  };
}

const args = process.argv.slice(2);
if (args[0] === '--list') {
  await list(args.slice(1).map((w) => w.toLowerCase()));
} else {
  const [res = '1k', ...ids] = args;
  if (!ids.length) throw new Error('usage: fetch-models.mjs <resolution> <id> [id ...]');
  await rm(OUT, { recursive: true, force: true }); // drop models no longer listed
  await mkdir(OUT, { recursive: true });
  const manifest = { resolution: res, source: 'Poly Haven (CC0)', models: {} };
  for (const id of ids) {
    try {
      manifest.models[id] = await fetchModel(id, res);
      console.log(`ok ${id}`);
    } catch (err) {
      console.log(`skipped ${id}: ${err.message}`);
    }
  }
  await rm(join(OUT, '_src'), { recursive: true, force: true });
  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Replace the models section of the credits, keep the rest.
  const rows = Object.values(manifest.models).map((m) => `| [${m.name}](${m.url}) | ${m.authors.join(', ')} | CC0 |`);
  const section = `<!-- models -->\n## Models\n\n3D models in \`models/\` come from [Poly Haven](https://polyhaven.com) and are\nCC0 (public domain); credit is not required but given gladly. Fetched by\n\`tools/fetch-models.mjs\` at ${res} and simplified for the browser.\n\n| Model | Authors | Licence |\n|---|---|---|\n${rows.join('\n')}\n<!-- /models -->`;
  let text = await readFile(CREDITS, 'utf8');
  text = text.includes('<!-- models -->')
    ? text.replace(/<!-- models -->[\s\S]*<!-- \/models -->/, section)
    : `${text.trimEnd()}\n\n${section}\n`;
  await writeFile(CREDITS, text);
}
