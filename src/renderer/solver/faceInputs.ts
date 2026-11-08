// Camera-rate estimation of eye closure, mouth openness and eye gaze from blendshapes + face-mesh
// geometry, with per-user adaptive ranges (see adaptive.ts). Output feeds FaceMapper (mapping.ts).
//
//  • Blink: eyeBlink blendshape fused with the eye aspect ratio (EAR) of the lid landmarks. Each eye
//    learns its own "open" level (running quantile) and "closed" level (average depth of detected
//    blinks), so a full natural blink reaches ≈1 and open eyes ≈0 for narrow eyes, glasses or a camera
//    above the face. Looking down (gaze / head pitch below neutral) lowers the upper lid; the expected
//    open level is lowered accordingly. Blinks stay unfiltered except a light One-Euro (low latency).
//  • Mouth: jawOpen fused with the inner-lip gap; closed/open levels adapt (low/high quantiles), so
//    small talking movements are visible and a wide-open mouth reaches 1.
//  • Gaze: iris centre relative to the eye corners (normalised by eye width) fused with eyeLook*,
//    relative to a neutral gaze (calibration, else a slow running median: people mostly look at their
//    screen, which then becomes "looking at the viewer").
//
// All values are from the USER's perspective (L = user's own left eye).

import type { TrackingSettings } from '../../shared/settings';
import { OneEuroFilter } from './OneEuroFilter';
import { RangeTracker } from './adaptive';
import { type FaceGeometry } from './faceGeometry';
import { BS, clamp, clamp01 } from './mapping';

/** Degrees of eye rotation per eye-width of iris displacement (fit on test videos: 110-160 / 100-190). */
const IRIS_YAW_DEG = 130;
const IRIS_PITCH_DEG = 120;
/** Share of the iris estimate in the fused gaze (rest: eyeLook* blendshapes). */
const IRIS_WEIGHT = 0.6;

/** Inputs for FaceMapper.update (user perspective). */
export interface FaceInputs {
  /** Eye closure before the output curve: ≈0 open, ≈1 fully closed (may exceed 1 slightly). */
  closeL: number; closeR: number;
  /** Mouth openness 0..1 (1 ≈ the user's typical wide-open mouth), before mouthSensitivity. */
  open: number;
  /** Gaze relative to neutral, degrees: yaw > 0 = user looks to own left, pitch > 0 = up. Not yet
   *  scaled by eyeGazeScale. */
  gazeYaw: number; gazePitch: number;
}

class EyeCloser {
  // EAR: open level = 60% quantile (blinks are a few % of the frames). Window ≈ 8.5 s.
  private ear = new RangeTracker(0.26, 0.26, { qLo: 0.6, qHi: 0.6, tauLoUp: 3, tauLoDown: 3, tauHiUp: 3, tauHiDown: 3, every: 4 });
  // eyeBlink blendshape: open level = 40% quantile.
  private bs = new RangeTracker(0.18, 0.18, { qLo: 0.4, qHi: 0.4, tauLoUp: 3, tauLoDown: 3, tauHiUp: 3, tauHiDown: 3, every: 4 });
  private earClosedFrac = 0.25;   // closed EAR as a fraction of the open EAR (learned from blinks)
  private bsClosed = 0.6;         // eyeBlink of a closed eye (learned from blinks)
  private inEvent = false;
  private evMinEar = 1;
  private evMaxBs = 0;
  private evLen = 0;
  private gatedFor = 0;           // seconds the open-level update was skipped
  private earF = new OneEuroFilter();
  value = 0;

  setFilter(minCutoff: number, beta: number): void { this.earF.setParams(minCutoff, beta * 8, 2); }

  reset(): void { this.earF.reset(); this.inEvent = false; this.value = 0; }

  resetLevels(): void {
    this.ear.reset(); this.bs.reset();
    this.earClosedFrac = 0.25; this.bsClosed = 0.6;
  }

