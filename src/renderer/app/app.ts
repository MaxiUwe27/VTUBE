// Entry point of the main app window: wires FaceTracker → PoseSolver → AvatarRenderer,
// LipSync, OBS output (sendPose), virtual camera frames, settings and the UI.

import { AvatarRenderer } from '../avatar/AvatarRenderer';
import { FaceTracker, isTrackerAbort, isUrlSourceError } from '../tracking/FaceTracker';
import { LipSync } from '../audio/LipSync';
import { PoseSolver } from '../solver/PoseSolver';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../../shared/settings';
import type { VcamStatus } from '../../shared/api';
import { SettingsStore, type SettingsPatch } from './store';
import { Controls } from './controls';
import { h } from './dom';
import { errorText, toast } from './toast';
import { buildPanel } from './panel';
import { setupViewport } from './viewport';
import type { AppActions, AppContext, AppEvent, LiveState, RunState } from './context';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Lets something happen at most `hz` times per second, driven by an irregular frame clock. */
class Pacer {
  private next = 0;
  ready(now: number, hz: number): boolean {
    const iv = 1000 / hz;
    if (now + 2 < this.next) return false;           // 2 ms tolerance for rAF jitter
    this.next = now - this.next > iv ? now + iv : this.next + iv;
    return true;
  }
}

function errName(err: unknown): string {
  return (err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '');
}

function cameraErrorText(err: unknown): string {
  if (isUrlSourceError(err)) return err.message; // "Browserquelle": already a German, specific message
  switch (errName(err)) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'Kamerazugriff verweigert. Bitte den Zugriff erlauben (KDE: Systemeinstellungen → Datenschutz → Kamera) und das Tracking erneut einschalten.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Keine Kamera gefunden. Ist die Webcam angeschlossen? Danach die Kameraliste aktualisieren.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Die Kamera ist belegt oder nicht lesbar – wird sie gerade von einer anderen Anwendung (z. B. OBS, Browser) verwendet?';
    case 'OverconstrainedError': {
      const c = (err as { constraint?: unknown }).constraint;
      if (c === 'deviceId' || c === undefined || c === '') {
        return 'Die gewählte Kamera wurde nicht gefunden. Bitte die Kameraliste aktualisieren und eine Kamera auswählen.';
      }
      return `Die Kamera unterstützt die angeforderte Einstellung nicht (${String(c)}). Bitte eine andere Auflösung/FPS oder Kamera wählen.`;
    }
    default:
      return `Tracking konnte nicht gestartet werden: ${errorText(err)}`;
  }
}

function micErrorText(err: unknown): string {
  switch (errName(err)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Mikrofonzugriff verweigert. Bitte den Zugriff erlauben und Lip-Sync erneut einschalten.';
    case 'NotFoundError':
      return 'Kein Mikrofon gefunden. Bitte ein Mikrofon anschließen oder ein anderes auswählen.';
    case 'NotReadableError':
      return 'Das Mikrofon ist belegt oder nicht lesbar.';
    case 'OverconstrainedError':
      return 'Das gewählte Mikrofon ist nicht verfügbar. Bitte ein anderes auswählen.';
    default:
      return `Lip-Sync konnte nicht gestartet werden: ${errorText(err)}`;
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'color', 'submit', 'reset'].includes(type);
  }
  return false;
}

function fatal(message: string, detail?: unknown): void {
  console.error('[app] fatal:', message, detail);
  document.body.appendChild(h('div', { class: 'fatal' },
    h('div', { class: 'fatal-box' },
      h('h1', null, 'VTube Linux konnte nicht starten'),
      h('p', null, message),
      detail ? h('pre', null, errorText(detail)) : null)));
}

