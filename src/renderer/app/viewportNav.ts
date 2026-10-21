// Mouse navigation directly in the avatar viewport (app window only – the OBS page has none):
//   left drag          → orbit the camera around the avatar ("grab and turn the scene")
//   right/middle drag  → pan (view.cameraOffset.x/y)
//   wheel              → zoom (view.cameraOffset.zoom)
//   double-click       → reset orbit, offsets and zoom
// Nothing is drawn on the canvas (it is captured by OBS); feedback is the mouse cursor only.

import type { SettingsStore } from './store';
import { clampOffset, clampZoom, currentOrbit, orbitPatch, resetViewPatch, ViewUpdater } from './orbit';

/** Degrees of orbit per pixel dragged. */
const ORBIT_DEG_PER_PX = 0.35;
/** Zoom factor per wheel "pixel" (one notch ≈ 100 px ≈ ×1.16). */
const ZOOM_PER_PX = 0.0015;

export interface ViewportNavOptions {
  /** True while something else owns the pointer (e.g. the file drop overlay is shown). */
  blocked(): boolean;
}

export function setupViewportNav(store: SettingsStore, canvas: HTMLCanvasElement, opts: ViewportNavOptions): void {
  const updater = new ViewUpdater(store);
  canvas.classList.add('nav');

  type Drag = {
    id: number;
    mode: 'orbit' | 'pan';
    x0: number; y0: number;
    yaw0: number; pitch0: number;
    ox0: number; oy0: number;
    moved: boolean;
  };
  let drag: Drag | null = null;

  const endDrag = (e?: PointerEvent) => {
    if (!drag) return;
    if (e && e.pointerId !== drag.id) return;
    try { if (canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id); } catch { /* ignore */ }
    const moved = drag.moved;
    drag = null;
    canvas.classList.remove('grabbing', 'panning');
    if (moved) updater.end();
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (drag || opts.blocked() || (e.pointerType === 'touch' && !e.isPrimary)) return;
    let mode: Drag['mode'] | null = null;
    if (e.button === 0) mode = e.shiftKey ? 'pan' : 'orbit';
    else if (e.button === 1 || e.button === 2) mode = 'pan';
    if (!mode) return;
    e.preventDefault(); // no text selection / middle-click autoscroll
    // Leave panel controls (otherwise arrow keys keep moving the last used slider; Tab toggles the panel again).
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    const v = store.value.view;
    const o = currentOrbit(v);
    drag = {
      id: e.pointerId, mode, x0: e.clientX, y0: e.clientY,
      yaw0: o.yaw, pitch0: o.pitch, ox0: v.cameraOffset.x, oy0: v.cameraOffset.y, moved: false,
    };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    canvas.classList.add(mode === 'orbit' ? 'grabbing' : 'panning');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (opts.blocked()) { endDrag(); return; }
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    drag.moved = true;
    if (drag.mode === 'orbit') {
      // Grab-the-scene feel: dragging right turns the avatar to the right, i.e. the camera moves
      // to the viewer's left (yaw decreases); dragging down shows more from above (pitch increases).
      updater.push(orbitPatch(drag.yaw0 - dx * ORBIT_DEG_PER_PX, drag.pitch0 + dy * ORBIT_DEG_PER_PX));
    } else {
      // Offsets are fractions of the framed height, which spans about canvasHeight / zoom … so one
      // pixel ≈ 1 / (height · zoom). x > 0 moves the avatar right, y > 0 moves it up.
      const hpx = Math.max(1, canvas.clientHeight) * clampZoom(store.value.view.cameraOffset.zoom);
      updater.push({ view: { cameraOffset: { x: round3(clampOffset(drag.ox0 + dx / hpx)), y: round3(clampOffset(drag.oy0 - dy / hpx)) } } });
    }
  });

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', (e) => endDrag(e));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Chromium starts autoscroll on middle mousedown unless it is cancelled.
  canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

  // Wheel zoom. Several wheel events can arrive per frame, so accumulate on a local value.
  let wheelZoom: number | null = null;
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  canvas.addEventListener('wheel', (e) => {
    if (opts.blocked()) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const base = wheelZoom ?? clampZoom(store.value.view.cameraOffset.zoom);
    wheelZoom = clampZoom(base * Math.exp(-px * ZOOM_PER_PX));
    updater.push({ view: { cameraOffset: { zoom: Math.round(wheelZoom * 1000) / 1000 } } });
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      wheelZoom = null;
      updater.end();
    }, 250);
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    if (opts.blocked()) return;
    e.preventDefault();
    store.update(resetViewPatch(), 0);
  });
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
