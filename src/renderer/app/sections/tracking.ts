// 2. Kamera & Tracking: device (or "Browserquelle" URL), resolution, fps, GPU, preview with landmark
//    overlay, calibration, live status.

import { FaceTracker } from '../../tracking/FaceTracker';
import type { AppContext, SectionModule } from '../context';
import { button, hint, iconButton, infoGrid, section, statusDot, subhead, type Opt } from '../controls';
import { h, setText, toggleClass } from '../dom';
import { toast } from '../toast';
import type { SettingsPatch } from '../store';

/** Select value of the "Browserquelle (URL) …" entry (never a real deviceId). */
const URL_KEY = '\u0001url';
const URL_OPT: Opt<string | null> = {
  value: URL_KEY,
  label: 'Browserquelle (URL) …',
  title: 'Handy-Kamera-App, Video-Stream oder Webseite (z. B. VDO.Ninja-Link) als Kamera verwenden',
};
const MAX_RECENT_URLS = 10;

/** User input → absolute URL ("192.168.0.5:8080/video" → "http://…"), or null if empty. */
function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(t) ? t : `http://${t}`;
}

/** German problem description for a URL the browser source cannot open, or null if fine. */
function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `Ungültige Adresse: ${url}`;
  }
  if (/^(rtsp|rtmp|rtp|srt):$/.test(u.protocol)) {
    return 'RTSP/RTMP-Streams kann die Browserquelle nicht abspielen – in der Handy-App die HTTP-Adresse verwenden (z. B. http://IP:8080/video).';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Nur http:// und https:// Adressen sind möglich.';
  if (!u.hostname) return `Ungültige Adresse: ${url}`;
  return null;
}