// ---------------------------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  if (!window.vtube) {
    fatal('Die Verbindung zum Hauptprozess (window.vtube) fehlt. Bitte die App über Electron starten.');
    return;
  }

  let initial: Settings;
  try {
    initial = mergeSettings(DEFAULT_SETTINGS, await window.vtube.getSettings());
  } catch (err) {
    initial = DEFAULT_SETTINGS;
    toast(`Einstellungen konnten nicht geladen werden – Standardwerte aktiv. (${errorText(err)})`, 'error');
  }

  const appEl = document.getElementById('app')!;
  const viewportEl = document.getElementById('viewport')!;
  const panelEl = document.getElementById('panel')!;
  const canvas = document.getElementById('avatar-canvas') as HTMLCanvasElement;

  const store = new SettingsStore(initial);
  store.onPersistError = (err) => toast(`Einstellungen konnten nicht gespeichert werden: ${errorText(err)}`, 'error');

  let renderer: AvatarRenderer;
  let tracker: FaceTracker;
  let lipSync: LipSync;
  let solver: PoseSolver;
  try {
    renderer = new AvatarRenderer(canvas, { transparentCapable: true });
  } catch (err) {
    fatal(`Die 3D-Ansicht konnte nicht initialisiert werden (WebGL nicht verfügbar?): ${errorText(err)}`, err);
    return;
  }
  try {
    tracker = new FaceTracker({ assetBase: './mediapipe' });
    lipSync = new LipSync();
    solver = new PoseSolver(initial.tracking, initial.lipSync);
  } catch (err) {
    fatal(`Initialisierung fehlgeschlagen: ${errorText(err)}`, err);
    return;
  }

  // --- Live state + tiny event bus -----------------------------------------------------------
  const live: LiveState = {
    model: null,
    modelLoading: false,
    lastPose: null,
    lastViseme: null,
    lastFace: null,
    lastFaceAt: -Infinity,
    tracker: { state: 'off', error: null },
    lipSync: { state: 'off', error: null },
    vcam: { running: false, device: initial.output.virtualCam.device, busy: false },
    server: null,
    calibrationCountdown: null,
    panelOpen: initial.ui.panelOpen,
  };
  const handlers = new Map<AppEvent, Set<() => void>>();
  const on = (ev: AppEvent, fn: () => void) => {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    handlers.get(ev)!.add(fn);
  };
  const emit = (ev: AppEvent) => {
    for (const fn of handlers.get(ev) ?? []) {
      try {
        fn();
      } catch (err) {
        console.error(`[app] handler for "${ev}" failed`, err);
      }
    }
  };

  // --- Model loading (serialized) -------------------------------------------------------------
  let modelChain: Promise<unknown> = Promise.resolve();
  const enqueueModel = (job: () => Promise<void>): Promise<void> => {
    const p = modelChain.then(job, job);
    modelChain = p.catch(() => undefined);
    return p;
  };

  async function showModel(data: ArrayBuffer, fileName: string, path: string | null): Promise<void> {
    live.modelLoading = true;
    emit('model');
    try {
      const info = await renderer.loadVRM(data);
      solver.setModel(info);
      live.model = { info, fileName, path };
      toast(`Modell geladen: ${info.name || fileName}`, 'success', 2500);
    } finally {
      live.modelLoading = false;
      emit('model');
    }
  }

  /** Main maintains model.lastPath/recent on load – take them over locally. */
  async function syncModelSettings(): Promise<void> {
    try {
      await store.flush();
      const s = await window.vtube.getSettings();
      store.adopt({ model: s.model });
    } catch (err) {
      console.warn('[app] could not refresh model settings', err);
    }
  }

  const modelError = (err: unknown) => toast(`Modell konnte nicht geladen werden: ${errorText(err)}`, 'error');

  const openModelDialog = () => enqueueModel(async () => {
    try {
      const mf = await window.vtube.openModelDialog();
      if (!mf) return;
      await showModel(mf.data, mf.name, mf.path);
      await syncModelSettings();
    } catch (err) {
      modelError(err);
    }
  });

  const loadModelPath = (path: string) => enqueueModel(async () => {
    try {
      const mf = await window.vtube.loadModel(path);
      await showModel(mf.data, mf.name, mf.path || path);
      await syncModelSettings();
    } catch (err) {
      modelError(err);
    }
  });

  const loadDroppedFile = async (file: File): Promise<void> => {
    let path = '';
    try {
      path = window.vtube.getPathForFile(file);
    } catch {
      path = '';
    }
    if (path) return loadModelPath(path);
    // Fallback (should not happen in Electron): read in the renderer. OBS output won't get it.
    return enqueueModel(async () => {
      try {
        await showModel(await file.arrayBuffer(), file.name, null);
      } catch (err) {
        modelError(err);
      }
    });
  };

  // --- Tracking (serialized restarts) -----------------------------------------------------------
  const setTracker = (state: RunState, error: string | null) => {
    live.tracker = { state, error };
    emit('tracker');
  };
  let trackerChain: Promise<void> = Promise.resolve();
  let trackerTimer: ReturnType<typeof setTimeout> | null = null;
  let trackerGen = 0;          // newest requested restart
  let trackerBusy = false;     // a restart is currently running
  async function runTrackerRestart(gen: number): Promise<void> {
    if (gen !== trackerGen) return; // superseded by a newer request – only the latest one runs
    trackerBusy = true;
    try {
      await doTrackerRestart();
    } finally {
      trackerBusy = false;
    }
  }
  async function doTrackerRestart(): Promise<void> {
    const s = store.value; // read at run time → always the latest settings
    try {
      tracker.stop();
    } catch (err) {
      console.warn('[app] tracker.stop failed', err);
    }
    live.lastFace = null;
    if (!s.tracking.enabled) {
      setTracker('off', null);
      return;
    }
    setTracker('starting', null);
    try {
      await tracker.start(s.camera, s.tracking.useGpu);
      setTracker('running', null);
      if (tracker.cameraFallback) toast('Gespeicherte Kamera nicht gefunden – Standardkamera wird verwendet', 'warning');
    } catch (err) {
      if (isTrackerAbort(err)) return; // cancelled by a newer restart / shutdown – not an error
      const msg = cameraErrorText(err);
      setTracker('error', msg);
      // No URL entered yet (just switched to "Browserquelle"): the panel shows it, no toast needed.
      if (!(isUrlSourceError(err) && err.code === 'no-url')) toast(msg, 'error');
    }
  }
  function restartTracker(delayMs = 0): void {
    if (trackerTimer) clearTimeout(trackerTimer);
    trackerTimer = setTimeout(() => {
      trackerTimer = null;
      const gen = ++trackerGen;
      // A start still in progress is obsolete now: cancel it (its start() rejects with an abort
      // error) so the latest settings apply right away instead of after it finished.
      if (trackerBusy) tracker.stop();
      const run = () => runTrackerRestart(gen);
      trackerChain = trackerChain.then(run, run);
    }, delayMs);
  }

  // Camera plugged in / out: retry automatically when tracking should run but does not (error state,
  // e.g. no camera at start), or when the saved camera reappears while the default one is used.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    const s = store.value;
    if (!s.tracking.enabled || s.camera.source === 'url') return;
    const st = live.tracker.state;
    if (st === 'error' || st === 'off' || (st === 'running' && !tracker.running)) {
      restartTracker(500);
    } else if (st === 'running' && tracker.cameraFallback && s.camera.deviceId) {
      const id = s.camera.deviceId;
      void FaceTracker.listCameras().then((cams) => {
        if (cams.some((c) => c.deviceId === id) && store.value.camera.deviceId === id && tracker.cameraFallback) restartTracker(500);
      }).catch(() => undefined);
    }
  });

  tracker.onError = (err) => {
    if (live.tracker.state !== 'running') return;
    const msg = isUrlSourceError(err) ? err.message : /disconnect/i.test(err.message)
      ? 'Die Kameraverbindung wurde unterbrochen. Sobald die Kamera wieder da ist, startet das Tracking neu – oder „Erneut versuchen“ klicken.'
      : `Tracking-Fehler: ${err.message}`;
    setTracker('error', msg);
    toast(msg, 'error');
  };
  tracker.onFrame = (f) => {
    live.lastFace = f;
    live.lastFaceAt = performance.now();
    solver.pushFace(f);
  };

  // --- Lip sync (serialized restarts) -----------------------------------------------------------
  const setLip = (state: RunState, error: string | null) => {
    live.lipSync = { state, error };
    emit('lipsync');
  };
  let lipChain: Promise<void> = Promise.resolve();
  async function runLipRestart(): Promise<void> {
    const s = store.value.lipSync;
    try {
      lipSync.stop();
    } catch (err) {
      console.warn('[app] lipSync.stop failed', err);
    }
    live.lastViseme = null;
    if (!s.enabled) {
      setLip('off', null);
      return;
    }
    setLip('starting', null);
    try {
      await lipSync.start(s);
      setLip('running', null);
    } catch (err) {
      const msg = micErrorText(err);
      setLip('error', msg);
      toast(msg, 'error');
    }
  }
  const restartLipSync = () => {
    lipChain = lipChain.then(runLipRestart, runLipRestart);
  };

  // --- Calibration --------------------------------------------------------------------------------
  function calibrate(): void {
    if (live.calibrationCountdown !== null) return;
    if (live.tracker.state !== 'running') {
      toast('Das Tracking ist nicht aktiv – bitte zuerst die Kamera einschalten.', 'warning');
      return;
    }
    live.calibrationCountdown = 3;
    emit('calibration');
    const step = async () => {
      const n = live.calibrationCountdown ?? 0;
      if (n > 1) {
        live.calibrationCountdown = n - 1;
        emit('calibration');
        setTimeout(step, 1000);
        return;
      }
      live.calibrationCountdown = null;
      emit('calibration');
      const cal = solver.captureCalibration();
      if (!cal) {
        toast('Kein Gesicht erkannt – Kalibrierung fehlgeschlagen. Bitte gerade in die Kamera schauen.', 'error');
        return;
      }
      // Clear first so main replaces (instead of deep-merging) the old calibration.
      store.update({ tracking: { calibration: null } }, 0);
      await store.flush();
      store.update({ tracking: { calibration: cal } }, 0);
      toast('Kalibrierung gespeichert.', 'success');
    };
    setTimeout(step, 1000);
  }

  function resetCalibration(): void {
    store.update({ tracking: { calibration: null } }, 0);
    toast('Kalibrierung zurückgesetzt.', 'info', 2000);
  }

  // --- OBS server + virtual camera ------------------------------------------------------------
  async function refreshServerInfo(): Promise<void> {
    try {
      live.server = await window.vtube.getServerInfo();
    } catch (err) {
      live.server = { running: false, port: store.value.output.browserSource.port, url: '', error: errorText(err) };
    }
    emit('server');
  }

  const setVcam = (st: VcamStatus) => {
    live.vcam = { ...st, busy: live.vcam.busy };
    emit('vcam');
  };
  const setVcamBusy = (busy: boolean) => {
    live.vcam = { ...live.vcam, busy };
    emit('vcam');
  };

  async function vcamStart(): Promise<void> {
    if (live.vcam.busy) return;
    setVcamBusy(true);
    try {
      await store.flush(); // main must see the current device/size/fps
      // Main persists output.virtualCam.enabled itself (true only on success → auto-start next launch).
      const st = await window.vtube.vcamStart();
      setVcam(st);
      if (st.running) {
        toast(`Virtuelle Kamera gestartet (${st.device}).`, 'success', 2500);
      } else {
        toast(st.error || 'Die virtuelle Kamera konnte nicht gestartet werden.', 'error');
      }
    } catch (err) {
      setVcam({ running: false, device: live.vcam.device, deviceSource: live.vcam.deviceSource, error: errorText(err) });
      toast(`Virtuelle Kamera: ${errorText(err)}`, 'error');
    } finally {
      setVcamBusy(false);
    }
  }

  async function vcamStop(): Promise<void> {
    if (live.vcam.busy) return;
    setVcamBusy(true);
    try {
      setVcam(await window.vtube.vcamStop());
    } catch (err) {
      toast(`Virtuelle Kamera: ${errorText(err)}`, 'error');
    } finally {
      setVcamBusy(false);
    }
  }

  async function pollVcam(): Promise<void> {
    if (live.vcam.busy) return;
    try {
      const st = await window.vtube.vcamStatus();
      if (live.vcam.busy) return;
      const restarting = performance.now() - lastVcamCfgChange < 4000; // main restarts it on config change
      if (live.vcam.running && !st.running && !restarting) {
        toast(st.error ? `Virtuelle Kamera beendet: ${st.error}` : 'Die virtuelle Kamera wurde beendet.', 'error');
      }
      if (st.running !== live.vcam.running || st.error !== live.vcam.error || st.device !== live.vcam.device ||
        st.deviceSource !== live.vcam.deviceSource) setVcam(st);
    } catch {
      /* ignore transient IPC errors */
    }
  }

  let lastVcamCfgChange = -Infinity;
  let vcamPollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Main restarts a running virtual camera itself when device/size/fps change – re-read status. */
  function scheduleVcamPoll(delayMs = 1500): void {
    lastVcamCfgChange = performance.now();
    if (vcamPollTimer) clearTimeout(vcamPollTimer);
    vcamPollTimer = setTimeout(() => {
      vcamPollTimer = null;
      void pollVcam();
    }, delayMs);
  }

  // --- Panel ------------------------------------------------------------------------------------
  function togglePanel(open?: boolean): void {
    const next = open ?? !live.panelOpen;
    if (next === live.panelOpen) return;
    live.panelOpen = next;
    appEl.classList.toggle('panel-closed', !next);
    if (!next && panelEl.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    store.update({ ui: { panelOpen: next } }, 0);
    emit('panel');
    if (next) void refreshServerInfo();
  }

  // --- Context + UI ---------------------------------------------------------------------------
  const actions: AppActions = {
    openModelDialog, loadModelPath, loadDroppedFile, calibrate, resetCalibration,
    restartTracker: () => restartTracker(0), restartLipSync, vcamStart, vcamStop,
    refreshServerInfo, togglePanel,
  };
  const ui = new Controls(store);
  const ctx: AppContext = { store, ui, renderer, tracker, lipSync, solver, live, actions, on, emit };

  appEl.classList.toggle('panel-closed', !live.panelOpen);
  const viewport = setupViewport(ctx, viewportEl, appEl);
  const panel = buildPanel(ctx, panelEl);
  // Let the renderer pick up size changes when the panel slides in/out.
  panelEl.addEventListener('transitionend', (e) => {
    if (e.target === panelEl) window.dispatchEvent(new Event('resize'));
  });
  requestAnimationFrame(() => appEl.classList.remove('booting'));

  // --- React to settings changes ---------------------------------------------------------------
  store.subscribe((s, patch: SettingsPatch) => {
    if (patch.view) renderer.setView(s.view);
    if (patch.tracking || patch.lipSync) solver.updateSettings(s.tracking, s.lipSync);

    const cam = patch.camera;
    const trk = patch.tracking;
    if ((cam && ('deviceId' in cam || 'source' in cam || 'url' in cam || 'width' in cam || 'height' in cam || 'fps' in cam)) ||
        (trk && ('enabled' in trk || 'useGpu' in trk))) {
      restartTracker(250);
    }

    const lip = patch.lipSync;
    if (lip) {
      if ('enabled' in lip || 'deviceId' in lip) restartLipSync();
      else if (live.lipSync.state === 'running') lipSync.update(s.lipSync);
    }

    const out = patch.output;
    if (out?.browserSource) setTimeout(() => void refreshServerInfo(), 700);
    const vc = out?.virtualCam;
    if (vc && ('device' in vc || 'width' in vc || 'height' in vc || 'fps' in vc)) scheduleVcamPoll();
  });

  // --- Main loop (driven by the renderer's own rAF) -------------------------------------------
  const posePacer = new Pacer();
  const vcamPacer = new Pacer();
  renderer.onFrame = () => {
    const now = performance.now();
    const viseme = lipSync.read();
    live.lastViseme = viseme;
    const pose = solver.solve(viseme, now);
    live.lastPose = pose;
    renderer.applyPose(pose);

    const s = store.value;
    if (s.output.browserSource.enabled && posePacer.ready(now, 60)) window.vtube.sendPose(pose);

    if (live.vcam.running && !live.vcam.busy) {
      const vc = s.output.virtualCam;
      if (vcamPacer.ready(now, vc.fps)) {
        const px = renderer.readPixels(vc.width, vc.height);
        if (px) {
          const buf = px.byteOffset === 0 && px.byteLength === px.buffer.byteLength
            ? (px.buffer as ArrayBuffer)
            : (px.slice().buffer as ArrayBuffer);
          window.vtube.vcamFrame(buf);
        }
      }
    }
  };

  renderer.setView(initial.view);
  renderer.start();

  // UI refresh (~10 Hz), independent of the render loop.
  setInterval(() => {
    const now = performance.now();
    viewport.tick(now);
    if (live.panelOpen) panel.tick(now);
    if (live.tracker.state === 'running' && !tracker.running) {
      setTracker('error', 'Die Kameraverbindung wurde unterbrochen. Sobald die Kamera wieder da ist, startet das Tracking neu – oder „Erneut versuchen“ klicken.');
      toast('Kameraverbindung unterbrochen.', 'error');
    }
  }, 100);

  // Server/vcam status polling.
  setInterval(() => {
    if (live.panelOpen) void refreshServerInfo();
    void pollVcam(); // also catches main's auto-start at launch and ffmpeg exits
  }, 2000);

  // --- Keyboard shortcuts ---------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const typing = isTypingTarget(e.target);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F1') {
      e.preventDefault();
      togglePanel();
    } else if (e.key === 'Tab' && !mod && !e.altKey &&
        (document.activeElement === document.body || document.activeElement === canvas || !document.activeElement)) {
      // Only when nothing is focused – otherwise Tab is normal keyboard navigation through the panel.
      e.preventDefault();
      togglePanel();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void openModelDialog();
    } else if (e.key === 'F11') {
      e.preventDefault();
      const req = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      req.catch(() => toast('Vollbild ist nicht verfügbar.', 'warning'));
    } else if (!typing && !mod && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      calibrate();
    }
  });

  window.addEventListener('beforeunload', () => {
    void store.flush();
    try {
      tracker.stop();
      lipSync.stop();
    } catch {
      /* closing anyway */
    }
  });

  // --- Startup tasks ----------------------------------------------------------------------------
  void refreshServerInfo();
  if (initial.model.lastPath) {
    const last = initial.model.lastPath;
    void enqueueModel(async () => {
      try {
        const mf = await window.vtube.loadModel(last);
        await showModel(mf.data, mf.name, mf.path || last);
        await syncModelSettings();
      } catch (err) {
        toast(`Zuletzt verwendetes Modell konnte nicht geladen werden: ${errorText(err)}`, 'warning');
      }
    });
  }
  if (initial.tracking.enabled) restartTracker(0);
  if (initial.lipSync.enabled) restartLipSync();
  // Main auto-starts the virtual camera at launch if it was running last time; just pick up its status.
  void pollVcam();
}

void bootstrap().catch((err) => fatal('Unerwarteter Fehler beim Start.', err));
