#!/usr/bin/env node
// Usage: node scripts/import-human-atlas.mjs /path/to/human-atlas
// Source: git clone https://github.com/ashemag/human-atlas
//         git -C /path/to/human-atlas checkout 1c38bf35c254a891200d3cedecfd57abebe83d8d
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const sourceCommit = '1c38bf35c254a891200d3cedecfd57abebe83d8d';
const sourceDir = process.argv[2] && resolve(process.argv[2]);
if (!sourceDir) throw new Error('Usage: node scripts/import-human-atlas.mjs /path/to/human-atlas');
const actualCommit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualCommit !== sourceCommit) throw new Error(`Expected source commit ${sourceCommit}; got ${actualCommit}`);
const atlas = JSON.parse(readFileSync(resolve(sourceDir, 'public/models/atlas.json'), 'utf8'));
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/human-atlas');
const buffers = [];
const sourceChunks = new Map();
let offset = 0;
function append(buffer) {
  const padding = (4 - offset % 4) % 4;
  if (padding) { buffers.push(Buffer.alloc(padding)); offset += padding; }
  const start = offset;
  buffers.push(buffer);
  offset += buffer.length;
  return start;
}
// Keep the main training muscles, forearms and hip adductors. The skin supplies
// the complete head/hand/foot silhouette without downloading every deep muscle.
const trainingMuscle = /pectoralis major|deltoid|biceps brachii|triceps brachii|brachialis|brachioradialis|trapezius|rhomboid|infraspinatus|teres major|external oblique|serratus anterior|gluteus|rectus femoris|vastus|biceps femoris|semitendinosus|semimembranosus|gastrocnemius|soleus|adductor (brevis|longus|magnus|minimus)|gracilis|pectineus|carpi|pronator|supinator|palmaris longus|flexor digitorum (superficialis|profundus)|extensor digitorum$|extensor digiti minimi$|extensor indicis|pollicis longus/;
const parts = atlas.parts.filter(part => (part.system === 'muscular' && trainingMuscle.test(part.name.toLowerCase())) || part.id === 'FJ2810').map(part => {
  if (!sourceChunks.has(part.chunk)) {
    sourceChunks.set(part.chunk, readFileSync(resolve(sourceDir, 'public', atlas.chunks[part.chunk].url.replace(/^\//, ''))));
  }
  const source = sourceChunks.get(part.chunk);
  const fields = {};
  for (const [field, bytes] of [['positions', part.vertexCount * 12], ['normals', part.vertexCount * 6], ['indices', part.indexCount * 4]]) {
    if (part[field] < 0 || part[field] + bytes > source.length) throw new Error(`Invalid ${field} range for ${part.id}`);
    fields[field] = append(source.subarray(part[field], part[field] + bytes));
  }
  return { ...part, chunk: 0, ...fields };
});
const binary = Buffer.concat(buffers);
const compressed = gzipSync(binary, { level: 9 });
const url = '/models/human-atlas/muscles.bin.gz';
const manifest = {
  version: 'training-logger-human-atlas-1',
  source: 'https://github.com/ashemag/human-atlas',
  sourceCommit,
  sex: atlas.sex,
  scope: 'Major training muscles, forearms, hip adductors, and the body surface from human-atlas. Training regions are illustrative; the source does not include latissimus dorsi or rectus abdominis meshes.',
  parts,
  chunks: [{ url, gzip: url, bytes: binary.length, gzipBytes: compressed.length }],
  triangles: parts.reduce((sum, part) => sum + part.indexCount / 3, 0),
};
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'atlas.json'), JSON.stringify(manifest));
writeFileSync(resolve(outputDir, 'muscles.bin.gz'), compressed);
writeFileSync(resolve(outputDir, 'HUMAN-ATLAS-LICENSE.txt'), readFileSync(resolve(sourceDir, 'LICENSE')));
writeFileSync(resolve(outputDir, 'ATTRIBUTION.md'), `# Anatomy model attribution\n\nAdapted from [human-atlas](https://github.com/ashemag/human-atlas), commit \`${sourceCommit}\`. The upstream software is MIT licensed; its license is included in HUMAN-ATLAS-LICENSE.txt.\n\nTraining Logger adaptations: retained ${parts.length - 1} major training, forearm, and hip-adductor muscular meshes plus the Skin mesh; omitted other anatomy systems and concept hierarchy; repacked existing vertex data into a single gzip-compressed binary. No geometry was modified. Training-region grouping and display colors are application annotations. The upstream dataset has no latissimus dorsi or rectus abdominis meshes; the regional display is illustrative.\n\nThe following attribution is preserved from the upstream repository:\n\n${readFileSync(resolve(sourceDir, 'public/ATTRIBUTION.md'), 'utf8')}`);
console.log(`Imported ${parts.length} parts, ${manifest.triangles} triangles: ${binary.length} bytes unpacked / ${compressed.length} bytes gzip.`);
