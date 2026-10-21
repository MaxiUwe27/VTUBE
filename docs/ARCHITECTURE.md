# Architektur

Electron-App (TypeScript). Renderer via Vite, Main via `tsc`.

```
Webcam ──► FaceTracker (MediaPipe FaceLandmarker) ──► FaceFrame ─┐
Mikrofon ─► LipSync (WebAudio)                    ──► VisemeFrame ┤
                                                                  ▼
                                         PoseSolver (Glättung, Kalibrierung, Mapping, Emotionen)
                                                                  │ AvatarPose
                         ┌────────────────────────────────────────┼─────────────────────────┐
                         ▼                                        ▼                         ▼
               AvatarRenderer (App-Fenster)          window.vtube.sendPose → Main    Canvas-Pixel → vcamFrame
                                                     → WebSocket → output.html        → Main → ffmpeg → v4l2loopback
                                                       (AvatarRenderer, transparent)
```

## Verzeichnisse / Besitz

| Pfad | Inhalt |
|---|---|
| `src/shared/` | Verträge: `types.ts`, `settings.ts`, `api.ts` (nur nach Absprache ändern); `vcamSetup.ts` (v4l2loopback-Befehle für UI/Meldungen) |
| `src/main/` | `main.ts`, `preload.ts`, `settingsStore.ts`, `server.ts`, `virtualCam.ts`, `vcamDevice.ts` (Gerät der virtuellen Kamera: Auflösung CLI/Env/Einstellung, Prüfungen, `--list-devices`; /proc-Scan im Worker-Thread), `serialQueue.ts` (Start/Stopp von Server und ffmpeg nacheinander, letzte Anforderung gewinnt), `childEnv.ts` (ffmpeg ohne AppImage-`LD_LIBRARY_PATH`/`PATH`) |
| `src/renderer/avatar/` | `AvatarRenderer.ts` (+ Hilfsdateien) |
| `src/renderer/output/` | `output.ts` (OBS-Seite), `src/renderer/output.html` |
| `src/renderer/tracking/` | `FaceTracker.ts` |
| `src/renderer/solver/` | `PoseSolver.ts`, `OneEuroFilter.ts`, `mapping.ts` |
| `src/renderer/audio/` | `LipSync.ts` |
| `src/renderer/app/` | `app.ts`, UI, Styles; `src/renderer/index.html` |
| `src/renderer/public/mediapipe/` | `wasm/` + `face_landmarker.task` (von `scripts/prepare-assets.mjs`) |

## Renderer-Modul-APIs (verbindlich)

### `src/renderer/avatar/AvatarRenderer.ts`
```ts
export class AvatarRenderer {
  constructor(canvas: HTMLCanvasElement, opts?: { transparentCapable?: boolean; preserveDrawingBuffer?: boolean });
  loadVRM(source: ArrayBuffer | string /* URL */): Promise<VrmInfo>; // ersetzt altes Modell, disposed es
  unloadVRM(): void;
  get vrmInfo(): VrmInfo | null;
  applyPose(pose: AvatarPose): void;     // setzt Zielwerte; Rendern passiert im eigenen rAF-Loop
  setView(view: ViewSettings): void;     // Hintergrund, Licht, Kamera-Framing, FPS-Limit, Idle
  start(): void; stop(): void; dispose(): void;
  onFrame: ((dtSeconds: number) => void) | null;  // nach jedem gerenderten Frame
  readPixels(width: number, height: number): Uint8Array | null; // RGBA top-down in Zielgröße (für vcam)
  readonly fps: number;                  // gemessene Render-FPS
}
```
Behandelt: VRM0 + VRM1 (`VRMUtils.rotateVRM0`), Arme aus T-Pose (`armPose`), Atmung/Idle, SpringBones,
LookAt, Auto-Framing per Head-Bone, Resize, Dispose (`VRMUtils.deepDispose`).

### `src/renderer/tracking/FaceTracker.ts`
```ts
export class FaceTracker {
  constructor(opts: { assetBase: string /* z.B. './mediapipe' */ });
  start(cam: CameraSettings, useGpu: boolean): Promise<void>; // öffnet Webcam + Modell
  stop(): void;
  readonly video: HTMLVideoElement;          // für Preview
  readonly running: boolean;
  readonly lastLandmarks: { x: number; y: number; z: number }[] | null; // normiert 0..1, für Overlay
  onFrame: ((f: FaceFrame) => void) | null;  // pro verarbeitetem Kamerabild
  static listCameras(): Promise<MediaDeviceInfo[]>;
  readonly fps: number;
}
```

### `src/renderer/audio/LipSync.ts`
```ts
export class LipSync {
  start(s: LipSyncSettings): Promise<void>; stop(): void; update(s: LipSyncSettings): void;
  read(): VisemeFrame | null;               // pollen pro Frame, null wenn aus
  static listMicrophones(): Promise<MediaDeviceInfo[]>;
}
```

### `src/renderer/solver/PoseSolver.ts`
```ts
export class PoseSolver {
  constructor(settings: TrackingSettings, lipSync: LipSyncSettings);
  updateSettings(t: TrackingSettings, l: LipSyncSettings): void;
  setModel(info: VrmInfo | null): void;     // Perfect-Sync-Erkennung, verfügbare Expressions
  pushFace(f: FaceFrame): void;
  /** Aufruf pro Render-Frame. viseme darf null sein. */
  solve(viseme: VisemeFrame | null, nowMs: number): AvatarPose;
  /** Aktuelles (letztes) FaceFrame als neutrale Pose übernehmen. null wenn kein Gesicht. */
  captureCalibration(): Calibration | null;
}
```

## Koordinaten-Konventionen
Siehe Kommentare in `src/shared/types.ts`. `FaceFrame` ist aus Nutzersicht, `AvatarPose` ist Avatar-Raum.
Spiegelung (`tracking.mirror`) macht ausschließlich der Solver.

## IPC
Siehe `src/shared/api.ts`. Channels: `settings:get`, `settings:set`, `model:open`, `model:load`,
`pose` (send), `server:info`, `vcam:start|stop|status`, `vcam:frame` (send), `vcam:devices`, `shell:open`.
