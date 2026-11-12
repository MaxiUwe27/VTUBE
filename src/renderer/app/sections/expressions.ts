// 4. Mimik & Emotionen: sensitivities, emotions, Perfect Sync, live expression meters.

import type { EmotionKey, Settings } from '../../../shared/settings';
import type { AppContext, SectionModule } from '../context';
import { fmt, hint, meter, more, section, subhead } from '../controls';
import { h, setText, toggleClass } from '../dom';

const EMOTIONS: { key: EmotionKey; label: string }[] = [
  { key: 'happy', label: 'Fröhlich' },
  { key: 'angry', label: 'Wütend' },
  { key: 'sad', label: 'Traurig' },
  { key: 'relaxed', label: 'Entspannt' },
  { key: 'surprised', label: 'Überrascht' },
];

// --- Live-Werte ------------------------------------------------------------------------------
// Fixed rows in a fixed order (2 columns, row by row) – the display never changes its size while
// the values update; only the bar widths and the (tabular) numbers change.

/** Pose expressions with lower-cased names (ARKit names differ in case between models). */
type Ex = Map<string, number>;
interface LiveRow { label: string; source: string; get(e: Ex): number }

const val = (e: Ex, n: string) => e.get(n) ?? 0;
const pair = (e: Ex, n: string) => Math.max(val(e, `${n}left`), val(e, `${n}right`));
const one = (label: string, name: string): LiveRow => ({ label, source: name, get: (e) => val(e, name.toLowerCase()) });
const both = (label: string, name: string): LiveRow => ({ label, source: `${name}Left/Right`, get: (e) => pair(e, name.toLowerCase()) });

/** VRM presets. "blink" closes both eyes, so it counts for left and right. */
const STD_ROWS: LiveRow[] = [
  { label: 'Blinzeln L', source: 'blink + blinkLeft', get: (e) => Math.min(1, val(e, 'blink') + val(e, 'blinkleft')) },
  { label: 'Blinzeln R', source: 'blink + blinkRight', get: (e) => Math.min(1, val(e, 'blink') + val(e, 'blinkright')) },
  one('A', 'aa'), one('Fröhlich', 'happy'),
  one('E', 'ee'), one('Wütend', 'angry'),
  one('I', 'ih'), one('Traurig', 'sad'),
  one('O', 'oh'), one('Entspannt', 'relaxed'),
  one('U', 'ou'), one('Überrascht', 'surprised'),
];

/** Perfect Sync: the solver drives ARKit blendshapes (presets and emotions are 0) – same 12 slots. */
const PS_ROWS: LiveRow[] = [
  one('Blinzeln L', 'eyeBlinkLeft'), one('Blinzeln R', 'eyeBlinkRight'),
  one('Kiefer', 'jawOpen'), one('Brauen ↑', 'browInnerUp'),
  both('Breit', 'mouthStretch'), both('Brauen ↓', 'browDown'),
  one('Spitz', 'mouthPucker'), both('Augen weit', 'eyeWide'),
  one('Rund', 'mouthFunnel'), both('Augen eng', 'eyeSquint'),
  both('Lächeln', 'mouthSmile'), both('Mundwinkel ↓', 'mouthFrown'),
];

