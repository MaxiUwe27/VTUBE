// 6. Ansicht: background, framing, camera orbit (Kugel + presets), offsets, light, idle, arm pose, fps.

import type { ViewSettings } from '../../../shared/settings';
import type { AppContext, SectionModule } from '../context';
import { button, fmt, hint, more, section, subhead } from '../controls';
import { h, toggleClass } from '../dom';
import { orbitBall } from '../orbitBall';
import {
  currentOrbit, fmtPitch, fmtYaw, ORBIT_PITCH_MAX, ORBIT_PITCH_MIN, ORBIT_PRESETS, orbitPatch, resetViewPatch, ZOOM_MAX, ZOOM_MIN,
} from '../orbit';

export function viewSection(ctx: AppContext): SectionModule {
  const { ui, store } = ctx;

  // Camera orbit: ball + presets side by side.
  const presets = ORBIT_PRESETS.map((p) => {
    const b = button(p.label, { small: true, title: p.title, onClick: () => store.update(orbitPatch(p.yaw, p.pitch), 0) });
    b.classList.add('orbit-preset');
    return { p, b };
  });
  ui.bind(() => {
    const o = currentOrbit(store.value.view);
    for (const { p, b } of presets) toggleClass(b, 'active', Math.abs(o.yaw - p.yaw) < 0.5 && Math.abs(o.pitch - p.pitch) < 0.5);
  });
  const orbitRow = h('div', { class: 'orbit-row' },
    orbitBall(store, ui),
    h('div', { class: 'orbit-presets' }, presets.map((x) => x.b)));
  const resetRow = h('div', { class: 'btn-row' },
    button('Ansicht zurücksetzen', {
      icon: 'refresh', small: true, variant: 'ghost',
      title: 'Orbit, Zoom und Versatz auf Standard (Ausschnitt, FOV und Licht bleiben)',
      onClick: () => store.update(resetViewPatch(), 0),
    }));
  const sec = section('view', 'Ansicht', 'eye', false,
    ui.segmented<ViewSettings['background']['mode']>({
      label: 'Hintergrund',
      hint: 'Farbe (z. B. Grün für Chroma-Key bei Fensteraufnahme) oder transparent',
      options: [{ value: 'color', label: 'Farbe' }, { value: 'transparent', label: 'Transparent' }],
      get: (s) => s.view.background.mode,
      set: (v) => ({ view: { background: { mode: v } } }),
    }),
    ui.color({
      label: 'Farbe',
      get: (s) => s.view.background.color,
      set: (v) => ({ view: { background: { color: v } } }),
      swatches: [
        { color: '#00ff00', label: 'Grün' },
        { color: '#0000ff', label: 'Blau' },
        { color: '#ff00ff', label: 'Magenta' },
      ],
      enabled: (s) => s.view.background.mode === 'color',
    }),
    subhead('Kamera'),
    ui.segmented<ViewSettings['framing']>({
      label: 'Ausschnitt',
      stacked: true,
      options: [
        { value: 'head', label: 'Kopf' },
        { value: 'upperBody', label: 'Oberkörper' },
        { value: 'fullBody', label: 'Ganzkörper' },
      ],
      get: (s) => s.view.framing,
      set: (v) => ({ view: { framing: v } }),
    }),
    orbitRow,
    ui.slider({
      label: 'Zoom',
      hint: 'Auch mit dem Mausrad im Avatar-Fenster',
      min: ZOOM_MIN, max: ZOOM_MAX, step: 0.01, format: fmt.times,
      get: (s) => s.view.cameraOffset.zoom,
      set: (v) => ({ view: { cameraOffset: { zoom: v } } }),
    }),
    resetRow,
    more('view',
      ui.slider({
        label: 'Drehung',
        hint: 'Orbit horizontal: Kamera um den Avatar drehen, vom Zuschauer aus gesehen: negativ (L) = Kamera nach links, positiv (R) = nach rechts',
        min: -180, max: 180, step: 1, format: fmtYaw,
        get: (s) => currentOrbit(s.view).yaw,
        set: (v) => orbitPatch(v, currentOrbit(store.value.view).pitch),
      }),
      ui.slider({
        label: 'Neigung',
        hint: 'Orbit vertikal: positiv = Kamera von oben, negativ = von unten',
        min: ORBIT_PITCH_MIN, max: ORBIT_PITCH_MAX, step: 1, format: fmtPitch,
        get: (s) => currentOrbit(s.view).pitch,
        set: (v) => orbitPatch(currentOrbit(store.value.view).yaw, v),
      }),
      ui.slider({
        label: 'Versatz X',
        hint: 'Avatar horizontal verschieben (auch: rechte oder mittlere Maustaste im Avatar-Fenster ziehen)',
        min: -1, max: 1, step: 0.01,
        get: (s) => s.view.cameraOffset.x,
        set: (v) => ({ view: { cameraOffset: { x: v } } }),
      }),
      ui.slider({
        label: 'Versatz Y',
        hint: 'Avatar vertikal verschieben',
        min: -1, max: 1, step: 0.01,
        get: (s) => s.view.cameraOffset.y,
        set: (v) => ({ view: { cameraOffset: { y: v } } }),
      }),
      ui.slider({
        label: 'Sichtfeld',
        hint: 'Sichtfeld der Kamera (FOV) – kleiner = weniger perspektivische Verzerrung',
        min: 10, max: 60, step: 1, format: fmt.deg,
        get: (s) => s.view.cameraFov,
        set: (v) => ({ view: { cameraFov: v } }),
      }),
      hint('Maus im Avatar-Fenster: linke Taste ziehen = drehen, rechte/mittlere Taste = verschieben, Mausrad = Zoom, Doppelklick = zurücksetzen.'),
      subhead('Licht'),
      ui.slider({
        label: 'Licht',
        hint: 'Helligkeit des Hauptlichts',
        min: 0, max: 4, step: 0.05, format: fmt.num(2),
        get: (s) => s.view.lightIntensity,
        set: (v) => ({ view: { lightIntensity: v } }),
      }),
      ui.color({
        label: 'Lichtfarbe',
        get: (s) => s.view.lightColor,
        set: (v) => ({ view: { lightColor: v } }),
        swatches: [
          { color: '#ffffff', label: 'Neutral' },
          { color: '#ffe8cc', label: 'Warm' },
          { color: '#dde8ff', label: 'Kühl' },
        ],
      }),
      ui.slider({
        label: 'Umgebung',
        hint: 'Helligkeit des Umgebungslichts',
        min: 0, max: 2, step: 0.05, format: fmt.num(2),
        get: (s) => s.view.ambientIntensity,
        set: (v) => ({ view: { ambientIntensity: v } }),
      }),
      subhead('Avatar'),
      ui.toggle({
        label: 'Idle-Animation',
        hint: 'Atmung und leichtes Wiegen',
        get: (s) => s.view.idleAnimation,
        set: (v) => ({ view: { idleAnimation: v } }),
      }),
      ui.slider({
        label: 'Armwinkel',
        hint: 'Wie weit die Arme aus der T-Pose abgesenkt werden (≈ 70° wirkt natürlich)',
        min: 0, max: 90, step: 1, format: fmt.deg,
        get: (s) => s.view.armPose,
        set: (v) => ({ view: { armPose: v } }),
      }),
      subhead('Leistung'),
      ui.segmented<number>({
        label: 'Ziel-FPS',
        hint: 'Maximale Bildrate des Avatars',
        options: [30, 60, 120, 144].map((v) => ({ value: v, label: String(v) })),
        get: (s) => s.view.targetFps,
        set: (v) => ({ view: { targetFps: v } }),
      }),
      ui.toggle({
        label: 'FPS-Anzeige',
        hint: 'Kleine FPS-Anzeige oben links im Avatar-Fenster',
        get: (s) => s.view.showFps,
        set: (v) => ({ view: { showFps: v } }),
      }),
      hint('OBS-Fensteraufnahme: Seitenleiste mit Tab ausblenden, dann Chroma-Key auf die Hintergrundfarbe setzen.'),
    ),
  );
  return { el: sec.el, isOpen: () => sec.open };
}
