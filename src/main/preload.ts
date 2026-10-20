// Preload (sandboxed): exposes window.vtube. A sandboxed preload may only require('electron'),
// so this file must not import runtime code from other local modules (type imports are fine).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { VtubeAPI } from '../shared/api';

/** ipcRenderer.invoke with the "Error invoking remote method 'x': Error:" prefix stripped. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
    const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
    throw new Error(msg);
  });
}

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

  openExternal: (url) => invoke('shell:open', url),
  // The clipboard module is not available in sandboxed preloads -> main does it.
  copyToClipboard: (text) => ipcRenderer.send('clipboard:write', String(text)),
};

contextBridge.exposeInMainWorld('vtube', api);
