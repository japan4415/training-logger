// Supplement the v4 atlas with four actual v3 muscle meshes. No substitute anatomy.
// Obtain the pinned official archive below and extract its OBJ files with unzip -j.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const supplementSource = {
  dataset: 'BodyParts3D 3.0',
  archive: 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/BodyParts3D_3.0_obj_99.zip',
  archiveSha256: '2125f6d761b14ead4ee64f71713f56f3f0f29982693ff20aac63474470cb92f4',
  names: 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/parts_list_e.txt',
  license: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html',
  registration: {
    method: 'Translation-only nearest-vertex ICP on bilateral external oblique (v3 FMA13336/FMA13337 to v4 FJ1452/FJ1452M); original anatomical axes and scale retained',
    translationMeters: [0.0006517015998415034, -0.01245280118938296, 0.00021022610881320748],
    sourceToTargetRmsMillimeters: [2.5130374596213065, 2.504056138925666],
    sourceToTargetP95Millimeters: [4.980876158615515, 4.959042888784051],
    independentReferences: {
      teresMajorRmsMillimeters: [5.272167351663051, 5.462379488750765],
      abdominalPectoralisRmsMillimeters: [3.5409694398051217, 3.667527872175079],
      sternocostalPectoralisRmsMillimeters: [3.4798874019798984, 3.5152664754115084],
    },
    reproduction: 'uv run scripts/verify-bodyparts3d-registration.py /path/to/extracted/v3/obj',
    limitation: 'Different dataset revisions are not identical anatomy; registration is approximate, with about 2.5 mm RMS nearest-vertex residual on the fitted reference muscles and 3.5–5.5 mm on independent chest/teres references.',
  },
};

const muscles = [
  ['FMA13358', 'Right latissimus dorsi'],
  ['FMA13359', 'Left latissimus dorsi'],
  ['FMA13377', 'Right rectus abdominis'],
  ['FMA13378', 'Left rectus abdominis'],
];
const hashes = {
  "FMA13358": "07082eb26856a47e408aa7915012140fc03ac8620baadec13fcde760ad369f9f",
  "FMA13359": "fad8dab60f63bceaed0dbee8b1bd6f11162176c4bc8ebd63844904b05bcbb671",
  "FMA13377": "b00b3d214f6ee3b4fc16ca9dd4e64b4ac3047862a2bfcb6c06b50e371d621772",
  "FMA13378": "b8029d562de3ef08af46414a004bd4d4bd569da72849bcb00c4f4e5b610c8b4f"
};

export function importSupplement(directory, append) {
  if (!directory) throw new Error('Provide the extracted BodyParts3D 3.0 OBJ directory as the second argument.');
  return muscles.map(([id, name]) => {
    const raw = readFileSync(resolve(directory, `${id}.obj`));
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (sha256 !== hashes[id]) throw new Error(`Unexpected official source mesh hash for ${id}`);
    const vertices = [], normals = [], faces = [];
    const [tx, ty, tz] = supplementSource.registration.translationMeters;
    for (const line of raw.toString('utf8').split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === 'v') {
        const [x, y, z] = fields.slice(1).map(Number);
        vertices.push(x * .001 + tx, z * .001 + .0781112 + ty, -y * .001 - .1 + tz);
      } else if (fields[0] === 'vn') {
        const [x, y, z] = fields.slice(1).map(Number);
        normals.push(...[x, z, -y].map(value => Math.round(value * 32767)));
      } else if (fields[0] === 'f') {
        const indices = fields.slice(1).map(value => Number(value.split('/')[0]) - 1);
        for (let j = 1; j < indices.length - 1; j++) faces.push(indices[0], indices[j], indices[j + 1]);
      }
    }
    if (!vertices.length || normals.length !== vertices.length || !faces.length ||
      vertices.some(value => !Number.isFinite(value)) ||
      faces.some(value => !Number.isInteger(value) || value < 0 || value >= vertices.length / 3)) {
      throw new Error(`Invalid source geometry for ${id}`);
    }
    const positions = new Float32Array(vertices), packedNormals = new Int16Array(normals), indices = new Uint32Array(faces);
    const bounds = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
    for (let i = 0; i < positions.length; i++) {
      bounds[0][i % 3] = Math.min(bounds[0][i % 3], positions[i]);
      bounds[1][i % 3] = Math.max(bounds[1][i % 3], positions[i]);
    }
    return {
      id, name, conceptId: id, system: 'muscular', chunk: 0,
      positions: append(Buffer.from(positions.buffer)), normals: append(Buffer.from(packedNormals.buffer)), indices: append(Buffer.from(indices.buffer)),
      vertexCount: positions.length / 3, indexCount: indices.length, bounds,
      source: { dataset: supplementSource.dataset, file: `${id}.obj`, sha256 },
    };
  });
}
