// Preload (sandboxed): exposes window.vtube. A sandboxed preload may only require('electron'),
// so this file must not import runtime code from other local modules (type imports are fine).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { UrlSourceFrame, UrlSourceStatus, VtubeAPI } from '../shared/api';

/** ipcRenderer.invoke with the "Error invoking remote method 'x': Error:" prefix stripped. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
    const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
    throw new Error(msg);
  });
}

/** One IPC listener per channel, fanned out to the page's callbacks (unsubscribe = remove from the set). */
function listeners<T>(channel: string, after?: (msg: T) => void): (cb: (msg: T) => void) => () => void {
  const set = new Set<(msg: T) => void>();
  ipcRenderer.on(channel, (_e, msg: T) => {
    try {
      for (const cb of set) {
        try { cb(msg); } catch (err) { console.error(`[preload] ${channel} listener failed`, err); }
      }
    } finally {
      after?.(msg);
    }
  });
  return (cb) => {
    set.add(cb);
    return () => { set.delete(cb); };
  };
}

// Every frame is acknowledged after the callbacks ran (main keeps at most two in flight).
const onUrlSourceFrame = listeners<UrlSourceFrame>('urlsource:frame', () => ipcRenderer.send('urlsource:ack'));
const onUrlSourceStatus = listeners<UrlSourceStatus>('urlsource:status');

const api: VtubeAPI = {
  platform: process.platform,
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),

  openModelDialog: () => invoke('model:open'),
  loadModel: (path) => invoke('model:load', path),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  sendPose: (pose) => ipcRenderer.send('pose', pose),
  getServerInfo: () => invoke('server:info'),

  vcamStart: () => invoke('vcam:start'),
  vcamStop: () => invoke('vcam:stop'),
  vcamStatus: () => invoke('vcam:status'),
  vcamFrame: (rgba) => ipcRenderer.send('vcam:frame', rgba),
  listVideoDevices: () => invoke('vcam:devices'),

  urlSourceStart: (req) => invoke('urlsource:start', req),
  urlSourceStop: (id) => invoke('urlsource:stop', id),
  onUrlSourceFrame,
  onUrlSourceStatus,

  openExternal: (url) => invoke('shell:open', url),
  // The clipboard module is not available in sandboxed preloads -> main does it.
  copyToClipboard: (text) => ipcRenderer.send('clipboard:write', String(text)),
};

contextBridge.exposeInMainWorld('vtube', api);
