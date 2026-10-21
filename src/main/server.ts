// Local HTTP + WebSocket server for the OBS browser source.
//   GET /, /output.html   -> <rootDir>/output.html
//   GET /model.vrm        -> current model bytes
//   GET /status           -> JSON diagnostics (clients, model, rev)
//   GET /<file>           -> static files from rootDir (vite build output)
//   WS  /ws               -> OutputMessage stream (view, model, pose)
// Deliberately free of electron imports so it can be tested with plain node.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerInfo } from '../shared/api';
import type { ViewSettings } from '../shared/settings';
import type { AvatarPose, OutputMessage } from '../shared/types';

const HOST = '127.0.0.1';
/** Also listen on IPv6 loopback: Firefox/Chromium resolve `localhost` to ::1 first on Fedora. */
const HOST6 = '::1';
const POSE_INTERVAL_MS = 1000 / 60;   // max pose broadcast rate
const MAX_CLIENT_BUFFER = 1 << 20;    // skip pose frames for clients that lag behind (bytes)

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
};

export interface OutputServerOptions {
  /** Directory with the built renderer (contains output.html and assets/). May be inside an asar. */
  rootDir: string;
}

export class OutputServer {
  private server: http.Server | null = null;
  private server6: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private error: string | undefined;

  private model: Buffer | null = null;
  private modelKey: string | null = null;
  private modelRev = 0;
  private modelName: string | null = null;
  private rejected = { host: 0, origin: 0 };
  private lastRejectLog = new Map<string, number>();
  private view: ViewSettings | null = null;

