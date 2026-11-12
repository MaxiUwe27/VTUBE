// The API exposed by the preload script as `window.vtube` (contextBridge).
import type { Settings, DeepPartial } from './settings';
import type { AvatarPose } from './types';

export interface ServerInfo {
  running: boolean;
  port: number;
  url: string;
  error?: string;
  /** Connected OBS/browser output pages (WebSocket clients). */
  clients?: number;
}
/** Where the virtual camera device path comes from (precedence: cli > env > settings > default). */
export type VcamDeviceSource = 'cli' | 'env' | 'settings' | 'default';
/** `device` is the effective device path (resolved in main); `deviceSource` says who set it. */
export interface VcamStatus { running: boolean; device: string; error?: string; deviceSource?: VcamDeviceSource }
/** A /dev/videoN node. `label` = sysfs name (card_label for v4l2loopback); `busyBy` = other
 *  processes holding it open (this app and its own ffmpeg excluded). */
export interface VideoDeviceInfo { path: string; label: string; loopback: boolean; busyBy: { pid: number; name: string }[] }
export interface ModelFile { path: string; name: string; data: ArrayBuffer }

/** Tracking input from a URL ("Browserquelle"): main renders the page offscreen and streams its frames. */
export interface UrlSourceRequest {
  /** Chosen by the renderer; echoed in every frame/status so stale ones can be ignored. */
  id: number;
  url: string;            // http(s) only (validated in main)
  width: number;          // offscreen page size in px
  height: number;
  fps: number;            // max paint rate
}
export type UrlSourceState = 'loading' | 'connected' | 'reconnecting' | 'error';
export interface UrlSourceStatus {
  id: number;
  state: UrlSourceState;
  url: string;
  /** German, user-facing (error reason, reconnect note). */
  message?: string;
  /** Unrecoverable (no retry in main, e.g. the URL triggers a download) → renderer gives up. */
  fatal?: boolean;
}
/** One rendered page frame. `data` = BGRA (little-endian, alpha ignored), top-down, width*height*4 bytes. */
export interface UrlSourceFrame { id: number; width: number; height: number; data: Uint8Array }

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
  /** All /dev/videoN nodes (numerically sorted) with label, v4l2loopback flag and current users. */
  listVideoDevices(): Promise<VideoDeviceInfo[]>;

  /** Start (or replace) the URL source. Rejects for invalid URLs (German message). Frames and status
   *  arrive via onUrlSourceFrame/onUrlSourceStatus; main retries failed loads by itself. */
  urlSourceStart(req: UrlSourceRequest): Promise<void>;
  /** Stop and destroy the offscreen page (only if `id` is still the current source; no id = always). */
  urlSourceStop(id?: number): Promise<void>;
  /** Frames are flow-controlled: the preload acks each one after the callbacks ran, main drops frames
   *  while two are unacknowledged. Returns an unsubscribe function. */
  onUrlSourceFrame(cb: (f: UrlSourceFrame) => void): () => void;
  onUrlSourceStatus(cb: (s: UrlSourceStatus) => void): () => void;

  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): void;
}

declare global {
  interface Window { vtube: VtubeAPI }
}
