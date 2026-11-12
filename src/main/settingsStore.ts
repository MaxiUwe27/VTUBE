// Persistent settings: JSON file merged over defaults, debounced atomic writes.
// No electron import so it can be unit-tested with plain node.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from '../shared/settings';

export class SettingsStore {
  private current: Settings;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly file: string, private readonly delayMs = 400) {
    this.current = SettingsStore.read(file, true);
  }

  get(): Settings {
    return this.current;
  }

  /** Deep-merge `patch`, schedule a write, return the new settings object. */
  update(patch: DeepPartial<Settings>): Settings {
    this.current = sanitize(mergeSettings(this.current, patch));
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    return this.current;
  }

  /** Write pending changes now (synchronous; call on quit). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2));
      fs.renameSync(tmp, this.file); // atomic replace on the same filesystem
    } catch (e) {
      console.error('[settings] write failed:', e);
    }
  }

  /** Settings from `file` merged over defaults, without creating a store. `repair` = false never
   *  touches the file (read-only callers such as `--list-devices`); true renames a corrupt file aside. */
  static read(file: string, repair = false): Settings {
    const defaults = structuredClone(DEFAULT_SETTINGS);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return defaults; // first start
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      // Merging over defaults makes keys added in newer versions appear automatically.
      return sanitize(mergeSettings(defaults, parsed as DeepPartial<Settings>));
    } catch (e) {
      if (!repair) return defaults;
      console.error('[settings] corrupt settings file, using defaults:', e);
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return defaults;
    }
  }
}

/** Repair values the main process relies on (ports, paths). */
function sanitize(input: Settings): Settings {
  const s = structuredClone(input); // never mutate objects shared with the previous snapshot
  s.version = 1;
  const bs = s.output.browserSource;
  if (!Number.isInteger(bs.port) || bs.port < 1024 || bs.port > 65535) bs.port = DEFAULT_SETTINGS.output.browserSource.port;
  const vc = s.output.virtualCam;
  if (typeof vc.device !== 'string' || !vc.device) vc.device = DEFAULT_SETTINGS.output.virtualCam.device;
  if (!Array.isArray(s.model.recent)) s.model.recent = [];
  s.model.recent = s.model.recent.filter((p): p is string => typeof p === 'string').slice(0, 10);
  if (typeof s.model.lastPath !== 'string') s.model.lastPath = null;
  return s;
}
