// Virtual camera device: the ONE place that decides which /dev/videoN VTube Linux writes to, plus
// read-only probing of video devices via /dev, /sys and /proc (used for pre-flight checks, the UI
// device list and `--list-devices`). Never picks a device automatically.
// No electron import (testable with plain node); all roots are injectable for tests.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { VcamDeviceSource, VideoDeviceInfo } from '../shared/api';
import { VCAM_DEFAULT_DEVICE, VCAM_SETUP_HINT } from '../shared/vcamSetup';

export const VCAM_DEVICE_FLAG = '--vcam-device';
export const VCAM_DEVICE_ENV = 'VTUBE_CAM_DEVICE';
export const LIST_DEVICES_FLAGS = ['--list-devices', '--vcam-list'] as const;

export interface ResolvedDevice { device: string; source: VcamDeviceSource }

/** Value of `--vcam-device=/dev/videoN` or `--vcam-device /dev/videoN` (last occurrence wins). */
export function cliDeviceArg(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(`${VCAM_DEVICE_FLAG}=`)) value = a.slice(VCAM_DEVICE_FLAG.length + 1);
    else if (a === VCAM_DEVICE_FLAG && i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
  }
  const v = value?.trim();
  return v ? v : undefined;
}

/**
 * Effective virtual camera device. Precedence:
 *   CLI `--vcam-device` > env `VTUBE_CAM_DEVICE` > settings output.virtualCam.device > /dev/video10.
 * The settings store always contains a device (defaults are merged in), so a stored value equal to
 * the default is reported as source 'default' – it is the default either way.
 */
export function resolveVcamDevice(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  settingsDevice: string | null | undefined,
): ResolvedDevice {
  const cli = cliDeviceArg(argv);
  if (cli) return { device: cli, source: 'cli' };
  const fromEnv = env[VCAM_DEVICE_ENV]?.trim();
  if (fromEnv) return { device: fromEnv, source: 'env' };
  const fromSettings = typeof settingsDevice === 'string' ? settingsDevice.trim() : '';
  if (fromSettings && fromSettings !== VCAM_DEFAULT_DEVICE) return { device: fromSettings, source: 'settings' };
  return { device: VCAM_DEFAULT_DEVICE, source: 'default' };
}

export function wantsDeviceList(argv: readonly string[]): boolean {
  return argv.some((a) => (LIST_DEVICES_FLAGS as readonly string[]).includes(a));
}

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

export interface ProbeOptions {
  devRoot?: string;    // default /dev
  sysRoot?: string;    // default /sys
  procRoot?: string;   // default /proc
  /** PIDs that are not reported as holders (our own pid is always excluded). */
  excludePids?: Iterable<number>;
}

export interface Holder {
  pid: number;
  name: string;        // /proc/PID/comm
}

export interface SysfsNode {
  label: string;       // sysfs `name` = card_label for v4l2loopback
  loopback: boolean;   // lives under /sys/devices/virtual/ (real cameras sit in the USB/PCI tree)
}

const VIDEO_NODE = /^video\d+$/;

function readTrim(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/** sysfs info for /dev/videoN, or null when sysfs has no (readable) entry for it. */
export function readSysfsNode(device: string, sysRoot = '/sys'): SysfsNode | null {
  const base = path.basename(device);
  if (!VIDEO_NODE.test(base)) return null;
  let real: string;
  try {
    real = fs.realpathSync(path.join(sysRoot, 'class', 'video4linux', base));
  } catch {
    return null;
  }
  return {
    label: readTrim(path.join(real, 'name')) ?? '',
    loopback: real.split(path.sep).join('/').includes('/devices/virtual/'),
  };
}

// --- Holders (/proc scan) ----------------------------------------------------------------------
// Scanning /proc/*/fd costs ~5 µs per open fd; with browsers/IDEs running that is 0.1–0.5 s. In
// the app it therefore runs in a worker thread (never blocks the main process, which also pumps
// the virtual camera frames), results are cached briefly, and concurrent requests share one scan.

interface ScanInput { procRoot: string; targets: [link: string, device: string][] }
interface ScanHit { device: string; pid: number; name: string }

/**
 * Processes that have one of the target paths open: reads /proc/[0-9]*\/fd/* symlinks (like fuser).
 * Entries we may not read (other users' processes) are skipped silently.
 * SELF-CONTAINED: also executed as source text inside a worker thread (see scanInWorker) – it must
 * not reference anything outside its own body.
 */
function scanProcSync(input: ScanInput): ScanHit[] {
  const fs = require('node:fs') as typeof import('node:fs');
  const targets = new Map(input.targets);
  const hits: ScanHit[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync(input.procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return hits;
  }
  for (const pidStr of pids) {
    const fdDir = `${input.procRoot}/${pidStr}/fd`;
    let fds: string[];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue; // EACCES (other user) or process gone
    }
    const found = new Set<string>();
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(`${fdDir}/${fd}`);
      } catch {
        continue;
      }
      const dev = targets.get(link);
      if (dev) found.add(dev);
    }
    if (found.size === 0) continue;
    let name = '?';
    try { name = fs.readFileSync(`${input.procRoot}/${pidStr}/comm`, 'utf8').trim() || '?'; } catch { /* gone */ }
    for (const device of found) hits.push({ device, pid: Number(pidStr), name });
  }
  return hits;
}

