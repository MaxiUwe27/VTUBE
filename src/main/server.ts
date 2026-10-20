// Local HTTP + WebSocket server for the OBS browser source.
//   GET /, /output.html   -> <rootDir>/output.html
//   GET /model.vrm        -> current model bytes
//   GET /<file>           -> static files from rootDir (vite build output)
//   WS  /ws               -> OutputMessage stream (view, model, pose)
// Deliberately free of electron imports so it can be tested with plain node.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerInfo } from '../shared/api';
import type { ViewSettings } from '../shared/settings';
import type { AvatarPose, OutputMessage } from '../shared/types';

const HOST = '127.0.0.1';
const POSE_INTERVAL_MS = 1000 / 60;   // max pose broadcast rate
const MAX_CLIENT_BUFFER = 1 << 20;    // skip pose frames for clients that lag behind (bytes)

const MIME: Record<string, string> = {
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
  private wss: WebSocketServer | null = null;
  private port = 0;
  private error: string | undefined;

  private model: Buffer | null = null;
  private modelKey: string | null = null;
  private modelRev = 0;
  private view: ViewSettings | null = null;

  private pendingPose: AvatarPose | null = null;
  private lastPoseAt = 0;
  private poseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: OutputServerOptions) {}

  get info(): ServerInfo {
    const info: ServerInfo = { running: this.server !== null, port: this.port, url: `http://${HOST}:${this.port}/` };
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

    const server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((e) => {
        console.error('[server] request failed:', e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(wss, req, socket, head));
    wss.on('connection', (ws) => this.onConnection(ws));

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
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
    return this.info;
  }

  async stop(): Promise<void> {
    if (this.poseTimer) clearTimeout(this.poseTimer);
    this.poseTimer = null;
    this.pendingPose = null;
    const { server, wss } = this;
    this.server = null;
    this.wss = null;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      wss.close();
    }
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // drop keep-alive sockets so close() completes promptly
      });
    }
  }

  /** Set the current model. `key` identifies the file version; same key => no reload for clients. */
  setModel(data: Buffer | null, key: string | null = null): void {
    if (key !== null && key === this.modelKey && data !== null) return;
    this.model = data;
    this.modelKey = data ? key : null;
    this.modelRev++;
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

  private onConnection(ws: WebSocket): void {
    ws.on('error', () => ws.terminate());
    ws.on('message', () => { /* clients don't send anything we need */ });
    if (this.view) ws.send(JSON.stringify({ type: 'view', view: this.view } satisfies OutputMessage));
    ws.send(JSON.stringify(this.modelMessage()));
  }

  /** Only localhost Host/Origin are accepted (protects against DNS rebinding / foreign web pages). */
  private allowedHost(host: string | undefined): boolean {
    return host === undefined || host === `${HOST}:${this.port}` || host === `localhost:${this.port}`;
  }

  private allowedOrigin(origin: string | undefined): boolean {
    return origin === undefined || origin === `http://${HOST}:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  private handleUpgrade(wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/ws' || !this.allowedHost(req.headers.host) || !this.allowedOrigin(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.allowedHost(req.headers.host)) return void res.writeHead(403).end('Forbidden');
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
