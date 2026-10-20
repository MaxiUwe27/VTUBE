// The API exposed by the preload script as `window.vtube` (contextBridge).
import type { Settings, DeepPartial } from './settings';
import type { AvatarPose } from './types';

export interface ServerInfo { running: boolean; port: number; url: string; error?: string }
export interface VcamStatus { running: boolean; device: string; error?: string }
export interface ModelFile { path: string; name: string; data: ArrayBuffer }

export interface VtubeAPI {
  platform: string;
  getSettings(): Promise<Settings>;
  /** Deep-merges patch, persists (debounced), returns full new settings. Main also applies
   *  side effects (restart server on port change etc.) and pushes view changes to OBS clients. */
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>;

  /** Native file dialog for .vrm; also registers it as current model + recent list. */
  openModelDialog(): Promise<ModelFile | null>;
  /** Read a .vrm from disk (used for drag&drop and recent list); registers as current model. */
  loadModel(path: string): Promise<ModelFile>;
  /** Absolute path of a dropped File (wraps webUtils.getPathForFile). */
  getPathForFile(file: File): string;

  /** Fire-and-forget, called every solved frame; main relays to OBS WebSocket clients. */
  sendPose(pose: AvatarPose): void;
  getServerInfo(): Promise<ServerInfo>;

  vcamStart(): Promise<VcamStatus>;
  vcamStop(): Promise<VcamStatus>;
  vcamStatus(): Promise<VcamStatus>;
  /** RGBA pixels, top-down rows, width*height*4 bytes, sized as output.virtualCam width/height. */
  vcamFrame(rgba: ArrayBuffer): void;
  listVideoDevices(): Promise<string[]>; // e.g. ["/dev/video0", "/dev/video10"]

  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): void;
}

declare global {
  interface Window { vtube: VtubeAPI }
}
