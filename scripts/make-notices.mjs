// Builds THIRD_PARTY_NOTICES.txt from the licenses of the libraries and fonts bundled into the app.
// Run via `npm run prepare-assets` (writes into the renderer public dir so "Über & Hilfe" can show it).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = (name) => JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));

// [name, license file (relative to root), extra note, { version, license } for non-npm assets]
const ENTRIES = [
  ['three', 'node_modules/three/LICENSE', ''],
  ['@pixiv/three-vrm', 'node_modules/@pixiv/three-vrm/LICENSE', ''],
  ['ws', 'node_modules/ws/LICENSE', ''],
  ['@mediapipe/tasks-vision', 'licenses/Apache-2.0.txt',
    'Includes the MediaPipe WASM runtime and the Face Landmarker model (face_landmarker.task), (c) Google LLC.'],
  ['electron', 'node_modules/electron/LICENSE',
    'Chromium and its third-party licenses: see LICENSES.chromium.html next to the executable.'],
  ['Inter (font)', 'licenses/OFL-1.1-Inter.txt',
    'Inter and Inter Display, static woff2 files from https://github.com/rsms/inter (fonts/Inter-*.woff2, fonts/InterDisplay-*.woff2).',
    { version: '4.1', license: 'OFL-1.1' }],
  ['Silkscreen (font)', 'licenses/OFL-1.1-Silkscreen.txt',
    'Silkscreen Bold from https://github.com/google/fonts/tree/main/ofl/silkscreen (fonts/Silkscreen-Bold.ttf).',
    { version: '1.001', license: 'OFL-1.1' }],
];

let out = 'VTube Linux – third-party software\n' + '='.repeat(40) + '\n\n';
out += 'VTube Linux itself is MIT-licensed (see LICENSE). It bundles:\n\n';
for (const [name, , note, meta] of ENTRIES) {
  const p = meta ?? pkg(name);
  out += `- ${name} ${p.version} (${p.license})${note ? ' – ' + note : ''}\n`;
}
for (const [name, file] of ENTRIES) {
  out += `\n\n${'-'.repeat(72)}\n${name}\n${'-'.repeat(72)}\n\n` + readFileSync(resolve(root, file), 'utf8').trim() + '\n';
}
const target = resolve(root, process.argv[2] ?? 'src/renderer/public/THIRD_PARTY_NOTICES.txt');
writeFileSync(target, out);
console.log('Wrote', target);
