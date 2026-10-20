// Avatar viewport chrome: empty state, loading pill, calibration countdown, optional FPS badge,
// hover-only panel button and the window-wide drag & drop overlay.
// The canvas itself stays clean (important for OBS window capture).

import type { AppContext } from './context';
import { button } from './controls';
import { h, icon, setText, toggleClass } from './dom';
import { toast } from './toast';

export function setupViewport(ctx: AppContext, viewport: HTMLElement, app: HTMLElement): { tick(now: number): void } {
  const { live, actions, store, ui, renderer } = ctx;

  // --- Empty state / loading ------------------------------------------------------------------
  const empty = h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon('upload')),
    h('div', { class: 'empty-title' }, 'VRM-Datei hierher ziehen oder Modell öffnen'),
    h('div', { class: 'empty-sub' }, 'Unterstützt VRM 0.x und VRM 1.0'),
    button('Modell öffnen…', { icon: 'folder', variant: 'primary', onClick: () => void actions.openModelDialog() }));
  const loading = h('div', { class: 'loading-pill' }, h('span', { class: 'spinner' }), 'Modell wird geladen…');
  const countdown = h('div', { class: 'countdown' });
  const fpsBadge = h('div', { class: 'fps-badge' });
  const fab = h('button', { type: 'button', class: 'panel-fab', title: 'Seitenleiste öffnen (Tab)', 'aria-label': 'Seitenleiste öffnen' }, icon('panel'));
  fab.addEventListener('click', () => actions.togglePanel(true));
  viewport.append(empty, loading, countdown, fpsBadge, fab);

  const renderModelState = () => {
    toggleClass(empty, 'visible', !live.model && !live.modelLoading);
    toggleClass(loading, 'visible', live.modelLoading);
  };
  ctx.on('model', renderModelState);
  renderModelState();

  ctx.on('calibration', () => {
    const n = live.calibrationCountdown;
    toggleClass(countdown, 'visible', n !== null);
    if (n !== null) {
      countdown.replaceChildren(h('div', { class: 'countdown-num' }, String(n)), h('div', { class: 'countdown-text' }, 'Neutral schauen und stillhalten'));
    }
  });

  // Background behind the canvas (visible before the first frame / in transparent mode).
  ui.bind(() => {
    const bg = store.value.view.background;
    toggleClass(viewport, 'transparent-bg', bg.mode === 'transparent');
    viewport.style.backgroundColor = bg.mode === 'color' ? bg.color : '';
    toggleClass(fpsBadge, 'visible', store.value.view.showFps);
  });

  // --- Hover reveal for the panel button (no permanent overlay on the avatar) -----------------
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const reveal = () => {
    app.classList.add('hovering');
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => app.classList.remove('hovering'), 2200);
  };
  viewport.addEventListener('mousemove', reveal);
  viewport.addEventListener('mouseleave', () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    app.classList.remove('hovering');
  });

  // --- Drag & drop (whole window) ---------------------------------------------------------------
  const drop = h('div', { class: 'drop-overlay' },
    h('div', { class: 'drop-box' }, icon('upload'), h('div', { class: 'drop-title' }, 'VRM-Datei loslassen zum Laden')));
  document.body.appendChild(drop);
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    drop.classList.add('visible');
  });
  window.addEventListener('dragover', (e) => {
    // Always prevent default so Electron never navigates to a dropped file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) drop.classList.remove('visible');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('visible');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const vrm = files.find((f) => /\.vrm$/i.test(f.name));
    if (!vrm) {
      toast(`„${files[0].name}“ ist keine VRM-Datei. Bitte eine .vrm-Datei verwenden.`, 'error');
      return;
    }
    void actions.loadDroppedFile(vrm);
  });

  let lastFpsAt = 0;
  return {
    tick(now) {
      if (store.value.view.showFps && now - lastFpsAt > 500) {
        lastFpsAt = now;
        setText(fpsBadge, `${Math.round(renderer.fps)} FPS`);
      }
    },
  };
}
