// Web Worker running MediaPipe FaceLandmarker off the main thread (keeps rendering smooth).
// Works as a classic (Vite default 'iife') or module worker.
//
// Protocol (main → worker):
//   { type: 'init', assetBase: string (ABSOLUTE url), delegate: 'GPU' | 'CPU' }
//   { type: 'frame', bitmap: ImageBitmap (transferred), ts: number }
//   { type: 'close' }
// (worker → main):
//   { type: 'ready', delegate } | { type: 'error', message, fatal: boolean }
//   { type: 'result', ts, ms, delegate, r: PackedResult }  (one per frame message, also on failure: r = null)

import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, packResult, SLOW_GPU_MS, type Delegate } from './landmarkerCore';

type InMsg =
  | { type: 'init'; assetBase: string; delegate: Delegate }
  | { type: 'frame'; bitmap: ImageBitmap; ts: number }
  | { type: 'close' };

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  close(): void;
};

let lm: FaceLandmarker | null = null;
let delegate: Delegate = 'CPU';
let assetBase = '';
let lastTs = 0;
let frames = 0;
let gpuMsSum = 0;
let errors = 0;
let switching: Promise<void> | null = null;

async function switchToCpu(reason: string): Promise<void> {
  console.warn('[faceWorker] switching to CPU delegate:', reason);
  try { lm?.close(); } catch { /* ignore */ }
  lm = null;
  const r = await createLandmarker(assetBase, 'CPU');
  lm = r.lm;
  delegate = r.delegate;
  frames = 0;
  ctx.postMessage({ type: 'ready', delegate });
}

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    assetBase = msg.assetBase;
    try {
      const r = await createLandmarker(assetBase, msg.delegate);
      lm = r.lm;
      delegate = r.delegate;
      ctx.postMessage({ type: 'ready', delegate });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err), fatal: true });
    }
    return;
  }
  if (msg.type === 'close') {
    try { lm?.close(); } catch { /* ignore */ }
    lm = null;
    ctx.close();
    return;
  }
  // frame
  const { bitmap } = msg;
  const ts = Math.max(lastTs + 1, Math.floor(msg.ts));
  lastTs = ts;
  if (!lm || switching) {
    bitmap.close();
    ctx.postMessage({ type: 'result', ts, ms: 0, delegate, r: null });
    return;
  }
  const t0 = performance.now();
  try {
    const res = lm.detectForVideo(bitmap, ts);
    const ms = performance.now() - t0;
    frames++;
    errors = 0;
    const r = packResult(res);
    ctx.postMessage({ type: 'result', ts, ms, delegate, r }, [r.scores.buffer, r.landmarks.buffer]);
    if (delegate === 'GPU' && frames > 5 && frames <= 20) {
      gpuMsSum += ms;
      if (frames === 20 && gpuMsSum / 15 > SLOW_GPU_MS) {
        switching = switchToCpu(`GPU too slow (${(gpuMsSum / 15).toFixed(0)} ms/frame)`).catch((e2) => {
          ctx.postMessage({ type: 'error', message: String((e2 as Error)?.message ?? e2), fatal: true });
        }).finally(() => { switching = null; });
      }
    }
  } catch (err) {
    errors++;
    ctx.postMessage({ type: 'result', ts, ms: 0, delegate, r: null });
    if (delegate === 'GPU' && frames < 10 && !switching) {
      switching = switchToCpu(String(err)).catch((e2) => {
        ctx.postMessage({ type: 'error', message: String((e2 as Error)?.message ?? e2), fatal: true });
      }).finally(() => { switching = null; });
    } else if (errors === 1 || errors % 100 === 0) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err), fatal: errors >= 300 });
    }
  } finally {
    bitmap.close();
  }
};
