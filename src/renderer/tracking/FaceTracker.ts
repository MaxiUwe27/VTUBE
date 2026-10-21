// Webcam → MediaPipe FaceLandmarker → FaceFrame (user perspective, see shared/types.ts and headPose.ts).
//
// Detection runs in a Web Worker by default (faceWorker.ts) so the ~5-30 ms detectForVideo call never
// blocks avatar rendering; frames are handed over as transferred ImageBitmaps, at most one in flight
// (if detection is slower than the camera, frames are dropped instead of queueing → no added latency).
// If the worker cannot start, it falls back to running MediaPipe on the main thread.
//
// Input is either a webcam (cam.source 'device', getUserMedia) or a URL ("Browserquelle", cam.source
// 'url'): main renders the page offscreen and streams its frames (window.vtube.urlSourceStart), which
// UrlFrameSource turns into a video track for the same <video> element.

import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceFrame } from '../../shared/types';
import type { CameraSettings } from '../../shared/settings';
import type { UrlSourceState } from '../../shared/api';
import { UrlFrameSource } from './urlFrameSource';
import { createLandmarker, packResult, SLOW_GPU_MS, type Delegate, type PackedResult } from './landmarkerCore';

export { MP_LEFT_IS_USER_LEFT } from './landmarkerCore';

type Landmark = { x: number; y: number; z: number };

export interface FaceTrackerOptions {
  /** Base URL of the MediaPipe assets ('<base>/wasm/', '<base>/face_landmarker.task'), e.g. './mediapipe'. */
  assetBase: string;
  /** Run detection in a Web Worker (default true; falls back to the main thread automatically). */
  useWorker?: boolean;
  /** Override the worker script URL (tests / custom bundling). Default: Vite-bundled faceWorker.ts. */
  workerUrl?: string | URL;
  /** Worker type for `workerUrl` (default 'module'; the worker script supports both). */
  workerType?: WorkerType;
}

function createDefaultWorker(): Worker {
  return new Worker(new URL('./faceWorker.ts', import.meta.url), { type: 'module' });
}

/** Thrown by start() when stop() (or a newer start()) cancelled it. Not a real failure. */
export class TrackerAbortError extends Error {
  readonly trackerAborted = true;
  constructor(message = 'Tracker start was cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/** True for the cancellation error of FaceTracker.start() (not for getUserMedia's own AbortError). */
export function isTrackerAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { trackerAborted?: unknown }).trackerAborted === true;
}

/** Failure of the URL source ("Browserquelle"). `message` is German and user-facing. */
export class UrlSourceError extends Error {
  constructor(readonly code: 'no-url' | 'invalid' | 'unavailable' | 'load' | 'fatal' | 'timeout' | 'stalled', message: string) {
    super(message);
    this.name = 'UrlSourceError';
  }
}

export function isUrlSourceError(err: unknown): err is UrlSourceError {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'UrlSourceError';
}

/** Live state of the URL source (null when the webcam is used / stopped). */
export interface UrlSourceInfo { state: UrlSourceState; message: string | null; url: string; width: number; height: number }

/** Waiting for the first picture of a URL source at most this long. */
const URL_FIRST_FRAME_MS = 20000;
/** No picture from a running URL source this long → tracking error (main reconnects in between). */
const URL_STALL_MS = 15000;
let urlIdSeq = Math.floor(Math.random() * 1e6);

