// 6. Ansicht: background, framing, camera offsets, light, idle, arm pose, fps.

import type { ViewSettings } from '../../../shared/settings';
import type { AppContext, SectionModule } from '../context';
import { fmt, hint, section, subhead } from '../controls';

export function viewSection(ctx: AppContext): SectionModule {
  const { ui } = ctx;
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
    ui.slider({
      label: 'Zoom',
      min: 0.3, max: 3, step: 0.01, format: fmt.times,
      get: (s) => s.view.cameraOffset.zoom,
      set: (v) => ({ view: { cameraOffset: { zoom: v } } }),
    }),
    ui.slider({
      label: 'Versatz X',
      hint: 'Avatar horizontal verschieben',
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
      label: 'Sichtfeld (FOV)',
      hint: 'Kleiner = weniger perspektivische Verzerrung',
      min: 10, max: 60, step: 1, format: fmt.deg,
      get: (s) => s.view.cameraFov,
      set: (v) => ({ view: { cameraFov: v } }),
    }),
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
      label: 'Umgebungslicht',
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
    hint('Hinweis für OBS-Fensteraufnahme: Seitenleiste mit Tab ausblenden, dann Chroma-Key auf die Hintergrundfarbe setzen.'),
  );
  return { el: sec.el, isOpen: () => sec.open };
}
