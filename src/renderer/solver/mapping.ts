// Face blendshapes → avatar features (blinks, mouth visemes, emotions, gaze).
//
// All functions here work on CALIBRATED blendshape values (see `calibrate`) indexed by ARKIT index,
// from the USER's own perspective ("Left" = user's anatomical left, ARKit convention).
// Mirroring and VRM naming are handled by PoseSolver. Everything is allocation-free so it can run
// once per camera frame.

import type { EmotionKey, TrackingSettings } from '../../shared/settings';

export const ARKIT_NAMES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
] as const;
export type ArkitName = (typeof ARKIT_NAMES)[number];
export const N_BS = ARKIT_NAMES.length; // 52

/** name → index */
export const BS = Object.fromEntries(ARKIT_NAMES.map((n, i) => [n, i])) as Record<ArkitName, number>;

/** Index of the same blendshape on the other side (identity for symmetric ones). Used for mirroring. */
export const MIRROR_INDEX: Int16Array = (() => {
  const out = new Int16Array(N_BS);
  ARKIT_NAMES.forEach((n, i) => {
    let m: string = n;
    if (n.endsWith('Left')) m = n.slice(0, -4) + 'Right';
    else if (n.endsWith('Right')) m = n.slice(0, -5) + 'Left';
    const j = (BS as Record<string, number>)[m];
    out[i] = j === undefined ? i : j;
  });
  return out;
})();

/** Smoothing groups: each gets its own One-Euro parameters. */
export const Group = { Blink: 0, Mouth: 1, Brow: 2, Gaze: 3 } as const;
export const BS_GROUP: Uint8Array = (() => {
  const g = new Uint8Array(N_BS);
  ARKIT_NAMES.forEach((n, i) => {
    if (n.startsWith('eyeLook')) g[i] = Group.Gaze;
    else if (n.startsWith('eye')) g[i] = Group.Blink;          // eyeBlink / eyeSquint / eyeWide
    else if (n.startsWith('brow') || n.startsWith('noseSneer') || n.startsWith('cheekSquint')) g[i] = Group.Brow;
    else g[i] = Group.Mouth;                                     // jaw*, mouth*, cheekPuff, tongueOut
  });
  return g;
})();

/**
 * Built-in neutral baselines used when the user has not calibrated. MediaPipe rarely outputs 0 for a
 * relaxed face: open eyes read eyeBlink ≈ 0.05-0.3, eyeSquint ≈ 0.2-0.4, mouthPucker ≈ 0.1-0.3 etc.
 */
export const DEFAULT_BASELINE: Float32Array = (() => {
  const b = new Float32Array(N_BS);
  const set = (prefix: string, v: number) => ARKIT_NAMES.forEach((n, i) => { if (n.startsWith(prefix)) b[i] = v; });
  set('eyeBlink', 0.15); set('eyeSquint', 0.25); set('eyeWide', 0.02); set('eyeLook', 0.06);
  set('browDown', 0.08); set('browInnerUp', 0.1); set('browOuterUp', 0.05);
  set('cheekSquint', 0.05); set('cheekPuff', 0.02); set('noseSneer', 0.03);
  set('jaw', 0.02); set('jawOpen', 0.03);
  set('mouthClose', 0.03); set('mouthFunnel', 0.03); set('mouthPucker', 0.15); set('mouthSmile', 0.05);
  set('mouthStretch', 0.03); set('mouthFrown', 0.03); set('mouthPress', 0.1); set('mouthDimple', 0.05);
  set('mouthShrugLower', 0.15); set('mouthShrugUpper', 0.1); set('mouthRollLower', 0.05); set('mouthRollUpper', 0.03);
  set('mouthLowerDown', 0.05); set('mouthUpperUp', 0.05); set('mouthLeft', 0.02); set('mouthRight', 0.02);
  set('tongueOut', 0);
  return b;
})();

export const MAX_BASELINE = 0.7;

// ── small math helpers ───────────────────────────────────────────────────────────────────────
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Linear ramp 0..1 between a and b. */
export const ramp = (x: number, a: number, b: number): number => clamp01((x - a) / (b - a));
export const smoothstep = (x: number, a: number, b: number): number => { const t = ramp(x, a, b); return t * t * (3 - 2 * t); };

/** v' = clamp01((v - base) / (1 - base)) for every blendshape. */
export function calibrate(raw: Float32Array, baseline: Float32Array, out: Float32Array): void {
  for (let i = 0; i < N_BS; i++) {
    const b = baseline[i];
    out[i] = clamp01((raw[i] - b) / (1 - b));
  }
}

// ── features ─────────────────────────────────────────────────────────────────────────────────

