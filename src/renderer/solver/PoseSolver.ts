// PoseSolver: FaceFrame (camera rate, user perspective) + VisemeFrame (audio) → AvatarPose
// (render rate, avatar space).
//
// Pipeline
//   pushFace (≈30 Hz):  raw → One-Euro filters (per channel, tuned per group) → calibration
//                       (neutral head pose + blendshape baselines) → features (mapping.ts) → TARGETS
//   solve (60-144 Hz):  exponential followers toward the targets (removes 30 Hz stair-stepping,
//                       emotion attack/release), face-lost fade + idle blinks, audio viseme mixing,
//                       mirroring, scaling, clamping, bone distribution → AvatarPose
//
// Conventions: see axes.ts. Timestamps (FaceFrame.timestamp and solve's nowMs) must use the same
// clock (performance.now()).

import { Euler, Quaternion, Vector3 } from 'three';
import type { AvatarPose, FaceFrame, HumanBone, Quat, Vec3, VisemeFrame, VrmInfo } from '../../shared/types';
import type { Calibration, LipSyncSettings, TrackingSettings } from '../../shared/settings';
import { OneEuroFilter } from './OneEuroFilter';
import {
  ARKIT_NAMES, BS, BS_GROUP, DEFAULT_BASELINE, FaceMapper, Group, MAX_BASELINE, MIRROR_INDEX, N_BS,
  calibrate, clamp, clamp01, perfectSyncGain, smoothstep,
} from './mapping';
import { EULER_ORDER, HIPS_X_SIGN, HIPS_Z_SIGN, LOOK_PITCH_SIGN, LOOK_YAW_SIGN, PITCH_SIGN, ROLL_SIGN, YAW_SIGN } from './axes';

const DEG = Math.PI / 180;
/** Face considered lost after this long without a detected frame. */
const LOST_AFTER_MS = 500;
/** Neck pivot relative to the MediaPipe face origin, in face-local cm (below + behind the face). Used to
 *  remove the translation that a pure head ROTATION causes, so only real body lean moves the hips. */
const NECK_PIVOT = new Vector3(0, -8, -5);
/** Without calibration the neutral neck position adapts slowly toward the user's average position. */
const AUTO_NEUTRAL_TAU_S = 30;
/** Ring buffer for calibration (raw frames). */
const CAL_FRAMES = 32;
const CAL_WINDOW_MS = 500;

// Semantic avatar angle limits (after headRotationScale), radians.
const YAW_LIMIT = 75 * DEG;
const PITCH_UP_LIMIT = 50 * DEG;
const PITCH_DOWN_LIMIT = 55 * DEG;
const ROLL_LIMIT = 45 * DEG;

/** Share of head rotation (per axis) that may go to the body at bodyFollow = 1. */
const BODY_SHARE = { yaw: 1.0, pitch: 0.5, roll: 0.6 };
const HEAD_SHARE = 0.6; // of the remaining head+neck rotation; neck gets the rest
const SPINE_SHARE = 0.45; // of the body rotation; chest gets the rest

const PRESET_VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
const IS_EYE_LOOK = ARKIT_NAMES.map((n) => n.startsWith('eyeLook'));
/** Perfect-sync shapes that form speech (attenuated by the audio mix like the preset visemes). */
const IS_SPEECH_SHAPE = ARKIT_NAMES.map((n) => /^(jawOpen|mouthClose|mouthFunnel|mouthPucker|mouthLowerDown|mouthUpperUp|mouthStretch)/.test(n));

/** Emotion → how much it suppresses blinks / mouth visemes (avoids VRM expression clipping). */
const EMO_BLINK_DAMP = { happy: 0.5, angry: 0.3, sad: 0.3, relaxed: 0.6, surprised: 0.85 };
const EMO_MOUTH_DAMP = { happy: 0.35, angry: 0.3, sad: 0.3, relaxed: 0.2, surprised: 0.6 };

