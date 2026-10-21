// "Browserquelle": tracking input from a URL. The page (web page, MJPEG stream of a phone webcam app,
// video file, VDO.Ninja view link …) is rendered in an invisible OFFSCREEN BrowserWindow; every painted
// frame is handed to the app window as raw BGRA pixels, where FaceTracker turns it into a video track.
//
// Security: the page is untrusted web content → own in-memory session, sandbox, context isolation, no
// preload, no node, no permissions, no popups, no downloads, muted; only http(s). Invalid/self-signed
// HTTPS certificates are NOT accepted (Electron rejects them unless 'certificate-error' is handled).
import { BrowserWindow, session, type NativeImage, type Session, type WebContents } from 'electron';
import type { UrlSourceFrame, UrlSourceRequest, UrlSourceState, UrlSourceStatus } from '../shared/api';

export interface UrlSourceSink {
  frame(f: UrlSourceFrame): void;
  status(s: UrlSourceStatus): void;
}

const PARTITION = 'vtube-urlsource';   // no "persist:" prefix → in memory, nothing written to disk
const MAX_URL_LENGTH = 4096;
const MAX_IN_FLIGHT = 2;               // unacknowledged frames before new paints are dropped
const ACK_TIMEOUT_MS = 1000;           // renderer reloaded / lost acks → reset flow control
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 15000;
const KEEPALIVE_MS = 1000;             // HTML page painted nothing this long → force a repaint (still picture)
const MEDIA_STALL_MS = 6000;           // stream/video document painted nothing this long → reload

/** Checks and normalizes a user-entered URL. Throws an Error with a German message. */
export function validateSourceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Bitte eine Adresse (URL) für die Browserquelle eingeben.');
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) throw new Error('Die Adresse ist zu lang.');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`Ungültige Adresse: ${text}`);
  }
  if (u.protocol === 'rtsp:' || u.protocol === 'rtmp:' || u.protocol === 'rtp:' || u.protocol === 'srt:') {
    throw new Error(`${u.protocol.slice(0, -1).toUpperCase()}-Streams kann die Browserquelle nicht abspielen. ` +
      'In der Handy-App die HTTP-Adresse verwenden (z. B. IP Webcam: http://IP:8080/video, DroidCam: http://IP:4747/video).');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http:// und https:// Adressen sind erlaubt.');
  if (!u.hostname) throw new Error(`Ungültige Adresse: ${text}`);
  return u.toString();
}

/** German text for a Chromium net error of the main frame. */
function loadErrorText(code: number, desc: string): string {
  if (code <= -200 && code > -300) {
    return 'Das HTTPS-Zertifikat ist ungültig oder selbst signiert und wird nicht akzeptiert. ' +
      'Bei Handy-Apps im WLAN stattdessen die http://-Adresse verwenden.';
  }
  switch (code) {
    case -105: return 'Adresse nicht gefunden (Name nicht auflösbar). Tippfehler in der Adresse?';
    case -102: return 'Verbindung abgelehnt – läuft die App/der Server und stimmt der Port?';
    case -7:
    case -118:
    case -109:
      return 'Keine Antwort – sind Handy und PC im selben (W)LAN und stimmt die IP-Adresse?';
    case -106: return 'Keine Netzwerkverbindung.';
    case -100:
    case -101:
    case -324:
      return 'Die Verbindung wurde vom Server getrennt.';
    case -312: return 'Dieser Port ist im Browser aus Sicherheitsgründen gesperrt – bitte in der App einen anderen Port einstellen.';
    case -300: return 'Ungültige Adresse.';
    case -301: return 'Diese Adresse/dieses Protokoll wird nicht unterstützt.';
    default: return `Laden fehlgeschlagen: ${desc || 'Fehler'} (${code}).`;
  }
}

/** Chromium's own document for a top-level image/video/MJPEG resource (not an HTML page). */
function isMediaType(contentType: unknown): boolean {
  return typeof contentType === 'string' && /^(image|video|audio)\/|^multipart\//i.test(contentType);
}

// Fill the viewport with the stream (bigger face for the tracker) instead of Chromium's centered,
// shrink-to-fit media document. Only injected into such media documents.
const MEDIA_CSS = `html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important;
  background: #000 !important; overflow: hidden !important; }
body > img, body > video { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; margin: 0 !important; object-fit: contain !important;
  cursor: default !important; background: #000 !important; }`;
