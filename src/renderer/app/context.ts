// Shared app context handed to UI sections (avoids circular imports with app.ts).

import type { AvatarRenderer } from '../avatar/AvatarRenderer';
import type { FaceTracker } from '../tracking/FaceTracker';
import type { LipSync } from '../audio/LipSync';
import type { PoseSolver } from '../solver/PoseSolver';
import type { AvatarPose, FaceFrame, VisemeFrame, VrmInfo } from '../../shared/types';
import type { ServerInfo, VcamStatus } from '../../shared/api';
import type { SettingsStore } from './store';
import type { Controls } from './controls';

export type RunState = 'off' | 'starting' | 'running' | 'error';

export interface LoadedModel {
  info: VrmInfo;
  fileName: string;
  path: string | null;
}

export interface LiveState {
  model: LoadedModel | null;
  modelLoading: boolean;
  lastPose: AvatarPose | null;
  lastViseme: VisemeFrame | null;
  lastFace: FaceFrame | null;
  lastFaceAt: number;                 // performance.now() of last FaceFrame
  tracker: { state: RunState; error: string | null };
  lipSync: { state: RunState; error: string | null };
  vcam: VcamStatus & { busy: boolean };
  server: ServerInfo | null;
  calibrationCountdown: number | null; // seconds left, null = idle
  panelOpen: boolean;
}

export type AppEvent = 'model' | 'tracker' | 'lipsync' | 'vcam' | 'server' | 'calibration' | 'panel';

export interface AppActions {
  openModelDialog(): Promise<void>;
  loadModelPath(path: string): Promise<void>;
  /** Drag & drop: resolves the file path via preload, falls back to reading the File. */
  loadDroppedFile(file: File): Promise<void>;
  calibrate(): void;
  resetCalibration(): void;
  restartTracker(): void;
  restartLipSync(): void;
  vcamStart(): Promise<void>;
  vcamStop(): Promise<void>;
  refreshServerInfo(): Promise<void>;
  togglePanel(open?: boolean): void;
}

export interface AppContext {
  store: SettingsStore;
  ui: Controls;
  renderer: AvatarRenderer;
  tracker: FaceTracker;
  lipSync: LipSync;
  solver: PoseSolver;
  live: LiveState;
  actions: AppActions;
  on(ev: AppEvent, fn: () => void): void;
  emit(ev: AppEvent): void;
}

/** A panel section: element plus optional live update hook (called ~10×/s while visible). */
export interface SectionModule {
  el: HTMLElement;
  tick?(now: number): void;
  isOpen(): boolean;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}
