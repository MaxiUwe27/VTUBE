// Shared data contracts between tracking, solver, renderer, main process and the
// OBS output page. Keep this file dependency-free (used by main + renderer).

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

/**
 * Raw face tracker output for one video frame.
 * Directions are from the USER's own perspective (not mirrored, not avatar space):
 *  - headRotation.x (pitch) > 0  : user looks up
 *  - headRotation.y (yaw)   > 0  : user turns head to their own left
 *  - headRotation.z (roll)  > 0  : user tilts head toward their own left shoulder
 *  - headPosition: cm, x > 0 = user moves to their own left, y > 0 = up, z > 0 = toward camera.
 *    Absolute (from MediaPipe facial transformation matrix); the solver subtracts the calibrated neutral.
 */
export interface FaceFrame {
  timestamp: number;                    // ms (performance.now())
  detected: boolean;                    // false => other fields are stale/zero
  blendshapes: Record<string, number>;  // MediaPipe/ARKit 52 names, e.g. "eyeBlinkLeft", "jawOpen"; 0..1
  headRotation: Vec3;                   // radians
  headPosition: Vec3;                   // cm
}

/** Microphone lip-sync analysis for one audio tick. */
export interface VisemeFrame {
  timestamp: number;
  volume: number;                       // 0..1 after gain/noise gate
  visemes: { aa: number; ih: number; ou: number; ee: number; oh: number }; // 0..1
}

export type HumanBone = 'hips' | 'spine' | 'chest' | 'upperChest' | 'neck' | 'head';

/**
 * Fully solved avatar state. Produced by the solver in the app window and
 * applied by AvatarRenderer (app window AND OBS output page via WebSocket).
 */
export interface AvatarPose {
  timestamp: number;
  /** VRM expression name -> weight 0..1. VRM1 preset names (happy, angry, sad, relaxed, surprised,
   *  aa, ih, ou, ee, oh, blink, blinkLeft, blinkRight, neutral) and/or custom names (e.g. ARKit
   *  perfect-sync names). The renderer silently ignores names the model lacks. */
  expressions: Record<string, number>;
  /** Local rotations of normalized humanoid bones (three-vrm normalized space; identity = rest pose). */
  bones: Partial<Record<HumanBone, Quat>>;
  /** Optional hips translation offset in metres, relative to rest position. */
  hipsOffset?: Vec3;
  /** Eye gaze in degrees from the avatar's perspective (yaw > 0 = avatar looks to its own left,
   *  pitch > 0 = up). null => renderer keeps eyes forward / uses its own idle. */
  lookAt: { yaw: number; pitch: number } | null;
}

/** Info about a loaded VRM, returned by AvatarRenderer.loadVRM. */
export interface VrmInfo {
  name: string;
  version: '0' | '1';
  /** Usable expression names (presets + custom + automatically mapped ones) – only expressions that
   *  actually change something (binds to morph targets with data / materials). */
  expressionNames: string[];
  hasPerfectSync: boolean;     // model has (most) ARKit 52 blendshapes (as expressions or mapped morphs)
  hasLookAt: boolean;
  /** Expressions the renderer created automatically from morph targets / differently named model
   *  expressions (name → German description of the source). */
  mappedExpressions?: { name: string; source: string }[];
  /** Model expressions that exist but do nothing (no binds or only morph targets without data). */
  emptyExpressions?: string[];
  /** Repairs applied while loading (German, shown in the diagnostics). */
  repairs?: string[];
}

/** WebSocket messages main -> OBS output page (JSON). */
export type OutputMessage =
  | { type: 'pose'; pose: AvatarPose }
  | { type: 'view'; view: import('./settings').ViewSettings }
  | { type: 'model'; url: string | null; rev: number }; // url relative to server root, e.g. "/model.vrm?rev=3"