const MEDIA_JS = `(() => { const v = document.querySelector('video');
  if (v) { v.muted = true; v.loop = true; v.controls = false; v.play().catch(() => {}); } })()`;

export class UrlSource {
  private win: BrowserWindow | null = null;
  private req: UrlSourceRequest | null = null;
  private state: UrlSourceState = 'loading';
  private inFlight = 0;
  private lastSendAt = 0;
  private lastPaintAt = 0;
  private loadFailed = false;      // current load ended in an error page → its paints are not frames
  private isMedia = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private ses: Session | null = null;

  constructor(private readonly sink: UrlSourceSink) {}

  get running(): boolean { return this.win !== null; }
  get currentId(): number | null { return this.req?.id ?? null; }

  /** Replaces any running source. Throws (German message) for an invalid URL. */
  start(raw: UrlSourceRequest): void {
    const url = validateSourceUrl(raw?.url);
    const num = (v: unknown, min: number, max: number, def: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    const req: UrlSourceRequest = {
      id: Number.isFinite(Number(raw.id)) ? Number(raw.id) : 0,
      url,
      width: num(raw.width, 160, 3840, 640),
      height: num(raw.height, 120, 2160, 480),
      fps: num(raw.fps, 1, 60, 30),
    };
    this.stop();
    this.req = req;
    this.retryMs = RETRY_MIN_MS;

    const win = new BrowserWindow({
      show: false,
      width: req.width,
      height: req.height,
      useContentSize: true,
      frame: false,
      resizable: false,
      backgroundColor: '#000000',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        session: this.session(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        disableDialogs: true,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    this.win = win;
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setFrameRate(req.fps);
    this.wire(wc, req);
    this.load(req);
    this.watchTimer = setInterval(() => this.watch(req), 500);
  }

  /** Stops the source if `id` is the current one (or no id given) and destroys the offscreen page. */
  stop(id?: number): void {
    if (id !== undefined && id !== null && this.req && this.req.id !== id) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.retryTimer = null;
    this.watchTimer = null;
    const w = this.win;
    this.win = null;
    this.req = null;
    this.inFlight = 0;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** The app window processed a frame. */
  ack(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  // ---------------------------------------------------------------------------------------------

  private session(): Session {
    if (this.ses) return this.ses;
    const ses = session.fromPartition(PARTITION);
    // Nothing the page may ask for is granted (camera, mic, notifications, geolocation, …). A
    // VDO.Ninja *view* link only receives, so it needs none of them.
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // Look like a normal Chrome (some sites refuse or degrade "Electron" user agents).
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|vtube-studio-linux|VTube Linux)\/\S+/gi, ''));
    // A URL that is a file download (e.g. .mkv served as attachment) must not end up on disk.
    ses.on('will-download', (e, _item, wc) => {
      e.preventDefault();
      if (this.win && !this.win.isDestroyed() && wc === this.win.webContents && this.req) {
        this.fail(this.req, 'Die Adresse startet einen Download statt eine Seite oder einen Stream anzuzeigen. ' +
          'Dieses Format kann nicht direkt abgespielt werden.', true);
      }
    });
    this.ses = ses;
    return ses;
  }

  private current(req: UrlSourceRequest): boolean {
    return this.req === req && this.win !== null && !this.win.isDestroyed();
  }

  private wire(wc: WebContents, req: UrlSourceRequest): void {
    // No popups/new windows, no navigation away from http(s).
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault();
    });
    wc.on('will-redirect', (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault();
    });
    wc.on('did-start-navigation', (d) => {
      if (!this.current(req) || !d.isMainFrame || d.isSameDocument) return;
      this.loadFailed = false;
      this.isMedia = false;
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!this.current(req) || !isMainFrame || code === -3 /* ABORTED (superseded navigation) */) return;
      console.warn(`[urlsource] load failed ${code} ${desc} ${url}`);
      this.fail(req, loadErrorText(code, desc));
    });
    wc.on('did-navigate', (_e, _url, httpCode) => {
      if (!this.current(req)) return;
      if (httpCode >= 400) {
        this.fail(req, `Der Server antwortet mit Fehler HTTP ${httpCode}${httpCode === 404 ? ' (Seite nicht gefunden – stimmt der Pfad, z. B. /video?)' : ''}.`);
        return;
      }
      void this.prepareDocument(wc, req);
    });
    wc.on('dom-ready', () => { if (this.current(req)) void this.prepareDocument(wc, req); });
    wc.on('render-process-gone', (_e, d) => {
      if (!this.current(req) || d.reason === 'clean-exit') return;
      this.fail(req, `Die Seite ist abgestürzt (${d.reason}).`);
    });
    wc.on('unresponsive', () => { if (this.current(req)) this.fail(req, 'Die Seite reagiert nicht mehr.'); });
    wc.on('paint', (_e, _dirty, image) => this.onPaint(req, image));
  }