  private pendingPose: AvatarPose | null = null;
  private lastPoseAt = 0;
  private poseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OutputServerOptions) {}

  get info(): ServerInfo {
    const info: ServerInfo = {
      running: this.server !== null,
      port: this.port,
      url: `http://${HOST}:${this.port}/`,
      clients: this.clientCount,
    };
    if (this.error) info.error = this.error;
    return info;
  }

  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  /** (Re)start listening on `port`. Never throws; failures are reported in the returned info. */
  async start(port: number): Promise<ServerInfo> {
    await this.stop();
    this.port = port;
    this.error = undefined;

    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    wss.on('connection', (ws, req) => this.onConnection(ws, req));
    const makeServer = (): http.Server => {
      const srv = http.createServer((req, res) => {
        this.handleHttp(req, res).catch((e) => {
          console.error('[server] request failed:', e);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      srv.on('upgrade', (req, socket, head) => this.handleUpgrade(wss, req, socket, head));
      return srv;
    };
    const server = makeServer();

    try {
      await listen(server, port, HOST);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.error = err.code === 'EADDRINUSE'
        ? `Port ${port} ist bereits belegt. Bitte einen anderen Port wählen.`
        : err.code === 'EACCES'
          ? `Keine Berechtigung für Port ${port}.`
          : `Server-Start fehlgeschlagen: ${err.message}`;
      wss.close();
      server.close();
      return this.info;
    }
    server.on('error', (e) => console.error('[server] error:', e));
    this.server = server;
    this.wss = wss;

    // IPv6 loopback is best effort (may be disabled on the system).
    const server6 = makeServer();
    try {
      await listen(server6, port, HOST6);
      server6.on('error', (e) => console.error('[server] error (IPv6):', e));
      this.server6 = server6;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      server6.close();
      if (code === 'EADDRINUSE') {
        console.warn(`[server] [::1]:${port} is used by another program – use http://${HOST}:${port}/ (not "localhost").`);
      } else {
        console.log(`[server] IPv6 loopback not available (${code ?? String(e)}); listening on ${HOST} only.`);
      }
    }
    return this.info;
  }

  async stop(): Promise<void> {
    if (this.poseTimer) clearTimeout(this.poseTimer);
    this.poseTimer = null;
    this.pendingPose = null;
    const { server, server6, wss } = this;
    this.server = null;
    this.server6 = null;
    this.wss = null;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      wss.close();
    }
    await Promise.all([server, server6].map((srv) => srv && new Promise<void>((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections(); // drop keep-alive sockets so close() completes promptly
    })));
  }

  /** Set the current model. `key` identifies the file version; same key => no reload for clients.
   *  `name` (e.g. file name) is only used for diagnostics (/status, logs). */
  setModel(data: Buffer | null, key: string | null = null, name: string | null = null): void {
    if (key !== null && key === this.modelKey && data !== null) return;
    this.model = data;
    this.modelKey = data ? key : null;
    this.modelName = data ? name : null;
    this.modelRev++;
    console.log(data
      ? `[server] model for OBS: ${name ?? '(unnamed)'} (${(data.length / 1048576).toFixed(1)} MB, rev ${this.modelRev}, clients: ${this.clientCount})`
      : '[server] model for OBS: none');
    this.broadcast(this.modelMessage());
  }

  setView(view: ViewSettings): void {
    this.view = view;
    this.broadcast({ type: 'view', view });
  }

  /** Called for every solved frame; throttled to POSE_INTERVAL_MS, latest pose wins. */
  pushPose(pose: AvatarPose): void {
    if (!this.wss || this.wss.clients.size === 0) return;
    this.pendingPose = pose;
    if (this.poseTimer) return;
    const wait = POSE_INTERVAL_MS - (performance.now() - this.lastPoseAt);
    if (wait <= 0) this.flushPose();
    else this.poseTimer = setTimeout(this.flushPose, wait);
  }

  private flushPose = (): void => {
    this.poseTimer = null;
    const pose = this.pendingPose;
    if (!pose) return;
    this.pendingPose = null;
    this.lastPoseAt = performance.now();
    this.broadcast({ type: 'pose', pose }, true);
  };

  private modelMessage(): OutputMessage {
    return { type: 'model', url: this.model ? `/model.vrm?rev=${this.modelRev}` : null, rev: this.modelRev };
  }

  private broadcast(msg: OutputMessage, droppable = false): void {
    if (!this.wss || this.wss.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const c of this.wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.bufferedAmount > MAX_CLIENT_BUFFER) continue;
      c.send(data);
    }
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const who = describeClient(req);
    console.log(`[server] output page connected: ${who} (clients: ${this.clientCount})`);
    ws.on('close', (code) => {
      console.log(`[server] output page disconnected: ${who} (code ${code}, clients: ${this.clientCount})`);
    });
    ws.on('error', (e) => {
      console.warn(`[server] WebSocket error (${who}):`, e.message);
      ws.terminate();
    });
    ws.on('message', () => { /* clients don't send anything we need */ });
    if (this.view) ws.send(JSON.stringify({ type: 'view', view: this.view } satisfies OutputMessage));
    ws.send(JSON.stringify(this.modelMessage()));
  }

  /**
   * Host header check against DNS rebinding: only loopback names (127.0.0.1, localhost, [::1],
   * this machine's hostname) with our port. The server only listens on loopback anyway.
   */
  private allowedHost(host: string | undefined): boolean {
    if (host === undefined) return true;
    const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d+))?$/i.exec(host.trim().toLowerCase());
    if (!m) return false;
    const port = m[2] ? Number(m[2]) : 80;
    return port === this.port && isLocalName(m[1].replace(/\.$/, ''));
  }

  /**
   * Origin check for the WebSocket (browsers don't apply the same-origin policy to WebSockets):
   * the output page is always served by this server, so a legitimate Origin is http://<allowed host>.
   * No Origin (non-browser clients) is fine; "null" or any other web site is rejected – a foreign
   * page could otherwise read the face-tracking stream.
   */
  private allowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    return u.protocol === 'http:' && this.allowedHost(u.host);
  }

  /** Logs a rejected request (rate limited per reason, so a misbehaving page can't flood the log). */
  private logReject(kind: 'host' | 'origin', value: string | undefined, req: http.IncomingMessage): void {
    this.rejected[kind]++;
    const key = `${kind}:${value}`;
    const now = Date.now();
    if (now - (this.lastRejectLog.get(key) ?? 0) < 10_000) return;
    this.lastRejectLog.set(key, now);
    if (this.lastRejectLog.size > 100) this.lastRejectLog.clear();
    console.warn(`[server] rejected ${req.method} ${req.url ?? ''}: bad ${kind} ${JSON.stringify(value ?? null)} ` +
      `(allowed: 127.0.0.1 / localhost / [::1] port ${this.port}) from ${describeClient(req)}`);
  }

  private handleUpgrade(wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '').split('?')[0];
    let reason = '';
    if (pathname !== '/ws') reason = 'path';
    else if (!this.allowedHost(req.headers.host)) { reason = 'host'; this.logReject('host', req.headers.host, req); }
    else if (!this.allowedOrigin(req.headers.origin)) { reason = 'origin'; this.logReject('origin', req.headers.origin, req); }
    if (reason) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  private statusJson(): string {
    return JSON.stringify({
      app: 'VTube Linux',
      port: this.port,
      clients: this.clientCount,
      model: { loaded: this.model !== null, name: this.modelName, rev: this.modelRev, bytes: this.model?.length ?? 0 },
      rev: this.modelRev,
      rejected: { ...this.rejected },
    }, null, 2);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.allowedHost(req.headers.host)) {
      this.logReject('host', req.headers.host, req);
      return void res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(`Forbidden: unexpected Host "${req.headers.host}". Use http://${HOST}:${this.port}/`);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return void res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return void res.writeHead(400).end('Bad Request');
    }
    if (pathname.includes('\0')) return void res.writeHead(400).end('Bad Request');

    if (pathname === '/model.vrm') {
      if (!this.model) return void res.writeHead(404, { 'Cache-Control': 'no-cache' }).end('No model loaded');
      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': this.model.length,
        'Cache-Control': 'no-cache, no-store',
      });
      return void res.end(req.method === 'HEAD' ? undefined : this.model);
    }
    if (pathname === '/ws') return void res.writeHead(426, { Upgrade: 'websocket' }).end('Upgrade Required');
    if (pathname === '/status') {
      const body = this.statusJson();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (pathname === '/' || pathname === '') pathname = '/output.html';
    const root = path.resolve(this.opts.rootDir);
    const file = path.resolve(root, '.' + path.posix.normalize(pathname));
    if (file !== root && !file.startsWith(root + path.sep)) return void res.writeHead(403).end('Forbidden');

    let data: Buffer;
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) throw new Error('not a file');
      data = await fs.promises.readFile(file);
    } catch {
      return void res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    }
    const hashed = pathname.startsWith('/assets/'); // vite output names contain content hashes
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Loopback host names/addresses (lower case, IPv6 in brackets). */
function isLocalName(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost') || name === 'localhost.localdomain') return true;
  if (name === '[::1]' || name === '[::ffff:127.0.0.1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  const hn = os.hostname().toLowerCase();
  return !!hn && (name === hn || name === `${hn}.localdomain`);
}

function describeClient(req: http.IncomingMessage): string {
  const ua = String(req.headers['user-agent'] ?? '');
  const kind = /OBS|CEF/i.test(ua) ? 'OBS' : /Firefox\//.test(ua) ? 'Firefox' : /Chrom/.test(ua) ? 'Chromium' : ua ? ua.slice(0, 40) : 'unknown client';
  return `${kind} @ ${req.socket.remoteAddress ?? '?'}`;
}
