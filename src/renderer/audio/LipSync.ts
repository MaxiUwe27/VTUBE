// Microphone → volume + vowel visemes (aa/ih/ou/ee/oh) via WebAudio FFT.
//
// Heuristic vowel estimation:
//  - loudness (RMS in dBFS, gain, noise gate, attack/release) drives how open the mouth is;
//  - an F1 proxy (spectral centroid of 250-1000 Hz) gives jaw openness (a > e/o > i/u);
//  - an F2 proxy (energy 1.8-3.4 kHz vs 0.6-1.4 kHz) gives front (i/e) vs back (o/u) vowels;
//  - the five vowels sit at fixed points in that 2D (F1, front) plane; soft-min distances give weights;
//  - unvoiced/fricative frames (energy mostly above 4 kHz) close the mouth a bit.
// It is not phoneme recognition, but the mouth opens with loudness and changes shape plausibly.

import type { VisemeFrame } from '../../shared/types';
import type { LipSyncSettings } from '../../shared/settings';

const FFT_SIZE = 2048;
const MIN_UPDATE_MS = 8;

// Vowel centres in (f1 0..1, front 0..1). Tuned on formant-synthesized vowels (measured f1Hz /
// ratioDb: a ≈ 810/-35, e ≈ 455/-2, i ≈ 265/+8, o ≈ 545/-51, u ≈ 345/-48); real voices have a flatter
// spectral tilt, so the 'a' centre sits a bit toward the front.
const VOWELS = [
  { k: 'aa', f1: 1.0, fr: 0.4 },
  { k: 'ee', f1: 0.36, fr: 0.95 },
  { k: 'ih', f1: 0.0, fr: 1.0 },
  { k: 'oh', f1: 0.52, fr: 0.05 },
  { k: 'ou', f1: 0.12, fr: 0.0 },
] as const;
type VisemeKey = (typeof VOWELS)[number]['k'];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class LipSync {
  private s: LipSyncSettings | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timeBuf = new Float32Array(FFT_SIZE);
  private freqBuf = new Float32Array(FFT_SIZE / 2);
  private weights = new Float32Array(VOWELS.length);
  private session = 0;
  private restarting: Promise<void> | null = null;

  private lastUpdate = -1;
  private volume = 0;
  private vis: Record<VisemeKey, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private shape: Record<VisemeKey, number> = { aa: 1, ih: 0, ou: 0, ee: 0, oh: 0 };

  /** Last raw analysis features (for UI meters / tuning). */
  readonly debug = { f1Hz: 0, ratioDb: 0, voicedness: 0, level: 0 };

  get running(): boolean { return !!this.analyser; }

  static async listMicrophones(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  async start(s: LipSyncSettings): Promise<void> {
    this.stop();
    this.s = s;
    const session = ++this.session;
    const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: true, autoGainControl: false };
    if (s.deviceId) audio.deviceId = { exact: s.deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    if (session !== this.session) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 70; // remove rumble / DC
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0; // we smooth ourselves (attack/release)
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    source.connect(hp);
    hp.connect(analyser); // not connected to destination: no monitoring echo
    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
    this.lastUpdate = -1;
  }

  stop(): void {
    this.session++;
    this.analyser = null;
    try { this.source?.disconnect(); } catch { /* ignore */ }
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.volume = 0;
    this.vis.aa = this.vis.ih = this.vis.ou = this.vis.ee = this.vis.oh = 0;
  }

  /** Apply new settings. Starts/stops/restarts the microphone if enabled/deviceId changed. */
  update(s: LipSyncSettings): void {
    const prev = this.s;
    this.s = s;
    if (!s.enabled) { if (this.running) this.stop(); return; }
    const needRestart = !this.running || !prev || prev.deviceId !== s.deviceId;
    if (needRestart && !this.restarting) {
      this.restarting = this.start(s)
        .catch((e) => console.error('[LipSync] microphone start failed:', e))
        .finally(() => { this.restarting = null; });
    }
  }

  /** Latest analysis, or null when not running. Cheap; recomputes at most every ~8 ms. */
  read(): VisemeFrame | null {
    const an = this.analyser, ctx = this.ctx, s = this.s;
    if (!an || !ctx || !s) return null;
    const now = performance.now();
    if (this.lastUpdate < 0 || now - this.lastUpdate >= MIN_UPDATE_MS) {
      const dt = this.lastUpdate < 0 ? 0.016 : Math.min(0.1, (now - this.lastUpdate) / 1000);
      this.lastUpdate = now;
      this.analyse(an, ctx.sampleRate, s, dt);
    }
    const v = this.vis;
    return { timestamp: now, volume: this.volume, visemes: { aa: v.aa, ih: v.ih, ou: v.ou, ee: v.ee, oh: v.oh } };
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────

  private analyse(an: AnalyserNode, sampleRate: number, s: LipSyncSettings, dt: number): void {
    an.getFloatTimeDomainData(this.timeBuf);
    let sq = 0;
    const tb = this.timeBuf;
    for (let i = 0; i < tb.length; i++) sq += tb[i] * tb[i];
    const rms = Math.sqrt(sq / tb.length) * Math.max(0, s.gain);
    // dBFS → 0..1: -55 dB → 0, -12 dB → 1
    const db = 20 * Math.log10(rms + 1e-9);
    let level = clamp01((db + 55) / 43);
    const gate = clamp01(s.noiseGate);
    level = level <= gate ? 0 : (level - gate) / (1 - gate);

    // Attack fast, release slower (mouth closes a bit later than it opens, looks natural).
    const tau = level > this.volume ? 0.03 : 0.09;
    this.volume += (level - this.volume) * (1 - Math.exp(-dt / tau));

    // Spectrum bands (power, linear)
    an.getFloatFrequencyData(this.freqBuf);
    const binHz = sampleRate / FFT_SIZE;
    const fb = this.freqBuf;
    const band = (lo: number, hi: number) => {
      let e = 0;
      const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(fb.length - 1, Math.ceil(hi / binHz));
      for (let i = a; i <= b; i++) e += Math.pow(10, fb[i] / 10);
      return e;
    };
    // F1 proxy: centroid in 250..1000 Hz
    let num = 0, den = 0;
    {
      const a = Math.floor(250 / binHz), b = Math.ceil(1000 / binHz);
      for (let i = a; i <= b; i++) {
        const p = Math.pow(10, fb[i] / 10);
        num += p * i * binHz;
        den += p;
      }
    }
    const f1Hz = den > 0 ? num / den : 500;
    const f1 = clamp01((f1Hz - 280) / (800 - 280));
    const low = band(600, 1400), high = band(1800, 3400);
    const ratioDb = 10 * Math.log10((high + 1e-12) / (low + 1e-12)); // ≈ -50 (back) .. +8 (front)
    const front = clamp01((ratioDb + 45) / 40);
    const voiced = band(100, 1500), fric = band(4000, 8000);
    const voicedness = clamp01(voiced / (voiced + 2 * fric + 1e-12) * 1.4);

    this.debug.f1Hz = f1Hz; this.debug.ratioDb = ratioDb; this.debug.voicedness = voicedness; this.debug.level = level;

    // Shape weights (soft-min over squared distance); only updated when there is voice.
    if (this.volume > 0.02) {
      let sum = 0;
      const w = this.weights;
      for (let i = 0; i < VOWELS.length; i++) {
        const v = VOWELS[i];
        const d = (v.f1 - f1) ** 2 + (v.fr - front) ** 2;
        w[i] = Math.exp(-d / 0.035);
        sum += w[i];
      }
      const k = 1 - Math.exp(-dt / 0.05); // shape smoothing ~50 ms
      VOWELS.forEach((v, i) => { this.shape[v.k] += ((w[i] / (sum || 1)) - this.shape[v.k]) * k; });
    }
    // Openness: loudness with a soft curve; unvoiced sounds (s, sh, f) keep the mouth smaller.
    const open = Math.pow(this.volume, 0.8) * (0.45 + 0.55 * voicedness);
    const k2 = 1 - Math.exp(-dt / 0.035);
    for (const v of VOWELS) {
      const target = clamp01(open * this.shape[v.k] * 1.25);
      this.vis[v.k] += (target - this.vis[v.k]) * k2;
    }
  }
}
