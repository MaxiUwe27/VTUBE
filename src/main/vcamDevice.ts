// Virtual camera device: the ONE place that decides which /dev/videoN VTube Linux writes to, plus
// read-only probing of video devices via /dev, /sys and /proc (used for pre-flight checks, the UI
// device list and `--list-devices`). Never picks a device automatically.
// No electron import (testable with plain node); all roots are injectable for tests.
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  if (fromSettings) return { device: fromSettings, source: 'settings' };
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
  /** Opened O_WRONLY – certainly a writer (e.g. ffmpeg's v4l2 output). */
  writeOnly: boolean;
}

export interface SysfsNode {
  label: string;       // sysfs `name` = card_label for v4l2loopback
  loopback: boolean;   // lives under /sys/devices/virtual/ (real cameras sit in the USB/PCI tree)
  /** v4l2loopback `format` attribute: non-empty while a producer is streaming ("YU12:1280x720@30/1"),
   *  empty without producer, null if not available (not loopback / old module / unreadable). */
  format: string | null;
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
  const loopback = real.split(path.sep).join('/').includes('/devices/virtual/');
  return {
    label: readTrim(path.join(real, 'name')) ?? '',
    loopback,
    format: loopback ? readTrim(path.join(real, 'format')) : null,
  };
}

/**
 * Processes that have one of `devices` open: scans /proc/[0-9]*\/fd/* symlinks (like fuser).
 * Entries we may not read (other users' processes) are skipped silently.
 */
export function findHolders(devices: readonly string[], opts: ProbeOptions = {}): Map<string, Holder[]> {
  const procRoot = opts.procRoot ?? '/proc';
  const exclude = new Set<number>([process.pid, ...(opts.excludePids ?? [])]);
  const result = new Map<string, Holder[]>(devices.map((d) => [d, []]));
  // Match both the given path and its resolved form (symlinked device paths).
  const targets = new Map<string, string>();
  for (const d of devices) {
    targets.set(d, d);
    try { targets.set(fs.realpathSync(d), d); } catch { /* missing: plain match only */ }
  }
  if (targets.size === 0) return result;

  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return result;
  }
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (exclude.has(pid)) continue;
    const fdDir = path.join(procRoot, pidStr, 'fd');
    let fds: string[];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue; // EACCES (other user) or process gone
    }
    const found = new Map<string, Holder>();
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const dev = targets.get(link);
      if (!dev) continue;
      let h = found.get(dev);
      if (!h) {
        h = { pid, name: readTrim(path.join(procRoot, pidStr, 'comm')) || '?', writeOnly: false };
        found.set(dev, h);
      }
      // fdinfo "flags:" is octal; O_ACCMODE == 3, O_WRONLY == 1.
      const m = /^flags:\s*([0-7]+)/m.exec(readTrim(path.join(procRoot, pidStr, 'fdinfo', fd)) ?? '');
      if (m && (parseInt(m[1], 8) & 3) === 1) h.writeOnly = true;
    }
    for (const [dev, h] of found) result.get(dev)!.push(h);
  }
  return result;
}

export function formatHolders(holders: readonly { pid: number; name: string }[]): string {
  return holders.map((h) => `${h.name} (PID ${h.pid})`).join(', ');
}

/** All /dev/videoN nodes, numerically sorted, with sysfs label, loopback flag and holders. */
export function listVideoDevices(opts: ProbeOptions & { withHolders?: boolean } = {}): VideoDeviceInfo[] {
  const devRoot = opts.devRoot ?? '/dev';
  let names: string[];
  try {
    names = fs.readdirSync(devRoot).filter((n) => VIDEO_NODE.test(n));
  } catch {
    return [];
  }
  names.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const paths = names.map((n) => path.join(devRoot, n));
  const holders = opts.withHolders === false ? null : findHolders(paths, opts);
  return paths.map((p) => {
    const node = readSysfsNode(p, opts.sysRoot);
    return {
      path: p,
      label: node?.label ?? '',
      loopback: node?.loopback ?? false,
      busyBy: (holders?.get(p) ?? []).map(({ pid, name }) => ({ pid, name })),
    };
  });
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
      const use = d.busyBy.length ? `benutzt von ${formatHolders(d.busyBy)}` : 'frei';
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

const OWN_DEVICE_HINT =
  'Jedes Programm mit virtueller Kamera (OBS, VTube Linux, …) braucht ein eigenes v4l2loopback-Gerät, ' +
  'sonst überschreiben sie sich gegenseitig.';

function quoteLabel(label: string): string {
  return label ? ` („${label}“)` : '';
}

/**
 * Checks the target device before ffmpeg starts. Returns a German error message (always naming the
 * device) or undefined if it is OK to write to it.
 */
export function checkDevice(device: string, opts: ProbeOptions = {}): string | undefined {
  // 1. exists, is a character device
  let st: fs.Stats;
  try {
    st = fs.statSync(device);
  } catch {
    const others = listVideoDevices({ ...opts, withHolders: false }).filter((d) => d.loopback);
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

  // 4. somebody else already uses it
  const holders = findHolders([device], opts).get(device) ?? [];
  if (holders.length) {
    // With exclusive_caps=1 normal viewers cannot even see the device before a producer started, so a
    // holder is usually a competing producer. Exception: viewers that kept the device open from an
    // earlier run of ours (e.g. OBS "Video Capture Device" source on "VTube Linux", Discord) – that is
    // fine. v4l2loopback's sysfs `format` is non-empty only while a producer is streaming.
    const producer = holders.some((h) => h.writeOnly) || !!node?.format;
    const unknown = !node || node.format === null;
    if (producer || unknown) {
      return `${device}${quoteLabel(node?.label ?? '')} wird bereits von ${formatHolders(holders)} benutzt – ` +
        `dort sendet offenbar schon ein anderes Programm Bilder hinein. ${OWN_DEVICE_HINT}\n` +
        'Lösung: In VTube Linux ein anderes, freies Gerät wählen (Übersicht: App mit --list-devices starten) oder ' +
        'v4l2loopback mit zwei Geräten laden:\n' + VCAM_SETUP_HINT;
    }
  }
  return undefined;
}
