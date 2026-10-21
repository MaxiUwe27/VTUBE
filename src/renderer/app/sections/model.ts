// 1. Modell: open dialog, recent list, current model info.

import { basename, dirname, type AppContext, type SectionModule } from '../context';
import { button, hint, infoGrid, section, subhead } from '../controls';
import { h, icon, setChildren, toggleClass } from '../dom';
import { expressionDiagnostics, isUnusedExpression } from './expressionDiag';

export function modelSection(ctx: AppContext): SectionModule {
  const { store, live, actions } = ctx;

  const openBtn = button('VRM öffnen…', {
    icon: 'folder', variant: 'primary', title: 'VRM-Datei auswählen (Strg+O)',
    onClick: () => void actions.openModelDialog(),
  });

  const info = infoGrid([
    { key: 'name', label: 'Name' },
    { key: 'version', label: 'VRM-Version' },
    { key: 'ps', label: 'Perfect Sync' },
    { key: 'expr', label: 'Expressions' },
    { key: 'lookat', label: 'Blicksteuerung' },
    { key: 'file', label: 'Datei' },
  ]);
  const empty = h('div', { class: 'card-empty' }, 'Kein Modell geladen.');
  const infoCard = h('div', { class: 'card' }, empty, info.el);

  const recentList = h('ul', { class: 'recent' });

  const renderInfo = () => {
    const m = live.model;
    toggleClass(infoCard, 'is-empty', !m);
    toggleClass(infoCard, 'is-loading', live.modelLoading);
    empty.textContent = live.modelLoading ? 'Modell wird geladen…' : 'Kein Modell geladen.';
    if (!m) return;
    info.set('name', m.info.name || m.fileName);
    info.set('version', m.info.version === '1' ? 'VRM 1.0' : 'VRM 0.x');
    info.set('ps', m.info.hasPerfectSync ? 'Ja (ARKit 52)' : 'Nein', m.info.hasPerfectSync ? 'good' : 'muted');
    const mapped = m.info.mappedExpressions?.length ?? 0;
    const emptyN = m.info.emptyExpressions?.filter((n) => !isUnusedExpression(n)).length ?? 0;
    info.set('expr', `${m.info.expressionNames.length} nutzbar${mapped ? ` · ${mapped} zugeordnet` : ''}${emptyN ? ` · ${emptyN} leer` : ''}`,
      m.info.expressionNames.length ? '' : 'warn');
    info.set('lookat', m.info.hasLookAt ? 'Ja' : 'Nein');
    info.set('file', m.fileName);
    const fileCell = info.el.querySelector('dd:last-of-type');
    if (fileCell) (fileCell as HTMLElement).title = m.path ?? m.fileName;
  };

  const renderRecent = () => {
    const recent = store.value.model.recent;
    const current = live.model?.path ?? null;
    if (!recent.length) {
      setChildren(recentList, h('li', { class: 'recent-empty' }, 'Noch keine Modelle geöffnet.'));
      return;
    }
    setChildren(recentList, recent.map((path) => {
      const item = h('button', { type: 'button', class: 'recent-item', title: `${path}\nKlicken zum Laden` },
        icon('user', 'recent-icon'),
        h('span', { class: 'recent-text' },
          h('span', { class: 'recent-name' }, basename(path).replace(/\.vrm$/i, '')),
          h('span', { class: 'recent-path' }, h('span', null, dirname(path)))));
      item.addEventListener('click', () => void actions.loadModelPath(path));
      const remove = button('', {
        icon: 'close', variant: 'ghost', small: true, title: 'Aus der Liste entfernen',
        onClick: (e) => {
          e.stopPropagation();
          store.update({ model: { recent: store.value.model.recent.filter((p) => p !== path) } }, 0);
        },
      });
      return h('li', { class: `recent-row${path === current ? ' current' : ''}` }, item, remove);
    }));
  };

  let lastRecentKey = '';
  ctx.ui.bind(() => {
    const key = store.value.model.recent.join('\n') + '|' + (live.model?.path ?? '');
    if (key !== lastRecentKey) {
      lastRecentKey = key;
      renderRecent();
    }
  });
  const diag = expressionDiagnostics(ctx);
  ctx.on('model', () => {
    renderInfo();
    lastRecentKey = '';
    renderRecent();
    diag.render();
  });
  renderInfo();
  diag.render();

  const sec = section('model', 'Modell', 'user', true,
    h('div', { class: 'btn-row' }, openBtn),
    hint('Oder eine ', h('b', null, '.vrm'), '-Datei einfach ins Fenster ziehen.'),
    infoCard,
    diag.el,
    subhead('Zuletzt verwendet'),
    recentList,
  );
  ctx.on('model', () => {
    sec.badge.textContent = live.model ? `VRM ${live.model.info.version === '1' ? '1.0' : '0.x'}` : '';
  });

  return { el: sec.el, isOpen: () => sec.open, tick: () => diag.tick() };
}
