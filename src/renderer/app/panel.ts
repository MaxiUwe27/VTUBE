// Right side panel: header with live status chips + collapsible, scrollable sections.

import type { AppContext, SectionModule } from './context';
import { h, icon, setText, toggleClass } from './dom';
import { modelSection } from './sections/model';
import { trackingSection } from './sections/tracking';
import { motionSection } from './sections/motion';
import { expressionsSection } from './sections/expressions';
import { lipSyncSection } from './sections/lipsync';
import { viewSection } from './sections/view';
import { outputSection } from './sections/output';
import { aboutSection } from './sections/about';

function chip(label: string, title: string): { el: HTMLElement; set(state: 'ok' | 'warn' | 'error' | 'off'): void } {
  const dot = h('span', { class: 'dot dot-off' });
  const el = h('span', { class: 'chip', title }, dot, label);
  return {
    el,
    set(state) {
      const cls = `dot dot-${state}`;
      if (dot.className !== cls) dot.className = cls;
      toggleClass(el, 'chip-on', state !== 'off');
    },
  };
}

export function buildPanel(ctx: AppContext, panel: HTMLElement): { tick(now: number): void } {
  const { live, store, renderer, tracker, actions } = ctx;

  const renderFps = h('span', { class: 'stat-num' }, '–');
  const trackFps = h('span', { class: 'stat-num' }, '–');
  const chips = {
    track: chip('Kamera', 'Gesichts-Tracking'),
    mic: chip('Mikro', 'Lip-Sync'),
    obs: chip('OBS', 'Browser-Quelle für OBS'),
    vcam: chip('VCam', 'Virtuelle Kamera'),
  };

  const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', title: 'Seitenleiste ausblenden (Tab)', 'aria-label': 'Seitenleiste ausblenden' }, icon('panelClose'));
  closeBtn.addEventListener('click', () => actions.togglePanel(false));

  const header = h('header', { class: 'panel-head' },
    h('div', { class: 'brand-row' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'V'), h('span', null, 'VTube ', h('b', null, 'Linux'))),
      closeBtn),
    h('div', { class: 'stats-row' },
      h('span', { class: 'stat', title: 'Gemessene Render-Bildrate' }, h('span', { class: 'stat-unit' }, 'Render'), renderFps, h('span', { class: 'stat-unit' }, 'FPS')),
      h('span', { class: 'stat', title: 'Verarbeitete Kamerabilder pro Sekunde' }, h('span', { class: 'stat-unit' }, 'Tracking'), trackFps, h('span', { class: 'stat-unit' }, 'FPS'))),
    h('div', { class: 'chips-row' }, Object.values(chips).map((c) => c.el)));

  const sections: SectionModule[] = [
    modelSection(ctx),
    trackingSection(ctx),
    motionSection(ctx),
    expressionsSection(ctx),
    lipSyncSection(ctx),
    viewSection(ctx),
    outputSection(ctx),
    aboutSection(ctx),
  ];
  const scroll = h('div', { class: 'panel-scroll' }, sections.map((s) => s.el));
  panel.append(header, scroll);

  const renderChips = () => {
    const t = live.tracker.state;
    chips.track.set(t === 'running' ? 'ok' : t === 'error' ? 'error' : t === 'starting' ? 'warn' : 'off');
    const l = live.lipSync.state;
    chips.mic.set(l === 'running' ? 'ok' : l === 'error' ? 'error' : l === 'starting' ? 'warn' : 'off');
    const obsOn = store.value.output.browserSource.enabled;
    chips.obs.set(!obsOn ? 'off' : live.server?.running ? 'ok' : live.server ? 'error' : 'warn');
    chips.vcam.set(live.vcam.running ? 'ok' : live.vcam.error ? 'error' : 'off');
  };
  for (const ev of ['tracker', 'lipsync', 'server', 'vcam'] as const) ctx.on(ev, renderChips);
  ctx.ui.bind(renderChips);

  let lastStatsAt = 0;
  return {
    tick(now) {
      if (now - lastStatsAt > 500) {
        lastStatsAt = now;
        setText(renderFps, String(Math.round(renderer.fps)));
        setText(trackFps, live.tracker.state === 'running' ? String(Math.round(tracker.fps)) : '–');
      }
      for (const s of sections) if (s.tick && s.isOpen()) s.tick(now);
    },
  };
}