export function expressionsSection(ctx: AppContext): SectionModule {
  const { ui, live, store } = ctx;

  /** Perfect sync active: the solver drives ARKit shapes directly and zeroes the preset emotions. */
  const psActive = (s: Settings) => !!live.model?.info.hasPerfectSync && s.tracking.usePerfectSync;
  const emoNote = hint('Bei Perfect Sync steuert das Gesicht die ARKit-Blendshapes direkt – automatische Emotionen sind dann aus.');
  ui.bind(() => toggleClass(emoNote, 'hidden', !psActive(store.value)));

  const psNote = hint('');
  const updatePsNote = () => {
    const m = live.model;
    psNote.textContent = !m
      ? 'Perfect Sync steuert die 52 ARKit-Blendshapes direkt, falls das Modell sie besitzt.'
      : m.info.hasPerfectSync
        ? 'Dieses Modell unterstützt Perfect Sync – feinere Mimik möglich.'
        : 'Dieses Modell hat keine Perfect-Sync-Blendshapes – es werden die VRM-Standardausdrücke genutzt.';
  };
  ctx.on('model', () => {
    updatePsNote();
    ui.refreshAll(); // re-evaluate the emotion controls (enabled state depends on the model)
  });
  updatePsNote();

  const meters = STD_ROWS.map((r) => meter(r.label, { stacked: true }));
  const liveCaption = h('span', { class: 'live-caption' });
  const liveChip = h('span', { class: 'live-chip', title: 'Leuchtet, solange Tracking oder Lip-Sync Werte liefern' }, 'LIVE');
  const meterBox = h('div', { class: 'card meter-card' },
    h('div', { class: 'live-head' }, liveCaption, liveChip),
    h('div', { class: 'live-grid' }, meters.map((m) => m.el)));
  let rows: LiveRow[] | null = null;
  const setRows = (next: LiveRow[]) => {
    if (rows === next) return;
    rows = next;
    next.forEach((r, i) => {
      meters[i].setLabel(r.label);
      meters[i].el.title = `${r.label}: ${r.source}`;
    });
    setText(liveCaption, next === PS_ROWS ? 'Perfect Sync (ARKit-Blendshapes), 0–100' : 'Ausdrücke des Avatars, 0–100');
  };
  const ex: Ex = new Map();

  const sec = section('expressions', 'Mimik & Emotionen', 'smile', false,
    ui.slider({
      label: 'Blinzeln',
      hint: 'Empfindlichkeit: höher = Augen schließen sich leichter',
      min: 0.2, max: 2.5, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.blinkSensitivity,
      set: (v) => ({ tracking: { blinkSensitivity: v } }),
    }),
    ui.slider({
      label: 'Mund',
      hint: 'Empfindlichkeit der Mundbewegungen',
      min: 0.2, max: 2.5, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.mouthSensitivity,
      set: (v) => ({ tracking: { mouthSensitivity: v } }),
    }),
    ui.toggle({
      label: 'Automatische Emotionen',
      hint: 'Fröhlich, wütend, traurig … aus dem Gesichtsausdruck ableiten',
      get: (s) => s.tracking.autoEmotions,
      set: (v) => ({ tracking: { autoEmotions: v } }),
      enabled: (s) => !psActive(s),
    }),
    emoNote,
    subhead('Live-Werte'),
    meterBox,
    more('expressions',
      ui.slider({
        label: 'Augenbrauen',
        hint: 'Empfindlichkeit der Augenbrauen',
        min: 0.2, max: 2.5, step: 0.05, format: fmt.times,
        get: (s) => s.tracking.browSensitivity,
        set: (v) => ({ tracking: { browSensitivity: v } }),
      }),
      ui.toggle({
        label: 'Augen gemeinsam',
        hint: 'Blinzeln beider Augen koppeln (verhindert ungewolltes Zwinkern)',
        get: (s) => s.tracking.linkBlinks,
        set: (v) => ({ tracking: { linkBlinks: v } }),
      }),
      ui.toggle({
        label: 'Perfect Sync',
        hint: 'ARKit-Blendshapes direkt ansteuern, wenn das Modell sie hat',
        get: (s) => s.tracking.usePerfectSync,
        set: (v) => ({ tracking: { usePerfectSync: v } }),
      }),
      psNote,
      subhead('Stärke der Emotionen'),
      EMOTIONS.map((e) => ui.slider({
        label: e.label,
        hint: `Stärke der Emotion „${e.label}“ (0 = deaktiviert)`,
        min: 0, max: 2, step: 0.05, format: fmt.times,
        get: (s) => s.tracking.emotionSensitivity[e.key],
        set: (v) => ({ tracking: { emotionSensitivity: { [e.key]: v } } }),
        enabled: (s) => s.tracking.autoEmotions && !psActive(s),
      })),
    ),
  );
  // Row set follows the solver mode (re-evaluated on settings changes and model loads via refreshAll).
  ui.bind(() => setRows(psActive(store.value) ? PS_ROWS : STD_ROWS));

  return {
    el: sec.el,
    isOpen: () => sec.open,
    tick(now) {
      const pose = live.lastPose;
      ex.clear();
      if (pose) for (const k in pose.expressions) ex.set(k.toLowerCase(), pose.expressions[k]);
      const cur = rows ?? STD_ROWS;
      for (let i = 0; i < cur.length; i++) meters[i].set(pose ? cur[i].get(ex) : 0);
      const fresh = (live.tracker.state === 'running' && now - live.lastFaceAt < 500) || live.lipSync.state === 'running';
      toggleClass(liveChip, 'on', fresh);
    },
  };
}
