// Pure (DOM/WebAudio-free) microphone analysis: time-domain samples → loudness + vowel visemes.
// Used by LipSync.ts; kept free of browser APIs so it can be tested offline on recordings.
//
// Pipeline per analysis tick (~60-120 Hz):
//  1. loudness: RMS of the whole buffer (dBFS → 0..1, gain, noise gate, fast attack / slower release);
//  2. low-pass + decimate the latest ~30 ms to ≈ 10-12 kHz (formants up to ~5 kHz);
//  3. voicing: normalized autocorrelation pitch strength (75-450 Hz) + share of energy below ~5 kHz,
//     so fricatives (s, sch, f) and noise do not produce random vowels; also yields F0;
//  4. formants: pre-emphasis 0.97, Hamming window, LPC (autocorrelation + Levinson-Durbin), polynomial
//     roots (Aberth, warm-started) → F1/F2 by frequency + bandwidth with sanity ranges;
//  5. speaker normalization: a uniform formant scale factor (Nearey-style log shift) from the running
//     median-ish F0 (male ≈ 1.0, female ≈ 1.15-1.2, child ≈ 1.3), so one set of vowel targets fits all;
//  6. soft classification in log(F1), log(F2) against German vowel prototypes (incl. ɛ, ɔ, ʊ, y, ø, ə),
//     each prototype mapping to a viseme mix; smoothing with fast attack and slower release.

