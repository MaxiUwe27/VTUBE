// Virtual webcam: pipes raw RGBA frames into ffmpeg, which writes to a v4l2loopback device.
// No electron import (testable with plain node).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VcamStatus } from '../shared/api';

export interface VcamConfig { device: string; width: number; height: number; fps: number }

const MODPROBE_HINT =
  'v4l2loopback installieren und laden:\n' +
  '  sudo dnf install v4l2loopback\n' +
  '  sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="VTube Linux" exclusive_caps=1';

export class VirtualCam {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cfg: VcamConfig | null = null;
  private device = '';
  private error: string | undefined;
  private blocked = false;      // ffmpeg stdin is full -> drop frames until 'drain'
  private stderrTail = '';
  private _droppedFrames = 0;

  constructor(private readonly ffmpegPath = process.env.VTUBE_FFMPEG || 'ffmpeg') {}

  get running(): boolean {
    return this.proc !== null;
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
    this.error = validateConfig(cfg) ?? checkDevice(cfg.device);
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
        ? 'ffmpeg wurde nicht gefunden. Installieren mit: sudo dnf install ffmpeg'
        : `ffmpeg konnte nicht gestartet werden: ${err.message}`;
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
      if (code !== 0 && signal !== 'SIGTERM') {
        this.error = describeFfmpegFailure(this.stderrTail, cfg.device, code, signal);
        console.error('[vcam]', this.error);
      }
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

/** /dev/video* device paths, numerically sorted. */
export async function listVideoDevices(): Promise<string[]> {
  try {
    const names = await fs.promises.readdir('/dev');
    return names
      .filter((n) => /^video\d+$/.test(n))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((n) => `/dev/${n}`);
  } catch {
    return [];
  }
}

function sameConfig(a: VcamConfig, b: VcamConfig): boolean {
  return a.device === b.device && a.width === b.width && a.height === b.height && a.fps === b.fps;
}

function validateConfig(c: VcamConfig): string | undefined {
  const okDim = (n: number) => Number.isInteger(n) && n >= 16 && n <= 4096 && n % 2 === 0;
  if (!okDim(c.width) || !okDim(c.height)) return `Ungültige Auflösung ${c.width}x${c.height} (gerade Werte zwischen 16 und 4096 erforderlich).`;
  if (!(c.fps >= 1 && c.fps <= 120)) return `Ungültige Bildrate ${c.fps} (1–120).`;
  if (!/^\/dev\/video\d+$/.test(c.device)) return `Ungültiges Gerät "${c.device}" (erwartet z.B. /dev/video10).`;
  return undefined;
}

/** Returns a German error message if the device is missing, not writable or not a loopback device. */
function checkDevice(device: string): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(device);
  } catch {
    return `Das Gerät ${device} existiert nicht – das Kernelmodul v4l2loopback ist vermutlich nicht geladen.\n${MODPROBE_HINT}`;
  }
  if (!st.isCharacterDevice()) return `${device} ist kein Video-Gerät.`;
  try {
    fs.accessSync(device, fs.constants.W_OK);
  } catch {
    return `Keine Schreibrechte auf ${device}. Benutzer zur Gruppe "video" hinzufügen:\n` +
      '  sudo usermod -aG video $USER\n(danach ab- und wieder anmelden)';
  }
  // v4l2loopback devices live under /sys/devices/virtual; real webcams under the USB/PCI tree.
  try {
    const real = fs.realpathSync(path.join('/sys/class/video4linux', path.basename(device)));
    if (!real.includes('/virtual/')) {
      return `${device} ist eine echte Kamera, kein v4l2loopback-Gerät. Bitte das virtuelle Gerät wählen.\n${MODPROBE_HINT}`;
    }
  } catch { /* sysfs not readable: skip this check */ }
  return undefined;
}

function describeFfmpegFailure(stderr: string, device: string, code: number | null, signal: NodeJS.Signals | null): string {
  const tail = stderr.trim().split('\n').slice(-3).join('\n');
  if (/Device or resource busy/i.test(stderr)) {
    return `${device} wird bereits von einem anderen Programm beschrieben (z.B. OBS Virtual Camera).`;
  }
  if (/Invalid argument|Inappropriate ioctl/i.test(stderr)) {
    return `ffmpeg kann nicht auf ${device} schreiben – ist es ein v4l2loopback-Gerät?\n${MODPROBE_HINT}` + (tail ? `\n\n${tail}` : '');
  }
  return `ffmpeg wurde beendet (${signal ?? `Code ${code}`}).` + (tail ? `\n${tail}` : '');
}