/** Per-camera-frame features derived from calibrated blendshapes (user perspective). */
export interface FaceFeatures {
  /** Eye closure 0..1 after blink curve (user's own left/right eye), before linking/mirroring. */
  blinkL: number; blinkR: number;
  /** Raw-ish eye closure (pre-curve) used for "relaxed". */
  eyeHalf: number;
  /** Mouth openness 0..1 and camera visemes. */
  open: number;
  aa: number; ih: number; ou: number; ee: number; oh: number;
  /** Emotion targets after thresholds, hysteresis and mutual damping. */
  happy: number; angry: number; sad: number; relaxed: number; surprised: number;
  /** Eye gaze from the user's perspective, degrees (yaw > 0 = user looks to own left, pitch > 0 = up). */
  gazeYaw: number; gazePitch: number;
}

export function makeFeatures(): FaceFeatures {
  return { blinkL: 0, blinkR: 0, eyeHalf: 0, open: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0,
    happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, gazeYaw: 0, gazePitch: 0 };
}

export const EMOTIONS: readonly EmotionKey[] = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

// Hysteresis thresholds on the (already ramped) emotion values.
const EMO_ON = 0.14;
const EMO_OFF = 0.05;

/** Eye closure mapping. MediaPipe rarely exceeds ~0.6-0.8 for a closed eye; calibrated ~0.45-0.6. */
const BLINK_LO = 0.14;
const BLINK_HI = 0.48;

/** Stateful mapper (emotion hysteresis, gaze hold during blinks). */
export class FaceMapper {
  readonly f: FaceFeatures = makeFeatures();
  private emoActive = new Uint8Array(5);
  private emoRaw = new Float32Array(5);

  reset(): void {
    const f = this.f;
    f.blinkL = f.blinkR = f.eyeHalf = f.open = 0;
    f.aa = f.ih = f.ou = f.ee = f.oh = 0;
    f.happy = f.angry = f.sad = f.relaxed = f.surprised = 0;
    f.gazeYaw = f.gazePitch = 0;
    this.emoActive.fill(0);
  }

