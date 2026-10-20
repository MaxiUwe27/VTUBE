// 2. Kamera & Tracking: device, resolution, fps, GPU, preview with landmark overlay,
//    calibration, live status.

import { FaceTracker } from '../../tracking/FaceTracker';
import type { AppContext, SectionModule } from '../context';
import { button, hint, iconButton, infoGrid, section, statusDot, subhead, type Opt } from '../controls';
import { h, setText, toggleClass } from '../dom';
import { toast } from '../toast';

export function trackingSection(ctx: AppContext): SectionModule {
  const { store, ui, live, actions, tracker } = ctx;

  // --- Camera selection ---------------------------------------------------------------------
  const refreshBtn = iconButton('refresh', 'Kameraliste aktualisieren', () => void loadCameras(true));
  const camSelect = ui.select<string | null>({
    label: 'Kamera',
    options: [{ value: null, label: 'Standard-Kamera' }],
    get: (s) => s.camera.deviceId,
    set: (v) => ({ camera: { deviceId: v } }),
    missingLabel: () => 'Gespeicherte Kamera (nicht gefunden)',
    extra: refreshBtn,
  });

  async function loadCameras(manual = false): Promise<void> {
    try {
      const cams = await FaceTracker.listCameras();
      const opts: Opt<string | null>[] = [{ value: null, label: 'Standard-Kamera' }];
      cams.forEach((c, i) => {
        if (c.deviceId) opts.push({ value: c.deviceId, label: c.label || `Kamera ${i + 1}` });
      });
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

  // --- Status ---------------------------------------------------------------------------------
  const status = infoGrid([
    { key: 'state', label: 'Status' },
    { key: 'face', label: 'Gesicht' },
    { key: 'fps', label: 'Tracking-FPS' },
    { key: 'delegate', label: 'Berechnung' },
  ]);
  const errorBox = h('div', { class: 'alert alert-error hidden' });

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
    ui.segmented<string>({
      label: 'Auflösung',
      hint: 'Höhere Auflösung = genauer, aber mehr Rechenlast',
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
    errorBox.textContent = t.error ?? '';
    toggleClass(errorBox, 'hidden', !(t.state === 'error' && t.error));
    toggleClass(preview, 'off', t.state !== 'running');
    previewPlaceholder.textContent = t.state === 'starting' ? 'Kamera wird gestartet…' : t.state === 'error' ? 'Kein Kamerabild' : 'Kamera ist aus';
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
      else if (stale) status.set('face', 'Keine Kamerabilder', 'warn');
      else if (face?.detected) status.set('face', h('span', { class: 'with-dot' }, statusDot('ok'), 'Erkannt'), 'good');
      else status.set('face', h('span', { class: 'with-dot' }, statusDot('warn'), 'Nicht erkannt'), 'warn');
      status.set('fps', t.state === 'running' ? `${Math.round(tracker.fps)} fps` : '–');
      if (tracker.delegate !== lastDelegate) {
        lastDelegate = tracker.delegate;
        renderStatus();
      }
      if (store.value.camera.showPreview && t.state === 'running' && !rafId) rafId = requestAnimationFrame(drawOverlay);
    },
  };
}