const geo = (a: number, b: number, s: number) => a * Math.pow(b / a, s);
const follow = (cur: number, target: number, dt: number, tau: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

interface Head { yaw: number; pitch: number; roll: number; dx: number; dy: number; dz: number }
const makeHead = (): Head => ({ yaw: 0, pitch: 0, roll: 0, dx: 0, dy: 0, dz: 0 });

interface Expr {
  blinkL: number; blinkR: number;
  aa: number; ih: number; ou: number; ee: number; oh: number;
  happy: number; angry: number; sad: number; relaxed: number; surprised: number;
  gazeYaw: number; gazePitch: number;
}
const makeExpr = (): Expr => ({ blinkL: 0, blinkR: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0,
  happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, gazeYaw: 0, gazePitch: 0 });

export class PoseSolver {
  private t!: TrackingSettings;
  private l!: LipSyncSettings;

  // Model / perfect sync
  private psNames: string[] = ARKIT_NAMES.slice();
  private modelHasPs = false;
  // Which blink expressions the model has (no model → assume all, the renderer ignores missing ones).
  private hasBlink = true;
  private hasBlinkLR = true;

  // Filters (camera rate)
  private rotF = [new OneEuroFilter(), new OneEuroFilter(), new OneEuroFilter()];
  private posF = [new OneEuroFilter(), new OneEuroFilter(), new OneEuroFilter()];
  private bsF: OneEuroFilter[] = Array.from({ length: N_BS }, () => new OneEuroFilter());
  private psGain = new Float32Array(N_BS);

  // Follower time constants (render rate), seconds
  private tauHead = 0.045;
  private tauMouth = 0.035;
  private tauEmoUp = 0.15;
  private tauEmoDown = 0.27;
  private tauGaze = 0.055;

  // Calibration
  private baseline = new Float32Array(DEFAULT_BASELINE);
  private neutralQ = new Quaternion();
  private neutralQInv = new Quaternion();
  private neutralNeck = new Vector3();
  private hasNeutralNeck = false;
  private calibrated = false;
  private settingsCalibRef: Calibration | null | undefined = undefined;
  private calBuf = Array.from({ length: CAL_FRAMES }, () => new Float32Array(N_BS + 6));
  private calTs = new Float64Array(CAL_FRAMES).fill(-Infinity);
  private calHead = 0;

  // Per-frame scratch
  private rawBs = new Float32Array(N_BS);
  private filtBs = new Float32Array(N_BS);
  private calBs = new Float32Array(N_BS);
  private mapper = new FaceMapper();
  private q = new Quaternion();
  private q2 = new Quaternion();
  private e = new Euler();
  private v = new Vector3();

  // Camera-rate state
  private lastDetTs = -Infinity;  // timestamp of the last detected frame
  private lastPushDetected = false;

  // Targets (user perspective, set at camera rate) and current smoothed values (render rate)
  private tgtHead = makeHead();
  private curHead = makeHead();
  private tgtExpr = makeExpr();
  private curExpr = makeExpr();
  private tgtPs = new Float32Array(N_BS);
  private curPs = new Float32Array(N_BS);
  private gazeValid = false;

  // Render-rate state
  private lastSolveMs = -1;
  private idleBlinkStart = -1;
  private nextIdleBlink = 0;

  constructor(settings: TrackingSettings, lipSync: LipSyncSettings) {
    this.updateSettings(settings, lipSync);
  }

  updateSettings(t: TrackingSettings, l: LipSyncSettings): void {
    this.t = t;
    this.l = l;
    const s = clamp01(t.smoothing);
    // One-Euro parameters. smoothing 0 → nearly raw, 1 → very smooth.
    const headMin = geo(5, 0.25, s);         // Hz
    const headBeta = geo(4, 0.25, s);        // per rad/s
    for (const f of this.rotF) f.setParams(headMin, headBeta, 1);
    for (const f of this.posF) f.setParams(headMin, headBeta * 0.04, 1); // per cm/s
    const groupParams: [number, number, number][] = [];
    groupParams[Group.Blink] = [Math.max(3, 4 * headMin), 4, 2];   // blinks must stay snappy
    groupParams[Group.Mouth] = [2.5 * headMin, 2, 2];
    groupParams[Group.Brow] = [1.2 * headMin, 0.8, 1];              // brows / emotions: calmer
    groupParams[Group.Gaze] = [1.0 * headMin, 0.6, 1];              // eye gaze is noisy
    for (let i = 0; i < N_BS; i++) {
      const [mc, b, dc] = groupParams[BS_GROUP[i]];
      this.bsF[i].setParams(mc, b, dc);
      this.psGain[i] = perfectSyncGain(i, t);
    }
    this.tauHead = 0.02 + 0.05 * s;
    this.tauMouth = 0.025 + 0.02 * s;
    this.tauEmoUp = 0.08 + 0.15 * s;
    this.tauEmoDown = 0.15 + 0.25 * s;
    this.tauGaze = 0.03 + 0.05 * s;

    if (t.calibration !== this.settingsCalibRef) {
      this.settingsCalibRef = t.calibration;
      // A malformed stored calibration (hand-edited / older settings.json) is ignored, never fatal.
      const cal = validCalibration(t.calibration);
      if (t.calibration && !cal) console.warn('[PoseSolver] ignoring invalid calibration in settings', t.calibration);
      this.applyCalibration(cal);
    }
  }

  setModel(info: VrmInfo | null): void {
    this.modelHasPs = !!info?.hasPerfectSync;
    const lower = new Map<string, string>();
    for (const n of info?.expressionNames ?? []) lower.set(n.toLowerCase(), n);
    this.psNames = ARKIT_NAMES.map((n) => lower.get(n.toLowerCase()) ?? n);
    this.hasBlink = !info || lower.has('blink');
    this.hasBlinkLR = !info || (lower.has('blinkleft') && lower.has('blinkright'));
  }

  pushFace(f: FaceFrame): void {
    if (!f.detected) { this.lastPushDetected = false; return; }
    this.lastPushDetected = true;

    let dt = (f.timestamp - this.lastDetTs) / 1000;
    if (!(dt > 0) || dt > LOST_AFTER_MS / 1000) {
      // First frame or re-acquired after a gap: restart filters from the raw value.
      for (const fl of this.rotF) fl.reset();
      for (const fl of this.posF) fl.reset();
      for (const fl of this.bsF) fl.reset();
      this.mapper.reset();
      dt = 0;
    }
    this.lastDetTs = f.timestamp;
    const r = f.headRotation, p = f.headPosition;

    // Store raw sample for calibration.
    const slot = this.calBuf[this.calHead];
    for (let i = 0; i < N_BS; i++) {
      const v = f.blendshapes[ARKIT_NAMES[i]];
      this.rawBs[i] = v === undefined || !Number.isFinite(v) ? 0 : v;
      slot[i] = this.rawBs[i];
    }
    slot[N_BS] = r.x; slot[N_BS + 1] = r.y; slot[N_BS + 2] = r.z;
    slot[N_BS + 3] = p.x; slot[N_BS + 4] = p.y; slot[N_BS + 5] = p.z;
    this.calTs[this.calHead] = f.timestamp;
    this.calHead = (this.calHead + 1) % CAL_FRAMES;

    // ── Head rotation ── (absolute, user perspective) → filtered → relative to the neutral pose.
    const pitch = this.rotF[0].filter(r.x, dt);
    const yaw = this.rotF[1].filter(r.y, dt);
    const roll = this.rotF[2].filter(r.z, dt);
    userQuat(pitch, yaw, roll, this.e, this.q);                // absolute head orientation (camera frame)
    this.q2.copy(this.neutralQInv).multiply(this.q);           // local delta: neutral⁻¹ · current
    this.e.setFromQuaternion(this.q2, EULER_ORDER);
    const th = this.tgtHead;
    th.pitch = -this.e.x; th.yaw = this.e.y; th.roll = -this.e.z;

    // ── Neck position ── (lean): face origin + rotated pivot, relative to neutral.
    const px = this.posF[0].filter(p.x, dt), py = this.posF[1].filter(p.y, dt), pz = this.posF[2].filter(p.z, dt);
    this.v.copy(NECK_PIVOT).applyQuaternion(this.q);
    this.v.x += px; this.v.y += py; this.v.z += pz;
    if (!this.hasNeutralNeck) { this.neutralNeck.copy(this.v); this.hasNeutralNeck = true; }
    else if (!this.calibrated && dt > 0) this.neutralNeck.lerp(this.v, 1 - Math.exp(-dt / AUTO_NEUTRAL_TAU_S));
    th.dx = this.v.x - this.neutralNeck.x;
    th.dy = this.v.y - this.neutralNeck.y;
    th.dz = this.v.z - this.neutralNeck.z;

    // ── Blendshapes ──
    for (let i = 0; i < N_BS; i++) this.filtBs[i] = this.bsF[i].filter(this.rawBs[i], dt);
    calibrate(this.filtBs, this.baseline, this.calBs);
    const feat = this.mapper.update(this.calBs, this.t);
    const te = this.tgtExpr;
    te.blinkL = feat.blinkL; te.blinkR = feat.blinkR;
    te.aa = feat.aa; te.ih = feat.ih; te.ou = feat.ou; te.ee = feat.ee; te.oh = feat.oh;
    te.happy = feat.happy; te.angry = feat.angry; te.sad = feat.sad; te.relaxed = feat.relaxed; te.surprised = feat.surprised;
    te.gazeYaw = feat.gazeYaw; te.gazePitch = feat.gazePitch;
    for (let i = 0; i < N_BS; i++) this.tgtPs[i] = clamp01(this.calBs[i] * this.psGain[i]);
    // Perfect-sync eyes use the same blink curve as the presets (MediaPipe never reaches 1.0).
    this.tgtPs[BS.eyeBlinkLeft] = feat.blinkL;
    this.tgtPs[BS.eyeBlinkRight] = feat.blinkR;
    this.gazeValid = true;
  }

  solve(viseme: VisemeFrame | null, nowMs: number): AvatarPose {
    const t = this.t;
    const dt = this.lastSolveMs < 0 ? 0 : clamp((nowMs - this.lastSolveMs) / 1000, 0, 0.1);
    this.lastSolveMs = nowMs;
    const lost = !(nowMs - this.lastDetTs <= LOST_AFTER_MS);

    // ── Followers ──
    const ch = this.curHead, th = this.tgtHead, ce = this.curExpr, te = this.tgtExpr;
    const tauH = lost ? 0.4 : this.tauHead;
    ch.yaw = follow(ch.yaw, lost ? 0 : th.yaw, dt, tauH);
    ch.pitch = follow(ch.pitch, lost ? 0 : th.pitch, dt, tauH);
    ch.roll = follow(ch.roll, lost ? 0 : th.roll, dt, tauH);
    ch.dx = follow(ch.dx, lost ? 0 : th.dx, dt, tauH);
    ch.dy = follow(ch.dy, lost ? 0 : th.dy, dt, tauH);
    ch.dz = follow(ch.dz, lost ? 0 : th.dz, dt, tauH);

    const tauB = lost ? 0.15 : 0.012;
    ce.blinkL = follow(ce.blinkL, lost ? 0 : te.blinkL, dt, tauB);
    ce.blinkR = follow(ce.blinkR, lost ? 0 : te.blinkR, dt, tauB);
    const tauM = lost ? 0.15 : this.tauMouth;
    ce.aa = follow(ce.aa, lost ? 0 : te.aa, dt, tauM);
    ce.ih = follow(ce.ih, lost ? 0 : te.ih, dt, tauM);
    ce.ou = follow(ce.ou, lost ? 0 : te.ou, dt, tauM);
    ce.ee = follow(ce.ee, lost ? 0 : te.ee, dt, tauM);
    ce.oh = follow(ce.oh, lost ? 0 : te.oh, dt, tauM);
    const emo = (cur: number, tgt: number) => {
      const target = lost ? 0 : tgt;
      return follow(cur, target, dt, target > cur ? this.tauEmoUp : this.tauEmoDown);
    };
    ce.happy = emo(ce.happy, te.happy);
    ce.angry = emo(ce.angry, te.angry);
    ce.sad = emo(ce.sad, te.sad);
    ce.relaxed = emo(ce.relaxed, te.relaxed);
    ce.surprised = emo(ce.surprised, te.surprised);
    const tauG = lost ? 0.2 : this.tauGaze;
    ce.gazeYaw = follow(ce.gazeYaw, lost ? 0 : te.gazeYaw, dt, tauG);
    ce.gazePitch = follow(ce.gazePitch, lost ? 0 : te.gazePitch, dt, tauG);
    for (let i = 0; i < N_BS; i++) {
      const tau = lost ? 0.15 : BS_GROUP[i] === Group.Blink ? 0.012 : this.tauMouth;
      this.curPs[i] = follow(this.curPs[i], lost ? 0 : this.tgtPs[i], dt, tau);
    }

    const mirror = t.mirror;
    const expressions: Record<string, number> = {};

    // ── Idle blink while the face is lost ──
    const idle = lost ? this.idleBlink(nowMs) : (this.idleBlinkStart = -1, 0);

    // ── Audio mixing weights ──
    let camW = 1, audW = 0, A: VisemeFrame['visemes'] | null = null;
    if (this.l.enabled && viseme) {
      const m = clamp01(this.l.mix);
      const g = smoothstep(viseme.volume, 0.02, 0.12);   // audio activity
      // mix = 1 → audio only. Otherwise: silent → camera fully; loud → camera mouth is partly reduced so
      // the audio vowel shape can show, and the max-blend lets audio open a mouth the camera sees closed.
      camW = m >= 0.99 ? 0 : 1 - 0.5 * m * g;
      audW = Math.sqrt(m);
      A = viseme.visemes;
    }

    const psActive = t.usePerfectSync && this.modelHasPs;
    // Eye closure after link / wink handling (user perspective).
    let bl = ce.blinkL, br = ce.blinkR;
    if (t.linkBlinks) {
      const v = 0.5 * (Math.max(bl, br) + 0.5 * (bl + br));
      bl = br = v;
    } else {
      // Small left/right differences are mostly tracking noise (e.g. head turned) → pull together;
      // deliberate winks (large difference) pass through.
      const d = bl - br, a = 0.5 * (bl + br);
      const d2 = d * smoothstep(Math.abs(d), 0.12, 0.35);
      bl = a + 0.5 * d2; br = a - 0.5 * d2;
    }

    if (psActive) {
      // Perfect sync: drive ARKit expressions directly; presets off to avoid double application.
      for (const k of PRESET_VISEMES) expressions[k] = 0;
      expressions.blink = expressions.blinkLeft = expressions.blinkRight = 0;
      expressions.happy = expressions.angry = expressions.sad = expressions.relaxed = expressions.surprised = 0;
      const ps = this.curPs;
      const eyeL = clamp01(bl + idle), eyeR = clamp01(br + idle);
      for (let i = 0; i < N_BS; i++) {
        if (IS_EYE_LOOK[i]) continue; // gaze goes through lookAt (avoid double eye movement)
        let v = ps[i];
        if (i === BS.eyeBlinkLeft) v = eyeL;
        else if (i === BS.eyeBlinkRight) v = eyeR;
        else if (IS_SPEECH_SHAPE[i]) v *= camW;
        expressions[this.psNames[mirror ? MIRROR_INDEX[i] : i]] = v;
      }
      if (A && audW > 0) {
        const put = (i: number, v: number) => {
          const n = this.psNames[mirror ? MIRROR_INDEX[i] : i];
          expressions[n] = Math.max(expressions[n], clamp01(v * audW));
        };
        put(BS.jawOpen, 0.8 * A.aa + 0.6 * A.oh + 0.45 * A.ee + 0.25 * A.ih + 0.25 * A.ou);
        put(BS.mouthFunnel, 0.7 * A.oh + 0.3 * A.ou);
        put(BS.mouthPucker, 0.8 * A.ou);
        put(BS.mouthStretchLeft, 0.35 * (A.ee + A.ih)); put(BS.mouthStretchRight, 0.35 * (A.ee + A.ih));
      }
    } else {
      // ── Emotions ──
      const happy = ce.happy, angry = ce.angry, sad = ce.sad, relaxed = ce.relaxed, surprised = ce.surprised;
      expressions.happy = happy; expressions.angry = angry; expressions.sad = sad;
      expressions.relaxed = relaxed; expressions.surprised = surprised;
      const blinkDamp = 1 - Math.max(EMO_BLINK_DAMP.happy * happy, EMO_BLINK_DAMP.angry * angry,
        EMO_BLINK_DAMP.sad * sad, EMO_BLINK_DAMP.relaxed * relaxed, EMO_BLINK_DAMP.surprised * surprised);
      const mouthDamp = 1 - Math.max(EMO_MOUTH_DAMP.happy * happy, EMO_MOUTH_DAMP.angry * angry,
        EMO_MOUTH_DAMP.sad * sad, EMO_MOUTH_DAMP.relaxed * relaxed, EMO_MOUTH_DAMP.surprised * surprised);

      // ── Blinks ── (mirror: the user's left eye drives the avatar's right eye)
      const userL = clamp01(bl * blinkDamp + idle), userR = clamp01(br * blinkDamp + idle);
      const avL = mirror ? userR : userL, avR = mirror ? userL : userR;
      if (this.hasBlink && this.hasBlinkLR) {
        // Shared part through "blink", the remainder through blinkLeft/Right: identical sum, but uses the
        // model's (often nicer) both-eyes blink and avoids double closing on models with all three.
        const common = Math.min(avL, avR);
        expressions.blink = common;
        expressions.blinkLeft = avL - common;
        expressions.blinkRight = avR - common;
      } else if (this.hasBlink) {
        // Only a combined blink: no winks possible – close both eyes as far as the more closed one.
        expressions.blink = Math.max(avL, avR);
        expressions.blinkLeft = expressions.blinkRight = 0;
      } else {
        // No combined blink: the per-eye expressions carry the full closure.
        expressions.blink = 0;
        expressions.blinkLeft = avL;
        expressions.blinkRight = avR;
      }

      // ── Mouth ──
      let aa = ce.aa * camW, ih = ce.ih * camW, ou = ce.ou * camW, ee = ce.ee * camW, oh = ce.oh * camW;
      if (A && audW > 0 && viseme) {
        // While audio is active, keep the camera's mouth openness but give it the audio vowel shape
        // (share m·g); otherwise the camera's mostly-aa/ih shape would dilute the audio vowel.
        const aSum = A.aa + A.ih + A.ou + A.ee + A.oh;
        const r = aSum > 0.05 ? clamp01(this.l.mix) * smoothstep(viseme.volume, 0.02, 0.12) : 0;
        if (r > 0) {
          const camOpen = Math.min(1, aa + ih + ou + ee + oh) * r / aSum, keep = 1 - r;
          aa = aa * keep + camOpen * A.aa; ih = ih * keep + camOpen * A.ih; ou = ou * keep + camOpen * A.ou;
          ee = ee * keep + camOpen * A.ee; oh = oh * keep + camOpen * A.oh;
        }
        aa = Math.max(aa, A.aa * audW); ih = Math.max(ih, A.ih * audW); ou = Math.max(ou, A.ou * audW);
        ee = Math.max(ee, A.ee * audW); oh = Math.max(oh, A.oh * audW);
      }
      const sum = aa + ih + ou + ee + oh;
      const k = (sum > 1 ? 1 / sum : 1) * mouthDamp;
      expressions.aa = aa * k; expressions.ih = ih * k; expressions.ou = ou * k;
      expressions.ee = ee * k; expressions.oh = oh * k;

      if (this.modelHasPs) for (let i = 0; i < N_BS; i++) expressions[this.psNames[i]] = 0;
    }

    // ── Head / body ──
    const ms = mirror ? -1 : 1;
    const sc = t.headRotationScale;
    const yaw = clamp(ms * ch.yaw * sc, -YAW_LIMIT, YAW_LIMIT);
    const pitch = clamp(ch.pitch * sc, -PITCH_DOWN_LIMIT, PITCH_UP_LIMIT);
    const roll = clamp(ms * ch.roll * sc, -ROLL_LIMIT, ROLL_LIMIT);
    const bf = clamp01(t.bodyFollow);
    const bYaw = yaw * bf * BODY_SHARE.yaw, bPitch = pitch * bf * BODY_SHARE.pitch, bRoll = roll * bf * BODY_SHARE.roll;
    const hYaw = yaw - bYaw, hPitch = pitch - bPitch, hRoll = roll - bRoll;

    // Lean from neck translation (cm, user frame: x = user's left, y = up, z = toward camera).
    const ps = Math.max(0, t.headPositionScale);
    const lx = ms * ch.dx * ps, ly = ch.dy * ps, lz = ch.dz * ps;
    const leanRoll = clamp(lx * 0.8, -10, 10) * DEG;     // leaning to own left → spine tilts to own left
    const leanPitch = -clamp(lz * 0.4, -8, 8) * DEG;     // leaning toward camera → spine bends forward
    const hipsOffset: Vec3 = {
      x: HIPS_X_SIGN * clamp(lx * 0.01 * 0.35, -0.12, 0.12),
      y: clamp(ly * 0.01 * 0.2, -0.05, 0.05),
      z: HIPS_Z_SIGN * clamp(lz * 0.01 * 0.3, -0.12, 0.12),
    };

    const bones: Partial<Record<HumanBone, Quat>> = {
      head: this.boneQuat(hPitch * HEAD_SHARE, hYaw * HEAD_SHARE, hRoll * HEAD_SHARE),
      neck: this.boneQuat(hPitch * (1 - HEAD_SHARE), hYaw * (1 - HEAD_SHARE), hRoll * (1 - HEAD_SHARE)),
      chest: this.boneQuat((bPitch + leanPitch) * (1 - SPINE_SHARE), bYaw * (1 - SPINE_SHARE), (bRoll + leanRoll) * (1 - SPINE_SHARE)),
      spine: this.boneQuat((bPitch + leanPitch) * SPINE_SHARE, bYaw * SPINE_SHARE, (bRoll + leanRoll) * SPINE_SHARE),
    };

    // ── Eye gaze ──
    let lookAt: AvatarPose['lookAt'] = null;
    if (t.eyeTracking && this.gazeValid) {
      if (lost && Math.abs(ce.gazeYaw) < 0.3 && Math.abs(ce.gazePitch) < 0.3) {
        lookAt = null;
      } else {
        lookAt = { yaw: LOOK_YAW_SIGN * ms * ce.gazeYaw, pitch: LOOK_PITCH_SIGN * ce.gazePitch };
      }
    }

    return { timestamp: nowMs, expressions, bones, hipsOffset, lookAt };
  }

  captureCalibration(): Calibration | null {
    if (!this.lastPushDetected || !Number.isFinite(this.lastDetTs)) return null;
    const from = this.lastDetTs - CAL_WINDOW_MS;
    const idx: number[] = [];
    for (let i = 0; i < CAL_FRAMES; i++) if (this.calTs[i] >= from && this.calTs[i] <= this.lastDetTs) idx.push(i);
    if (idx.length === 0) return null;
    // Median per channel: robust against a blink or a twitch inside the window.
    const tmp = new Float64Array(idx.length);
    const med = (ch: number) => {
      for (let k = 0; k < idx.length; k++) tmp[k] = this.calBuf[idx[k]][ch];
      tmp.sort();
      const m = tmp.length >> 1;
      return tmp.length % 2 ? tmp[m] : 0.5 * (tmp[m - 1] + tmp[m]);
    };
    const blendshapes: Record<string, number> = {};
    for (let i = 0; i < N_BS; i++) blendshapes[ARKIT_NAMES[i]] = Math.round(med(i) * 1e4) / 1e4;
    const cal: Calibration = {
      blendshapes,
      headRotation: { x: med(N_BS), y: med(N_BS + 1), z: med(N_BS + 2) },
      headPosition: { x: med(N_BS + 3), y: med(N_BS + 4), z: med(N_BS + 5) },
    };
    // Apply immediately; the app should persist it in tracking.calibration. A later updateSettings only
    // replaces it when the settings' calibration object changes.
    this.applyCalibration(cal);
    return cal;
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────

  private applyCalibration(c: Calibration | null): void {
    this.calibrated = !!c;
    for (let i = 0; i < N_BS; i++) {
      const v = c?.blendshapes?.[ARKIT_NAMES[i]];
      this.baseline[i] = typeof v === 'number' && Number.isFinite(v)
        ? clamp(v, 0, MAX_BASELINE)
        : DEFAULT_BASELINE[i];
    }
    if (c) {
      const r = c.headRotation, p = c.headPosition;
      userQuat(r.x, r.y, r.z, this.e, this.neutralQ);
      this.neutralQInv.copy(this.neutralQ).invert();
      this.neutralNeck.copy(NECK_PIVOT).applyQuaternion(this.neutralQ);
      this.neutralNeck.x += p.x; this.neutralNeck.y += p.y; this.neutralNeck.z += p.z;
      this.hasNeutralNeck = true;
    } else {
      this.neutralQ.identity();
      this.neutralQInv.identity();
      this.hasNeutralNeck = false; // re-seeded from the next detected frame
    }
  }

  private boneQuat(pitch: number, yaw: number, roll: number): Quat {
    this.e.set(PITCH_SIGN * pitch, YAW_SIGN * yaw, ROLL_SIGN * roll, EULER_ORDER);
    this.q.setFromEuler(this.e);
    return { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w };
  }

  /** Simple randomized blink (≈ every 2-6 s) while no face is visible. */
  private idleBlink(nowMs: number): number {
    if (nowMs - this.lastDetTs < LOST_AFTER_MS + 600) { this.nextIdleBlink = nowMs + 1500; return 0; }
    if (this.idleBlinkStart < 0) {
      if (nowMs < this.nextIdleBlink) return 0;
      this.idleBlinkStart = nowMs;
    }
    const e = nowMs - this.idleBlinkStart;
    if (e < 70) return e / 70;
    if (e < 120) return 1;
    if (e < 260) return 1 - (e - 120) / 140;
    this.idleBlinkStart = -1;
    this.nextIdleBlink = nowMs + 2000 + Math.random() * 4000;
    return 0;
  }
}

/**
 * Orientation quaternion of the user's head in the camera frame from semantic user angles.
 * Camera frame (MediaPipe metric space, non-mirrored image): +X = image right = the user's own left,
 * +Y up, +Z toward the camera; the user's face looks along +Z. That is the same axis layout as the
 * VRM1 avatar frame (faces +Z, +X = own left), so look-up = rotation about +X by -pitch, turn-left =
 * rotation about +Y by +yaw, tilt-left = rotation about +Z by -roll.
 */
function userQuat(pitch: number, yaw: number, roll: number, e: Euler, out: Quaternion): Quaternion {
  e.set(-pitch, yaw, -roll, EULER_ORDER);
  return out.setFromEuler(e);
}

const isVec3 = (v: unknown): v is Vec3 =>
  !!v && typeof v === 'object' &&
  Number.isFinite((v as Vec3).x) && Number.isFinite((v as Vec3).y) && Number.isFinite((v as Vec3).z);

/** The calibration if it has the expected shape (head pose required, blendshapes optional), else null. */
export function validCalibration(c: unknown): Calibration | null {
  if (!c || typeof c !== 'object') return null;
  const cal = c as Partial<Calibration>;
  if (!isVec3(cal.headRotation) || !isVec3(cal.headPosition)) return null;
  const bs = cal.blendshapes;
  if (bs !== undefined && bs !== null && (typeof bs !== 'object' || Array.isArray(bs))) return null;
  return cal as Calibration;
}