export function trackingSection(ctx: AppContext): SectionModule {
  const { store, ui, live, actions, tracker } = ctx;

  // --- Camera selection ---------------------------------------------------------------------
  const refreshBtn = iconButton('refresh', 'Kameraliste aktualisieren', () => void loadCameras(true));
  const camSelect = ui.select<string | null>({
    label: 'Kamera',
    options: [{ value: null, label: 'Standard-Kamera' }, URL_OPT],
    get: (s) => (s.camera.source === 'url' ? URL_KEY : s.camera.deviceId),
    set: (v) => (v === URL_KEY ? { camera: { source: 'url' } } : { camera: { source: 'device', deviceId: v } }),
    missingLabel: () => 'Gespeicherte Kamera (nicht gefunden)',
    extra: refreshBtn,
    // After a failure, picking the same camera again restarts the tracking.
    reselectLabel: (cur) => (live.tracker.state === 'error' && store.value.tracking.enabled ? `${cur} – erneut wählen zum Neustart` : null),
  });

  async function loadCameras(manual = false): Promise<void> {
    try {
      const cams = await FaceTracker.listCameras();
      const opts: Opt<string | null>[] = [{ value: null, label: 'Standard-Kamera' }];
      cams.forEach((c, i) => {
        if (c.deviceId) opts.push({ value: c.deviceId, label: c.label || `Kamera ${i + 1}` });
      });
      opts.push(URL_OPT);
      camSelect.setOptions(opts);
      if (manual) toast(`${cams.length} Kamera${cams.length === 1 ? '' : 's'} gefunden.`, 'info', 2000);
    } catch (err) {
      if (manual) toast('Kameras konnten nicht aufgelistet werden.', 'error');
      console.warn('[ui] listCameras failed', err);
    }
  }
  void loadCameras();
  // Device labels are only available after permission was granted → refresh once tracking runs.
  let labelsLoaded = false;
  ctx.on('tracker', () => {
    if (live.tracker.state === 'running' && !labelsLoaded) {
      labelsLoaded = true;
      void loadCameras();
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void loadCameras());

  // --- Browserquelle (URL) ----------------------------------------------------------------------
  const urlInputId = 'tracking-url';
  const urlList = h('datalist', { id: `${urlInputId}-list` });
  const urlInput = h('input', {
    id: urlInputId, type: 'text', class: 'text', list: `${urlInputId}-list`, spellcheck: false, autocomplete: 'off',
    placeholder: 'http://192.168.x.x:8080/video',
  });
  const connect = () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      toast('Bitte die Adresse der Browserquelle eingeben.', 'warning');
      urlInput.focus();
      return;
    }
    const problem = urlProblem(url);
    if (problem) {
      toast(problem, 'error');
      urlInput.focus();
      return;
    }
    urlInput.value = url;
    const s = store.value;
    const unchanged = s.camera.source === 'url' && s.camera.url === url && s.tracking.enabled;
    const patch: SettingsPatch = { camera: { source: 'url', url } };
    if (!s.tracking.enabled) patch.tracking = { enabled: true };
    store.update(patch, 0);
    if (unchanged) actions.restartTracker(); // same address again = reconnect
  };
  const connectBtn = button('Verbinden', {
    icon: 'play', variant: 'primary', small: true, title: 'Browserquelle (neu) laden und als Kamerabild verwenden',
    onClick: connect,
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      connect();
    }
  });
  const urlState = h('div', { class: 'calib-state' });
  const urlBox = h('div', { class: 'url-source' },
    h('div', { class: 'ctl ctl-input' },
      h('label', { class: 'ctl-label', for: urlInputId, title: 'Adresse einer Webseite oder eines Video-Streams' }, 'Adresse'),
      h('div', { class: 'select-wrap' }, urlInput, urlList, connectBtn)),
    urlState,
    hint('Handy als Webcam: App „IP Webcam“ (Android) → ', h('code', null, 'http://192.168.x.x:8080/video'),
      ', DroidCam → ', h('code', null, 'http://IP:4747/video'), ', oder ein VDO.Ninja-Link (',
      h('code', null, 'https://vdo.ninja/?view=…'), '). Auch MP4/WebM-Videos und normale Webseiten gehen. ',
      'Handy und PC müssen im selben WLAN sein. RTSP wird nicht unterstützt; selbst signierte HTTPS-Zertifikate ',
      'werden abgelehnt (dann http:// verwenden). Auflösung/FPS unten = Größe und Bildrate der unsichtbaren Seite.'),
  );
  let shownRecent = '';
  ui.bind(() => {
    const c = store.value.camera;
    toggleClass(urlBox, 'hidden', c.source !== 'url');
    if (document.activeElement !== urlInput) urlInput.value = c.url;
    const key = c.recentUrls.join('\n');
    if (key !== shownRecent) {
      shownRecent = key;
      urlList.replaceChildren(...c.recentUrls.map((u) => h('option', { value: u })));
    }
  });
  // Remember addresses that actually worked (max 10, newest first, no duplicates).
  ctx.on('tracker', () => {
    const c = store.value.camera;
    if (live.tracker.state !== 'running' || c.source !== 'url' || !c.url || c.recentUrls[0] === c.url) return;
    store.update({ camera: { recentUrls: [c.url, ...c.recentUrls.filter((u) => u !== c.url)].slice(0, MAX_RECENT_URLS) } }, 0);
  });
  const renderUrlState = (now: number) => {
    const c = store.value.camera;
    if (c.source !== 'url') return;
    const t = live.tracker.state;
    const info = tracker.urlSource;
    let dot: 'ok' | 'warn' | 'error' | 'off' = 'off';
    let text = 'Nicht verbunden';
    if (t === 'starting') {
      dot = 'warn';
      text = info?.state === 'error' ? `Fehler: ${info.message ?? ''}` : 'Verbinde…';
    } else if (t === 'running' && info) {
      const idle = now - tracker.urlLastFrameAt;
      if (info.state === 'error') {
        dot = 'error';
        text = `${info.message ?? 'Fehler'} – neuer Versuch läuft…`;
      } else if (info.state === 'reconnecting' || info.state === 'loading') {
        dot = 'warn';
        text = info.message || 'Verbindung wird wiederhergestellt…';
      } else if (idle > 2000) {
        dot = 'warn';
        text = `Verbunden, aber keine neuen Bilder seit ${Math.round(idle / 1000)} s`;
      } else {
        dot = 'ok';
        text = `Verbunden – ${info.width}×${info.height}`;
      }
    } else if (t === 'error') {
      dot = 'error';
      text = 'Getrennt (siehe Fehler unten)';
    }
    const cur = urlState.dataset.v;
    const v = `${dot}|${text}`;
    if (cur === v) return;
    urlState.dataset.v = v;
    urlState.replaceChildren(statusDot(dot), h('span', { class: 'calib-text', title: info?.url ?? c.url }, text));
  };

  // --- Status ---------------------------------------------------------------------------------
  const status = infoGrid([
    { key: 'state', label: 'Status' },
    { key: 'face', label: 'Gesicht' },
    { key: 'fps', label: 'Tracking-FPS' },
    { key: 'delegate', label: 'Berechnung' },
  ]);
  const errorText = h('div', { class: 'alert-text' });
  const retryBtn = button('Erneut versuchen', {
    icon: 'refresh', small: true, title: 'Kamera und Tracking neu starten',
    onClick: () => actions.restartTracker(),
  });
  const errorBox = h('div', { class: 'alert alert-error hidden' }, errorText, h('div', { class: 'btn-row' }, retryBtn));

  // --- Preview -------------------------------------------------------------------------------
  const overlay = h('canvas', { class: 'preview-overlay' });
  const previewPlaceholder = h('div', { class: 'preview-placeholder' }, 'Kamera ist aus');
  const previewInner = h('div', { class: 'preview-inner' });
  const preview = h('div', { class: 'preview' }, previewInner, previewPlaceholder);
  const video = tracker.video;
  video.classList.add('preview-video');
  previewInner.append(video, overlay);

  // --- Calibration ----------------------------------------------------------------------------
  const calibBtn = button('Kalibrieren (neutrales Gesicht)', {
    icon: 'target', variant: 'primary', title: 'Neutrale Kopfhaltung und Mimik übernehmen (Taste C)',
    onClick: () => actions.calibrate(),
  });
  const resetBtn = button('Zurücksetzen', {
    variant: 'ghost', small: true, title: 'Kalibrierung zurücksetzen',
    onClick: () => actions.resetCalibration(),
  });
  const calibState = h('div', { class: 'calib-state' });

  ctx.on('calibration', () => {
    const n = live.calibrationCountdown;
    calibBtn.disabled = n !== null;
    setText(calibBtn.querySelector('span')!, n !== null ? `Bitte stillhalten… ${n}` : 'Kalibrieren (neutrales Gesicht)');
  });
  ui.bind(() => {
    const cal = store.value.tracking.calibration;
    calibState.replaceChildren(statusDot(cal ? 'ok' : 'off'), h('span', { class: 'calib-text' }, cal ? 'Kalibriert' : 'Nicht kalibriert'), resetBtn);
    resetBtn.disabled = !cal;
  });

  const sec = section('tracking', 'Kamera & Tracking', 'camera', true,
    ui.toggle({
      label: 'Gesichts-Tracking',
      hint: 'Webcam-Tracking ein- oder ausschalten',
      get: (s) => s.tracking.enabled,
      set: (v) => ({ tracking: { enabled: v } }),
    }),
    camSelect.el,
    urlBox,
    ui.segmented<string>({
      label: 'Auflösung',
      hint: 'Höhere Auflösung = genauer, aber mehr Rechenlast (bei der Browserquelle: Größe der Seite)',
      options: [{ value: '640x480', label: '640×480' }, { value: '1280x720', label: '1280×720' }],
      get: (s) => `${s.camera.width}x${s.camera.height}`,
      set: (v) => {
        const [w, hh] = v.split('x').map(Number);
        return { camera: { width: w, height: hh } };
      },
    }),
    ui.segmented<number>({
      label: 'Kamera-FPS',
      options: [{ value: 30, label: '30' }, { value: 60, label: '60' }],
      get: (s) => s.camera.fps,
      set: (v) => ({ camera: { fps: v } }),
    }),
    ui.toggle({
      label: 'GPU-Beschleunigung',
      hint: 'MediaPipe auf der Grafikkarte ausführen (fällt bei Problemen automatisch auf CPU zurück)',
      get: (s) => s.tracking.useGpu,
      set: (v) => ({ tracking: { useGpu: v } }),
    }),
    status.el,
    errorBox,
    subhead('Vorschau'),
    ui.toggle({
      label: 'Kamerabild anzeigen',
      get: (s) => s.camera.showPreview,
      set: (v) => ({ camera: { showPreview: v } }),
    }),
    ui.toggle({
      label: 'Gesichtspunkte einblenden',
      get: (s) => s.camera.showLandmarks,
      set: (v) => ({ camera: { showLandmarks: v } }),
      enabled: (s) => s.camera.showPreview,
    }),
    preview,
    subhead('Kalibrierung'),
    hint('Gerade in die Kamera schauen, entspanntes neutrales Gesicht, Mund geschlossen. Nach 3 Sekunden wird die Haltung übernommen.'),
    h('div', { class: 'btn-row' }, calibBtn),
    calibState,
  );

  ui.bind(() => {
    toggleClass(preview, 'collapsed', !store.value.camera.showPreview);
  });

  const renderStatus = () => {
    const t = live.tracker;
    const s = store.value;
    const label = { off: 'Aus', starting: 'Startet…', running: 'Läuft', error: 'Fehler' }[t.state];
    const dot = { off: 'off', starting: 'warn', running: 'ok', error: 'error' }[t.state] as 'ok';
    status.set('state', h('span', { class: 'with-dot' }, statusDot(dot), label));
    errorText.textContent = t.error ?? '';
    toggleClass(errorBox, 'hidden', !(t.state === 'error' && t.error));
    camSelect.refresh();
    toggleClass(preview, 'off', t.state !== 'running');
    const isUrl = s.camera.source === 'url';
    previewPlaceholder.textContent = t.state === 'starting' ? (isUrl ? 'Browserquelle wird geladen…' : 'Kamera wird gestartet…')
      : t.state === 'error' ? 'Kein Kamerabild' : 'Kamera ist aus';
    renderUrlState(performance.now());
    status.set('delegate', t.state !== 'running' ? '–'
      : tracker.delegate === 'GPU' ? 'GPU'
      : tracker.delegate === 'CPU' ? (s.tracking.useGpu ? 'CPU (GPU nicht verfügbar)' : 'CPU')
      : '–');
    sec.badge.textContent = t.state === 'running' ? 'aktiv' : t.state === 'error' ? 'Fehler' : '';
    sec.badge.className = `section-badge ${t.state === 'running' ? 'ok' : t.state === 'error' ? 'error' : ''}`;
  };
  ctx.on('tracker', renderStatus);
  renderStatus();

  // --- Landmark overlay -------------------------------------------------------------------------
  // Runs on its own rAF while the section is visible (tick() keeps it alive) for smooth drawing.
  let lastDelegate = tracker.delegate;
  let rafId = 0;
  let lastTickAt = -Infinity;
  const drawOverlay = () => {
    rafId = 0;
    const s = store.value;
    if (performance.now() - lastTickAt > 300 || !s.camera.showPreview) return;
    rafId = requestAnimationFrame(drawOverlay);
    const ctx2d = overlay.getContext('2d');
    if (!ctx2d) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (overlay.width !== vw || overlay.height !== vh) {
      overlay.width = vw;
      overlay.height = vh;
      previewInner.style.aspectRatio = `${vw} / ${vh}`;
    }
    ctx2d.clearRect(0, 0, vw, vh);
    const lm = tracker.lastLandmarks;
    const fresh = live.lastFace?.detected && performance.now() - live.lastFaceAt < 500;
    if (s.camera.showLandmarks && lm && fresh) {
      ctx2d.fillStyle = 'rgba(167, 139, 250, 0.9)';
      const r = Math.max(1, vw / 400);
      for (const p of lm) ctx2d.fillRect(p.x * vw - r / 2, p.y * vh - r / 2, r, r);
    }
  };

  return {
    el: sec.el,
    isOpen: () => sec.open,
    tick(now) {
      lastTickAt = now;
      const t = live.tracker;
      const face = live.lastFace;
      const stale = now - live.lastFaceAt > 1000;
      if (t.state !== 'running') status.set('face', '–', 'muted');
      else if (stale) status.set('face', store.value.camera.source === 'url' ? 'Keine Bilder von der Browserquelle' : 'Keine Kamerabilder', 'warn');
      else if (face?.detected) status.set('face', h('span', { class: 'with-dot' }, statusDot('ok'), 'Erkannt'), 'good');
      else status.set('face', h('span', { class: 'with-dot' }, statusDot('warn'), 'Nicht erkannt'), 'warn');
      status.set('fps', t.state === 'running' ? `${Math.round(tracker.fps)} fps` : '–');
      renderUrlState(now);
      if (tracker.delegate !== lastDelegate) {
        lastDelegate = tracker.delegate;
        renderStatus();
      }
      if (store.value.camera.showPreview && t.state === 'running' && !rafId) rafId = requestAnimationFrame(drawOverlay);
    },
  };
}