const WORKER_TIMEOUT_MS = 10_000;

/** Runs scanProcSync in a worker thread; falls back to an in-thread scan if workers are unavailable. */
function scanInWorker(input: ScanInput): Promise<ScanHit[]> {
  let worker: Worker;
  try {
    const src = 'const { parentPort, workerData } = require("node:worker_threads");\n' +
      `parentPort.postMessage((${scanProcSync.toString()})(workerData));`;
    worker = new Worker(src, { eval: true, workerData: input });
  } catch (e) {
    console.warn('[vcam] worker thread unavailable, scanning /proc inline:', e);
    return Promise.resolve(scanProcSync(input));
  }
  return new Promise<ScanHit[]>((resolve) => {
    let done = false;
    const finish = (hits: ScanHit[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(hits);
    };
    const timer = setTimeout(() => finish([]), WORKER_TIMEOUT_MS);
    worker.once('message', (hits: ScanHit[]) => finish(hits));
    worker.once('error', (e) => {
      console.warn('[vcam] /proc scan failed:', e);
      finish([]);
    });
    worker.once('exit', () => finish([]));
  });
}

export interface HolderOptions extends ProbeOptions {
  /** Reuse a scan of the same devices that is at most this old (default 1500 ms; 0 = always fresh). */
  maxAgeMs?: number;
}

const HOLDER_CACHE_MS = 1500;
let holderCache: { key: string; at: number; done: boolean; hits: Promise<ScanHit[]> } | null = null;

function scanInput(devices: readonly string[], procRoot: string): ScanInput {
  // Match both the given path and its resolved form (symlinked device paths).
  const targets = new Map<string, string>();
  for (const d of devices) {
    targets.set(d, d);
    try { targets.set(fs.realpathSync(d), d); } catch { /* missing: plain match only */ }
  }
  return { procRoot, targets: [...targets] };
}

function groupHits(devices: readonly string[], hits: readonly ScanHit[], opts: ProbeOptions): Map<string, Holder[]> {
  const exclude = new Set<number>([process.pid, ...(opts.excludePids ?? [])]);
  const result = new Map<string, Holder[]>(devices.map((d) => [d, []]));
  for (const h of hits) {
    if (!exclude.has(h.pid)) result.get(h.device)?.push({ pid: h.pid, name: h.name });
  }
  return result;
}

/** Processes that have one of `devices` open (scan off the main thread, briefly cached). */
export async function findHolders(devices: readonly string[], opts: HolderOptions = {}): Promise<Map<string, Holder[]>> {
  if (devices.length === 0) return new Map();
  const input = scanInput(devices, opts.procRoot ?? '/proc');
  const key = JSON.stringify(input);
  const maxAge = opts.maxAgeMs ?? HOLDER_CACHE_MS;
  const now = Date.now();
  let entry = holderCache;
  // A scan still running is always shared; a finished one is reused while it is fresh enough.
  if (!entry || entry.key !== key || (entry.done && now - entry.at > maxAge)) {
    const fresh = { key, at: now, done: false, hits: scanInWorker(input) };
    void fresh.hits.then(() => { fresh.at = Date.now(); fresh.done = true; }); // age counts from the end
    holderCache = entry = fresh;
  }
  return groupHits(devices, await entry.hits, opts);
}

/** Synchronous variant for the `--list-devices` command line path only (no UI to block there). */
export function findHoldersSync(devices: readonly string[], opts: ProbeOptions = {}): Map<string, Holder[]> {
  if (devices.length === 0) return new Map();
  return groupHits(devices, scanProcSync(scanInput(devices, opts.procRoot ?? '/proc')), opts);
}

export function formatHolders(holders: readonly { pid: number; name: string }[]): string {
  return holders.map((h) => `${h.name} (PID ${h.pid})`).join(', ');
}

function videoNodePaths(devRoot = '/dev'): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(devRoot).filter((n) => VIDEO_NODE.test(n));
  } catch {
    return [];
  }
  names.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  return names.map((n) => path.join(devRoot, n));
}

function describeNodes(paths: readonly string[], holders: Map<string, Holder[]> | null, sysRoot?: string): VideoDeviceInfo[] {
  return paths.map((p) => {
    const node = readSysfsNode(p, sysRoot);
    return {
      path: p,
      label: node?.label ?? '',
      loopback: node?.loopback ?? false,
      busyBy: holders?.get(p) ?? [],
    };
  });
}

