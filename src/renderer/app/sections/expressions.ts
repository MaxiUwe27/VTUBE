// 4. Mimik & Emotionen: sensitivities, emotions, Perfect Sync, live expression meters.

import type { EmotionKey } from '../../../shared/settings';
import type { AppContext, SectionModule } from '../context';
import { fmt, hint, meter, section, subhead } from '../controls';
import { h, toggleClass } from '../dom';

const EMOTIONS: { key: EmotionKey; label: string }[] = [
  { key: 'happy', label: 'Fröhlich' },
  { key: 'angry', label: 'Wütend' },
  { key: 'sad', label: 'Traurig' },
  { key: 'relaxed', label: 'Entspannt' },
  { key: 'surprised', label: 'Überrascht' },
];

const METER_ROWS = 12;

export function expressionsSection(ctx: AppContext): SectionModule {
  const { ui, live } = ctx;

  const psNote = hint('');
  const updatePsNote = () => {
    const m = live.model;
    psNote.textContent = !m
      ? 'Perfect Sync steuert die 52 ARKit-Blendshapes direkt, falls das Modell sie besitzt.'
      : m.info.hasPerfectSync
        ? 'Dieses Modell unterstützt Perfect Sync – feinere Mimik möglich.'
        : 'Dieses Modell hat keine Perfect-Sync-Blendshapes – es werden die VRM-Standardausdrücke genutzt.';
  };
  ctx.on('model', updatePsNote);
  updatePsNote();

  const meters = Array.from({ length: METER_ROWS }, () => meter(''));
  const meterList = h('div', { class: 'meters' }, meters.map((m) => m.el));
  const meterEmpty = h('div', { class: 'meters-empty' }, 'Keine aktiven Ausdrücke.');
  const meterBox = h('div', { class: 'card meter-card' }, meterList, meterEmpty);

  const sec = section('expressions', 'Mimik & Emotionen', 'smile', false,
    ui.slider({
      label: 'Blinzeln',
      hint: 'Empfindlichkeit: höher = Augen schließen sich leichter',
      min: 0.2, max: 2.5, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.blinkSensitivity,
      set: (v) => ({ tracking: { blinkSensitivity: v } }),
    }),
    ui.toggle({
      label: 'Beide Augen gemeinsam',
      hint: 'Blinzeln beider Augen koppeln (verhindert ungewolltes Zwinkern)',
      get: (s) => s.tracking.linkBlinks,
      set: (v) => ({ tracking: { linkBlinks: v } }),
    }),
    ui.slider({
      label: 'Mund',
      hint: 'Empfindlichkeit der Mundbewegungen',
      min: 0.2, max: 2.5, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.mouthSensitivity,
      set: (v) => ({ tracking: { mouthSensitivity: v } }),
    }),
    ui.slider({
      label: 'Augenbrauen',
      hint: 'Empfindlichkeit der Augenbrauen',
      min: 0.2, max: 2.5, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.browSensitivity,
      set: (v) => ({ tracking: { browSensitivity: v } }),
    }),
    ui.toggle({
      label: 'Perfect Sync nutzen',
      hint: 'ARKit-Blendshapes direkt ansteuern, wenn das Modell sie hat',
      get: (s) => s.tracking.usePerfectSync,
      set: (v) => ({ tracking: { usePerfectSync: v } }),
    }),
    psNote,
    subhead('Emotionen'),
    ui.toggle({
      label: 'Automatische Emotionen',
      hint: 'Fröhlich, wütend, traurig … aus dem Gesichtsausdruck ableiten',
      get: (s) => s.tracking.autoEmotions,
      set: (v) => ({ tracking: { autoEmotions: v } }),
    }),
    EMOTIONS.map((e) => ui.slider({
      label: e.label,
      hint: `Stärke der Emotion „${e.label}“ (0 = deaktiviert)`,
      min: 0, max: 2, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.emotionSensitivity[e.key],
      set: (v) => ({ tracking: { emotionSensitivity: { [e.key]: v } } }),
      enabled: (s) => s.tracking.autoEmotions,
    })),
    subhead('Live-Werte'),
    hint('Die aktuell stärksten Ausdrücke des Avatars – hilfreich beim Feinjustieren.'),
    meterBox,
  );

  return {
    el: sec.el,
    isOpen: () => sec.open,
    tick() {
      const pose = live.lastPose;
      const entries = pose
        ? Object.entries(pose.expressions).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]).slice(0, METER_ROWS)
        : [];
      meters.forEach((m, i) => {
        const e = entries[i];
        toggleClass(m.el, 'hidden', !e);
        if (e) {
          m.setLabel(e[0]);
          m.set(e[1], e[1].toFixed(2).replace('.', ','));
        }
      });
      toggleClass(meterEmpty, 'hidden', entries.length > 0);
    },
  };
}
