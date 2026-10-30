// fetch-models.mjs — downloads the CC0 3D models the world uses.
//
// Does: with --list, prints Poly Haven's model catalogue (id, categories,
// tags, size) so models can be chosen; with a list of ids, downloads each
// model as glTF with its textures at the chosen resolution into
// web/assets/models/<id>/, and writes web/assets/models/manifest.json and
// the models section of web/assets/CREDITS.md.
// Does NOT: run in the browser or at build time. It is run by hand or by
// the "Fetch models" workflow, and the files are committed, so the site
// never depends on Poly Haven being up.
//
// Poly Haven assets are CC0 (public domain): https://polyhaven.com/license
// Usage: node tools/fetch-models.mjs --list [filter words]
//        node tools/fetch-models.mjs <resolution> <id> [id ...]

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'assets', 'models');
const CREDITS = join(ROOT, 'web', 'assets', 'CREDITS.md');
const HEADERS = { 'User-Agent': 'drone-world-fetch-models (github.com/CasperCrypto/drone-world)' };

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
  const dir = join(OUT, id);
  await rm(dir, { recursive: true, force: true });
  const main = entry.url.split('/').pop();
  await download(entry.url, join(dir, main));
  // The .bin and the textures the .gltf refers to, at their relative paths.
  for (const [rel, f] of Object.entries(entry.include || {})) await download(f.url, join(dir, rel));
  return {
    id,
    name: info.name,
    authors: Object.keys(info.authors || {}),
    categories: info.categories || [],
    polycount: info.polycount ?? null,
    dimensionsMm: info.dimensions || null,
    url: `https://polyhaven.com/a/${id}`,
    file: `${id}/${main}`,
  };
}

const args = process.argv.slice(2);
if (args[0] === '--list') {
  await list(args.slice(1).map((w) => w.toLowerCase()));
} else {
  const [res = '1k', ...ids] = args;
  if (!ids.length) throw new Error('usage: fetch-models.mjs <resolution> <id> [id ...]');
  const manifest = { resolution: res, source: 'Poly Haven (CC0)', models: {} };
  for (const id of ids) {
    try {
      manifest.models[id] = await fetchModel(id, res);
      console.log(`ok ${id}`);
    } catch (err) {
      console.log(`skipped ${id}: ${err.message}`);
    }
  }
  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Replace the models section of the credits, keep the rest.
  const rows = Object.values(manifest.models).map((m) => `| [${m.name}](${m.url}) | ${m.authors.join(', ')} | CC0 |`);
  const section = `<!-- models -->\n## Models\n\n3D models in \`models/\` come from [Poly Haven](https://polyhaven.com) and are\nCC0 (public domain); credit is not required but given gladly. Fetched by\n\`tools/fetch-models.mjs\` at ${res}.\n\n| Model | Authors | Licence |\n|---|---|---|\n${rows.join('\n')}\n<!-- /models -->`;
  let text = await readFile(CREDITS, 'utf8');
  text = text.includes('<!-- models -->')
    ? text.replace(/<!-- models -->[\s\S]*<!-- \/models -->/, section)
    : `${text.trimEnd()}\n\n${section}\n`;
  await writeFile(CREDITS, text);
}
