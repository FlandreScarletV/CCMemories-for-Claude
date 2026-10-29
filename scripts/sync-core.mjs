import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2] || process.env.CCMEMORIES_SOURCE;
if (!source) throw new Error('Usage: node scripts/sync-core.mjs <CCMemories source directory>');
const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor');
const original = resolve(source, 'thread-store.mjs');
const data = readFileSync(original);
if (!data.includes('options.chunkedRead')) throw new Error('The source core lacks complete-message pagination.');
mkdirSync(destination, { recursive: true });
copyFileSync(original, resolve(destination, 'thread-store.mjs'));
writeFileSync(resolve(destination, 'provenance.json'), JSON.stringify({
  source: 'CCMemories/thread-store.mjs',
  sha256: createHash('sha256').update(data).digest('hex'),
  maintenance: 'Generated from the CCMemories source; edit upstream and run sync-core. Do not maintain a second parser.',
}, null, 2) + '\n');
console.log('Shared conversation core synchronized.');
