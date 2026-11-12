// "Kugel": a small trackball for the camera orbit in the Ansicht section.
//
// The ball stands for the avatar and is drawn exactly as the camera currently sees it: the
// white square is the avatar's front (face), the small navy square its top. Dragging the ball turns it like
// grabbing the scene in the avatar window (drag right → the avatar turns right = camera moves to
// the viewer's left). Arrow keys step 5° (Shift: 15°), Home / double-click → frontal.

import type { SettingsStore } from './store';
import type { Controls } from './controls';
import { h, setText } from './dom';
import { currentOrbit, orbitPatch, pitchText, ViewUpdater, yawText } from './orbit';

const SIZE = 116; // CSS px
const RADIUS = SIZE / 2 - 6; // room for the outline and the hard shadow below
const NAVY = '#061838';

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
    title: 'Kugel = Avatar (weißes Quadrat = Gesicht). Ziehen dreht die Ansicht wie im Avatar-Fenster.\nPfeiltasten: 5° (Umschalt: 15°) · Doppelklick / Pos1: frontal',
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
    const cy = SIZE / 2 - 1.5;
    const R = RADIUS;

    // Camera basis (same as framing.ts): c = towards camera, right = up × c, up' = c × right.
    const c = orbitDir(o.yaw, o.pitch);
    const r = norm(cross([0, 1, 0], c));
    const u = norm(cross(c, r));
    const proj = (w: V3) => ({ x: cx + dot(w, r) * R, y: cy - dot(w, u) * R, z: dot(w, c) });

    // Sticker look: hard navy shadow below (no blur), then the ball in the brand gradient –
    // lit from the upper left like the avatar's key light: Glanz-Cyan → Türkis → Blau.
    g.beginPath();
    g.arc(cx, cy + 3, R + 1, 0, Math.PI * 2);
    g.fillStyle = NAVY;
    g.fill();
    const shade = g.createRadialGradient(cx - R * 0.38, cy - R * 0.42, R * 0.08, cx, cy, R * 1.05);
    shade.addColorStop(0, '#d9fdff');
    shade.addColorStop(0.35, '#5ff0e6');
    shade.addColorStop(0.75, '#1a9cf5');
    shade.addColorStop(1, '#006eff');
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
        g.lineWidth = emphasis ? 1.6 : 1;
        g.strokeStyle = front
          ? (emphasis ? 'rgba(6, 24, 56, 0.75)' : 'rgba(255, 255, 255, 0.55)')
          : (emphasis ? 'rgba(6, 24, 56, 0.18)' : 'rgba(255, 255, 255, 0.16)');
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

    // Specular highlight (hard-edged gloss spot, no glow).
    g.beginPath();
    g.ellipse(cx - R * 0.42, cy - R * 0.5, R * 0.16, R * 0.1, -0.6, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fill();

    // Navy outline.
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.lineWidth = 2;
    g.strokeStyle = NAVY;
    g.stroke();

    // Markers (square = pixel language): top pole (small, navy) and the avatar's face (white, navy outline).
    const marker = (w: V3, half: number, fill: string) => {
      const p = proj(w);
      const front = p.z >= -0.02;
      const s = half * (front ? 1 : 0.8);
      if (front) {
        g.fillStyle = fill;
        g.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        g.lineWidth = 2;
        g.strokeStyle = NAVY;
        g.strokeRect(p.x - s, p.y - s, s * 2, s * 2);
      } else {
        g.lineWidth = 1.5;
        g.strokeStyle = 'rgba(6, 24, 56, 0.35)';
        g.strokeRect(p.x - s, p.y - s, s * 2, s * 2);
      }
    };
    marker([0, 1, 0], 2.5, NAVY);
    marker([0, 0, 1], 5, '#ffffff');
  };
  ui.bind(draw);

  // --- Dragging -----------------------------------------------------------------------------
  let drag: { id: number; x0: number; y0: number; yaw0: number; pitch0: number; moved: boolean } | null = null;
  const degPerPx = () => 180 / Math.PI / RADIUS; // the grabbed point follows the pointer near the centre
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
