// OBS browser-source page: renders the avatar only, driven over WebSocket by the main process.
//
// URL query options:
//   (default)              transparent background – OBS composites the alpha channel
//   ?bg=%2300ff00 / ?bg=00ff00   force a background colour
//   ?bg=app                follow the app window's background setting
//   ?debug                 show a small live status line (bottom left)
//   ?nostatus              never show the status/error box (top left)
//
// The status/error box itself lives in an inline ES5 script in output.html (window.VTubeStatus),
// so errors are visible even if this bundle fails to load. It is shown whenever the avatar is not
// visible for a reason the user can fix (app not running, no model, no WebGL, script errors) and
// hides itself once the avatar renders.
import { AvatarRenderer } from '../avatar/AvatarRenderer';
import type { AvatarPose, OutputMessage } from '../../shared/types';
import { DEFAULT_SETTINGS, type ViewSettings } from '../../shared/settings';

type Level = 'error' | 'warn' | 'info';
interface StatusBox {
  set(key: string, text: string, level?: Level, ttlMs?: number): void;
  clear(key: string): void;
  setGood(good: boolean): void;
  booted(): void;
}
declare global {
  interface Window { VTubeStatus?: StatusBox }
}

const status: StatusBox = window.VTubeStatus ?? {
  set: (k, t) => console.warn(`[output] ${k}: ${t}`),
  clear: () => undefined,
  setGood: () => undefined,
  booted: () => undefined,
};
status.booted();

const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const bgOverride = parseBgOverride(params.get('bg'));

const CONNECT_GRACE_MS = 1500;   // don't flash "no connection" on a normal (re)connect
const LOADING_GRACE_MS = 800;    // show "loading model" only for slow loads

const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement | null;

const MSG_WEBGL =
  'WebGL nicht verfügbar – in OBS: Einstellungen → Erweitert → Browserquellen-Hardwarebeschleunigung aktivieren ' +
  '(und OBS neu starten). Im Browser: Hardwarebeschleunigung aktivieren.';

let renderer: AvatarRenderer | null = null;
let rendererError = '';
try {
  renderer = new AvatarRenderer(canvas, { transparentCapable: true });
} catch (err) {
  // No WebGL (2): keep running (WebSocket + status) so the reason is visible and /status counts us.
  rendererError = errText(err);
  console.error('[output] WebGL renderer could not be created:', err);
  status.set('webgl', `${MSG_WEBGL}\n(${rendererError})`, 'error');
}

// Until the first 'view' message, stay transparent (avoids a green flash in OBS).
let lastView: ViewSettings = {
  ...cloneJson(DEFAULT_SETTINGS.view),
  background: { mode: 'transparent', color: DEFAULT_SETTINGS.view.background.color },
};
applyView(lastView);
renderer?.start();

// ------------------------------------------------------------------ state

let ws: WebSocket | null = null;
let connected = false;
let everConnected = false;
let disconnectedSince = performance.now();
let serverReachable: boolean | null = null; // HTTP /status answered while the WebSocket failed
let retryMs = 500;
let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;
let modelKnown = false;                     // got at least one 'model' message
let currentModelKey: string | null = null;  // `${rev}|${url}` of the model shown / loading
let modelLoadingSince = 0;
let modelName = '';
let modelError = '';
let poseCount = 0;
let poseRate = 0;
let lastPose: AvatarPose | null = null;

function applyView(view: ViewSettings): void {
  if (!renderer) return;
  const v: ViewSettings = cloneJson(view);
  if (bgOverride) v.background = { ...v.background, ...bgOverride };
  renderer.setView(v);
}

async function setModel(url: string | null, rev: number): Promise<void> {
  modelKnown = true;
  if (!url) {
    currentModelKey = null;
    modelName = '';
    modelError = '';
    modelLoadingSince = 0;
    renderer?.unloadVRM();
    updateStatus();
    return;
  }
  const key = `${rev}|${url}`;
  if (key === currentModelKey) return; // already shown / loading (e.g. after reconnect)
  currentModelKey = key;
  modelError = '';
  if (!renderer) return; // no WebGL: nothing to load into
  modelLoadingSince = performance.now();
  updateStatus();
  try {
    const abs = new URL(url, location.origin).toString();
    const info = await renderer.loadVRM(abs);
    if (currentModelKey !== key) return;
    modelName = info.name;
    if (lastPose) renderer.applyPose(lastPose);
  } catch (err) {
    if (currentModelKey !== key) return; // superseded by a newer model message
    modelError = errText(err);
    modelName = '';
    currentModelKey = null; // let the model message sent on reconnect retry the download
    console.warn('[output] model load failed:', modelError);
  } finally {
    if (currentModelKey === key) modelLoadingSince = 0;
    updateStatus();
  }
}

