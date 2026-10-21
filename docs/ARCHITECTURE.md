# Architektur

Electron-App (TypeScript). Renderer via Vite, Main via `tsc`.

```
Webcam / Browserquelle ──► FaceTracker (MediaPipe FaceLandmarker) ──► FaceFrame ─┐
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
| `src/main/` | `main.ts`, `preload.ts`, `settingsStore.ts`, `server.ts`, `virtualCam.ts`, `vcamDevice.ts` (Gerät der virtuellen Kamera: Auflösung CLI/Env/Einstellung, Prüfungen, `--list-devices`; /proc-Scan im Worker-Thread), `serialQueue.ts` (Start/Stopp von Server und ffmpeg nacheinander, letzte Anforderung gewinnt), `childEnv.ts` (ffmpeg ohne AppImage-`LD_LIBRARY_PATH`/`PATH`), `urlSource.ts` („Browserquelle“: Offscreen-Fenster → BGRA-Frames) |
| `src/renderer/avatar/` | `AvatarRenderer.ts` (+ Hilfsdateien) |
| `src/renderer/output/` | `output.ts` (OBS-Seite), `src/renderer/output.html` |
| `src/renderer/tracking/` | `FaceTracker.ts` (+ `faceWorker.ts`, `landmarkerCore.ts`, `urlFrameSource.ts`) |
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
  setView(view: ViewSettings): void;     // Hintergrund, Licht, Kamera-Framing + Orbit (view.orbit), FPS-Limit, Idle
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
  start(cam: CameraSettings, useGpu: boolean): Promise<void>; // öffnet Webcam (oder cam.url bei cam.source 'url') + Modell
  stop(): void;
  readonly video: HTMLVideoElement;          // für Preview
  readonly running: boolean;
  readonly lastLandmarks: { x: number; y: number; z: number }[] | null; // normiert 0..1, für Overlay
  onFrame: ((f: FaceFrame) => void) | null;  // pro verarbeitetem Kamerabild
  static listCameras(): Promise<MediaDeviceInfo[]>;
  readonly fps: number;
  readonly urlSource: UrlSourceInfo | null;  // Zustand der Browserquelle (state/message/url/Größe), sonst null
  readonly urlLastFrameAt: number;           // performance.now() des letzten Bildes der Browserquelle
}
```
Fehler der Browserquelle sind `UrlSourceError` (`isUrlSourceError`, `code`: no-url, invalid, load, fatal,
timeout, stalled) mit deutscher Meldung; `start()` löst erst nach dem ersten Bild auf (max. 20 s).

### Browserquelle (Kamera-Quelle `url`)
`main/urlSource.ts` lädt `camera.url` (nur http/https) in ein unsichtbares Offscreen-`BrowserWindow`
(Größe `camera.width×height`, `setFrameRate(camera.fps)`) mit eigener In-Memory-Session
`vtube-urlsource`: Sandbox, Context-Isolation, kein Preload/Node, alle Berechtigungen verweigert,
Pop-ups/Downloads/Nicht-http-Navigation blockiert, stumm, ungültige Zertifikate abgelehnt. Jedes
`paint`-Bild geht als BGRA (`NativeImage.toBitmap`) per `urlsource:frame` an das App-Fenster; der
Preload quittiert jedes Bild (`urlsource:ack`), Main verwirft Bilder, solange zwei unquittiert sind.
Medien-Dokumente (MJPEG, Bild, Video) bekommen CSS „füllen“ + Video-Loop; stehen sie 6 s still, wird
neu geladen. HTML-Seiten werden bei Stillstand jede Sekunde neu gezeichnet (Standbild bleibt Bild).
Ladefehler → `urlsource:status` (deutsch) + Neuversuch mit Backoff (3…15 s). Skalierte Desktops:
Fenster wird verkleinert, damit die Bilder die gewünschte Pixelgröße haben. Im Renderer macht
`UrlFrameSource` daraus per `VideoFrame` (BGRX) + `MediaStreamTrackGenerator` (Fallback: Canvas +
`captureStream`) einen Video-Track für `FaceTracker.video` – der Rest der Pipeline ist unverändert.
Das Offscreen-Fenster wird beim Quellwechsel, Tracker-Stopp, Schließen/Neuladen des App-Fensters und
beim Beenden zerstört.

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
`pose` (send), `server:info`, `vcam:start|stop|status`, `vcam:frame` (send), `vcam:devices`, `shell:open`,
`urlsource:start|stop` (invoke), `urlsource:frame|status` (main → App-Fenster), `urlsource:ack` (send).
