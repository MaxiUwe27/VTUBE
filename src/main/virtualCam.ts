// Virtual webcam: pipes raw RGBA frames into ffmpeg, which writes to a v4l2loopback device.
// The device path is decided by the caller (main.ts via vcamDevice.resolveVcamDevice) – this module
// never picks a device on its own. No electron import (testable with plain node).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { VcamStatus } from '../shared/api';
import { VCAM_SETUP_HINT } from '../shared/vcamSetup';
import { childProcessEnv } from './childEnv';
import { LatestQueue } from './serialQueue';
import { checkDevice, findHolders, formatHolders, type ProbeOptions } from './vcamDevice';

export interface VcamConfig { device: string; width: number; height: number; fps: number }

/** An ffmpeg exit within this time after a restart counts as "restart failed". */
const RESTART_FAIL_WINDOW_MS = 10_000;

export class VirtualCam {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private spawning: ChildProcessWithoutNullStreams | null = null;
  private cfg: VcamConfig | null = null;
  private device = '';
  private error: string | undefined;
  private blocked = false;      // ffmpeg stdin is full -> drop frames until 'drain'
  private stderrTail = '';
  private _droppedFrames = 0;
  private disposed = false;     // kill() was called (app quits): no restarts, exits are expected
  /** start()/stop() run strictly one after another; pending superseded requests are skipped. */
  private readonly queue = new LatestQueue<VcamStatus>();

