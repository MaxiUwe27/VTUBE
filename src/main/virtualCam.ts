// Virtual webcam: pipes raw RGBA frames into ffmpeg, which writes to a v4l2loopback device.
// The device path is decided by the caller (main.ts via vcamDevice.resolveVcamDevice) – this module
// never picks a device on its own. No electron import (testable with plain node).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { VcamStatus } from '../shared/api';
import { VCAM_SETUP_HINT } from '../shared/vcamSetup';
import { checkDevice, findHolders, formatHolders, type ProbeOptions } from './vcamDevice';

export interface VcamConfig { device: string; width: number; height: number; fps: number }

export class VirtualCam {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cfg: VcamConfig | null = null;
  private device = '';
  private error: string | undefined;
  private blocked = false;      // ffmpeg stdin is full -> drop frames until 'drain'
  private stderrTail = '';
  private _droppedFrames = 0;

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

  /** Start (or restart with a new config). Idempotent if already running with the same config. */
  async start(cfg: VcamConfig): Promise<VcamStatus> {
    if (this.proc && this.cfg && sameConfig(this.cfg, cfg)) return this.status();
    await this.stop();
    this.device = cfg.device;
    this.error = validateConfig(cfg) ?? checkDevice(cfg.device, this.probe);
    if (this.error) return this.status();

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cfg.width}x${cfg.height}`, '-r', String(cfg.fps), '-i', '-',
      '-f', 'v4l2', '-pix_fmt', 'yuv420p', cfg.device,
    ];
    const proc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve);
        proc.once('error', reject);
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.error = err.code === 'ENOENT'
        ? `ffmpeg wurde nicht gefunden (benötigt für die virtuelle Kamera ${cfg.device}). Installieren mit: sudo dnf install ffmpeg`
        : `ffmpeg (Ausgabe auf ${cfg.device}) konnte nicht gestartet werden: ${err.message}`;
      return this.status();
    }

    this.proc = proc;
    this.cfg = { ...cfg };
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
      if (this.proc !== proc) return; // superseded by stop()/restart
      this.proc = null;
      this.cfg = null;
      // Every exit that did not come from stop()/kill() is unexpected (even code 0 or an external SIGTERM).
      const msg = describeFfmpegFailure(this.stderrTail, cfg, code, signal);
      this.error = msg;
      console.error('[vcam]', msg);
      // Name whoever else has the device open (another producer, or a viewer locking the format).
      try {
        const others = findHolders([cfg.device], this.probe).get(cfg.device) ?? [];
        if (others.length && this.error === msg && !this.proc) {
          this.error = `${msg}\nGerät ${cfg.device} ist geöffnet von: ${formatHolders(others)}.`;
        }
      } catch { /* best effort */ }
    });
    return this.status();
  }

  async stop(): Promise<VcamStatus> {
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

  /** Synchronous best-effort kill for app quit. */
  kill(): void {
    if (this.proc) this.proc.kill('SIGTERM');
    this.proc = null;
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