/** getUserMedia failed because the requested (saved) camera is not present anymore. */
function isMissingDeviceError(err: unknown): boolean {
  const e = err as { name?: unknown; constraint?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') return true;
  return e.name === 'OverconstrainedError' && (e.constraint === 'deviceId' || e.constraint === undefined || e.constraint === '');
}

/** If requestVideoFrameCallback / rAF stays silent this long while the video plays, poll by timer
 *  (Wayland compositors may stop frame callbacks for minimized windows). */
const FRAME_CB_STALL_MS = 200;

export class FaceTracker {
  readonly video: HTMLVideoElement;
  /** Called once per processed camera frame (also with detected=false when no face is visible). */
  onFrame: ((f: FaceFrame) => void) | null = null;
  /** Called on runtime failures after start() resolved (camera unplugged, detection crash...). */
  onError: ((e: Error) => void) | null = null;

  private readonly assetBase: string;
  private readonly useWorker: boolean;
  private readonly workerUrl?: string | URL;
  private readonly workerType: WorkerType;

  private worker: Worker | null = null;
  private landmarker: FaceLandmarker | null = null; // main-thread fallback
  private stream: MediaStream | null = null;
  private _running = false;
  private _delegate: Delegate | null = null;
  private _mode: 'worker' | 'main' | null = null;
  private lmData: Float32Array | null = null;
  private lmCache: Landmark[] | null = null;
  private _fps = 0;
  private fpsCount = 0;
  private fpsWindowStart = 0;
  private lastTs = 0;
  private lastVideoTime = -1;
  private rvfcId = 0;
  private rafId = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private cbStalled = false;     // frame callbacks stopped firing → timer polling active
  private lastTickByTimer = false;
  private stallWarned = false;
  private pollMs = 16;
  private pendingInit: ((e: Error) => void) | null = null; // rejects the running worker init
  private _cameraFallback = false;
  private session = 0;           // increments on every start/stop; stale async work checks it
  private inFlight = false;
  private inFlightSince = 0;
  private captureTs = 0;
  // main-thread mode bookkeeping
  private framesProcessed = 0;
  private gpuMsSum = 0;
  private recovering = false;
  private errorCount = 0;
  private _detectMs = 0;
  // URL source ("Browserquelle")
  private urlSrc: UrlFrameSource | null = null;
  private urlId = 0;
  private urlUnsubs: (() => void)[] = [];
  private urlWatch: ReturnType<typeof setInterval> | null = null;
  private pendingSource: ((e: Error) => void) | null = null;
  private lastUrlFrameAt = 0;
  private _urlInfo: UrlSourceInfo | null = null;

  constructor(opts: FaceTrackerOptions) {
    this.assetBase = opts.assetBase.replace(/\/+$/, '');
    this.useWorker = opts.useWorker ?? true;
    this.workerUrl = opts.workerUrl;
    this.workerType = opts.workerType ?? 'module';
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    this.video = v;
  }

  get running(): boolean { return this._running; }
  /** Processed (detected or not) frames per second. */
  get fps(): number { return this._fps; }
  /** Delegate actually in use (GPU may have fallen back to CPU). */
  get delegate(): Delegate | null { return this._delegate; }
  /** 'worker' or 'main' (thread running MediaPipe), null when stopped. */
  get mode(): 'worker' | 'main' | null { return this._mode; }
  /** Duration of the last detectForVideo call in ms. */
  get detectMs(): number { return this._detectMs; }
  /** True when the saved camera (cam.deviceId) was not found and the default camera is used instead. */
  get cameraFallback(): boolean { return this._cameraFallback; }
  /** State of the URL source ("Browserquelle"), null when a webcam is used or the tracker is stopped. */
  get urlSource(): UrlSourceInfo | null { return this._urlInfo; }
  /** performance.now() of the last picture received from the URL source (0 = none yet). */
  get urlLastFrameAt(): number { return this.lastUrlFrameAt; }
  /** Normalized landmarks (x,y in 0..1 of the NON-mirrored video image) of the last frame, or null. */
  get lastLandmarks(): Landmark[] | null {
    if (!this.lmData) return null;
    if (!this.lmCache) {
      const d = this.lmData, n = d.length / 3, out: Landmark[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = { x: d[i * 3], y: d[i * 3 + 1], z: d[i * 3 + 2] };
      this.lmCache = out;
    }
    return this.lmCache;
  }

  /** Video input devices. Labels are empty until camera permission was granted once. */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  /**
   * Opens the camera and the model. Rejects with a TrackerAbortError (name 'AbortError', see
   * isTrackerAbort) when stop() or another start() ran in the meantime.
   * If the saved camera (cam.deviceId) is missing, the default camera is used (see cameraFallback).
   * cam.source === 'url': opens cam.url as "Browserquelle" instead (cam.width/height = page size, cam.fps =
   * max frame rate); resolves after the first picture, rejects with a UrlSourceError on failures.
   */
  async start(cam: CameraSettings, useGpu: boolean): Promise<void> {
    this.stop();
    const session = ++this.session;
    const alive = () => { if (session !== this.session) throw new TrackerAbortError(); };
    try {
      // ── Camera ──
      const video: MediaTrackConstraints = {
        width: { ideal: cam.width },
        height: { ideal: cam.height },
        frameRate: { ideal: cam.fps },
      };
      let stream: MediaStream;
      if (cam.source === 'url') {
        stream = await this.openUrlSource(cam, session);
      } else if (cam.deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { ...video, deviceId: { exact: cam.deviceId } }, audio: false });
        } catch (e) {
          alive();
          if (!isMissingDeviceError(e)) throw e;
          console.warn('[FaceTracker] saved camera not found, using the default camera:', e);
          stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
          this._cameraFallback = true;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      }
      if (session !== this.session) { stream.getTracks().forEach((t) => t.stop()); throw new TrackerAbortError(); }
      this.stream = stream;
      this.pollMs = Math.max(8, Math.min(33, 500 / Math.max(1, cam.fps || 30)));
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (session !== this.session) return;
          console.warn('[FaceTracker] camera track ended');
          this.stop();
          this.onError?.(new Error('Camera disconnected'));
        });
      }
      this.video.srcObject = stream;
      await this.video.play().catch(() => { /* muted autoplay should not fail; frames still arrive */ });
      alive();

      // ── Model ──
      const delegate: Delegate = useGpu ? 'GPU' : 'CPU';
      let ok = false;
      if (this.useWorker && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
        try {
          await this.startWorker(delegate, session);
          ok = true;
        } catch (e) {
          alive();
          console.warn('[FaceTracker] worker unavailable, running MediaPipe on the main thread:', e);
          this.worker?.terminate();
          this.worker = null;
        }
      }
      if (!ok) {
        const r = await createLandmarker(this.assetBase, delegate);
        if (session !== this.session) { r.lm.close(); throw new TrackerAbortError(); }
        this.landmarker = r.lm;
        this._delegate = r.delegate;
        this._mode = 'main';
      }

      this._running = true;
      this.framesProcessed = 0;
      this.gpuMsSum = 0;
      this.errorCount = 0;
      this.inFlight = false;
      this.fpsWindowStart = performance.now();
      this.fpsCount = 0;
      this.scheduleNext(session);
      if (this.urlSrc) this.urlWatch = setInterval(() => this.checkUrlStall(session), 1000);
    } catch (e) {
      if (session === this.session) { this.stop(); throw e; }
      throw isTrackerAbort(e) ? e : new TrackerAbortError(); // failure of a cancelled start: irrelevant
    }
  }

  stop(): void {
    this.session++;
    this._running = false;
    if (this.pendingInit) {
      const reject = this.pendingInit;
      this.pendingInit = null;
      reject(new TrackerAbortError());
    }
    if (this.pendingSource) {
      const reject = this.pendingSource;
      this.pendingSource = null;
      reject(new TrackerAbortError());
    }
    this.closeUrlSource();
    if (this.rvfcId && typeof this.video.cancelVideoFrameCallback === 'function') this.video.cancelVideoFrameCallback(this.rvfcId);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.rvfcId = 0;
    this.rafId = 0;
    this.stallTimer = null;
    this.cbStalled = false;
    this.stallWarned = false;
    this._cameraFallback = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'close' }); } catch { /* ignore */ }
      const w = this.worker;
      setTimeout(() => w.terminate(), 500); // let it close the landmarker gracefully first
      this.worker = null;
    }
    if (this.landmarker) {
      try { this.landmarker.close(); } catch { /* ignore */ }
      this.landmarker = null;
    }
    this._delegate = null;
    this._mode = null;
    this.lmData = null;
    this.lmCache = null;
    this._fps = 0;
    this.lastVideoTime = -1;
    this.recovering = false;
    this.inFlight = false;
  }

  // ── URL source ("Browserquelle") ──────────────────────────────────────────────────────────

  private async openUrlSource(cam: CameraSettings, session: number): Promise<MediaStream> {
    const api = typeof window !== 'undefined' ? window.vtube : undefined;
    if (!api?.urlSourceStart) throw new UrlSourceError('unavailable', 'Die Browserquelle ist hier nicht verfügbar.');
    const url = (cam.url ?? '').trim();
    if (!url) throw new UrlSourceError('no-url', 'Bitte die Adresse der Browserquelle eingeben und „Verbinden“ klicken.');
    const id = ++urlIdSeq;
    const src = new UrlFrameSource(cam.fps);
    this.urlSrc = src;
    this.urlId = id;
    this.lastUrlFrameAt = 0;
    this._urlInfo = { state: 'loading', message: null, url, width: 0, height: 0 };
    let gotFrame = false;
    let resolveFirst!: () => void;
    let rejectFirst!: (e: Error) => void;
    const first = new Promise<void>((res, rej) => { resolveFirst = res; rejectFirst = rej; });
    first.catch(() => undefined);
    this.pendingSource = rejectFirst;
    this.urlUnsubs.push(api.onUrlSourceFrame((f) => {
      if (f.id !== id || session !== this.session || !this.urlSrc) return;
      src.push(f.data, f.width, f.height);
      this.lastUrlFrameAt = performance.now();
      const info = this._urlInfo;
      if (info && (info.width !== f.width || info.height !== f.height)) this._urlInfo = { ...info, width: f.width, height: f.height };
      if (!gotFrame) { gotFrame = true; resolveFirst(); }
    }));
    this.urlUnsubs.push(api.onUrlSourceStatus((st) => {
      if (st.id !== id || session !== this.session) return;
      this._urlInfo = { ...(this._urlInfo ?? { width: 0, height: 0 }), state: st.state, message: st.message ?? null, url: st.url };
      if (st.state !== 'error') return;
      const err = new UrlSourceError(st.fatal ? 'fatal' : 'load', `Browserquelle ${st.url}: ${st.message ?? 'Fehler'}`);
      if (!gotFrame) rejectFirst(err);       // start() fails with the reason (main's retry stops with it)
      else if (st.fatal && this._running) {   // otherwise main reconnects; checkUrlStall gives up later
        this.stop();
        this.onError?.(err);
      }
    }));
    try {
      await api.urlSourceStart({ id, url, width: cam.width, height: cam.height, fps: cam.fps });
    } catch (e) {
      if (session !== this.session) throw new TrackerAbortError();
      throw new UrlSourceError('invalid', String((e as Error)?.message ?? e));
    }
    const timer = setTimeout(() => rejectFirst(new UrlSourceError('timeout',
      `Keine Bilder von der Browserquelle ${url} (nach ${URL_FIRST_FRAME_MS / 1000} s).`)), URL_FIRST_FRAME_MS);
    try {
      await first;
    } finally {
      clearTimeout(timer);
      if (this.pendingSource === rejectFirst) this.pendingSource = null;
    }
    if (session !== this.session) throw new TrackerAbortError();
    return src.stream;
  }

  private checkUrlStall(session: number): void {
    if (session !== this.session || !this._running || !this.urlSrc) return;
    const idle = performance.now() - this.lastUrlFrameAt;
    if (idle < URL_STALL_MS) return;
    const why = this._urlInfo?.state === 'error' && this._urlInfo.message ? ` Letzter Fehler: ${this._urlInfo.message}` : '';
    this.stop();
    this.onError?.(new UrlSourceError('stalled', `Keine Bilder von der Browserquelle seit ${Math.round(idle / 1000)} s.${why}`));
  }

  private closeUrlSource(): void {
    if (this.urlWatch) clearInterval(this.urlWatch);
    this.urlWatch = null;
    for (const off of this.urlUnsubs) {
      try { off(); } catch { /* ignore */ }
    }
    this.urlUnsubs = [];
    if (this.urlSrc) {
      this.urlSrc.close();
      this.urlSrc = null;
      void window.vtube?.urlSourceStop(this.urlId).catch(() => undefined);
    }
    this._urlInfo = null;
    this.lastUrlFrameAt = 0;
  }

  // ── Worker mode ────────────────────────────────────────────────────────────────────────────

  private startWorker(delegate: Delegate, session: number): Promise<void> {
    const worker = this.workerUrl
      ? new Worker(this.workerUrl, { type: this.workerType })
      : createDefaultWorker();
    this.worker = worker;
    // Relative URLs would resolve against the worker script inside the worker → make absolute.
    const base = new URL(this.assetBase + '/', document.baseURI).href.replace(/\/+$/, '');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.pendingInit = null; reject(new Error('worker init timeout')); } }, 30000);
      // stop() during init settles immediately instead of waiting for the timeout.
      this.pendingInit = (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
      worker.onerror = (ev) => {
        if (!settled) { settled = true; clearTimeout(timer); this.pendingInit = null; reject(new Error(ev.message || 'worker error')); return; }
        if (session === this.session) console.error('[FaceTracker] worker error:', ev.message);
      };
      worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (session !== this.session) return;
        if (m.type === 'ready') {
          this._delegate = m.delegate;
          this._mode = 'worker';
          if (!settled) { settled = true; clearTimeout(timer); this.pendingInit = null; resolve(); }
        } else if (m.type === 'error') {
          if (!settled) { settled = true; clearTimeout(timer); this.pendingInit = null; reject(new Error(m.message)); return; }
          console.error('[FaceTracker] detection error:', m.message);
          if (m.fatal) { this.stop(); this.onError?.(new Error(m.message)); }
        } else if (m.type === 'result') {
          this.inFlight = false;
          this._delegate = m.delegate;
          this._detectMs = m.ms;
          if (m.r) this.emit(m.r as PackedResult, this.captureTs);
        }
      };
      worker.postMessage({ type: 'init', assetBase: base, delegate });
    });
  }

  private sendToWorker(session: number): void {
    const now = performance.now();
    if (this.inFlight) {
      if (now - this.inFlightSince < 3000) return; // drop this frame; detection still busy
      this.inFlight = false;                        // watchdog: lost a message
    }
    this.inFlight = true;
    this.inFlightSince = now;
    createImageBitmap(this.video).then((bmp) => {
      if (session !== this.session || !this.worker) { bmp.close(); return; }
      this.captureTs = now;
      this.worker.postMessage({ type: 'frame', bitmap: bmp, ts: now }, [bmp]);
    }).catch(() => { this.inFlight = false; });
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────────────────────

  // Frame callbacks (rVFC, else rAF) drive the loop. A watchdog timer polls the video instead when they
  // stop firing (e.g. KWin/Wayland throttles minimized windows while visibilityState stays 'visible').
  private scheduleNext(session: number): void {
    if (session !== this.session || !this._running) return;
    const v = this.video;
    if (!this.rvfcId && !this.rafId) {
      if (typeof v.requestVideoFrameCallback === 'function') {
        this.rvfcId = v.requestVideoFrameCallback(() => { this.rvfcId = 0; this.onFrameCallback(session, true); });
      } else {
        this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.onFrameCallback(session, false); });
      }
    }
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (session !== this.session || !this._running) return;
      if (!this.cbStalled && !v.paused && !this.stallWarned) {
        this.stallWarned = true;
        console.warn('[FaceTracker] frame callbacks stalled – polling the video by timer while they are missing');
      }
      this.cbStalled = !v.paused;
      this.tick(session, false, true);
    }, this.cbStalled ? this.pollMs : FRAME_CB_STALL_MS);
  }

  private onFrameCallback(session: number, fromRvfc: boolean): void {
    this.cbStalled = false;
    this.tick(session, fromRvfc, false);
  }

  private tick(session: number, fromRvfc: boolean, byTimer: boolean): void {
    if (session !== this.session || !this._running) return;
    const v = this.video;
    try {
      if (v.readyState >= 2 && v.videoWidth > 0) {
        // With rVFC every callback is a new frame (unless the timer already took it); rAF/timer polling
        // must skip repeated frames.
        const isNew = v.currentTime !== this.lastVideoTime || (fromRvfc && !this.lastTickByTimer);
        if (isNew) {
          this.lastTickByTimer = byTimer;
          this.lastVideoTime = v.currentTime;
          if (this.worker) this.sendToWorker(session);
          else if (this.landmarker && !this.recovering) this.processMain(session);
        }
      }
    } finally {
      this.scheduleNext(session);
    }
  }

  private emit(r: PackedResult, ts: number): void {
    const now = performance.now();
    this.fpsCount++;
    if (now - this.fpsWindowStart >= 1000) {
      this._fps = (this.fpsCount * 1000) / (now - this.fpsWindowStart);
      this.fpsCount = 0;
      this.fpsWindowStart = now;
    }
    const frame: FaceFrame = {
      timestamp: ts,
      detected: r.detected,
      blendshapes: {},
      headRotation: r.rot,
      headPosition: r.pos,
    };
    if (r.detected) {
      for (let i = 0; i < r.names.length; i++) {
        const n = r.names[i];
        if (n !== '_neutral') frame.blendshapes[n] = r.scores[i];
      }
      this.lmData = r.landmarks;
    } else {
      this.lmData = null;
    }
    this.lmCache = null;
    this.onFrame?.(frame);
  }

  // ── Main-thread fallback ───────────────────────────────────────────────────────────────────

  private processMain(session: number): void {
    const now = performance.now();
    const ts = Math.max(this.lastTs + 1, Math.floor(now)); // strictly increasing (ms)
    this.lastTs = ts;
    let packed: PackedResult;
    try {
      const res = this.landmarker!.detectForVideo(this.video, ts);
      this._detectMs = performance.now() - now;
      packed = packResult(res);
    } catch (e) {
      this.handleDetectError(e, session, String(e));
      return;
    }
    this.framesProcessed++;
    this.errorCount = 0;
    if (this._delegate === 'GPU' && this.framesProcessed > 5 && this.framesProcessed <= 20) {
      this.gpuMsSum += this._detectMs;
      if (this.framesProcessed === 20 && this.gpuMsSum / 15 > SLOW_GPU_MS) {
        this.rebuildOnCpu(session, `GPU too slow (${(this.gpuMsSum / 15).toFixed(0)} ms/frame)`);
      }
    }
    this.emit(packed, now);
  }

  private rebuildOnCpu(session: number, reason: string): void {
    console.warn('[FaceTracker] switching to CPU delegate:', reason);
    this.recovering = true;
    const old = this.landmarker;
    this.landmarker = null;
    try { old?.close(); } catch { /* ignore */ }
    createLandmarker(this.assetBase, 'CPU').then((r) => {
      if (session !== this.session) { r.lm.close(); return; }
      this.landmarker = r.lm;
      this._delegate = r.delegate;
      this.recovering = false;
    }).catch((err) => {
      if (session !== this.session) return;
      console.error('[FaceTracker] CPU fallback failed:', err);
      this.stop();
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private handleDetectError(e: unknown, session: number, msg: string): void {
    this.errorCount++;
    if (this._delegate === 'GPU' && this.framesProcessed < 10 && !this.recovering) {
      this.rebuildOnCpu(session, msg); // GPU delegate created fine but cannot run (e.g. broken WebGL)
      return;
    }
    if (this.errorCount === 1 || this.errorCount % 100 === 0) console.error('[FaceTracker] detectForVideo failed:', e);
    if (this.errorCount >= 300) {
      this.stop();
      this.onError?.(e instanceof Error ? e : new Error(msg));
    }
  }
}
