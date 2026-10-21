// Electron main process: window, IPC, settings, OBS server, virtual camera.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelFile, ServerInfo, VcamStatus } from '../shared/api';
import type { DeepPartial, Settings } from '../shared/settings';
import type { AvatarPose } from '../shared/types';
import { MIME, OutputServer } from './server';
import { SettingsStore } from './settingsStore';
import { VirtualCam } from './virtualCam';
import { formatDeviceList, listVideoDevices, resolveVcamDevice, VCAM_DEVICE_ENV, VCAM_DEVICE_FLAG, wantsDeviceList, type ResolvedDevice } from './vcamDevice';

// `--list-devices` / `--vcam-list`: print the video devices and exit – before the single-instance
// lock or any window (plain fs; settings are only read).
if (wantsDeviceList(process.argv)) {
  let configured: string | undefined;
  try {
    configured = new SettingsStore(path.join(app.getPath('userData'), 'settings.json')).get().output.virtualCam.device;
  } catch { /* defaults */ }
  fs.writeSync(1, formatDeviceList(listVideoDevices(), resolveVcamDevice(process.argv, process.env, configured)));
  app.exit(0);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Command line / Chromium switches (must happen before 'ready')
// ---------------------------------------------------------------------------
const isDev = process.argv.includes('--dev');
const gpuDisabled = process.argv.includes('--disable-gpu') || process.env.VTUBE_DISABLE_GPU === '1';

app.setName('VTube Linux');
if (process.env.VTUBE_DISABLE_GPU === '1') app.disableHardwareAcceleration(); // --disable-gpu is handled by Chromium itself

const cl = app.commandLine;
// Native Wayland when available (KDE Plasma 6), X11 otherwise. A user-supplied value wins.
if (!cl.hasSwitch('ozone-platform-hint') && !cl.hasSwitch('ozone-platform')) cl.appendSwitch('ozone-platform-hint', 'auto');
appendFeatures('enable-features', ['WaylandWindowDecorations']);
if (!gpuDisabled) {
  cl.appendSwitch('ignore-gpu-blocklist');       // NVIDIA proprietary driver is often blocklisted
  cl.appendSwitch('enable-gpu-rasterization');
}
// Keep tracking/rendering alive while the window is unfocused, covered or minimized (streaming!).
cl.appendSwitch('disable-background-timer-throttling');
cl.appendSwitch('disable-renderer-backgrounding');
cl.appendSwitch('disable-backgrounding-occluded-windows');

function appendFeatures(sw: string, features: string[]): void {
  // appendSwitch replaces earlier values of the same switch -> merge with what the user passed.
  const existing = cl.getSwitchValue(sw).split(',').filter(Boolean);
  cl.appendSwitch(sw, [...new Set([...existing, ...features])].join(','));
}

// The UI is served from app://local/ instead of file:// — MediaPipe loads its wasm/model via
// fetch() and runs in a module Worker, both of which Chromium refuses for file:// pages.
const APP_SCHEME = 'app';
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function registerAppProtocol(): void {
  const root = path.resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file); // works inside app.asar too
      return new Response(data, {
        headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const appRoot = path.join(__dirname, '../..');                  // project root / app.asar
const rendererDir = path.join(appRoot, 'dist/renderer');
const store = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
const server = new OutputServer({ rootDir: rendererDir });
const vcam = new VirtualCam();
let win: BrowserWindow | null = null;

const MAX_RECENT = 10;
const MAX_MODEL_BYTES = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#15151c',
    title: 'VTube Linux',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });

  // The app is a single local page: no navigation, external links go to the browser.
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) wc.toggleDevTools();
    else if (isDev && input.control && input.key.toLowerCase() === 'r') wc.reloadIgnoringCache();
  });
  wc.on('render-process-gone', (_e, d) => console.error('[main] renderer gone:', d.reason, d.exitCode));

  const index = path.join(rendererDir, 'index.html');
  if (!fs.existsSync(index)) {
    dialog.showErrorBox('VTube Linux', `Renderer nicht gefunden:\n${index}\n\nBitte zuerst "npm run build" ausführen.`);
  }
  void win.loadURL(`${APP_SCHEME}://local/index.html`);
  if (isDev) wc.openDevTools({ mode: 'detach' });
}

function openExternalSafe(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    void shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings + side effects
// ---------------------------------------------------------------------------
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function applySettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const prev = store.get();
  const next = store.update(patch ?? {});

  if (!same(prev.output.browserSource, next.output.browserSource)) await syncServer(next);
  if (!same(prev.view, next.view)) server.setView(next.view);

  const pv = prev.output.virtualCam;
  const nv = next.output.virtualCam;
  if (pv.enabled !== nv.enabled) {
    if (nv.enabled) await startVcam();
    else await vcam.stop();
  } else if (vcam.running && !same(pv, nv)) {
    await startVcam(); // restarts with the new device/size/fps
  }
  return store.get();
}

/** The ONLY place the virtual camera device is determined (CLI > env > settings > default).
 *  Never auto-selects a device. */
function vcamDevice(): ResolvedDevice {
  return resolveVcamDevice(process.argv, process.env, store.get().output.virtualCam.device);
}

/** vcam.status() plus the effective device and where it comes from. */
function vcamStatus(): VcamStatus {
  const r = vcamDevice();
  const st = vcam.status();
  return { ...st, device: st.running ? st.device : r.device, deviceSource: r.source };
}

/** Start/restart the virtual camera from settings. `enabled` mirrors success, so a failed start
 *  (missing module/ffmpeg) is not retried on every launch; the error stays in vcam.status(). */
