// Microphone → volume + vowel visemes (aa/ih/ou/ee/oh) via WebAudio.
//
// The AnalyserNode only delivers the latest time-domain samples; all analysis (loudness, voicing,
// LPC formants F1/F2, speaker normalization, vowel classification, smoothing) lives in the pure
// VowelAnalyzer (./VowelAnalyzer.ts), which is also tested offline on real recordings.
// Loudness drives how open the mouth is; the vowel only decides the shape. Unvoiced sounds
// (s, sch, f) and noise keep the mouth small without a vowel shape.

import type { VisemeFrame } from '../../shared/types';
import type { LipSyncSettings } from '../../shared/settings';
import { VowelAnalyzer } from './VowelAnalyzer';

const MIN_UPDATE_MS = 8;

export class LipSync {
  private s: LipSyncSettings | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timeBuf = new Float32Array(2048);
  private session = 0;
  private restarting: Promise<void> | null = null;

  private lastUpdate = -1;
  private analyzer: VowelAnalyzer | null = null;

  /** Last raw analysis features (level, voicing, F0, F1, F2, speaker scale) for UI meters / tuning. */
  get debug(): VowelAnalyzer['debug'] | null { return this.analyzer?.debug ?? null; }

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
    // Keep the speaker adaptation (F0 / formant statistics) across restarts at the same sample rate.
    const analyzer = this.analyzer?.sampleRate === ctx.sampleRate ? this.analyzer : new VowelAnalyzer(ctx.sampleRate);
    analyzer.reset();
    let size = 2048;
    while (size < analyzer.inputLength && size < 32768) size *= 2; // ≥ ~43 ms at any sample rate
    analyser.fftSize = size;
    analyser.smoothingTimeConstant = 0;
    if (this.timeBuf.length !== size) this.timeBuf = new Float32Array(size);
    source.connect(hp);
    hp.connect(analyser); // not connected to destination: no monitoring echo
    this.ctx = ctx;
    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
    this.analyzer = analyzer;
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
    this.analyzer?.reset();
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
    const an = this.analyser, az = this.analyzer, s = this.s;
    if (!an || !az || !s) return null;
    const now = performance.now();
    if (this.lastUpdate < 0 || now - this.lastUpdate >= MIN_UPDATE_MS) {
      const dt = this.lastUpdate < 0 ? 0.016 : Math.min(0.1, (now - this.lastUpdate) / 1000);
      this.lastUpdate = now;
      an.getFloatTimeDomainData(this.timeBuf);
      az.process(this.timeBuf, dt, s);
    }
    const v = az.visemes;
    return { timestamp: now, volume: az.volume, visemes: { aa: v.aa, ih: v.ih, ou: v.ou, ee: v.ee, oh: v.oh } };
  }
}
