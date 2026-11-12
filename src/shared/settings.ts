// Persistent settings schema + defaults. Stored as JSON in Electron userData (settings.json).

export interface CameraSettings {
  source: 'device' | 'url';  // webcam device, or a URL (web page / MJPEG / video stream) rendered offscreen
  deviceId: string | null;   // null = default webcam
  url: string;               // used when source === 'url'
  recentUrls: string[];      // last used URLs (max 10)
  width: number;             // requested capture size
  height: number;
  fps: number;
  showPreview: boolean;      // show webcam preview in the UI
  showLandmarks: boolean;    // draw face mesh on preview
}

export type EmotionKey = 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised';

export interface Calibration {
  blendshapes: Record<string, number>; // neutral-face baseline per blendshape (subtracted, then rescaled)
  headRotation: { x: number; y: number; z: number };
  headPosition: { x: number; y: number; z: number };
  /** Neutral eye gaze (fused iris + eyeLook estimate, degrees, user perspective). Optional: older
   *  calibrations without it use the automatic gaze neutral. */
  gaze?: { yaw: number; pitch: number };
}

export interface TrackingSettings {
  enabled: boolean;
  useGpu: boolean;                 // MediaPipe GPU delegate (falls back to CPU on failure)
  mirror: boolean;                 // avatar moves like a mirror image of the user
  smoothing: number;               // 0 (raw/jittery) .. 1 (very smooth/laggy)
  headRotationScale: number;       // multiplier, 1 = 1:1
  headPositionScale: number;       // multiplier for body lean/translation, 0 disables
  bodyFollow: number;              // 0..1 share of head rotation passed down to spine/chest
  eyeTracking: boolean;            // drive VRM lookAt from eye blendshapes
  eyeGazeScale: number;
  linkBlinks: boolean;             // blink both eyes together (avoid accidental winks)
  blinkSensitivity: number;        // >1 = closes eyes more easily
  mouthSensitivity: number;
  browSensitivity: number;
  autoEmotions: boolean;           // derive happy/angry/sad/relaxed/surprised from face
  emotionSensitivity: Record<EmotionKey, number>; // per emotion multiplier, 0 disables
  usePerfectSync: boolean;         // drive ARKit custom expressions directly if the model has them
  calibration: Calibration | null;
  /** Learn per-user levels while tracking: open/closed eyes, mouth range, neutral blendshape baselines
   *  (emotion thresholds). Works with and without calibration. */
  adaptiveTracking: boolean;
  irisGaze: boolean;               // eye gaze from the iris landmarks (fused with eyeLook blendshapes)
  headDeadzone: number;            // degrees; soft deadzone against micro-jitter of the head at rest
}

export interface LipSyncSettings {
  enabled: boolean;
  deviceId: string | null;
  gain: number;                    // input gain multiplier
  noiseGate: number;               // 0..1 volume threshold
  mix: number;                     // 0 = only camera mouth, 1 = only audio, between = max-blend weight of audio
}

export interface ViewSettings {
  background: { mode: 'color' | 'transparent'; color: string }; // color e.g. "#00ff00" for chroma key
  cameraFov: number;               // degrees
  framing: 'head' | 'upperBody' | 'fullBody';
  cameraOffset: { x: number; y: number; zoom: number }; // user adjustments on top of auto framing
  /** Camera orbit around the framed target, degrees. yaw > 0 = camera moves toward the avatar's own
   *  left side (viewer sees more of the avatar's left cheek); pitch > 0 = camera above, looking down. */
  orbit: { yaw: number; pitch: number };
  lightIntensity: number;
  ambientIntensity: number;
  lightColor: string;
  idleAnimation: boolean;          // breathing / subtle sway
  armPose: number;                 // degrees arms are lowered from T-pose (≈ 65-75 natural)
  targetFps: number;               // 30 | 60 | 120 ...
  showFps: boolean;
}

export interface OutputSettings {
  browserSource: { enabled: boolean; port: number };
  virtualCam: { enabled: boolean; device: string; width: number; height: number; fps: number };
}

export interface Settings {
  version: 1;
  camera: CameraSettings;
  tracking: TrackingSettings;
  lipSync: LipSyncSettings;
  view: ViewSettings;
  output: OutputSettings;
  model: { lastPath: string | null; recent: string[] };
  ui: { panelOpen: boolean; theme: 'light' | 'dark' };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  camera: { source: 'device', deviceId: null, url: '', recentUrls: [], width: 640, height: 480, fps: 30, showPreview: true, showLandmarks: false },
  tracking: {
    enabled: true,
    useGpu: true,
    mirror: true,
    smoothing: 0.5,
    headRotationScale: 1,
    headPositionScale: 1,
    bodyFollow: 0.35,
    eyeTracking: true,
    eyeGazeScale: 1,
    linkBlinks: false,
    blinkSensitivity: 1,
    mouthSensitivity: 1,
    browSensitivity: 1,
    autoEmotions: true,
    emotionSensitivity: { happy: 1, angry: 1, sad: 1, relaxed: 0.6, surprised: 1 },
    usePerfectSync: true,
    calibration: null,
    adaptiveTracking: true,
    irisGaze: true,
    headDeadzone: 0.3,
  },
  lipSync: { enabled: false, deviceId: null, gain: 1.5, noiseGate: 0.08, mix: 0.6 },
  view: {
    background: { mode: 'color', color: '#00ff00' },
    cameraFov: 30,
    framing: 'upperBody',
    cameraOffset: { x: 0, y: 0, zoom: 1 },
    orbit: { yaw: 0, pitch: 0 },
    lightIntensity: 1.6,
    ambientIntensity: 0.6,
    lightColor: '#ffffff',
    idleAnimation: true,
    armPose: 70,
    targetFps: 60,
    showFps: false,
  },
  output: {
    browserSource: { enabled: true, port: 39540 },
    virtualCam: { enabled: false, device: '/dev/video10', width: 1280, height: 720, fps: 30 },
  },
  model: { lastPath: null, recent: [] },
  ui: { panelOpen: true, theme: 'light' },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/** Deep-merge `patch` into `base` (arrays and null replace; returns new object). */
export function mergeSettings<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    const b = (base as any)?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = mergeSettings(b, v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
