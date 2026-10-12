#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const taskRoot = fileURLToPath(new URL('../', import.meta.url));
const taskOutput = process.argv[2] && path.resolve(process.argv[2]);
if (!taskOutput || existsSync(taskOutput)) {
  console.error('Pass a new output directory; existing directories are preserved.');
  process.exit(2);
}
const client = path.join(taskRoot, 'apps/client/dist');
const store = path.join(taskRoot, 'apps/store/dist');
if (!existsSync(path.join(client, 'index.html')) || !existsSync(path.join(store, 'store.html'))) {
  console.error('Build @space/client and @space/store before assembling UI.');
  process.exit(1);
}
mkdirSync(taskOutput, { recursive: true });
cpSync(client, taskOutput, { recursive: true, dereference: false });
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (entry.isSymbolicLink()) throw new Error('Build output must not contain symlinks');
  if (entry.name === 'index.html') continue;
  const name = entry.name === 'store.html' ? 'complete-store.html' : entry.name;
  cpSync(path.join(store, entry.name), path.join(taskOutput, name), { recursive: true, dereference: false });
}
writeFileSync(path.join(taskOutput, 'runtime-config.json'), '{"nasOrigin":""}\n');
const textExtensions = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest']);
function precompress(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build output must not contain symlinks');
    if (entry.isDirectory()) precompress(file);
    else if (entry.isFile() && textExtensions.has(path.extname(file))) {
      const raw = readFileSync(file), packed = gzipSync(raw, { level: 9 });
      if (packed.length < raw.length) writeFileSync(file + '.gz', packed);
    }
  }
}
precompress(taskOutput);
console.log(`Assembled same-origin UI + standalone store: ${taskOutput}`);
