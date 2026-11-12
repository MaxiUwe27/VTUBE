// Local settings state for the app window.
// Every change is applied locally right away (listeners update modules + UI) and persisted to
// the main process through window.vtube.setSettings – coalesced and debounced, so dragging a
// slider does not flood IPC / disk.

import { mergeSettings, type DeepPartial, type Settings } from '../../shared/settings';

export type SettingsPatch = DeepPartial<Settings>;
export type SettingsListener = (settings: Settings, patch: SettingsPatch) => void;

export class SettingsStore {
  private current: Settings;
  private pending: SettingsPatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<SettingsListener>();
  private inflight: Promise<void> = Promise.resolve();

  /** Called when persisting fails (e.g. main process error). */
  onPersistError: ((err: unknown) => void) | null = null;

  constructor(initial: Settings) {
    this.current = initial;
  }

  get value(): Settings {
    return this.current;
  }

  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Apply a patch locally (immediately) and persist it.
   * @param delayMs persistence debounce; sliders use the default, discrete controls may pass 0.
   */
  update(patch: SettingsPatch, delayMs = 100): void {
    this.current = mergeSettings(this.current, patch);
    this.pending = this.pending
      ? mergeSettings(this.pending as Settings, patch) as SettingsPatch
      : patch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delayMs);
    this.emit(patch);
  }

  /** Take over values that main already knows (e.g. model.recent after loading) – no echo back. */
  adopt(patch: SettingsPatch): void {
    this.current = mergeSettings(this.current, patch);
    this.emit(patch);
  }

  /** Persist pending changes now. Resolves once main has received them. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const patch = this.pending;
    this.pending = null;
    if (patch) {
      // Keep IPC calls ordered.
      this.inflight = this.inflight.then(async () => {
        try {
          await window.vtube.setSettings(patch);
        } catch (err) {
          this.onPersistError?.(err);
        }
      });
    }
    return this.inflight;
  }

  private emit(patch: SettingsPatch): void {
    for (const fn of this.listeners) {
      try {
        fn(this.current, patch);
      } catch (err) {
        console.error('[settings] listener failed', err);
      }
    }
  }
}
