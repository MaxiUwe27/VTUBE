// Pure (DOM/WebAudio-free) microphone analysis: time-domain samples → loudness + vowel visemes.
// Used by LipSync.ts; kept free of browser APIs so it can be tested offline on recordings.
//
// Pipeline per analysis tick (~60-120 Hz):
//  1. loudness: RMS of the whole buffer (dBFS → 0..1, gain, noise gate, fast attack / slower release);
//  2. low-pass + decimate the latest ~30 ms to ≈ 11-12 kHz (formants up to ~5 kHz);
//  3. voicing: normalized autocorrelation pitch strength (75-450 Hz) + share of energy below ~5 kHz,
//     so fricatives (s, sch, f) and noise do not produce random vowels; also yields F0;
//  4. formants: pre-emphasis 0.97, Hamming window, LPC (autocorrelation + Levinson-Durbin) at two
//     model orders, polynomial roots (Aberth, warm-started) → F1/F2 by frequency + bandwidth.
//     A high order resolves the close F1/F2 of back vowels (o, u) in low voices, a low order avoids
//     fitting single harmonics of high voices; the hypothesis that fits the vowel space best wins,
//     with a prior from the speaker's F0;
//  5. speaker normalization: uniform formant scale factor (Nearey-style log shift) from a running
//     median of F0 (male ≈ 1.0, female ≈ 1.15-1.2, child ≈ 1.3), so one set of vowel targets fits all;
//  6. soft classification in log(F1), log(F2) against German vowel prototypes (incl. ɛ, ɔ, ʊ, y, ø, ə),
//     each prototype mapping to a viseme mix; smoothing with fast attack and slower release.

