// 5. Lip-Sync (Mikrofon): enable, device, gain, noise gate, camera↔audio mix, live meters.

import { LipSync } from '../../audio/LipSync';
import type { AppContext, SectionModule } from '../context';
import { fmt, hint, iconButton, meter, section, type Opt } from '../controls';
import { h, toggleClass } from '../dom';
import { toast } from '../toast';

const VISEMES = ['aa', 'ee', 'ih', 'oh', 'ou'] as const; // German vowel order A E I O U
const VISEME_LABEL: Record<(typeof VISEMES)[number], string> = { aa: 'A', ih: 'I', ou: 'U', ee: 'E', oh: 'O' };

export function lipSyncSection(ctx: AppContext): SectionModule {
  const { ui, live, store } = ctx;

  const refreshBtn = iconButton('refresh', 'Mikrofonliste aktualisieren', () => void loadMics(true));
  const micSelect = ui.select<string | null>({
    label: 'Mikrofon',
    options: [{ value: null, label: 'Standard-Mikrofon' }],
    get: (s) => s.lipSync.deviceId,
    set: (v) => ({ lipSync: { deviceId: v } }),
    missingLabel: () => 'Gespeichertes Mikrofon (nicht gefunden)',
    extra: refreshBtn,
  });

  async function loadMics(manual = false): Promise<void> {
    try {
      const mics = await LipSync.listMicrophones();
      const opts: Opt<string | null>[] = [{ value: null, label: 'Standard-Mikrofon' }];
      mics.forEach((m, i) => {
        if (m.deviceId && m.deviceId !== 'default') opts.push({ value: m.deviceId, label: m.label || `Mikrofon ${i + 1}` });
      });
      micSelect.setOptions(opts);
      if (manual) toast(`${opts.length - 1} Mikrofon${opts.length === 2 ? '' : 'e'} gefunden.`, 'info', 2000);
    } catch (err) {
      if (manual) toast('Mikrofone konnten nicht aufgelistet werden.', 'error');
      console.warn('[ui] listMicrophones failed', err);
    }
  }
  void loadMics();
  let labelsLoaded = false;
  ctx.on('lipsync', () => {
    if (live.lipSync.state === 'running' && !labelsLoaded) {
      labelsLoaded = true;
      void loadMics();
    }
    renderState();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void loadMics());

  const volume = meter('Pegel', { marker: true });
  volume.el.classList.add('meter-lg');
  const visemeMeters = VISEMES.map((v) => meter(VISEME_LABEL[v]));
  const levelCard = h('div', { class: 'card meter-card' },
    volume.el,
    h('div', { class: 'viseme-grid' }, visemeMeters.map((m) => m.el)));
  const errorBox = h('div', { class: 'alert alert-error hidden' });

  const sec = section('lipsync', 'Lip-Sync (Mikrofon)', 'mic', false,
    ui.toggle({
      label: 'Lip-Sync aktiv',
      hint: 'Mundbewegung zusätzlich aus dem Mikrofon berechnen',
      get: (s) => s.lipSync.enabled,
      set: (v) => ({ lipSync: { enabled: v } }),
    }),
    micSelect.el,
    ui.slider({
      label: 'Verstärkung',
      hint: 'Eingangsverstärkung des Mikrofons',
      min: 0, max: 5, step: 0.1, format: fmt.times,
      get: (s) => s.lipSync.gain,
      set: (v) => ({ lipSync: { gain: v } }),
    }),
    ui.slider({
      label: 'Rauschsperre',
      hint: 'Leise Geräusche unterhalb dieser Schwelle werden ignoriert (Markierung im Pegel)',
      min: 0, max: 0.5, step: 0.01, format: fmt.pct,
      get: (s) => s.lipSync.noiseGate,
      set: (v) => ({ lipSync: { noiseGate: v } }),
    }),
    h('div', { class: 'mix-wrap' },
      ui.slider({
        label: 'Mischung',
        hint: 'Links: Mund nur aus der Kamera · Rechts: Mund nur aus dem Mikrofon',
        min: 0, max: 1, step: 0.01, format: fmt.pct,
        get: (s) => s.lipSync.mix,
        set: (v) => ({ lipSync: { mix: v } }),
      }),
      h('div', { class: 'mix-scale' }, h('span', null, 'Kamera'), h('span', null, 'Audio'))),
    errorBox,
    levelCard,
    hint('Tipp: Rauschsperre knapp über das Grundrauschen stellen, sodass der Pegel in Sprechpausen bei 0 bleibt.'),
  );

  function renderState(): void {
    const st = live.lipSync;
    errorBox.textContent = st.error ?? '';
    toggleClass(errorBox, 'hidden', !(st.state === 'error' && st.error));
    toggleClass(levelCard, 'inactive', st.state !== 'running');
    sec.badge.textContent = st.state === 'running' ? 'aktiv' : st.state === 'error' ? 'Fehler' : '';
    sec.badge.className = `section-badge ${st.state === 'running' ? 'ok' : st.state === 'error' ? 'error' : ''}`;
  }
  renderState();

  return {
    el: sec.el,
    isOpen: () => sec.open,
    tick() {
      const vf = live.lipSync.state === 'running' ? live.lastViseme : null;
      volume.setMarker(store.value.lipSync.noiseGate);
      volume.set(vf?.volume ?? 0);
      VISEMES.forEach((v, i) => visemeMeters[i].set(vf?.visemes[v] ?? 0));
    },
  };
}