  constructor(
    private readonly ffmpegPath = process.env.VTUBE_FFMPEG || 'ffmpeg',
    private readonly probe: ProbeOptions = {}, // injectable /dev, /sys, /proc roots (tests)
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  /** PID of our own ffmpeg child (excluded from "device busy" scans). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get droppedFrames(): number {
    return this._droppedFrames;
  }

  status(): VcamStatus {
    const s: VcamStatus = { running: this.running, device: this.device };
    if (this.error) s.error = this.error;
    return s;
  }

  /** Start (or restart with a new config). Idempotent if already running with the same config.
   *  Serialized with stop(): the last request wins. */
  start(cfg: VcamConfig): Promise<VcamStatus> {
    return this.queue.run(() => this.doStart({ ...cfg }));
  }

  stop(): Promise<VcamStatus> {
    return this.queue.run(() => this.doStop());
  }

  private async doStart(cfg: VcamConfig): Promise<VcamStatus> {
    if (this.disposed) return this.status();
    if (this.proc && this.cfg && sameConfig(this.cfg, cfg)) return this.status();
    const previous = this.proc && this.cfg ? { ...this.cfg } : null;
    await this.doStop();
    if (this.disposed) return this.status();
    const restartNote = previous ? restartFailedNote(previous, cfg) : '';
    this.device = cfg.device;
    const invalid = validateConfig(cfg) ?? checkDevice(cfg.device, this.probe);
    if (invalid) {
      this.error = restartNote + invalid;
      return this.status();
    }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cfg.width}x${cfg.height}`, '-r', String(cfg.fps), '-i', '-',
      '-f', 'v4l2', '-pix_fmt', 'yuv420p', cfg.device,
    ];
    // detached: own process group, so Ctrl+C in the terminal reaches only Electron (which then stops
    // ffmpeg itself) instead of killing ffmpeg first. If Electron dies, ffmpeg reads EOF on stdin
    // and exits. The environment is cleaned of AppImage library paths (see childEnv.ts).
    const proc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: childProcessEnv() });
    this.spawning = proc;
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve);
        proc.once('error', reject);
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.error = restartNote + (err.code === 'ENOENT'
        ? `ffmpeg wurde nicht gefunden (benötigt für die virtuelle Kamera ${cfg.device}). Installieren mit: sudo dnf install ffmpeg`
        : `ffmpeg (Ausgabe auf ${cfg.device}) konnte nicht gestartet werden: ${err.message}`);
      return this.status();
    } finally {
      this.spawning = null;
    }
    if (this.disposed) { // kill() during spawn
      proc.kill('SIGTERM');
      return this.status();
    }

    const startedAt = Date.now();
    this.proc = proc;
    this.cfg = { ...cfg };
    this.error = undefined;
    this.blocked = false;
    this.stderrTail = '';
    this._droppedFrames = 0;
    proc.stdout.resume();
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    proc.stdin.on('error', () => { /* EPIPE when ffmpeg dies; handled in 'exit' */ });
    proc.stdin.on('drain', () => { this.blocked = false; });
    proc.on('error', (e) => console.error('[vcam] ffmpeg error:', e));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc || this.disposed) return; // superseded by stop()/restart, or app quits
      this.proc = null;
      this.cfg = null;
      // Every exit that did not come from stop()/kill() is unexpected (even code 0 or an external SIGTERM).
      const note = restartNote && Date.now() - startedAt < RESTART_FAIL_WINDOW_MS ? restartNote : '';
      const msg = note + describeFfmpegFailure(this.stderrTail, cfg, code, signal);
      this.error = msg;
      console.error('[vcam]', msg);
      // Name whoever else has the device open (another producer, or a viewer locking the format).
      void findHolders([cfg.device], { ...this.probe, maxAgeMs: 0 }).then((all) => {
        const others = all.get(cfg.device) ?? [];
        if (others.length && this.error === msg && !this.proc && !this.disposed) {
          this.error = `${msg}\nGerät ${cfg.device} ist geöffnet von: ${formatHolders(others)}.`;
        }
      }).catch(() => { /* best effort */ });
    });
    // Information only: viewers (OBS source, Discord) keeping the device open are normal.
    void findHolders([cfg.device], { ...this.probe, excludePids: proc.pid ? [proc.pid] : [] }).then((all) => {
      const others = all.get(cfg.device) ?? [];
      if (others.length) console.log(`[vcam] ${cfg.device} ist auch geöffnet von: ${formatHolders(others)}`);
    }).catch(() => { /* best effort */ });
    return this.status();
  }

  private async doStop(): Promise<VcamStatus> {
    const proc = this.proc;
    this.proc = null;
    this.cfg = null;
    this.error = undefined;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => proc.kill('SIGKILL'), 1500);
        proc.once('exit', () => { clearTimeout(kill); resolve(); });
        proc.stdin.end();
        proc.kill('SIGTERM');
      });
    }
    return this.status();
  }

  /** Synchronous best-effort kill for app quit. Afterwards the instance ignores ffmpeg exits and
   *  refuses to start again (queued restarts become no-ops). */
  kill(): void {
    this.disposed = true;
    for (const p of [this.proc, this.spawning]) {
      if (p && p.exitCode === null && p.signalCode === null) {
        p.stdin.end();
        p.kill('SIGTERM');
      }
    }
    this.proc = null;
    this.cfg = null;
  }

  /** Feed one RGBA frame. Dropped if size mismatches or ffmpeg can't keep up (never queues unbounded). */
  pushFrame(frame: Buffer): void {
    const { proc, cfg } = this;
    if (!proc || !cfg) return;
    if (frame.length !== cfg.width * cfg.height * 4 || this.blocked || !proc.stdin.writable) {
      this._droppedFrames++;
      return;
    }
    // write() returning false means the chunk is buffered; at most one frame waits until 'drain'.
    if (!proc.stdin.write(frame)) this.blocked = true;
  }
}

function restartFailedNote(prev: VcamConfig, next: VcamConfig): string {
  const fmt = (c: VcamConfig) => `${c.device}, ${c.width}×${c.height}, ${c.fps} FPS`;
  return `Neustart der virtuellen Kamera mit neuen Einstellungen (${fmt(next)}; vorher ${fmt(prev)}) ` +
    'fehlgeschlagen – die virtuelle Kamera ist aus.\n';
}

function sameConfig(a: VcamConfig, b: VcamConfig): boolean {
  return a.device === b.device && a.width === b.width && a.height === b.height && a.fps === b.fps;
}

function validateConfig(c: VcamConfig): string | undefined {
  if (!/^\/dev\/video\d+$/.test(c.device)) return `Ungültiges Gerät "${c.device}" (erwartet z. B. /dev/video10).`;
  // yuv420p subsamples chroma 2x2 -> width and height must be even.
  const okDim = (n: number) => Number.isInteger(n) && n >= 16 && n <= 4096 && n % 2 === 0;
  if (!okDim(c.width) || !okDim(c.height)) {
    return `Ungültige Auflösung ${c.width}x${c.height} für ${c.device} (gerade Werte zwischen 16 und 4096 erforderlich).`;
  }
  if (!(Number.isFinite(c.fps) && c.fps >= 1 && c.fps <= 120)) return `Ungültige Bildrate ${c.fps} für ${c.device} (1–120).`;
  return undefined;
}

/** German message for an unexpected ffmpeg exit; always names the device. Exported for tests. */
export function describeFfmpegFailure(stderr: string, cfg: VcamConfig, code: number | null, signal: NodeJS.Signals | null): string {
  const { device } = cfg;
  const tail = stderr.trim().split('\n').slice(-3).join('\n');
  const withTail = (m: string) => m + (tail ? `\n\nffmpeg: ${tail}` : '');
  if (/Device or resource busy/i.test(stderr)) {
    return withTail(`${device} ist belegt: Ein anderes Programm sendet bereits Bilder an dieses Gerät ` +
      '(z. B. die virtuelle Kamera von OBS). Jedes Programm mit virtueller Kamera braucht ein eigenes ' +
      `v4l2loopback-Gerät.\n${VCAM_SETUP_HINT}`);
  }
  if (/Permission denied/i.test(stderr)) {
    return withTail(`Keine Schreibrechte auf ${device}. Benutzer zur Gruppe "video" hinzufügen:\n` +
      '  sudo usermod -aG video $USER\n(danach ab- und wieder anmelden)');
  }
  if (/No such file or directory|No such device/i.test(stderr)) {
    return withTail(`Das Gerät ${device} ist verschwunden (v4l2loopback entladen?).\n${VCAM_SETUP_HINT}`);
  }
  if (/Invalid argument|Inappropriate ioctl/i.test(stderr)) {
    return withTail(`ffmpeg konnte auf ${device} das Bildformat ${cfg.width}×${cfg.height} (yuv420p, ${cfg.fps} FPS) ` +
      'nicht einstellen. Mögliche Ursachen:\n' +
      '• Das Format ist gesperrt, weil ein anderes Programm das Gerät noch offen hat – eine andere virtuelle ' +
      'Kamera, oder ein Zuschauer (z. B. OBS-Quelle, Discord) mit der vorherigen Auflösung – oder weil ' +
      'keep_format gesetzt ist. Abhilfe: dieses Programm bzw. die Quelle schließen und neu starten, ' +
      'oder die vorherige Auflösung wählen.\n' +
      `• ${device} ist kein v4l2loopback-Gerät.`);
  }
  return withTail(`ffmpeg (Ausgabe auf ${device}) wurde unerwartet beendet (${signal ?? `Code ${code}`}).`);
}
