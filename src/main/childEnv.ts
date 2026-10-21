// Environment for child processes (ffmpeg). No electron import (testable with plain node).
import * as path from 'node:path';

/** Colon-separated variables that electron-builder's AppRun prefixes with $APPDIR entries. */
const APPDIR_LISTS = ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'] as const;

/**
 * Inside an AppImage the AppRun puts $APPDIR/usr/lib into LD_LIBRARY_PATH and $APPDIR/… into
 * PATH (also XDG_DATA_DIRS, GSETTINGS_SCHEMA_DIR). A system program such as /usr/bin/ffmpeg must
 * not inherit that: it would load the AppImage's bundled libraries (e.g. Electron's own
 * libffmpeg.so) instead of the system ones (crash / "symbol lookup error"). Entries under $APPDIR
 * are removed; a variable that ends up empty is dropped (PATH falls back to the system default).
 * Outside an AppImage (no APPDIR/APPIMAGE) the environment is returned unchanged.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const appDir = env.APPDIR?.trim();
  if (!appDir && !env.APPIMAGE) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  if (!appDir) return out;
  const root = path.resolve(appDir);
  const inside = (entry: string) => {
    if (!entry) return true; // empty entry = current directory: drop it as well
    const abs = path.resolve(entry);
    return abs === root || abs.startsWith(root + path.sep);
  };
  for (const key of APPDIR_LISTS) {
    const value = out[key];
    if (value === undefined) continue;
    const kept = value.split(':').filter((e) => !inside(e));
    if (kept.length) out[key] = kept.join(':');
    else if (key === 'PATH') out[key] = '/usr/local/bin:/usr/bin:/bin';
    else delete out[key];
  }
  return out;
}
