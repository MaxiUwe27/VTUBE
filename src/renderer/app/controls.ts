// Declarative, settings-bound UI controls (label + control + value) and layout helpers.
// Each bound control reads its value via `get(settings)` and writes via `set(value) => patch`.
// All bound controls refresh whenever the settings store changes.

import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { SettingsPatch, SettingsStore } from './store';
import { h, icon, setText, toggleClass, type Children } from './dom';
import { toast } from './toast';

export interface Opt<T> { value: T; label: string; title?: string }

interface BaseOpts<T> {
  label: string;
  hint?: string;                         // tooltip on the label
  get(s: Settings): T;
  set(v: T): SettingsPatch;
  enabled?(s: Settings): boolean;
  /** Persistence debounce in ms (default 100 for sliders, 0 for discrete controls). */
  persistDelay?: number;
}

export interface SliderOpts extends BaseOpts<number> {
  min: number;
  max: number;
  step: number;
  format?(v: number): string;
}

export interface SelectOpts<T> extends BaseOpts<T> {
  options: Opt<T>[];
  /** Label for a stored value that is not in the option list (e.g. unplugged device). */
  missingLabel?(v: T): string;
  /** Extra element placed next to the select (e.g. refresh button). */
  extra?: HTMLElement;
  /**
   * When this returns a text, the select shows it (built from the current option's label) instead of
   * the current option, so picking the SAME option again fires a change (e.g. retry a failed camera).
   */
  reselectLabel?(currentLabel: string): string | null;
}

export interface SelectHandle<T> {
  el: HTMLElement;
  setOptions(opts: Opt<T>[]): void;
  /** Re-evaluate reselectLabel / current value (call when outside state changed). */
  refresh(): void;
}

const RESELECT_KEY = '\u0000reselect';

const keyOf = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function safeDefault<T>(get: (s: Settings) => T): T | undefined {
  try {
    return get(DEFAULT_SETTINGS);
  } catch {
    return undefined;
  }
}

function decimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Formatters (German number formatting). */
export const fmt = {
  num: (d: number) => (v: number) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (v: number) => `${Math.round(v * 100)} %`,
  times: (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`,
  deg: (v: number) => `${Math.round(v)}°`,
};

function labelEl(text: string, hint?: string, forId?: string): HTMLLabelElement {
  return h('label', { class: 'ctl-label', title: hint, for: forId }, text, hint ? h('span', { class: 'hint-dot', 'aria-hidden': 'true' }, '?') : null);
}

let idSeq = 0;
const nextId = (p: string) => `${p}-${++idSeq}`;

export class Controls {
  private refreshers: (() => void)[] = [];

  constructor(private readonly store: SettingsStore) {
    store.subscribe(() => this.refreshAll());
  }

  refreshAll(): void {
    for (const r of this.refreshers) r();
  }

  /** Register a custom refresh callback (runs now and on every settings change). */
  bind(fn: () => void): void {
    this.refreshers.push(fn);
    fn();
  }

  private isEnabled(o: { enabled?(s: Settings): boolean }): boolean {
    return o.enabled ? o.enabled(this.store.value) : true;
  }

  slider(o: SliderOpts): HTMLElement {
    const id = nextId('sl');
    const format = o.format ?? fmt.num(decimals(o.step));
    const def = safeDefault(o.get);
    const input = h('input', {
      id, type: 'range', class: 'range',
      min: String(o.min), max: String(o.max), step: String(o.step),
      title: def !== undefined ? `Doppelklick: Standardwert (${format(def)})` : undefined,
    });
    const out = h('output', { class: 'ctl-value', for: id });
    const paint = (v: number) => {
      const p = ((Math.min(o.max, Math.max(o.min, v)) - o.min) / (o.max - o.min)) * 100;
      input.style.setProperty('--p', `${p}%`);
      setText(out, format(v));
    };
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      paint(v);
      this.store.update(o.set(v), o.persistDelay ?? 100);
    });
    if (def !== undefined) {
      input.addEventListener('dblclick', () => this.store.update(o.set(def), 0));
    }
    const row = h('div', { class: 'ctl ctl-slider' }, labelEl(o.label, o.hint, id), input, out);
    this.bind(() => {
      const v = o.get(this.store.value);
      if (parseFloat(input.value) !== v) input.value = String(v);
      paint(v);
      const en = this.isEnabled(o);
      input.disabled = !en;
      toggleClass(row, 'disabled', !en);
    });
    return row;
  }

  toggle(o: BaseOpts<boolean>): HTMLElement {
    const id = nextId('tg');
    const input = h('input', { id, type: 'checkbox', class: 'switch', role: 'switch' });
    input.addEventListener('change', () => this.store.update(o.set(input.checked), o.persistDelay ?? 0));
    const row = h('div', { class: 'ctl ctl-toggle' }, labelEl(o.label, o.hint, id), input);
    this.bind(() => {
      input.checked = o.get(this.store.value);
      const en = this.isEnabled(o);
      input.disabled = !en;
      toggleClass(row, 'disabled', !en);
    });
    return row;
  }

  select<T>(o: SelectOpts<T>): SelectHandle<T> {
    const id = nextId('se');
    const sel = h('select', { id, class: 'select' });
    let options = o.options;
    let reselect: string | null = null;
    const currentLabel = (): string => {
      const v = o.get(this.store.value);
      const opt = options.find((x) => keyOf(x.value) === keyOf(v));
      return opt ? opt.label : o.missingLabel ? o.missingLabel(v) : String(v);
    };
    const wanted = () => (reselect !== null ? RESELECT_KEY : keyOf(o.get(this.store.value)));
    const render = () => {
      const cur = keyOf(o.get(this.store.value));
      reselect = o.reselectLabel ? o.reselectLabel(currentLabel()) : null;
      sel.textContent = '';
      if (reselect !== null) {
        // Shown in the closed select only (hidden in the list), so every list entry is a change.
        sel.appendChild(h('option', { value: RESELECT_KEY, disabled: true, hidden: true }, reselect));
      }
      for (const opt of options) {
        sel.appendChild(h('option', { value: keyOf(opt.value), title: opt.title }, opt.label));
      }
      if (!options.some((x) => keyOf(x.value) === cur)) {
        const v = o.get(this.store.value);
        sel.appendChild(h('option', { value: cur }, o.missingLabel ? o.missingLabel(v) : String(v)));
      }
      sel.value = wanted();
    };
    sel.addEventListener('change', () => {
      const opt = options.find((x) => keyOf(x.value) === sel.value);
      if (opt) this.store.update(o.set(opt.value), o.persistDelay ?? 0);
      else if (sel.value === keyOf(o.get(this.store.value))) {
        // Re-picked the stored (missing) entry: emit the same value again so listeners can react.
        this.store.update(o.set(o.get(this.store.value)), o.persistDelay ?? 0);
      }
    });
    const row = h('div', { class: 'ctl ctl-select' }, labelEl(o.label, o.hint, id),
      h('div', { class: 'select-wrap' }, sel, o.extra ?? null));
    const refresh = () => {
      const want = o.reselectLabel ? o.reselectLabel(currentLabel()) : null;
      if (sel.value !== wanted() || want !== reselect || sel.options.length === 0) render();
      const en = this.isEnabled(o);
      sel.disabled = !en;
      toggleClass(row, 'disabled', !en);
    };
    this.bind(refresh);
    return {
      el: row,
      setOptions: (opts) => {
        options = opts;
        render();
      },
      refresh,
    };
  }

  /** Button group. `stacked` puts the label above a full-width group (for long option labels). */
  segmented<T>(o: BaseOpts<T> & { options: Opt<T>[]; stacked?: boolean }): HTMLElement {
    const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': o.label });
    const buttons = o.options.map((opt) => {
      const b = h('button', { type: 'button', class: 'seg-btn', title: opt.title, role: 'radio' }, opt.label);
      b.addEventListener('click', () => this.store.update(o.set(opt.value), o.persistDelay ?? 0));
      group.appendChild(b);
      return b;
    });
    const row = h('div', { class: `ctl ctl-seg${o.stacked ? ' stacked' : ''}` }, labelEl(o.label, o.hint), group);
    this.bind(() => {
      const cur = keyOf(o.get(this.store.value));
      const en = this.isEnabled(o);
      o.options.forEach((opt, i) => {
        const on = keyOf(opt.value) === cur;
        toggleClass(buttons[i], 'active', on);
        buttons[i].setAttribute('aria-checked', String(on));
        buttons[i].disabled = !en;
      });
      toggleClass(row, 'disabled', !en);
    });
    return row;
  }

  color(o: BaseOpts<string> & { swatches?: { color: string; label: string }[] }): HTMLElement {
    const id = nextId('co');
    const input = h('input', { id, type: 'color', class: 'color' });
    const hex = h('span', { class: 'color-hex' });
    input.addEventListener('input', () => this.store.update(o.set(input.value), o.persistDelay ?? 100));
    const sw = (o.swatches ?? []).map((s) => {
      const b = h('button', { type: 'button', class: 'swatch', title: `${s.label} (${s.color})`, style: { background: s.color } });
      b.addEventListener('click', () => this.store.update(o.set(s.color), 0));
      return b;
    });
    const row = h('div', { class: 'ctl ctl-color' }, labelEl(o.label, o.hint, id),
      h('div', { class: 'color-wrap' }, h('div', { class: 'color-chip' }, input), hex, h('div', { class: 'swatches' }, sw)));
    this.bind(() => {
      const v = o.get(this.store.value).toLowerCase();
      if (input.value.toLowerCase() !== v) input.value = v;
      setText(hex, v.toUpperCase());
      sw.forEach((b, i) => toggleClass(b, 'active', o.swatches![i].color.toLowerCase() === v));
      const en = this.isEnabled(o);
      input.disabled = !en;
      sw.forEach((b) => (b.disabled = !en));
      toggleClass(row, 'disabled', !en);
    });
    return row;
  }

  /** Integer input, committed on change/Enter, validated against min/max. */
  number(o: BaseOpts<number> & { min: number; max: number }): HTMLElement {
    const id = nextId('nu');
    const input = h('input', { id, type: 'number', class: 'text num', min: String(o.min), max: String(o.max), step: '1' });
    const commit = () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v < o.min || v > o.max) {
        toast(`Ungültiger Wert – erlaubt ist ${o.min} bis ${o.max}.`, 'error');
        input.value = String(o.get(this.store.value));
        return;
      }
      if (v !== o.get(this.store.value)) this.store.update(o.set(v), 0);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    const row = h('div', { class: 'ctl ctl-input' }, labelEl(o.label, o.hint, id), input);
    this.bind(() => {
      if (document.activeElement !== input) input.value = String(o.get(this.store.value));
      const en = this.isEnabled(o);
      input.disabled = !en;
      toggleClass(row, 'disabled', !en);
    });
    return row;
  }

  /** Free text with suggestions (datalist), committed on change/Enter. */
  text(o: BaseOpts<string> & { placeholder?: string; extra?: HTMLElement }): { el: HTMLElement; setSuggestions(v: (string | { value: string; label?: string })[]): void } {
    const id = nextId('tx');
    const listId = `${id}-list`;
    const list = h('datalist', { id: listId });
    const input = h('input', { id, type: 'text', class: 'text', list: listId, placeholder: o.placeholder, spellcheck: false });
    const commit = () => {
      const v = input.value.trim();
      if (v && v !== o.get(this.store.value)) this.store.update(o.set(v), 0);
      else if (!v) input.value = o.get(this.store.value);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    const row = h('div', { class: 'ctl ctl-input' }, labelEl(o.label, o.hint, id),
      h('div', { class: 'select-wrap' }, input, list, o.extra ?? null));
    this.bind(() => {
      if (document.activeElement !== input) input.value = o.get(this.store.value);
      const en = this.isEnabled(o);
      input.disabled = !en;
      toggleClass(row, 'disabled', !en);
    });
    return {
      el: row,
      setSuggestions: (vals) => {
        list.textContent = '';
        for (const v of vals) {
          list.appendChild(typeof v === 'string' ? h('option', { value: v }) : h('option', { value: v.value, label: v.label }));
        }
      },
    };
  }
}

// --- Layout helpers ---------------------------------------------------------------------------

const SECTION_KEY = 'vtube.sections.open';

function loadOpenSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTION_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function saveOpenSection(id: string, open: boolean): void {
  try {
    const m = loadOpenSections();
    m[id] = open;
    localStorage.setItem(SECTION_KEY, JSON.stringify(m));
  } catch {
    /* per-viewer convenience only */
  }
}

export interface SectionHandle {
  el: HTMLElement;
  body: HTMLElement;
  badge: HTMLElement;
  readonly open: boolean;
  setOpen(open: boolean): void;
}

export function section(id: string, title: string, iconName: string, defaultOpen: boolean, ...children: Children): SectionHandle {
  const stored = loadOpenSections()[id];
  let open = stored ?? defaultOpen;
  const badge = h('span', { class: 'section-badge' });
  const header = h('button', { type: 'button', class: 'section-head', 'aria-expanded': String(open) },
    icon(iconName, 'section-icon'), h('span', { class: 'section-title' }, title), badge, icon('chevron', 'chev'));
  const body = h('div', { class: 'section-body' }, ...children);
  const el = h('section', { class: 'section', id: `sec-${id}` }, header, body);
  const apply = () => {
    toggleClass(el, 'open', open);
    header.setAttribute('aria-expanded', String(open));
  };
  const handle: SectionHandle = {
    el, body, badge,
    get open() { return open; },
    setOpen(v) {
      open = v;
      apply();
      saveOpenSection(id, v);
    },
  };
  header.addEventListener('click', () => handle.setOpen(!open));
  apply();
  return handle;
}

export function subhead(text: string, extra?: HTMLElement): HTMLElement {
  return h('div', { class: 'subhead' }, h('span', null, text), extra ?? null);
}

export function hint(...children: Children): HTMLElement {
  return h('p', { class: 'hint' }, ...children);
}

export interface ButtonOpts {
  icon?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  title?: string;
  small?: boolean;
  onClick?(e: MouseEvent): void;
}

export function button(label: string, o: ButtonOpts = {}): HTMLButtonElement {
  const b = h('button', {
    type: 'button',
    class: `btn btn-${o.variant ?? 'secondary'}${o.small ? ' btn-sm' : ''}${label ? '' : ' btn-icon'}`,
    title: o.title,
    'aria-label': label ? undefined : o.title,
  }, o.icon ? icon(o.icon) : null, label ? h('span', null, label) : null);
  if (o.onClick) b.addEventListener('click', o.onClick);
  return b;
}

export function iconButton(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
  return button('', { icon: iconName, title, variant: 'ghost', small: true, onClick });
}

/** Monospace box with a copy button. */
export function codeBox(text: string | (() => string), copyLabel = 'Kopieren'): { el: HTMLElement; setText(t: string): void } {
  const code = h('code', null, typeof text === 'string' ? text : text());
  const copy = button('', {
    icon: 'copy', title: copyLabel, variant: 'ghost', small: true,
    onClick: () => {
      try {
        window.vtube.copyToClipboard(code.textContent ?? '');
        toast('In die Zwischenablage kopiert.', 'success', 1800);
      } catch {
        toast('Kopieren fehlgeschlagen.', 'error');
      }
    },
  });
  const el = h('div', { class: 'codebox' }, code, copy);
  return { el, setText: (t) => setText(code, t) };
}

/** Key/value info grid. Returns setters per key. */
export function infoGrid(rows: { key: string; label: string }[]): { el: HTMLElement; set(key: string, value: string | Node, cls?: string): void } {
  const cells = new Map<string, HTMLElement>();
  const el = h('dl', { class: 'info-grid' });
  for (const r of rows) {
    const dd = h('dd', null, '–');
    cells.set(r.key, dd);
    el.append(h('dt', null, r.label), dd);
  }
  return {
    el,
    set(key, value, cls = '') {
      const dd = cells.get(key);
      if (!dd) return;
      if (typeof value === 'string') setText(dd, value);
      else if (dd.firstChild !== value) dd.replaceChildren(value);
      if (dd.className !== cls) dd.className = cls;
    },
  };
}

/** Horizontal level bar with label and value. */
export function meter(label: string, opts: { marker?: boolean } = {}): { el: HTMLElement; set(v: number, text?: string): void; setLabel(t: string): void; setMarker(v: number): void } {
  const fill = h('div', { class: 'meter-fill' });
  const marker = opts.marker ? h('div', { class: 'meter-marker' }) : null;
  const lab = h('span', { class: 'meter-label' }, label);
  const val = h('span', { class: 'meter-value' });
  const el = h('div', { class: 'meter' }, lab, h('div', { class: 'meter-track' }, fill, marker), val);
  let last = -1;
  return {
    el,
    set(v, text) {
      const c = Math.max(0, Math.min(1, v));
      if (Math.abs(c - last) > 0.002) {
        fill.style.transform = `scaleX(${c})`;
        last = c;
      }
      setText(val, text ?? `${Math.round(c * 100)}`);
    },
    setLabel(t) {
      setText(lab, t);
      lab.title = t;
    },
    setMarker(v) {
      if (marker) marker.style.left = `${Math.max(0, Math.min(1, v)) * 100}%`;
    },
  };
}

export function statusDot(state: 'ok' | 'warn' | 'error' | 'off'): HTMLElement {
  return h('span', { class: `dot dot-${state}` });
}
