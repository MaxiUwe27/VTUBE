// 8. Über / Hilfe: version + shortcuts.

import { version } from '../../../../package.json';
import type { AppContext, SectionModule } from '../context';
import { hint, infoGrid, section, subhead } from '../controls';
import { h } from '../dom';

const SHORTCUTS: [string[], string][] = [
  [['Tab'], 'Seitenleiste ein-/ausblenden'],
  [['F1'], 'Seitenleiste ein-/ausblenden'],
  [['C'], 'Kalibrieren (neutrales Gesicht)'],
  [['Strg', 'O'], 'Modell öffnen'],
  [['F11'], 'Vollbild'],
  [['Doppelklick'], 'Regler auf Standardwert'],
];

export function aboutSection(_ctx: AppContext): SectionModule {
  const info = infoGrid([
    { key: 'version', label: 'Version' },
    { key: 'platform', label: 'Plattform' },
  ]);
  info.set('version', version);
  info.set('platform', window.vtube?.platform ?? navigator.platform);

  const sec = section('about', 'Über & Hilfe', 'info', false,
    info.el,
    subhead('Tastenkürzel'),
    h('dl', { class: 'shortcuts' },
      SHORTCUTS.map(([keys, text]) => [
        h('dt', null, keys.map((k, i) => [i ? ' + ' : '', h('kbd', null, k)]).flat()),
        h('dd', null, text),
      ]).flat()),
    subhead('Kurzanleitung'),
    h('ol', { class: 'steps' },
      h('li', null, 'VRM-Modell öffnen oder ins Fenster ziehen.'),
      h('li', null, 'Kamera wählen und einmal ', h('b', null, 'kalibrieren'), ' (neutrales Gesicht).'),
      h('li', null, 'In OBS die Browser-Quelle oder die virtuelle Kamera verwenden.')),
    hint('Alle Einstellungen werden automatisch gespeichert.'),
  );
  return { el: sec.el, isOpen: () => sec.open };
}
