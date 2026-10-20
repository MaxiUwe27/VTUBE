// MediaPipe FaceLandmarker creation + result packing, shared by the main-thread path and the worker.

import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { Vec3 } from '../../shared/types';
import { matrixToHeadPose } from './headPose';

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
export type Delegate = 'GPU' | 'CPU';

/**
 * MediaPipe's blendshape sides: true if "eyeBlinkLeft" refers to the user's anatomical LEFT eye
 * (ARKit convention). Verified with synthetic one-eye-closed photos: covering the eye on the image's
 * right side (the subject's left eye) raises eyeBlinkLeft. FaceFrame always uses the ARKit
 * convention; if this were false the tracker would swap Left/Right names on ingest.
 */
export const MP_LEFT_IS_USER_LEFT = true;

/** GPU delegate slower than this (avg ms per detect, frames 5..20) → switch to CPU (e.g. software GL). */
export const SLOW_GPU_MS = 90;

const filesetCache = new Map<string, Promise<WasmFileset>>();

/** True inside a module worker (importScripts unavailable) → MediaPipe needs its ES-module wasm loader. */
function inModuleWorker(): boolean {
  const g = globalThis as unknown as { importScripts?: (...u: string[]) => void; document?: unknown };
  if (g.document !== undefined) return false;
  if (typeof g.importScripts !== 'function') return true;
  try { g.importScripts(); return false; } catch { return true; }
}

export async function createLandmarker(assetBase: string, delegate: Delegate): Promise<{ lm: FaceLandmarker; delegate: Delegate }> {
  let fsP = filesetCache.get(assetBase);
  if (!fsP) {
    fsP = FilesetResolver.forVisionTasks(assetBase + '/wasm', inModuleWorker());
    filesetCache.set(assetBase, fsP);
    fsP.catch(() => filesetCache.delete(assetBase));
  }
  const fileset = await fsP;
  const make = (d: Delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: assetBase + '/face_landmarker.task', delegate: d },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  if (delegate === 'GPU') {
    try {
      return { lm: await make('GPU'), delegate: 'GPU' };
    } catch (e) {
      console.warn('[FaceTracker] GPU delegate failed, falling back to CPU:', e);
    }
  }
  return { lm: await make('CPU'), delegate: 'CPU' };
}

/** Compact, transferable representation of one detection result. */
export interface PackedResult {
  detected: boolean;
  rot: Vec3;
  pos: Vec3;
  names: string[];          // blendshape names (user perspective, ARKit sides)
  scores: Float32Array;     // same order as names
  landmarks: Float32Array;  // x,y,z interleaved (normalized)
}

function swapSide(name: string): string {
  if (name.endsWith('Left')) return name.slice(0, -4) + 'Right';
  if (name.endsWith('Right')) return name.slice(0, -5) + 'Left';
  return name;
}

let cachedNamesSrc: string[] | null = null;
let cachedNames: string[] = [];

export function packResult(res: FaceLandmarkerResult): PackedResult {
  const out: PackedResult = {
    detected: false, rot: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 },
    names: [], scores: new Float32Array(0), landmarks: new Float32Array(0),
  };
  const lms = res.faceLandmarks?.[0];
  const mat = res.facialTransformationMatrixes?.[0];
  const cats = res.faceBlendshapes?.[0]?.categories;
  if (!lms || !lms.length || !mat || !cats || !matrixToHeadPose(mat.data, out.rot, out.pos)) return out;
  out.detected = true;
  // names (cached: MediaPipe always returns the same categories in the same order)
  if (!cachedNamesSrc || cachedNamesSrc.length !== cats.length || cachedNamesSrc[1] !== cats[1]?.categoryName) {
    cachedNamesSrc = cats.map((c) => c.categoryName);
    cachedNames = cachedNamesSrc.map((n) => (MP_LEFT_IS_USER_LEFT ? n : swapSide(n)));
  }
  out.names = cachedNames;
  out.scores = new Float32Array(cats.length);
  for (let i = 0; i < cats.length; i++) out.scores[i] = cats[i].score;
  out.landmarks = new Float32Array(lms.length * 3);
  for (let i = 0; i < lms.length; i++) {
    out.landmarks[i * 3] = lms[i].x;
    out.landmarks[i * 3 + 1] = lms[i].y;
    out.landmarks[i * 3 + 2] = lms[i].z;
  }
  return out;
}