/** All /dev/videoN nodes, numerically sorted, with sysfs label, loopback flag and holders. */
export async function listVideoDevices(opts: HolderOptions & { withHolders?: boolean } = {}): Promise<VideoDeviceInfo[]> {
  const paths = videoNodePaths(opts.devRoot);
  const holders = opts.withHolders === false ? null : await findHolders(paths, opts);
  return describeNodes(paths, holders, opts.sysRoot);
}

/** Synchronous variant for `--list-devices` (and holder-less listings). */
export function listVideoDevicesSync(opts: ProbeOptions & { withHolders?: boolean } = {}): VideoDeviceInfo[] {
  const paths = videoNodePaths(opts.devRoot);
  return describeNodes(paths, opts.withHolders === false ? null : findHoldersSync(paths, opts), opts.sysRoot);
}

/** Text for `--list-devices`. */
export function formatDeviceList(devices: readonly VideoDeviceInfo[], effective?: ResolvedDevice): string {
  const loop = devices.filter((d) => d.loopback);
  const real = devices.filter((d) => !d.loopback);
  const lines: string[] = [];
  lines.push('Virtuelle Kameras (v4l2loopback):');
  if (loop.length === 0) {
    lines.push('  keine – v4l2loopback ist nicht geladen.');
  } else {
    for (const d of loop) {
      const use = d.busyBy.length ? `geöffnet von ${formatHolders(d.busyBy)}` : 'frei';
      const mark = effective && d.path === effective.device ? '   <- VTube Linux' : '';
      lines.push(`  ${d.path.padEnd(13)} "${d.label || '?'}"  ${use}${mark}`);
    }
  }
  if (real.length) {
    lines.push('', 'Echte Kameras (nicht als Ausgabe nutzbar):');
    for (const d of real) lines.push(`  ${d.path.padEnd(13)} ${d.label ? `"${d.label}"` : '(Treiber unbekannt – kein sysfs-Eintrag)'}`);
  }
  if (effective) {
    const src = { cli: `${VCAM_DEVICE_FLAG}`, env: VCAM_DEVICE_ENV, settings: 'Einstellungen', default: 'Standard' }[effective.source];
    lines.push('', `VTube Linux schreibt nach: ${effective.device} (${src})` +
      (devices.some((d) => d.path === effective.device) ? '' : ' – existiert nicht!'));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Pre-flight check before ffmpeg is started
// ---------------------------------------------------------------------------------------------

function quoteLabel(label: string): string {
  return label ? ` („${label}“)` : '';
}

/**
 * Hard checks of the target device before ffmpeg starts: exists, is a character device, is a
 * v4l2loopback device (when sysfs is readable), is writable. Returns a German error message (always
 * naming the device) or undefined.
 *
 * Deliberately NOT checked: whether other programs have the device open. Viewers (OBS "Video
 * Capture Device" source, Discord, browsers) commonly keep it open across our restarts, and from
 * /proc + sysfs a viewer cannot be told apart from a producer (v4l2loopback keeps `format` set
 * while any opener holds it; ffmpeg's v4l2 output opens O_RDWR like a reader). If another program
 * already writes into the device, the kernel refuses ffmpeg (EBUSY / EINVAL) and the exit message
 * names the programs that hold the device (see VirtualCam / describeFfmpegFailure).
 */
export function checkDevice(device: string, opts: ProbeOptions = {}): string | undefined {
  // 1. exists, is a character device
  let st: fs.Stats;
  try {
    st = fs.statSync(device);
  } catch {
    const others = listVideoDevicesSync({ ...opts, withHolders: false }).filter((d) => d.loopback);
    const have = others.length
      ? `Vorhandene v4l2loopback-Geräte: ${others.map((d) => `${d.path}${quoteLabel(d.label)}`).join(', ')}.\n` +
        'Ist v4l2loopback schon von einem anderen Programm (z. B. OBS) geladen worden, legt ein späteres ' +
        '„modprobe“ keine weiteren Geräte an – Modul entladen und mit zwei Geräten neu laden:\n'
      : 'Das Kernelmodul v4l2loopback ist vermutlich nicht geladen.\n';
    return `Das Gerät ${device} existiert nicht.\n${have}${VCAM_SETUP_HINT}`;
  }
  if (!st.isCharacterDevice()) return `${device} ist kein Video-Gerät (keine Gerätedatei).`;

  // 2. driver is v4l2loopback (sysfs). No readable sysfs entry (sandbox/container): skip.
  const node = readSysfsNode(device, opts.sysRoot);
  if (node && !node.loopback) {
    return `${device}${quoteLabel(node.label)} ist eine echte Kamera, kein v4l2loopback-Gerät. ` +
      `VTube Linux schreibt nur in virtuelle (v4l2loopback-)Geräte.\n${VCAM_SETUP_HINT}`;
  }

  // 3. write permission
  try {
    fs.accessSync(device, fs.constants.W_OK);
  } catch {
    return `Keine Schreibrechte auf ${device}. Benutzer zur Gruppe "video" hinzufügen:\n` +
      '  sudo usermod -aG video $USER\n(danach ab- und wieder anmelden)';
  }
  return undefined;
}
