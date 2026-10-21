// Camera orbit / offset helpers shared by the viewport mouse navigation and the "Ansicht" section.
//
// Sign convention (src/shared/settings.ts, ViewSettings.orbit): yaw > 0 moves the camera toward the
// avatar's own left, which is the VIEWER's right. All UI texts use the viewer's perspective:
// "links" = camera to the viewer's left (yaw < 0), "rechts" = yaw > 0, "oben" = pitch > 0.

import { DEFAULT_SETTINGS, type ViewSettings } from '../../shared/settings';
import { normalizeOrbit, ORBIT_PITCH_MAX, ORBIT_PITCH_MIN, wrapYaw } from '../avatar/framing';
import type { SettingsPatch, SettingsStore } from './store';

export { normalizeOrbit, ORBIT_PITCH_MAX, ORBIT_PITCH_MIN, wrapYaw };

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;
export const OFFSET_MAX = 1;

export interface OrbitPreset { label: string; title: string; yaw: number; pitch: number }

export const ORBIT_PRESETS: OrbitPreset[] = [
  { label: 'Frontal', title: 'Kamera direkt von vorn', yaw: 0, pitch: 0 },
  { label: 'Von oben', title: 'Kamera leicht von oben (35°)', yaw: 0, pitch: 35 },
  { label: 'Leicht links', title: 'Kamera 30° nach links (vom Zuschauer aus) – der Avatar ist leicht nach rechts gedreht', yaw: -30, pitch: 0 },
  { label: 'Leicht rechts', title: 'Kamera 30° nach rechts (vom Zuschauer aus) – der Avatar ist leicht nach links gedreht', yaw: 30, pitch: 0 },
  { label: 'Profil links', title: 'Kamera 90° links (vom Zuschauer aus) – Seitenansicht, der Avatar schaut im Bild nach rechts', yaw: -90, pitch: 0 },
  { label: 'Profil rechts', title: 'Kamera 90° rechts (vom Zuschauer aus) – Seitenansicht, der Avatar schaut im Bild nach links', yaw: 90, pitch: 0 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Rounds to 0.1° so stored values stay readable. */
const r1 = (v: number) => Math.round(v * 10) / 10;

export function orbitPatch(yaw: number, pitch: number): SettingsPatch {
  const o = normalizeOrbit({ yaw, pitch });
  return { view: { orbit: { yaw: r1(o.yaw), pitch: r1(o.pitch) } } };
}

export function clampZoom(z: number): number {
  return clamp(Number.isFinite(z) ? z : 1, ZOOM_MIN, ZOOM_MAX);
}

export function clampOffset(v: number): number {
  return clamp(Number.isFinite(v) ? v : 0, -OFFSET_MAX, OFFSET_MAX);
}

/** Orbit + offsets + zoom back to defaults (framing, FOV, light etc. stay). */
export function resetViewPatch(): SettingsPatch {
  const d = DEFAULT_SETTINGS.view;
  return { view: { orbit: { ...d.orbit }, cameraOffset: { ...d.cameraOffset } } };
}

export function currentOrbit(view: ViewSettings): { yaw: number; pitch: number } {
  return normalizeOrbit(view.orbit);
}

/** "30° links", "frontal", "90° rechts" – from the viewer's perspective. */
export function yawText(yaw: number): string {
  const y = Math.round(wrapYaw(yaw));
  if (y === 0) return 'frontal';
  if (Math.abs(y) === 180) return 'von hinten';
  return `${Math.abs(y)}° ${y < 0 ? 'links' : 'rechts'}`;
}

export function pitchText(pitch: number): string {
  const p = Math.round(pitch);
  if (p === 0) return 'auf Augenhöhe';
  return `${Math.abs(p)}° ${p > 0 ? 'von oben' : 'von unten'}`;
}

/** Compact slider value: "30° L" / "30° R" / "0°". */
export function fmtYaw(v: number): string {
  const y = Math.round(v);
  if (y === 0) return '0°';
  return `${Math.abs(y)}° ${y < 0 ? 'L' : 'R'}`;
}

export function fmtPitch(v: number): string {
  const p = Math.round(v);
  return p > 0 ? `+${p}°` : p < 0 ? `−${-p}°` : '0°';
}

/**
 * Coalesces rapid view changes (pointer drags) into one store update per animation frame and
 * persists at most every `persistMs` while the drag lasts (so OBS follows along), plus once at the end.
 */
export class ViewUpdater {
  private pending: SettingsPatch | null = null;
  private raf = 0;
  private lastFlush = 0;

  constructor(private readonly store: SettingsStore, private readonly persistMs = 150) {}

  push(patch: SettingsPatch): void {
    this.pending = patch;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.apply());
  }

  /** Apply the pending patch now and persist immediately. */
  end(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.pending) {
      this.store.update(this.pending, 0);
      this.pending = null;
    } else {
      void this.store.flush();
    }
  }

  private apply(): void {
    this.raf = 0;
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    this.store.update(p, 400);
    const now = performance.now();
    if (now - this.lastFlush > this.persistMs) {
      this.lastFlush = now;
      void this.store.flush();
    }
  }
}
