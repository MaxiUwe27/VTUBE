// "Kugel": a small trackball for the camera orbit in the Ansicht section.
//
// The ball stands for the avatar and is drawn exactly as the camera currently sees it: the
// accent dot is the avatar's front (face), the small dot its top. Dragging the ball turns it like
// grabbing the scene in the avatar window (drag right → the avatar turns right = camera moves to
// the viewer's left). Arrow keys step 5° (Shift: 15°), Home / double-click → frontal.

import type { SettingsStore } from './store';
import type { Controls } from './controls';
import { h, setText } from './dom';
import { currentOrbit, orbitPatch, pitchText, ViewUpdater, yawText } from './orbit';

const SIZE = 116; // CSS px

type V3 = [number, number, number];

function orbitDir(yawDeg: number, pitchDeg: number): V3 {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const sph = (latDeg: number, lonDeg: number): V3 => {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
};

export function orbitBall(store: SettingsStore, ui: Controls): HTMLElement {
  const canvas = h('canvas', {
    class: 'orbit-ball',
    tabindex: 0,
    role: 'img',
    'aria-label': 'Kamera-Orbit: ziehen zum Drehen, Pfeiltasten in 5°-Schritten, Pos1 = frontal',
    title: 'Kugel = Avatar (Punkt = Gesicht). Ziehen dreht die Ansicht wie im Avatar-Fenster.\nPfeiltasten: 5° (Umschalt: 15°) · Doppelklick / Pos1: frontal',
  });
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  const readout = h('div', { class: 'orbit-readout' });
  const updater = new ViewUpdater(store);

  let drawn = '';
  const draw = () => {
    const o = currentOrbit(store.value.view);
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
    const key = `${o.yaw}|${o.pitch}|${dpr}`;
    setText(readout, `Kamera ${yawText(o.yaw)}\n${pitchText(o.pitch)}`);
    if (key === drawn) return;
    drawn = key;
    const px = Math.round(SIZE * dpr);
    if (canvas.width !== px) canvas.width = canvas.height = px;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, SIZE, SIZE);
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const R = SIZE / 2 - 5;

    // Camera basis (same as framing.ts): c = towards camera, right = up × c, up' = c × right.
    const c = orbitDir(o.yaw, o.pitch);
    const r = norm(cross([0, 1, 0], c));
    const u = norm(cross(c, r));
    const proj = (w: V3) => ({ x: cx + dot(w, r) * R, y: cy - dot(w, u) * R, z: dot(w, c) });

    // Shaded ball, lit from the upper left like the avatar's key light.
    const shade = g.createRadialGradient(cx - R * 0.38, cy - R * 0.42, R * 0.08, cx, cy, R);
    shade.addColorStop(0, '#5b6378');
    shade.addColorStop(0.55, '#2c3242');
    shade.addColorStop(1, '#141820');
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = shade;
    g.fill();

    // Latitude / longitude lines; the far side is only hinted.
    const line = (pts: V3[], emphasis: boolean) => {
      for (let pass = 0; pass < 2; pass++) {
        const front = pass === 1;
        g.beginPath();
        let open = false;
        for (const w of pts) {
          const p = proj(w);
          if ((p.z >= 0) === front) {
            if (open) g.lineTo(p.x, p.y);
            else g.moveTo(p.x, p.y);
            open = true;
          } else {
            open = false;
          }
        }
        g.lineWidth = emphasis ? 1.4 : 1;
        g.strokeStyle = front
          ? (emphasis ? 'rgba(167, 139, 250, 0.85)' : 'rgba(255, 255, 255, 0.22)')
          : (emphasis ? 'rgba(167, 139, 250, 0.22)' : 'rgba(255, 255, 255, 0.06)');
        g.stroke();
      }
    };
    const N = 72;
    for (const lat of [-60, -30, 0, 30, 60]) {
      const pts: V3[] = [];
      for (let i = 0; i <= N; i++) pts.push(sph(lat, (i / N) * 360));
      line(pts, lat === 0);
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const pts: V3[] = [];
      for (let i = 0; i <= N / 2; i++) pts.push(sph(-90 + (i / (N / 2)) * 180, lon));
      line(pts, lon === 0);
    }

    // Rim.
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    g.stroke();

    // Markers: top pole (small) and the avatar's face direction (accent).
    const marker = (w: V3, radius: number, fill: string) => {
      const p = proj(w);
      const front = p.z >= -0.02;
      g.beginPath();
      g.arc(p.x, p.y, radius * (front ? 1 : 0.8), 0, Math.PI * 2);
      if (front) {
        g.fillStyle = fill;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = '#fff';
        g.stroke();
      } else {
        g.lineWidth = 1.2;
        g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        g.stroke();
      }
    };
    marker([0, 1, 0], 3, '#cfd3dc');
    marker([0, 0, 1], 6, '#8b5cf6');

    // Specular highlight on top.
    const hi = g.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.5);
    hi.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
    hi.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = hi;
    g.fill();
  };
  ui.bind(draw);

  // --- Dragging -----------------------------------------------------------------------------
  let drag: { id: number; x0: number; y0: number; yaw0: number; pitch0: number; moved: boolean } | null = null;
  const degPerPx = () => 180 / Math.PI / (SIZE / 2 - 5); // the grabbed point follows the pointer near the centre
  canvas.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0) return;
    e.preventDefault();
    canvas.classList.add('mouse'); // focus ring only for keyboard use
    canvas.focus({ preventScroll: true });
    const o = currentOrbit(store.value.view);
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, yaw0: o.yaw, pitch0: o.pitch, moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    canvas.classList.add('grabbing');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    drag.moved = true;
    const k = degPerPx();
    updater.push(orbitPatch(drag.yaw0 - dx * k, drag.pitch0 + dy * k));
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    canvas.classList.remove('grabbing');
    try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (moved) updater.end();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
  canvas.addEventListener('dblclick', () => store.update(orbitPatch(0, 0), 0));
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 5;
    const o = currentOrbit(store.value.view);
    let yaw = o.yaw;
    let pitch = o.pitch;
    // Same direction as dragging: ← turns the avatar left (camera moves right).
    if (e.key === 'ArrowLeft') yaw += step;
    else if (e.key === 'ArrowRight') yaw -= step;
    else if (e.key === 'ArrowUp') pitch -= step;
    else if (e.key === 'ArrowDown') pitch += step;
    else if (e.key === 'Home') { yaw = 0; pitch = 0; }
    else return;
    e.preventDefault();
    canvas.classList.remove('mouse');
    store.update(orbitPatch(yaw, pitch), 150);
  });

  return h('div', { class: 'orbit-ball-wrap' }, canvas, readout);
}