  private load(req: UrlSourceRequest): void {
    if (!this.current(req)) return;
    this.loadFailed = false;
    this.lastPaintAt = 0;
    this.setState(req, this.state === 'connected' || this.state === 'reconnecting' ? 'reconnecting' : 'loading',
      this.state === 'connected' ? 'Verbindung wird wiederhergestellt…' : undefined);
    // loadURL rejects on failures; did-fail-load reports them (with the net error code).
    this.win!.webContents.loadURL(req.url).catch(() => undefined);
  }

  /** Media documents (stream, image, video file): fill the viewport, loop videos. */
  private async prepareDocument(wc: WebContents, req: UrlSourceRequest): Promise<void> {
    try {
      const type = await wc.executeJavaScript('document.contentType', false);
      if (!this.current(req) || !isMediaType(type)) return;
      if (!this.isMedia) {
        this.isMedia = true;
        await wc.insertCSS(MEDIA_CSS, { cssOrigin: 'user' });
      }
      await wc.executeJavaScript(MEDIA_JS, false);
    } catch {
      /* navigated away / destroyed meanwhile */
    }
  }

  private onPaint(req: UrlSourceRequest, image: NativeImage): void {
    if (!this.current(req) || this.loadFailed) return; // error pages are not frames
    const now = Date.now();
    this.lastPaintAt = now;
    if (this.state !== 'connected') {
      this.retryMs = RETRY_MIN_MS;
      this.setState(req, 'connected');
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      if (now - this.lastSendAt < ACK_TIMEOUT_MS) return; // app window is behind → drop this frame
      this.inFlight = 0;
    }
    if (image.isEmpty()) return;
    // The bitmap may be larger than the DIP size on HiDPI screens → derive the real pixel size.
    const size = image.getSize();
    const data = image.toBitmap();
    let { width, height } = size;
    if (data.length !== width * height * 4) {
      const s = Math.sqrt(data.length / (4 * width * height));
      width = Math.round(width * s);
      height = Math.round(height * s);
      if (data.length !== width * height * 4) return;
    }
    this.inFlight++;
    this.lastSendAt = now;
    this.sink.frame({ id: req.id, width, height, data });
  }

  private watch(req: UrlSourceRequest): void {
    if (!this.current(req) || this.state !== 'connected' || this.loadFailed) return;
    const idle = Date.now() - this.lastPaintAt;
    if (this.isMedia) {
      // A stream that stopped (phone app closed, Wi-Fi hiccup) or a video that ended → reconnect.
      if (idle > MEDIA_STALL_MS) {
        console.warn('[urlsource] stream stalled, reloading');
        this.load(req);
      }
    } else if (idle > KEEPALIVE_MS) {
      // HTML pages only paint on changes; a still page is still a valid (unchanged) picture.
      this.win!.webContents.invalidate();
    }
  }

  private fail(req: UrlSourceRequest, message: string, fatal = false): void {
    if (!this.current(req)) return;
    this.loadFailed = true;
    this.state = 'error';
    this.sink.status({ id: req.id, state: 'error', url: req.url, message, fatal });
    if (fatal) {
      this.stop(req.id);
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.load(req);
    }, delay);
  }

  private setState(req: UrlSourceRequest, state: UrlSourceState, message?: string): void {
    this.state = state;
    this.sink.status({ id: req.id, state, url: req.url, message });
  }
}
