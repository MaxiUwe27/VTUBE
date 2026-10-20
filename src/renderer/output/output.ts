// OBS browser-source page: renders the avatar only, driven over WebSocket by the main process.
//
// URL query options:
//   ?bg=transparent        force a transparent background
//   ?bg=%2300ff00 / ?bg=00ff00   force a background colour
//   ?debug                 show a small status line
import { AvatarRenderer } from '../avatar/AvatarRenderer';
import type { AvatarPose, OutputMessage } from '../../shared/types';
import { DEFAULT_SETTINGS, type ViewSettings } from '../../shared/settings';

const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const bgOverride = parseBgOverride(params.get('bg'));

const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement | null;

let renderer: AvatarRenderer;
try {
  renderer = new AvatarRenderer(canvas, { transparentCapable: true });
} catch (err) {
  // No WebGL: nothing sensible to show. Log once and stop.
  console.error('[output] WebGL renderer could not be created:', err);
  throw err;
}

// Until the first 'view' message, stay transparent (avoids a green flash in OBS).
let lastView: ViewSettings = {
  ...structuredClone(DEFAULT_SETTINGS.view),
  background: { mode: 'transparent', color: DEFAULT_SETTINGS.view.background.color },
};
applyView(lastView);
renderer.start();

// ------------------------------------------------------------------ state

let ws: WebSocket | null = null;
let connected = false;
let retryMs = 500;
let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;
let currentModelKey: string | null = null;  // `${rev}|${url}` of the model shown / loading
let modelName = '';
let modelError = '';
let poseCount = 0;
let poseRate = 0;
let lastPose: AvatarPose | null = null;

function applyView(view: ViewSettings): void {
  const v: ViewSettings = structuredClone(view);
  if (bgOverride) v.background = { ...v.background, ...bgOverride };
  renderer.setView(v);
}

async function setModel(url: string | null, rev: number): Promise<void> {
  if (!url) {
    currentModelKey = null;
    modelName = '';
    modelError = '';
    renderer.unloadVRM();
    return;
  }
  const key = `${rev}|${url}`;
  if (key === currentModelKey) return; // already shown / loading (e.g. after reconnect)
  currentModelKey = key;
  modelError = '';
  try {
    const abs = new URL(url, location.origin).toString();
    const info = await renderer.loadVRM(abs);
    if (currentModelKey !== key) return;
    modelName = info.name;
    if (lastPose) renderer.applyPose(lastPose);
  } catch (err) {
    if (currentModelKey !== key) return; // superseded by a newer model message
    modelError = err instanceof Error ? err.message : String(err);
    modelName = '';
    if (debug) console.warn('[output] model load failed:', modelError);
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
        renderer.applyPose(msg.pose);
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
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    connected = true;
    retryMs = 500;
  };
  sock.onmessage = (e) => handleMessage(e.data);
  sock.onerror = () => {
    /* onclose follows; avoid console spam */
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    connected = false;
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 5000);
}

connect();

// ------------------------------------------------------------------ debug status

if (debug && statusEl) {
  statusEl.hidden = false;
  setInterval(() => {
    poseRate = poseCount;
    poseCount = 0;
    const lines = [
      `ws: ${connected ? 'connected' : 'reconnecting…'}`,
      `model: ${modelError ? 'error: ' + modelError : modelName || (currentModelKey ? 'loading…' : 'none')}`,
      `render: ${renderer.fps.toFixed(0)} fps · poses: ${poseRate}/s`,
      bgOverride ? `bg override: ${bgOverride.mode}${bgOverride.mode === 'color' ? ' ' + bgOverride.color : ''}` : '',
    ].filter(Boolean);
    statusEl.textContent = lines.join('\n');
  }, 1000);
}

window.addEventListener('beforeunload', () => {
  try { ws?.close(); } catch { /* ignore */ }
  renderer.dispose();
});

// ------------------------------------------------------------------ helpers

function parseBgOverride(v: string | null): ViewSettings['background'] | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === 'transparent' || s === 'none' || s === 'alpha') {
    return { mode: 'transparent', color: DEFAULT_SETTINGS.view.background.color };
  }
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(hex)) return { mode: 'color', color: `#${hex}` };
  return null;
}