  /** `ear` NaN when no landmarks; `bs` = smoothed raw eyeBlink; lidComp 0..0.4 = expected lid drop. */
  update(ear: number, bs: number, lidComp: number, dt: number, adaptive: boolean, learn: boolean): number {
    const hasEar = Number.isFinite(ear);
    if (hasEar) ear = this.earF.filter(ear, dt);
    const O = this.ear.lo, B0 = this.bs.lo;
    const B1 = Math.max(this.bsClosed, B0 + 0.25);
    let cB = (bs - (B0 + lidComp * (B1 - B0) * 1.2)) / (B1 - B0);
    let fused: number;
    if (hasEar) {
      const Oeff = O * (1 - lidComp), C = O * this.earClosedFrac;
      const cE = (Oeff - ear) / Math.max(0.03, Oeff - C);
      cB = clamp(cB, 0, 1.2);
      fused = 0.6 * clamp(cE, 0, 1.2) + 0.4 * cB;
    } else {
      fused = clamp(cB, 0, 1.2);
    }
    this.value = fused;
    if (!adaptive || !learn) return fused;

    // Blink events → learn the closed levels (only short, deep closures = real blinks).
    if (!this.inEvent && fused > 0.55) {
      this.inEvent = true; this.evMinEar = hasEar ? ear : 1; this.evMaxBs = bs; this.evLen = 0;
    } else if (this.inEvent) {
      this.evLen += dt;
      if (hasEar) this.evMinEar = Math.min(this.evMinEar, ear);
      this.evMaxBs = Math.max(this.evMaxBs, bs);
      if (fused < 0.3) {
        this.inEvent = false;
        if (this.evLen < 1.2) {
          if (hasEar && this.evMinEar < 0.8 * O) this.earClosedFrac += 0.25 * (clamp(this.evMinEar / O, 0.03, 0.55) - this.earClosedFrac);
          if (this.evMaxBs > B0 + 0.15) this.bsClosed += 0.25 * (clamp(this.evMaxBs, B0 + 0.25, 1) - this.bsClosed);
        }
      }
    }
    // Open levels: skip clearly closed frames (unbiased by blinks), but never get stuck.
    if (fused < 0.45 || this.ear.samples < 32 || this.gatedFor > 2.5) {
      this.gatedFor = 0;
      if (hasEar && lidComp < 0.05) this.ear.push(ear, dt);
      if (lidComp < 0.05) this.bs.push(bs, dt);
    } else {
      this.gatedFor += dt;
    }
    return fused;
  }
}