async function startVcam(): Promise<VcamStatus> {
  const { width, height, fps } = store.get().output.virtualCam;
  await vcam.start({ device: vcamDevice().device, width, height, fps });
  const st = vcamStatus();
  const enabled = st.running;
  if (store.get().output.virtualCam.enabled !== enabled) store.update({ output: { virtualCam: { enabled } } });
  if (st.error) console.error('[vcam]', st.error);
  return st;
}

async function syncServer(s: Settings): Promise<void> {
  const { enabled, port } = s.output.browserSource;
  if (!enabled) return server.stop();
  if (server.info.running && server.info.port === port) return;
  const info = await server.start(port);
  if (info.error) console.error('[server]', info.error);
  else console.log(`[server] OBS browser source: ${info.url}`);
}

function serverInfo(): ServerInfo {
  const s = store.get().output.browserSource;
  if (!s.enabled) return { running: false, port: s.port, url: `http://127.0.0.1:${s.port}/` };
  return server.info;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
async function readModel(p: string, register: boolean): Promise<ModelFile> {
  if (typeof p !== 'string' || !p) throw new Error('Kein Dateipfad angegeben.');
  const abs = path.resolve(p);
  if (path.extname(abs).toLowerCase() !== '.vrm') throw new Error('Nur .vrm-Dateien werden unterstützt.');
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch {
    if (register) dropRecent(abs);
    throw new Error(`Datei nicht gefunden: ${abs}`);
  }
  if (!st.isFile()) throw new Error(`Keine Datei: ${abs}`);
  if (st.size > MAX_MODEL_BYTES) throw new Error('Die Datei ist zu groß (> 1 GB).');
  const buf = await fs.promises.readFile(abs);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'glTF') {
    throw new Error('Keine gültige VRM-Datei (glTF-Binärformat erwartet).');
  }

  server.setModel(buf, `${abs}:${st.size}:${st.mtimeMs}`, path.basename(abs));
  if (register) {
    const recent = [abs, ...store.get().model.recent.filter((r) => r !== abs && fs.existsSync(r))].slice(0, MAX_RECENT);
    store.update({ model: { lastPath: abs, recent } });
  }
  const data = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? buf.buffer as ArrayBuffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { path: abs, name: path.basename(abs), data };
}

function dropRecent(abs: string): void {
  const m = store.get().model;
  if (!m.recent.includes(abs) && m.lastPath !== abs) return;
  store.update({ model: { recent: m.recent.filter((r) => r !== abs), lastPath: m.lastPath === abs ? null : m.lastPath } });
}

async function openModelDialog(): Promise<ModelFile | null> {
  const last = store.get().model.lastPath;
  const opts: Electron.OpenDialogOptions = {
    title: 'VRM-Modell öffnen',
    filters: [{ name: 'VRM-Modelle', extensions: ['vrm', 'VRM'] }],
    properties: ['openFile'],
  };
  if (last) opts.defaultPath = path.dirname(last);
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || res.filePaths.length === 0) return null;
  return readModel(res.filePaths[0], true);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return win !== null && e.sender === win.webContents;
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...args);
  });
}

function toBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function registerIpc(): void {
  handle('settings:get', () => store.get());
  handle('settings:set', (patch: DeepPartial<Settings>) => applySettings(patch));

  handle('model:open', () => openModelDialog());
  handle('model:load', (p: string) => readModel(p, true));

  ipcMain.on('pose', (e, pose: AvatarPose) => {
    if (trusted(e) && pose && typeof pose === 'object') server.pushPose(pose);
  });
  handle('server:info', (): ServerInfo => serverInfo());

  handle('vcam:start', (): Promise<VcamStatus> => startVcam());
  handle('vcam:stop', async (): Promise<VcamStatus> => {
    if (store.get().output.virtualCam.enabled) store.update({ output: { virtualCam: { enabled: false } } });
    await vcam.stop();
    return vcamStatus();
  });
  handle('vcam:status', (): VcamStatus => vcamStatus());
  handle('vcam:devices', () => listVideoDevices({ excludePids: vcam.pid ? [vcam.pid] : [] }));
  ipcMain.on('vcam:frame', (e, data: unknown) => {
    if (!trusted(e)) return;
    const buf = toBuffer(data);
    if (buf) vcam.pushFrame(buf);
  });

  handle('shell:open', async (url: string) => {
    if (!openExternalSafe(String(url))) throw new Error('Nur http(s)-Links sind erlaubt.');
  });
  ipcMain.on('clipboard:write', (e, text: unknown) => {
    if (trusted(e) && typeof text === 'string') clipboard.writeText(text);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  store.flush();
  if (quitting) return;
  // Give the server/ffmpeg a moment to shut down cleanly, then quit for real.
  quitting = true;
  e.preventDefault();
  vcam.kill();
  const timeout = new Promise((r) => setTimeout(r, 1000));
  void Promise.race([server.stop(), timeout]).finally(() => app.quit());
});

process.on('exit', () => vcam.kill());
// Ctrl+C in the terminal / kill: quit through the normal path (flush settings, stop ffmpeg).
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();

  const ses = session.defaultSession;
  // Camera + microphone only; everything else (notifications, geolocation, MIDI, ...) is denied.
  const allowed = new Set(['media', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  registerIpc();
  createWindow();

  const dev = vcamDevice();
  if (dev.source === 'cli' || dev.source === 'env') {
    console.log(`[vcam] Gerät ${dev.device} festgelegt durch ${dev.source === 'cli' ? VCAM_DEVICE_FLAG : VCAM_DEVICE_ENV}`);
  }

  const s = store.get();
  server.setView(s.view);
  await syncServer(s);

  // Make the last model available to OBS right away (the renderer loads it again via model:load;
  // same file => no reload for OBS clients).
  if (s.model.lastPath) await readModel(s.model.lastPath, false).catch(() => undefined);
  if (s.output.virtualCam.enabled) await startVcam();
});