export type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';
export const VISEME_KEYS: readonly VisemeKey[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

export interface AnalyzerParams {
  gain: number;       // input gain multiplier
  noiseGate: number;  // 0..1 threshold on the level scale
}

/**
 * Vowel prototypes for an adult male German speaker (Hz). Female/child voices are handled by the
 * speaker scale factor. Values are rounded averages from published German formant data
 * (e.g. Pätzold & Simpson 1997, Sendlmeier & Seebode 2006), slightly centralized for connected speech.
 * `v` = viseme mix the vowel maps to (sum 1).
 */
const PROTOS: { f1: number; f2: number; v: Partial<Record<VisemeKey, number>> }[] = [
  { f1: 280, f2: 2250, v: { ih: 1 } },                    // iː  (Sie, Bier)
  { f1: 370, f2: 1950, v: { ih: 0.5, ee: 0.5 } },         // ɪ   (bitte)
  { f1: 380, f2: 2100, v: { ee: 1 } },                    // eː  (See, Tee)
  { f1: 530, f2: 1750, v: { ee: 0.75, aa: 0.25 } },       // ɛ   (Bett, Bär)
  { f1: 730, f2: 1300, v: { aa: 1 } },                    // a/aː (Saal, Tag)
  { f1: 540, f2: 950, v: { oh: 0.8, aa: 0.2 } },          // ɔ   (Sonne)
  { f1: 400, f2: 780, v: { oh: 1 } },                     // oː  (so, rot)
  { f1: 370, f2: 1000, v: { ou: 0.55, oh: 0.45 } },       // ʊ   (Mutter)
  { f1: 300, f2: 720, v: { ou: 1 } },                     // uː  (Schuh, gut)
  { f1: 290, f2: 1750, v: { ou: 0.55, ih: 0.45 } },       // yː  (Tür)
  { f1: 380, f2: 1450, v: { oh: 0.5, ou: 0.25, ee: 0.25 } }, // øː (schön)
  { f1: 480, f2: 1500, v: { aa: 0.4, ee: 0.3, oh: 0.3 } },   // ə  (bitte, Name)
];
/** Spread of each prototype in natural-log units (≈ ±20 % F1, ±16 % F2). Larger = softer blending. */
const SIGMA_F1 = 0.2;
const SIGMA_F2 = 0.17;

const NV = VISEME_KEYS.length;
const P_LN1 = PROTOS.map((p) => Math.log(p.f1));
const P_LN2 = PROTOS.map((p) => Math.log(p.f2));
const P_VIS = PROTOS.map((p) => VISEME_KEYS.map((k) => p.v[k] ?? 0));

const TARGET_FS = 11000;       // ≈ decimated rate (Hz)
const WIN_SEC = 0.03;          // analysis window
const MAX_ORDER = 16;
const PRE_EMPHASIS = 0.97;
const F0_MIN = 75, F0_MAX = 450;
const REF_F0 = 120;            // F0 of the reference (male) speaker the prototypes are for
const SCALE_EXP = 0.3;         // formant scale ≈ (F0 / REF_F0)^0.3 (male 120 Hz → 1, female 210 Hz → 1.18)

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (x: number, a: number, b: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export interface AnalyzerDebug {
  level: number;      // gated level 0..1 (before smoothing)
  voicing: number;    // 0..1
  f0: number;         // Hz (0 = unvoiced)
  f1: number;         // Hz (0 = none)
  f2: number;         // Hz (0 = none)
  scale: number;      // speaker formant scale factor
  l21: number;
}

export class VowelAnalyzer {
  readonly sampleRate: number;
  private readonly D: number;           // decimation factor
  private readonly fsd: number;         // decimated rate
  private readonly win: number;         // window length at fsd
  private readonly taps: Float64Array;  // low-pass FIR
  private readonly hamming: Float64Array;
  private readonly y: Float64Array;     // decimated window
  private readonly e: Float64Array;     // pre-emphasized + windowed
  private readonly r = new Float64Array(MAX_ORDER + 1);
  private readonly a = new Float64Array(MAX_ORDER + 1);
  private readonly aTmp = new Float64Array(MAX_ORDER + 1);
  private readonly zr = new Float64Array(MAX_ORDER);
  private readonly zi = new Float64Array(MAX_ORDER);
  private rootsWarm = false;
  private readonly cf: number[] = [];   // formant candidates (Hz), ascending
  private readonly cb: number[] = [];   // their bandwidths (Hz)
  private readonly cumE: Float64Array;
  private readonly visT = new Float64Array(NV);
  private readonly f1Hist = new Float64Array(3);
  private readonly f2Hist = new Float64Array(3);
  private histN = 0;
  private lnF0 = Math.log(140);         // running log F0 (start between male and female)
  private f0Evidence = 0;

  /** Smoothed loudness 0..1 (after gain / noise gate). */
  volume = 0;
  /** Output viseme weights 0..1. */
  readonly visemes: Record<VisemeKey, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  /** Smoothed vowel shape (sums to ~1), independent of loudness. */
  readonly shape: Record<VisemeKey, number> = { aa: 1, ih: 0, ou: 0, ee: 0, oh: 0 };
  readonly debug: AnalyzerDebug = { level: 0, voicing: 0, f0: 0, f1: 0, f2: 0, scale: 1, l21: 0 };
  private voicingS = 0;

  private readonly order: number;
  private readonly targetFs: number;

  constructor(sampleRate: number, opts: { targetFs?: number; order?: number } = {}) {
    this.sampleRate = sampleRate;
    this.targetFs = opts.targetFs ?? TARGET_FS;
    this.order = Math.min(MAX_ORDER, opts.order ?? 12);
    this.D = Math.max(1, Math.floor(sampleRate / this.targetFs + 0.25));
    this.fsd = sampleRate / this.D;
    this.win = Math.round(WIN_SEC * this.fsd);
    // Windowed-sinc low-pass at ~0.42 * fsd (anti-alias for the decimation).
    const nt = this.D === 1 ? 1 : 8 * this.D + 1;
    this.taps = new Float64Array(nt);
    if (nt === 1) this.taps[0] = 1;
    else {
      const fc = 0.42 / this.D, m = (nt - 1) / 2;
      let s = 0;
      for (let i = 0; i < nt; i++) {
        const x = i - m;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (nt - 1));
        this.taps[i] = sinc * w; s += this.taps[i];
      }
      for (let i = 0; i < nt; i++) this.taps[i] /= s;
    }
    this.hamming = new Float64Array(this.win);
    for (let i = 0; i < this.win; i++) this.hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (this.win - 1));
    this.y = new Float64Array(this.win);
    this.e = new Float64Array(this.win);
    this.cumE = new Float64Array(this.win + 1);
  }

  /** Number of input samples one analysis needs (provide at least this many, newest last). */
  get inputLength(): number { return this.win * this.D + this.taps.length; }

  reset(): void {
    this.volume = 0; this.voicingS = 0; this.histN = 0; this.rootsWarm = false;
    for (const k of VISEME_KEYS) { this.visemes[k] = 0; this.shape[k] = 0; }
    this.shape.aa = 1;
  }

  /**
   * Analyse the newest samples. `buf` holds time-domain samples (newest at the end), at least
   * `inputLength` long for full quality; `dt` = seconds since the previous call.
   */
  process(buf: Float32Array, dt: number, p: AnalyzerParams): void {
    const n = buf.length;
    // ── Loudness ──
    let sq = 0, mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n || 1;
    for (let i = 0; i < n; i++) { const v = buf[i] - mean; sq += v * v; }
    const rmsRaw = Math.sqrt(sq / (n || 1));
    const rms = rmsRaw * Math.max(0, p.gain);
    const db = 20 * Math.log10(rms + 1e-9);
    let level = clamp01((db + 55) / 43); // -55 dBFS → 0, -12 dBFS → 1
    const gate = clamp01(p.noiseGate);
    level = level <= gate ? 0 : (level - gate) / (1 - gate);
    const tau = level > this.volume ? 0.03 : 0.09;
    this.volume += (level - this.volume) * (1 - Math.exp(-dt / tau));
    this.debug.level = level;

    // ── Voicing + formants (skipped in silence) ──
    let voicing = 0;
    this.debug.f0 = 0; this.debug.f1 = 0; this.debug.f2 = 0;
    if (level > 0 && n >= this.taps.length + this.D * 32) {
      const lpRatio = this.decimate(buf, mean, rmsRaw);
      const { strength, f0 } = this.pitch();
      // Periodicity, and most energy below ~5 kHz (sibilants have little there).
      voicing = smoothstep(strength, 0.3, 0.65) * smoothstep(lpRatio, 0.25, 0.6);
      if (voicing > 0.5 && f0 > 0) {
        this.debug.f0 = f0;
        // Running log-F0 (time constant ≈ 2 s of voiced speech, faster at the very beginning).
        this.f0Evidence = Math.min(2, this.f0Evidence + dt);
        const k = 1 - Math.exp(-dt / Math.max(0.3, this.f0Evidence));
        this.lnF0 += (Math.log(f0) - this.lnF0) * k;
      }
      if (voicing > 0.25) this.formantsAndShape(dt, voicing);
      else this.histN = 0;
    } else {
      this.histN = 0;
    }
    // Voicing is smoothed a little so the mouth does not flicker on plosives.
    this.voicingS += (voicing - this.voicingS) * (1 - Math.exp(-dt / (voicing > this.voicingS ? 0.02 : 0.06)));
    this.debug.voicing = voicing;

    // ── Output: openness from loudness; unvoiced sounds keep the mouth small and shapeless ──
    const open = Math.pow(this.volume, 0.8) * (0.3 + 0.7 * this.voicingS);
    const shapeAmt = 0.25 + 0.75 * this.voicingS;
    for (const k of VISEME_KEYS) {
      const target = clamp01(open * (this.shape[k] * shapeAmt + (1 - shapeAmt) * 0.2) * 1.25);
      const cur = this.visemes[k];
      const t = target > cur ? 0.03 : 0.08;
      this.visemes[k] = cur + (target - cur) * (1 - Math.exp(-dt / t));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────

  /** Low-pass + decimate the newest window into this.y. Returns rms(lowpassed)/rms(raw). */
  private decimate(buf: Float32Array, mean: number, rmsRaw: number): number {
    const D = this.D, taps = this.taps, nt = taps.length, y = this.y;
    let win = this.win;
    const need = win * D + nt;
    const start = Math.max(0, buf.length - need);
    if (buf.length < need) win = Math.floor((buf.length - nt) / D);
    let sq = 0;
    for (let j = 0; j < this.win; j++) {
      if (j >= win) { y[j] = 0; continue; }
      const o = start + j * D;
      let s = 0;
      for (let k = 0; k < nt; k++) s += taps[k] * buf[o + k];
      s -= mean;
      y[j] = s; sq += s * s;
    }
    const r = Math.sqrt(sq / Math.max(1, win));
    return rmsRaw > 0 ? r / rmsRaw : 0;
  }

  /** Normalized autocorrelation pitch strength (0..1) and F0 (Hz) of this.y. */
  private pitch(): { strength: number; f0: number } {
    const y = this.y, N = this.win, fs = this.fsd, c = this.cumE;
    c[0] = 0;
    for (let i = 0; i < N; i++) c[i + 1] = c[i] + y[i] * y[i];
    const lo = Math.max(2, Math.floor(fs / F0_MAX)), hi = Math.min(Math.floor(N * 0.6), Math.ceil(fs / F0_MIN));
    let best = 0, bestLag = 0;
    let prev = -1, prev2 = -1;
    for (let lag = lo; lag <= hi; lag++) {
      let s = 0;
      for (let i = 0, m = N - lag; i < m; i++) s += y[i] * y[i + lag];
      const e0 = c[N - lag], e1 = c[N] - c[lag];
      const r = e0 > 0 && e1 > 0 ? s / Math.sqrt(e0 * e1) : 0;
      // Local maximum at lag-1; slight preference for shorter lags (avoids octave-down errors).
      if (prev > prev2 && prev >= r) {
        const sc = prev * (1 - 0.1 * (lag - 1 - lo) / (hi - lo + 1));
        if (sc > best) { best = sc; bestLag = lag - 1; }
      }
      prev2 = prev; prev = r;
    }
    return { strength: best, f0: bestLag > 0 ? fs / bestLag : 0 };
  }

  /** LPC formants of this.y → F1/F2 → vowel shape. */
  private formantsAndShape(dt: number, voicing: number): void {
    const y = this.y, e = this.e, N = this.win, w = this.hamming, p = this.order;
    e[0] = y[0] * w[0];
    for (let i = 1; i < N; i++) e[i] = (y[i] - PRE_EMPHASIS * y[i - 1]) * w[i];
    const r = this.r;
    for (let k = 0; k <= p; k++) {
      let s = 0;
      for (let i = k; i < N; i++) s += e[i] * e[i - k];
      r[k] = s;
    }
    if (r[0] <= 0) return;
    // Lag window (≈ 50 Hz Gaussian bandwidth expansion) + tiny white-noise floor for stability.
    r[0] *= 1.0001;
    for (let k = 1; k <= p; k++) { const x = (2 * Math.PI * 50 * k) / this.fsd; r[k] *= Math.exp(-0.5 * x * x); }
    if (!this.levinson()) return;
    if (!this.roots()) return;

    // Candidates (upper half-plane roots) sorted by frequency.
    const fs = this.fsd, zr = this.zr, zi = this.zi;
    const cf = this.cf, cb = this.cb;
    cf.length = 0; cb.length = 0;
    for (let i = 0; i < p; i++) {
      if (zi[i] <= 0) continue;
      const f = (Math.atan2(zi[i], zr[i]) * fs) / (2 * Math.PI);
      const mag = Math.hypot(zr[i], zi[i]);
      const bw = (-Math.log(Math.max(1e-6, mag)) * fs) / Math.PI;
      if (f < 150 || f > fs / 2 - 150 || bw > 700) continue;
      let j = cf.length;
      cf.push(f); cb.push(bw);
      while (j > 0 && cf[j - 1] > f) { cf[j] = cf[j - 1]; cb[j] = cb[j - 1]; cf[j - 1] = f; cb[j - 1] = bw; j--; }
    }
    let i1 = -1;
    for (let i = 0; i < cf.length; i++) if (cf[i] >= 200 && cf[i] <= 1150 && cb[i] < 500) { i1 = i; break; }
    if (i1 < 0) return;
    let i2 = -1;
    for (let i = i1 + 1; i < cf.length; i++) if (cf[i] >= Math.max(400, cf[i1] + 80) && cf[i] <= 3300 && cb[i] < 600) { i2 = i; break; }
    if (i2 < 0) return;
    let f1 = cf[i1], f2 = cf[i2];

    // 3-frame median against single-frame tracking errors.
    const h1 = this.f1Hist, h2 = this.f2Hist;
    if (this.histN === 0) { h1.fill(f1); h2.fill(f2); }
    h1[this.histN % 3] = f1; h2[this.histN % 3] = f2; this.histN++;
    f1 = median3(h1[0], h1[1], h1[2]); f2 = median3(h2[0], h2[1], h2[2]);
    this.debug.f1 = f1; this.debug.f2 = f2;
    this.debug.l21 = this.envDb(cf[i2]) - this.envDb(cf[i1]);

    // Speaker normalization (uniform log shift from running F0).
    const scale = Math.min(1.32, Math.max(0.95, Math.exp(SCALE_EXP * (this.lnF0 - Math.log(REF_F0)))));
    this.debug.scale = scale;
    const l1 = Math.log(f1 / scale), l2 = Math.log(f2 / scale);

    // Soft classification over prototypes.
    const vt = this.visT;
    vt.fill(0);
    let sum = 0;
    for (let i = 0; i < PROTOS.length; i++) {
      const d1 = (l1 - P_LN1[i]) / SIGMA_F1, d2 = (l2 - P_LN2[i]) / SIGMA_F2;
      const wt = Math.exp(-0.5 * (d1 * d1 + d2 * d2));
      sum += wt;
      const pv = P_VIS[i];
      for (let k = 0; k < NV; k++) vt[k] += wt * pv[k];
    }
    if (sum < 1e-12) return; // far from every vowel (tracking error) → keep previous shape
    // Shape follows quickly towards a new vowel, a bit slower away from the old one.
    const conf = clamp01(voicing * 1.5);
    for (let k = 0; k < NV; k++) {
      const key = VISEME_KEYS[k];
      const target = vt[k] / sum, cur = this.shape[key];
      const t = target > cur ? 0.035 : 0.06;
      this.shape[key] = cur + (target - cur) * (1 - Math.exp(-dt / t)) * conf;
    }
  }

  /** LPC envelope level (dB, arbitrary reference) at frequency f. */
  private envDb(f: number): number {
    const w = (2 * Math.PI * f) / this.fsd, a = this.a;
    let re = 0, im = 0;
    for (let k = 0; k <= this.order; k++) { re += a[k] * Math.cos(w * k); im -= a[k] * Math.sin(w * k); }
    return -10 * Math.log10(re * re + im * im + 1e-30);
  }

  /** Levinson-Durbin on this.r → this.a (a[0] = 1). */
  private levinson(): boolean {
    const r = this.r, a = this.a, t = this.aTmp, p = this.order;
    a.fill(0); a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= p; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / err;
      if (!(Math.abs(k) < 1)) return false;
      t.set(a);
      for (let j = 1; j < i; j++) a[j] = t[j] + k * t[i - j];
      a[i] = k;
      err *= 1 - k * k;
      if (err <= 0) return false;
    }
    return true;
  }

  /** Roots of z^p + a1 z^(p-1) + … + ap (Aberth-Ehrlich, warm-started from the previous frame). */
  private roots(): boolean {
    const p = this.order, a = this.a, zr = this.zr, zi = this.zi;
    if (!this.rootsWarm) {
      for (let i = 0; i < p; i++) {
        const ang = (2 * Math.PI * (i + 0.25)) / p + 0.4;
        zr[i] = 0.9 * Math.cos(ang); zi[i] = 0.9 * Math.sin(ang);
      }
    }
    let ok = false;
    for (let iter = 0; iter < 80; iter++) {
      let maxStep = 0;
      for (let i = 0; i < p; i++) {
        const xr = zr[i], xi = zi[i];
        // Horner: P and P'
        let pr = 1, pi = 0, dr = 0, di = 0;
        for (let k = 1; k <= p; k++) {
          // d = d*z + P ; P = P*z + a[k]
          const ndr = dr * xr - di * xi + pr, ndi = dr * xi + di * xr + pi;
          dr = ndr; di = ndi;
          const npr = pr * xr - pi * xi + a[k], npi = pr * xi + pi * xr;
          pr = npr; pi = npi;
        }
        // ratio = P / P'
        const dd = dr * dr + di * di;
        if (dd === 0) continue;
        const rr = (pr * dr + pi * di) / dd, ri = (pi * dr - pr * di) / dd;
        // s = Σ 1/(z_i - z_j)
        let sr = 0, si = 0;
        for (let j = 0; j < p; j++) {
          if (j === i) continue;
          const ur = xr - zr[j], ui = xi - zi[j];
          const uu = ur * ur + ui * ui;
          if (uu === 0) continue;
          sr += ur / uu; si -= ui / uu;
        }
        // w = ratio / (1 - ratio * s)
        const br = 1 - (rr * sr - ri * si), bi = -(rr * si + ri * sr);
        const bb = br * br + bi * bi;
        if (bb === 0) continue;
        const wr = (rr * br + ri * bi) / bb, wi = (ri * br - rr * bi) / bb;
        zr[i] = xr - wr; zi[i] = xi - wi;
        const st = Math.abs(wr) + Math.abs(wi);
        if (st > maxStep) maxStep = st;
      }
      if (maxStep < 1e-8) { ok = true; break; }
    }
    for (let i = 0; i < p; i++) if (!Number.isFinite(zr[i]) || !Number.isFinite(zi[i])) ok = false;
    this.rootsWarm = ok;
    return ok;
  }
}

function median3(a: number, b: number, c: number): number {
  return a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b);
}