function handleMessage(raw: unknown): void {
  if (typeof raw !== 'string') return;
  let msg: OutputMessage;
  try {
    msg = JSON.parse(raw) as OutputMessage;
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'pose':
      if (msg.pose) {
        lastPose = msg.pose;
        poseCount++;
        renderer?.applyPose(msg.pose);
      }
      break;
    case 'view':
      if (msg.view) {
        lastView = msg.view;
        applyView(lastView);
      }
      break;
    case 'model':
      void setModel(msg.url ?? null, msg.rev ?? 0);
      break;
  }
}

// ------------------------------------------------------------------ WebSocket

function connect(): void {
  retryTimer = 0;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${proto}://${location.host}/ws`);
  } catch (err) {
    console.warn('[output] WebSocket could not be created:', err);
    scheduleReconnect();
    return;
  }
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    connected = true;
    everConnected = true;
    serverReachable = null;
    retryMs = 500;
    updateStatus();
  };
  sock.onmessage = (e) => handleMessage(e.data);
  sock.onerror = () => {
    /* onclose follows; avoid console spam */
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (connected) disconnectedSince = performance.now();
    connected = false;
    if (!opened) void probeServer();
    scheduleReconnect();
    updateStatus();
  };
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 5000);
}

/** WebSocket failed: is the app reachable over plain HTTP? (distinguishes "app not running"
 *  from "WebSocket blocked", e.g. by a proxy/extension or the server's origin check) */
async function probeServer(): Promise<void> {
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    serverReachable = r.ok;
  } catch {
    serverReachable = false;
  }
  updateStatus();
}

connect();

// ------------------------------------------------------------------ status box

function updateStatus(): void {
  const now = performance.now();

  // Connection
  if (connected) {
    status.clear('conn');
  } else if (now - disconnectedSince >= CONNECT_GRACE_MS) {
    status.set('conn', serverReachable
      ? 'VTube-App erreichbar, aber die WebSocket-Verbindung wird abgelehnt/blockiert – Seite über die ' +
        'in der App angezeigte URL öffnen (Details im Terminal der App). Neuer Versuch läuft…'
      : everConnected
        ? 'Verbindung zur VTube-App verloren – läuft sie noch? Neuer Versuch läuft…'
        : 'Keine Verbindung zur VTube-App – läuft sie? Neuer Versuch läuft…', 'error');
  }

  // WebGL
  if (renderer?.isContextLost) status.set('webgl', 'WebGL-Kontext verloren (Grafiktreiber) – warte auf Wiederherstellung…', 'warn');
  else if (renderer) status.clear('webgl');

  // Model (only meaningful while connected)
  if (!connected || !modelKnown || !renderer) {
    status.clear('model');
  } else if (!currentModelKey) {
    status.set('model', 'Kein Modell geladen – in der VTube-App ein VRM-Modell öffnen.', 'warn');
  } else if (modelError) {
    status.set('model', `Modell konnte nicht geladen werden: ${modelError}`, 'error');
  } else if (modelLoadingSince && now - modelLoadingSince >= LOADING_GRACE_MS) {
    status.set('model', 'Lade Modell…', 'info');
  } else if (!modelLoadingSince) {
    status.clear('model');
  }

  status.setGood(!!renderer && !renderer.isContextLost && connected && !!modelName && !modelError);
}

setInterval(updateStatus, 500);

// ------------------------------------------------------------------ debug status

if (debug && statusEl) {
  statusEl.hidden = false;
  setInterval(() => {
    poseRate = poseCount;
    poseCount = 0;
    const lines = [
      `ws: ${connected ? 'connected' : 'reconnecting…'}`,
      `model: ${modelError ? 'error: ' + modelError : modelName || (currentModelKey ? 'loading…' : 'none')}`,
      renderer
        ? `render: ${renderer.fps.toFixed(0)} fps · poses: ${poseRate}/s`
        : `render: no WebGL (${rendererError}) · poses: ${poseRate}/s`,
      bgOverride ? `bg override: ${bgOverride.mode}${bgOverride.mode === 'color' ? ' ' + bgOverride.color : ''}` : '',
    ].filter(Boolean);
    statusEl.textContent = lines.join('\n');
  }, 1000);
}

window.addEventListener('beforeunload', () => {
  try { ws?.close(); } catch { /* ignore */ }
  renderer?.dispose();
});

// ------------------------------------------------------------------ helpers

function parseBgOverride(v: string | null): ViewSettings['background'] | null {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'app') return null;
  // The app window's chroma green is meant for window capture; a browser source is transparent.
  if (!s || s === 'transparent' || s === 'none' || s === 'alpha') {
    return { mode: 'transparent', color: DEFAULT_SETTINGS.view.background.color };
  }
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return { mode: 'color', color: `#${hex}` };
  return null;
}

/** structuredClone needs Chromium 98+; older OBS builds ship an older CEF. */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