function smoothstepLocal(x: number, a: number, b: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export class FaceInputEstimator {
  readonly out: FaceInputs = { closeL: 0, closeR: 0, open: 0, gazeYaw: 0, gazePitch: 0 };
  /** Fused gaze BEFORE neutral subtraction (degrees) – stored by calibration. */
  rawGazeYaw = 0;
  rawGazePitch = 0;

  private eyeL = new EyeCloser();
  private eyeR = new EyeCloser();
  private lip = new RangeTracker(0.0, 0.3, { qLo: 0.1, qHi: 0.97, tauLoUp: 4, tauLoDown: 1, tauHiUp: 1.5, tauHiDown: 25, size: 96, every: 4 });
  private jaw = new RangeTracker(0.0, 0.35, { qLo: 0.1, qHi: 0.97, tauLoUp: 4, tauLoDown: 1, tauHiUp: 1.5, tauHiDown: 25, size: 96, every: 4 });
  private lipF = new OneEuroFilter();
  private gazeF = [new OneEuroFilter(), new OneEuroFilter()];
  // Auto gaze neutral (running median over ≈ 20 s, only while the eyes are open).
  private nYaw = new RangeTracker(0, 0, { qLo: 0.5, qHi: 0.5, tauLoUp: 6, tauLoDown: 6, tauHiUp: 6, tauHiDown: 6, size: 96, every: 6 });
  private nPitch = new RangeTracker(0, 0, { qLo: 0.5, qHi: 0.5, tauLoUp: 6, tauLoDown: 6, tauHiUp: 6, tauHiDown: 6, size: 96, every: 6 });
  private nInit = false;
  private calGaze: { yaw: number; pitch: number } | null = null;

  setFilters(blinkMin: number, mouthMin: number, gazeMin: number): void {
    this.eyeL.setFilter(blinkMin, 4); this.eyeR.setFilter(blinkMin, 4);
    this.lipF.setParams(mouthMin, 6, 2);
    for (const f of this.gazeF) f.setParams(gazeMin, 0.04, 1.5); // beta per deg/s: saccades stay fast
  }

  /** Neutral gaze from the calibration (null = automatic). */
  setCalibration(gaze: { yaw: number; pitch: number } | null | undefined): void {
    this.calGaze = gaze && Number.isFinite(gaze.yaw) && Number.isFinite(gaze.pitch) ? { yaw: gaze.yaw, pitch: gaze.pitch } : null;
  }

  /** Filters restart (face re-acquired). Learned levels are kept. */
  reset(): void {
    this.eyeL.reset(); this.eyeR.reset(); this.lipF.reset();
    for (const f of this.gazeF) f.reset();
  }

  /**
   * @param geo        face geometry or null (no landmarks)
   * @param bs         smoothed RAW blendshapes (ARKit index)
   * @param rawBs      unsmoothed raw blendshapes (gaze has its own filter)
   * @param headPitch  head pitch relative to neutral, radians (> 0 = up)
   * @param camYaw     head yaw relative to the CAMERA, radians (> 0 = user turned to own left)
   */
  update(geo: FaceGeometry | null, bs: Float32Array, rawBs: Float32Array, headPitch: number, camYaw: number,
    t: TrackingSettings, dt: number): FaceInputs {
    const o = this.out;
    const adaptive = t.adaptiveTracking !== false;

    // ── Gaze (raw fused, degrees) ──
    const bsLeft = 0.5 * (rawBs[BS.eyeLookOutLeft] + rawBs[BS.eyeLookInRight]) - 0.5 * (rawBs[BS.eyeLookInLeft] + rawBs[BS.eyeLookOutRight]);
    const bsUp = 0.5 * (rawBs[BS.eyeLookUpLeft] + rawBs[BS.eyeLookUpRight]) - 0.5 * (rawBs[BS.eyeLookDownLeft] + rawBs[BS.eyeLookDownRight]);
    let yaw = bsLeft * 40, pitch = bsUp * 30;
    if (geo && t.irisGaze !== false) {
      yaw = IRIS_WEIGHT * 0.5 * (geo.irisLX + geo.irisRX) * IRIS_YAW_DEG + (1 - IRIS_WEIGHT) * yaw;
      pitch = IRIS_WEIGHT * 0.5 * (geo.irisLY + geo.irisRY) * IRIS_PITCH_DEG + (1 - IRIS_WEIGHT) * pitch;
    }
    // Hold the gaze while the eyes are closing (lids drag the iris / eyeLookDown along).
    const closing = Math.max(this.eyeL.value, this.eyeR.value) > 0.45;
    if (!closing || !this.gazeF[0].ready) {
      this.rawGazeYaw = this.gazeF[0].filter(yaw, dt);
      this.rawGazePitch = this.gazeF[1].filter(pitch, dt);
    }
    if (!this.nInit) { this.nYaw.reset(this.rawGazeYaw, this.rawGazeYaw); this.nPitch.reset(this.rawGazePitch, this.rawGazePitch); this.nInit = true; }
    else if (!closing) { this.nYaw.push(this.rawGazeYaw, dt); this.nPitch.push(this.rawGazePitch, dt); }
    const ny = this.calGaze ? this.calGaze.yaw : this.nYaw.lo;
    const np = this.calGaze ? this.calGaze.pitch : this.nPitch.lo;
    o.gazeYaw = this.rawGazeYaw - ny;
    o.gazePitch = this.rawGazePitch - np;

    // ── Eyes ──
    // Looking (eyes or head) further down than neutral lowers the upper lid.
    const downDeg = Math.max(0, -o.gazePitch) + 0.5 * Math.max(0, -headPitch * 57.3);
    const lidComp = adaptive ? clamp(0.012 * downDeg, 0, 0.4) : 0;
    // Learn levels only while the face looks roughly at the camera (turned faces distort both cues).
    const yawDeg = camYaw * 57.3, learn = Math.abs(yawDeg) < 15;
    let cl = this.eyeL.update(geo ? geo.earL : NaN, bs[BS.eyeBlinkLeft], lidComp, dt, adaptive, learn);
    let cr = this.eyeR.update(geo ? geo.earR : NaN, bs[BS.eyeBlinkRight], lidComp, dt, adaptive, learn);
    // Head turned: the far eye is foreshortened / partly hidden by the nose, its lid landmarks and
    // eyeBlink read "closed" (measured: EAR −60 %, eyeBlink ≈ 0.45 at 35° yaw) → follow the near eye.
    // Turned to the user's own right (yaw < 0) the LEFT eye is the unreliable one (verified on video).
    const w = smoothstepLocal(Math.abs(yawDeg), 12, 28);
    if (w > 0) {
      if (yawDeg < 0) cl += (Math.min(cl, cr + 0.15) - cl) * w; else cr += (Math.min(cr, cl + 0.15) - cr) * w;
    }
    o.closeL = cl; o.closeR = cr;

    // ── Mouth ──
    const jaw = Math.max(0, bs[BS.jawOpen] - 0.8 * bs[BS.mouthClose]);
    const jawN = this.jaw.norm(jaw, 0.2);
    let open = jawN;
    if (geo) {
      const lip = this.lipF.filter(geo.lipGap, dt);
      open = 0.55 * this.lip.norm(lip, 0.12) + 0.45 * jawN;
      if (adaptive) this.lip.push(lip, dt);
    }
    if (adaptive) this.jaw.push(jaw, dt);
    o.open = clamp01(open);
    return o;
  }

  /** Forget everything learned (e.g. a different person). */
  resetLevels(): void {
    this.eyeL.resetLevels(); this.eyeR.resetLevels(); this.lip.reset(); this.jaw.reset();
    this.nInit = false;
  }
}