export type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';
export const VISEME_KEYS: readonly VisemeKey[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

export interface AnalyzerParams {
  gain: number;       // input gain multiplier
  noiseGate: number;  // 0..1 threshold on the level scale
}

/** Tuning knobs (exposed for offline tests; the app uses the defaults). */
export interface AnalyzerOptions {
  targetFs?: number;     // ≈ decimated sample rate (Hz)
  orders?: number[];     // LPC orders tried per frame (ascending)
  sigmaF1?: number;      // prototype spread, natural-log units
  sigmaF2?: number;
  orderPrior?: number;   // weight of the F0-based preference between LPC orders
}

/**
 * Vowel prototypes for an adult male German speaker (Hz). Female/child voices are handled by the
 * speaker scale factor. Values are rounded averages from published German formant data
 * (e.g. Pätzold & Simpson 1997, Sendlmeier & Seebode 2006), slightly centralized for connected speech.
 * `v` = viseme mix the vowel maps to (sum 1).
 */
const PROTOS: { f1: number; f2: number; back?: boolean; v: Partial<Record<VisemeKey, number>> }[] = [
  { f1: 270, f2: 2250, v: { ih: 1 } },                              // iː  (Sie, Bier)
  { f1: 360, f2: 1950, v: { ih: 0.5, ee: 0.5 } },                   // ɪ   (bitte)
  { f1: 360, f2: 2150, v: { ee: 1 } },                              // eː  (See, Tee)
  { f1: 530, f2: 1800, v: { ee: 0.75, aa: 0.25 } },                 // ɛ   (Bett, Bär)
  { f1: 750, f2: 1250, v: { aa: 1 } },                              // a/aː (Saal, Tag)
  { f1: 560, f2: 950, back: true, v: { oh: 0.75, aa: 0.25 } },      // ɔ   (Sonne)
  { f1: 410, f2: 780, back: true, v: { oh: 1 } },                   // oː  (so, rot)
  { f1: 350, f2: 1000, back: true, v: { ou: 0.55, oh: 0.45 } },     // ʊ   (Mutter)
  { f1: 290, f2: 740, back: true, v: { ou: 1 } },                   // uː  (Schuh, gut)
  { f1: 280, f2: 1750, v: { ou: 0.55, ih: 0.45 } },                 // yː  (Tür)
  { f1: 370, f2: 1450, v: { oh: 0.5, ou: 0.3, ee: 0.2 } },          // øː  (schön)
  { f1: 480, f2: 1500, v: { aa: 0.4, ee: 0.3, oh: 0.3 } },          // ə   (bitte, Name)
];

const NV = VISEME_KEYS.length;
const P_LN1 = PROTOS.map((p) => Math.log(p.f1));
const P_LN2 = PROTOS.map((p) => Math.log(p.f2));
const P_VIS = PROTOS.map((p) => VISEME_KEYS.map((k) => p.v[k] ?? 0));
/** Back vowels: F2 is less reliable / less distinctive (o vs u differ mainly in F1). */
const BACK_F2_SPREAD = 1.5;

const DEFAULTS: Required<AnalyzerOptions> = { targetFs: 11000, orders: [10, 14], sigmaF1: 0.2, sigmaF2: 0.17, orderPrior: 1.5 };
const MAX_ORDER = 18;
const WIN_SEC = 0.03;          // analysis window
const PRE_EMPHASIS = 0.97;
const F0_MIN = 75, F0_MAX = 450;
const REF_F0 = 120;            // F0 of the reference (male) speaker the prototypes are for
const FEMALE_F0 = 210;
const SCALE_EXP = 0.3;         // formant scale ≈ (F0 / REF_F0)^0.3 (male 120 Hz → 1, female 210 Hz → 1.18)

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (x: number, a: number, b: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export interface AnalyzerDebug {
  level: number;      // gated level 0..1 (before smoothing)
  voicing: number;    // 0..1
  f0: number;         // Hz (0 = unvoiced)
  f1: number;         // Hz (0 = none)
  f2: number;         // Hz (0 = none)
  order: number;      // LPC order of the chosen hypothesis
  scale: number;      // speaker formant scale factor
  lowHigh: number;    // dB: LPC envelope energy 200-1200 Hz vs 1500-3500 Hz
}

/** Per-order LPC state (coefficients + warm-started roots). */
class LpcSlot {
  readonly a: Float64Array;
  readonly zr: Float64Array;
  readonly zi: Float64Array;
  warm = false;
  f1 = 0; f2 = 0;
  constructor(readonly p: number) {
    this.a = new Float64Array(p + 1);
    this.zr = new Float64Array(p);
    this.zi = new Float64Array(p);
  }
}

export class VowelAnalyzer {
  readonly sampleRate: number;
  private readonly o: Required<AnalyzerOptions>;
  private readonly sig2: number[];      // per-prototype F2 spread
  private readonly D: number;           // decimation factor
  private readonly fsd: number;         // decimated rate
  private readonly win: number;         // window length at fsd
  private readonly taps: Float64Array;  // low-pass FIR
  private readonly hamming: Float64Array;
  private readonly y: Float64Array;     // decimated window
  private readonly e: Float64Array;     // pre-emphasized + windowed
  private readonly r = new Float64Array(MAX_ORDER + 1);
  private readonly tmp = new Float64Array(MAX_ORDER + 1);
  private readonly slots: LpcSlot[];
  private readonly cumE: Float64Array;
  private readonly cf: number[] = [];   // formant candidates (Hz), ascending
  private readonly cb: number[] = [];   // their bandwidths (Hz)
  private readonly visT = new Float64Array(NV);
  private readonly f1Hist = new Float64Array(3);
  private readonly f2Hist = new Float64Array(3);
  private histN = 0;
  private lnF0 = Math.log(150);         // running median of log F0 (start between male and female)
  private f0Evidence = 0;
  private voicingS = 0;

  /** Smoothed loudness 0..1 (after gain / noise gate). */
  volume = 0;
  /** Output viseme weights 0..1. */
  readonly visemes: Record<VisemeKey, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  /** Smoothed vowel shape (sums to ~1), independent of loudness. */
  readonly shape: Record<VisemeKey, number> = { aa: 1, ih: 0, ou: 0, ee: 0, oh: 0 };
  readonly debug: AnalyzerDebug = { level: 0, voicing: 0, f0: 0, f1: 0, f2: 0, order: 0, scale: 1, lowHigh: 0 };

  constructor(sampleRate: number, opts: AnalyzerOptions = {}) {
    this.sampleRate = sampleRate;
    const o: Required<AnalyzerOptions> = { ...DEFAULTS };
    if (opts.targetFs) o.targetFs = opts.targetFs;
    if (opts.orders?.length) o.orders = [...opts.orders].sort((x, y) => x - y);
    if (opts.sigmaF1) o.sigmaF1 = opts.sigmaF1;
    if (opts.sigmaF2) o.sigmaF2 = opts.sigmaF2;
    if (opts.orderPrior !== undefined) o.orderPrior = opts.orderPrior;
    this.o = o;
    this.sig2 = PROTOS.map((pr) => o.sigmaF2 * (pr.back ? BACK_F2_SPREAD : 1));
    this.D = Math.max(1, Math.floor(sampleRate / o.targetFs + 0.25));
    this.fsd = sampleRate / this.D;
    this.win = Math.round(WIN_SEC * this.fsd);
    this.slots = o.orders.map((p) => new LpcSlot(Math.min(MAX_ORDER, Math.max(4, Math.round(p)))));
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
    this.volume = 0; this.voicingS = 0; this.histN = 0;
    for (const s of this.slots) s.warm = false;
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
    if (level > 0 && n >= this.taps.length + this.D * 64) {
      const lpRatio = this.decimate(buf, mean, rmsRaw);
      const { strength, f0 } = this.pitch();
      // Periodicity, and most energy below ~5 kHz (sibilants have little there).
      voicing = smoothstep(strength, 0.3, 0.65) * smoothstep(lpRatio, 0.25, 0.6);
      if (voicing > 0.6 && f0 > 0) {
        this.debug.f0 = f0;
        // Running median of log F0 (sign-step estimator: robust against octave errors).
        this.f0Evidence += dt;
        const step = dt * (this.f0Evidence < 1.5 ? 1.2 : 0.25);
        const d = Math.log(f0) - this.lnF0;
        this.lnF0 += Math.abs(d) < step ? d : Math.sign(d) * step;
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

  /** Speaker formant scale factor from the running F0. */
  private get scale(): number {
    return Math.min(1.32, Math.max(0.95, Math.exp(SCALE_EXP * (this.lnF0 - Math.log(REF_F0)))));
  }

  /** Squared normalized distance of (F1, F2) to the nearest vowel prototype. */
  private vowelDist(f1: number, f2: number, scale: number): number {
    const l1 = Math.log(f1 / scale), l2 = Math.log(f2 / scale);
    let best = Infinity;
    for (let i = 0; i < PROTOS.length; i++) {
      const d1 = (l1 - P_LN1[i]) / this.o.sigmaF1, d2 = (l2 - P_LN2[i]) / this.sig2[i];
      const d = d1 * d1 + d2 * d2;
      if (d < best) best = d;
    }
    return best;
  }

  /** LPC formants of this.y → F1/F2 → vowel shape. */
  private formantsAndShape(dt: number, voicing: number): void {
    const y = this.y, e = this.e, N = this.win, w = this.hamming, slots = this.slots;
    const pMax = slots[slots.length - 1].p;
    e[0] = y[0] * w[0];
    for (let i = 1; i < N; i++) e[i] = (y[i] - PRE_EMPHASIS * y[i - 1]) * w[i];
    const r = this.r;
    for (let k = 0; k <= pMax; k++) {
      let s = 0;
      for (let i = k; i < N; i++) s += e[i] * e[i - k];
      r[k] = s;
    }
    if (r[0] <= 0) return;
    // Lag window (≈ 50 Hz Gaussian bandwidth expansion) + tiny white-noise floor for stability.
    r[0] *= 1.0001;
    for (let k = 1; k <= pMax; k++) { const x = (2 * Math.PI * 50 * k) / this.fsd; r[k] *= Math.exp(-0.5 * x * x); }

    // One F1/F2 hypothesis per LPC order; pick the most vowel-like one, with an F0-based prior
    // (low voices → prefer high order, high voices → prefer low order).
    const scale = this.scale;
    const female = clamp01((this.lnF0 - Math.log(REF_F0 + 20)) / Math.log(FEMALE_F0 / (REF_F0 + 20)));
    let bestScore = Infinity, bestSlot: LpcSlot | null = null;
    for (let si = 0; si < slots.length; si++) {
      const s = slots[si];
      if (!this.levinson(s) || !this.roots(s) || !this.pickFormants(s)) continue;
      const rank = slots.length > 1 ? si / (slots.length - 1) : 0; // 0 = lowest order
      const prior = this.o.orderPrior * (rank * female + (1 - rank) * (1 - female));
      const score = this.vowelDist(s.f1, s.f2, scale) + prior;
      if (score < bestScore) { bestScore = score; bestSlot = s; }
    }
    if (slots[0].p > 0 && this.levinson(slots[0])) this.debug.lowHigh = this.bandRatioDb(slots[0]);
    if (!bestSlot) return;
    let f1 = bestSlot.f1, f2 = bestSlot.f2;
    this.debug.order = bestSlot.p;

    // 3-frame median against single-frame tracking errors.
    const h1 = this.f1Hist, h2 = this.f2Hist;
    if (this.histN === 0) { h1.fill(f1); h2.fill(f2); }
    h1[this.histN % 3] = f1; h2[this.histN % 3] = f2; this.histN++;
    f1 = median3(h1[0], h1[1], h1[2]); f2 = median3(h2[0], h2[1], h2[2]);
    this.debug.f1 = f1; this.debug.f2 = f2; this.debug.scale = scale;

    // Soft classification over prototypes (speaker-normalized log formants).
    const l1 = Math.log(f1 / scale), l2 = Math.log(f2 / scale);
    const vt = this.visT;
    vt.fill(0);
    let sum = 0;
    for (let i = 0; i < PROTOS.length; i++) {
      const d1 = (l1 - P_LN1[i]) / this.o.sigmaF1, d2 = (l2 - P_LN2[i]) / this.sig2[i];
      const wt = Math.exp(-0.5 * (d1 * d1 + d2 * d2));
      sum += wt;
      const pv = P_VIS[i];
      for (let k = 0; k < NV; k++) vt[k] += wt * pv[k];
    }
    if (sum < 1e-6) return; // far from every vowel (tracking error) → keep previous shape
    // Shape follows quickly towards a new vowel, a bit slower away from the old one.
    const conf = clamp01(voicing * 1.5);
    for (let k = 0; k < NV; k++) {
      const key = VISEME_KEYS[k];
      const target = vt[k] / sum, cur = this.shape[key];
      const t = target > cur ? 0.035 : 0.06;
      this.shape[key] = cur + (target - cur) * (1 - Math.exp(-dt / t)) * conf;
    }
  }

  /** LPC envelope energy ratio (dB) 200-1200 Hz vs 1500-3500 Hz. */
  private bandRatioDb(s: LpcSlot): number {
    let lo = 0, hi = 0;
    for (let f = 200; f <= 3500; f += 50) {
      if (f > 1200 && f < 1500) continue;
      const w = (2 * Math.PI * f) / this.fsd;
      let re = 0, im = 0;
      for (let k = 0; k <= s.p; k++) { re += s.a[k] * Math.cos(w * k); im -= s.a[k] * Math.sin(w * k); }
      const pw = 1 / (re * re + im * im + 1e-30);
      if (f <= 1200) lo += pw; else hi += pw;
    }
    return 10 * Math.log10((lo / 21) / (hi / 41));
  }

  /** F1/F2 from the slot's roots (frequency + bandwidth sanity ranges). */
  private pickFormants(s: LpcSlot): boolean {
    const fs = this.fsd, zr = s.zr, zi = s.zi, cf = this.cf, cb = this.cb;
    cf.length = 0; cb.length = 0;
    for (let i = 0; i < s.p; i++) {
      if (zi[i] <= 0) continue;
      const f = (Math.atan2(zi[i], zr[i]) * fs) / (2 * Math.PI);
      const bw = (-Math.log(Math.max(1e-6, Math.hypot(zr[i], zi[i]))) * fs) / Math.PI;
      if (f < 150 || f > fs / 2 - 150 || bw > 700) continue;
      let j = cf.length;
      cf.push(f); cb.push(bw);
      while (j > 0 && cf[j - 1] > f) { cf[j] = cf[j - 1]; cb[j] = cb[j - 1]; cf[j - 1] = f; cb[j - 1] = bw; j--; }
    }
    let i1 = -1;
    for (let i = 0; i < cf.length; i++) if (cf[i] >= 200 && cf[i] <= 1150 && cb[i] < 500) { i1 = i; break; }
    if (i1 < 0) return false;
    let i2 = -1;
    for (let i = i1 + 1; i < cf.length; i++) if (cf[i] >= Math.max(450, cf[i1] + 100) && cf[i] <= 3300 && cb[i] < 600) { i2 = i; break; }
    if (i2 < 0) return false;
    s.f1 = cf[i1]; s.f2 = cf[i2];
    return true;
  }

  /** Levinson-Durbin on this.r → s.a (a[0] = 1). */
  private levinson(s: LpcSlot): boolean {
    const r = this.r, a = s.a, t = this.tmp, p = s.p;
    a.fill(0); a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= p; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / err;
      if (!(Math.abs(k) < 1)) return false;
      for (let j = 0; j < i; j++) t[j] = a[j];
      for (let j = 1; j < i; j++) a[j] = t[j] + k * t[i - j];
      a[i] = k;
      err *= 1 - k * k;
      if (err <= 0) return false;
    }
    return true;
  }

  /** Roots of z^p + a1 z^(p-1) + … + ap (Aberth-Ehrlich, warm-started from the previous frame). */
  private roots(s: LpcSlot): boolean {
    const p = s.p, a = s.a, zr = s.zr, zi = s.zi;
    if (!s.warm) {
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
        // Horner: P(z) and P'(z)
        let pr = 1, pi = 0, dr = 0, di = 0;
        for (let k = 1; k <= p; k++) {
          const ndr = dr * xr - di * xi + pr, ndi = dr * xi + di * xr + pi;
          dr = ndr; di = ndi;
          const npr = pr * xr - pi * xi + a[k], npi = pr * xi + pi * xr;
          pr = npr; pi = npi;
        }
        const dd = dr * dr + di * di;
        if (dd === 0) continue;
        const rr = (pr * dr + pi * di) / dd, ri = (pi * dr - pr * di) / dd; // P / P'
        let sr = 0, si = 0;                                                 // Σ 1 / (z_i - z_j)
        for (let j = 0; j < p; j++) {
          if (j === i) continue;
          const ur = xr - zr[j], ui = xi - zi[j];
          const uu = ur * ur + ui * ui;
          if (uu === 0) continue;
          sr += ur / uu; si -= ui / uu;
        }
        const br = 1 - (rr * sr - ri * si), bi = -(rr * si + ri * sr);       // 1 - ratio * Σ
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
    s.warm = ok;
    return ok;
  }
}

function median3(a: number, b: number, c: number): number {
  return a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b);
}
