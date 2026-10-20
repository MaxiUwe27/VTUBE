// Copies MediaPipe WASM runtime into the renderer public dir and downloads the
// face landmarker model if it is missing. Run before building.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'src/renderer/public/mediapipe');
mkdirSync(resolve(pub, 'wasm'), { recursive: true });
cpSync(resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm'), resolve(pub, 'wasm'), { recursive: true });

const model = resolve(pub, 'face_landmarker.task');
if (!existsSync(model)) {
  const url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
}
console.log('Assets ready in', pub);