  /** `c` = calibrated + smoothed blendshapes (user perspective). */
  update(c: Float32Array, t: TrackingSettings): FaceFeatures {
    const f = this.f;
    const avg = (a: number, b: number) => 0.5 * (c[a] + c[b]);

    // ── Eyes ──
    // Looking down lowers the upper lid and raises eyeBlink; compensate a bit (fades out when the
    // eye is clearly closing so real blinks are never suppressed). Squinting adds a little closure.
    const blinkSens = Math.max(0.05, t.blinkSensitivity);
    const eyeL = c[BS.eyeBlinkLeft] + 0.2 * c[BS.eyeSquintLeft]
      - 0.3 * c[BS.eyeLookDownLeft] * (1 - ramp(c[BS.eyeBlinkLeft], 0.3, 0.6));
    const eyeR = c[BS.eyeBlinkRight] + 0.2 * c[BS.eyeSquintRight]
      - 0.3 * c[BS.eyeLookDownRight] * (1 - ramp(c[BS.eyeBlinkRight], 0.3, 0.6));
    f.blinkL = smoothstep(eyeL * blinkSens, BLINK_LO, BLINK_HI);
    f.blinkR = smoothstep(eyeR * blinkSens, BLINK_LO, BLINK_HI);
    f.eyeHalf = clamp01(0.5 * (eyeL + eyeR) * blinkSens / BLINK_HI);

    // ── Mouth ──
    const ms = Math.max(0, t.mouthSensitivity);
    const lipsApart = Math.max(0, c[BS.jawOpen] - 0.8 * c[BS.mouthClose])
      + 0.15 * (avg(BS.mouthLowerDownLeft, BS.mouthLowerDownRight) + avg(BS.mouthUpperUpLeft, BS.mouthUpperUpRight));
    const open = ramp(lipsApart * ms, 0.04, 0.5);
    const pucker = ramp(c[BS.mouthPucker] * ms, 0.1, 0.6);
    const funnel = ramp(c[BS.mouthFunnel] * ms, 0.05, 0.45);
    const smile = avg(BS.mouthSmileLeft, BS.mouthSmileRight);
    const stretch = avg(BS.mouthStretchLeft, BS.mouthStretchRight);
    const wide = clamp01(ramp(stretch * ms, 0.04, 0.4) + 0.5 * ramp(smile, 0.1, 0.6));
    const round = Math.max(pucker, funnel);
    const funnelShare = funnel / (funnel + pucker + 1e-4);
    f.open = open;
    let aa = open * (1 - 0.85 * round) * (1 - 0.5 * wide);
    let oh = round * ramp(open, 0.05, 0.35) * (0.4 + 0.6 * funnelShare);
    let ou = round * (1 - ramp(open, 0.15, 0.5)) * (0.4 + 0.6 * (1 - funnelShare));
    let ih = wide * (1 - round) * ramp(open, 0.02, 0.12) * (1 - ramp(open, 0.2, 0.45));
    let ee = wide * (1 - round) * ramp(open, 0.15, 0.4);
    const sum = aa + oh + ou + ih + ee;
    if (sum > 1) { const k = 1 / sum; aa *= k; oh *= k; ou *= k; ih *= k; ee *= k; }
    f.aa = aa; f.oh = oh; f.ou = ou; f.ih = ih; f.ee = ee;

    // ── Emotions ──
    const bs = Math.max(0, t.browSensitivity);
    const cheek = avg(BS.cheekSquintLeft, BS.cheekSquintRight);
    const browDown = avg(BS.browDownLeft, BS.browDownRight) * bs;
    const innerUp = c[BS.browInnerUp] * bs;
    const outerUp = avg(BS.browOuterUpLeft, BS.browOuterUpRight) * bs;
    const browsUp = 0.5 * (innerUp + outerUp);
    const sneer = avg(BS.noseSneerLeft, BS.noseSneerRight);
    const frown = avg(BS.mouthFrownLeft, BS.mouthFrownRight);
    const press = avg(BS.mouthPressLeft, BS.mouthPressRight);
    const eyeWide = avg(BS.eyeWideLeft, BS.eyeWideRight);
    const es = t.emotionSensitivity;
    const raw = this.emoRaw;
    if (t.autoEmotions) {
      // happy: smile (+ cheek raise). Talking with the mouth wide open also produces smile/stretch
      // readings, so open mouth raises the threshold unless the smile itself is big (laughing).
      raw[0] = ramp(smile + 0.3 * cheek - 0.25 * open * (1 - ramp(smile, 0.4, 0.7)), 0.12, 0.55) * es.happy;
      // angry: lowered brows + nose sneer (+ frown / pressed lips); raised inner brows or smile cancel.
      raw[1] = ramp(0.75 * browDown + 0.5 * sneer + 0.2 * frown + 0.15 * press - 0.6 * innerUp - 0.4 * smile, 0.18, 0.6) * es.angry;
      // sad: mouth corners down + raised INNER brows without raised outer brows (that'd be surprise).
      raw[2] = ramp(0.7 * frown + 0.6 * innerUp * (1 - ramp(outerUp, 0.15, 0.45)) - 0.6 * smile - 0.3 * browDown, 0.2, 0.6) * es.sad;
      // relaxed: slight smile + half-closed eyes, mouth mostly closed.
      raw[3] = ramp(smile, 0.03, 0.2) * (1 - ramp(smile, 0.45, 0.7))
        * ramp(f.eyeHalf, 0.2, 0.45) * (1 - ramp(f.eyeHalf, 0.8, 0.95)) * (1 - ramp(open, 0.1, 0.3)) * es.relaxed;
      // surprised: brows up (gate) + wide eyes + open jaw.
      raw[4] = ramp(0.55 * browsUp + 0.35 * ramp(eyeWide, 0, 0.4) + 0.2 * open, 0.22, 0.6) * ramp(browsUp, 0.1, 0.28) * es.surprised;
    } else {
      raw.fill(0);
    }
    // Hysteresis.
    let maxV = 0, maxI = -1;
    for (let i = 0; i < 5; i++) {
      const v = clamp01(raw[i]);
      if (this.emoActive[i]) { if (v < EMO_OFF) this.emoActive[i] = 0; }
      else if (v > EMO_ON) this.emoActive[i] = 1;
      raw[i] = this.emoActive[i] ? v : 0;
      if (raw[i] > maxV) { maxV = raw[i]; maxI = i; }
    }
    // Mutual damping: the strongest emotion dominates, the others are reduced; total limited to 1.
    let total = 0;
    for (let i = 0; i < 5; i++) {
      if (i !== maxI) raw[i] *= 1 - 0.75 * maxV;
      total += raw[i];
    }
    if (total > 1) for (let i = 0; i < 5; i++) raw[i] /= total;
    f.happy = raw[0]; f.angry = raw[1]; f.sad = raw[2]; f.relaxed = raw[3]; f.surprised = raw[4];

    // ── Gaze ── (hold the last value while the eyes are closing: lids drag eyeLookDown along)
    if (Math.max(f.blinkL, f.blinkR) < 0.5) {
      const left = 0.5 * (c[BS.eyeLookOutLeft] + c[BS.eyeLookInRight]) - 0.5 * (c[BS.eyeLookInLeft] + c[BS.eyeLookOutRight]);
      const up = avg(BS.eyeLookUpLeft, BS.eyeLookUpRight) - avg(BS.eyeLookDownLeft, BS.eyeLookDownRight);
      const gs = t.eyeGazeScale;
      f.gazeYaw = clamp(left * 40 * gs, -35, 35);
      f.gazePitch = clamp(up * 30 * gs, -25, 25);
    }
    return f;
  }
}

// ── Perfect sync output gains (MediaPipe values are smaller than ARKit's) ──
export function perfectSyncGain(i: number, t: TrackingSettings): number {
  const n = ARKIT_NAMES[i];
  if (n === 'jawOpen') return 1.6 * t.mouthSensitivity;
  if (n.startsWith('brow')) return 1.25 * t.browSensitivity;
  if (n.startsWith('eyeWide')) return 2.0;
  if (n.startsWith('eyeSquint')) return 1.0;
  if (n.startsWith('mouth') || n.startsWith('jaw') || n === 'tongueOut' || n === 'cheekPuff') return 1.3 * t.mouthSensitivity;
  return 1.2;
}
