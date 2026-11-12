// "Ausdrücke (Diagnose)" inside the Modell section: every model expression with kind, binds,
// automatic mapping, live tracking value and a hold-to-test slider; morph-target list; JSON dump
// for support ("Diagnose kopieren").

import type { ExpressionReport, ExpressionReportEntry } from '../../avatar/expressionSetup';
import type { AppContext } from '../context';
import { button, hint } from '../controls';
import { h, setChildren, setText, toggleClass } from '../dom';
import { toast } from '../toast';

const KIND_LABEL: Record<ExpressionReportEntry['kind'], string> = {
  preset: 'Preset',
  custom: 'Benutzerdefiniert',
  mapped: 'Automatisch zugeordnet',
};

/** Solver presets: if fewer than this many are usable (and no perfect sync), warn after loading. */
const CORE = ['aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

/** Expressions VTube Linux never drives (gaze goes through the lookAt bones/applier). An empty one is normal. */
const UNUSED = new Set(['neutral', 'lookup', 'lookdown', 'lookleft', 'lookright']);
export const isUnusedExpression = (name: string) => UNUSED.has(name.toLowerCase());

/** Number of usable standard expressions (blink counts once: "blink" or both "blinkLeft"+"blinkRight"). */
export function usableStandardCount(names: string[]): number {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const blink = lower.has('blink') || (lower.has('blinkleft') && lower.has('blinkright'));
  return CORE.filter((n) => lower.has(n)).length + (blink ? 1 : 0);
}

interface Row {
  name: string;
  fill: HTMLElement | null;
  value: HTMLElement | null;
}

const fmt2 = (v: number) => v.toFixed(2).replace('.', ',');

export function expressionDiagnostics(ctx: AppContext): { el: HTMLElement; render(): void; tick(): void } {
  const { renderer, live } = ctx;

  const summaryText = h('span', { class: 'diag-sum' });
  const repairsBox = h('div', { class: 'alert alert-warn hidden' });
  const list = h('div', { class: 'diag-list' });
  const morphSummary = h('summary', null, 'Morph-Targets');
  const morphBody = h('div', { class: 'diag-morphs' });
  const morphDetails = h('details', { class: 'setup diag-sub' }, morphSummary, morphBody);
  const copyBtn = button('Diagnose kopieren', {
    icon: 'copy', small: true, title: 'Ausdrücke, Morph-Targets und Zuordnungen als JSON in die Zwischenablage kopieren (für den Support)',
    onClick: () => copyDump(),
  });
  const body = h('div', { class: 'diag-body' },
    hint('Alle Ausdrücke des Modells und ob sie etwas bewegen. „Tracking“ zeigt den aktuell gesetzten Wert; ',
      'Regler gedrückt halten testet den Ausdruck direkt am Modell (überschreibt solange das Tracking).'),
    repairsBox, list, morphDetails, h('div', { class: 'btn-row' }, copyBtn));
  const details = h('details', { class: 'setup diag' }, h('summary', null, 'Ausdrücke (Diagnose) ', summaryText), body);

  let rows: Row[] = [];

  const testSlider = (name: string): HTMLInputElement => {
    const input = h('input', { type: 'range', class: 'range diag-test', min: '0', max: '1', step: '0.01', value: '0',
      title: `„${name}“ testen: gedrückt halten und ziehen` });
    input.style.setProperty('--p', '0%');
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const set = () => {
      const v = parseFloat(input.value) || 0;
      input.style.setProperty('--p', `${v * 100}%`);
      renderer.setExpressionTest(name, v);
    };
    const release = () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      renderer.setExpressionTest(name, null);
      input.value = '0';
      input.style.setProperty('--p', '0%');
    };
    input.addEventListener('pointerdown', () => { if (releaseTimer) clearTimeout(releaseTimer); set(); });
    input.addEventListener('input', set);
    input.addEventListener('pointerup', release);
    input.addEventListener('pointercancel', release);
    input.addEventListener('blur', release);
    // Keyboard: keep the value while keys are pressed, release shortly after.
    input.addEventListener('keyup', () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(release, 700);
    });
    return input;
  };

  const bindText = (e: ExpressionReportEntry) => {
    const parts = [`${e.morphBinds} Morph`, `${e.materialBinds} Material`, `${e.uvBinds} UV`];
    if (e.isBinary) parts.push('binär');
    return parts.join(' · ');
  };

  const render = () => {
    const rep = renderer.expressionReport;
    const m = live.model;
    rows = [];
    if (!m || !rep) {
      setText(summaryText, '');
      toggleClass(repairsBox, 'hidden', true);
      setChildren(list, h('div', { class: 'diag-empty' }, m ? 'Keine Diagnose verfügbar.' : 'Kein Modell geladen.'));
      setChildren(morphBody);
      setText(morphSummary, 'Morph-Targets');
      copyBtn.disabled = !m;
      return;
    }
    copyBtn.disabled = false;
    const live_ = rep.entries.filter((e) => !e.replaced);
    const emptyN = rep.entries.filter((e) => !e.effective && !isUnusedExpression(e.name)).length;
    setText(summaryText, `– ${live_.length} Ausdrücke${rep.mapped.length ? `, ${rep.mapped.length} zugeordnet` : ''}${emptyN ? `, ${emptyN} leer` : ''}`);
    toggleClass(summaryText, 'warn', usableStandardCount(m.info.expressionNames) < 3 && !m.info.hasPerfectSync);

    toggleClass(repairsBox, 'hidden', rep.repairs.length === 0);
    setChildren(repairsBox, h('b', null, 'Beim Laden automatisch korrigiert:'),
      h('ul', { class: 'diag-repairs' }, rep.repairs.map((r) => h('li', null, r))));

    const els = rep.entries.map((e) => {
      const fill = e.replaced ? null : h('div', { class: 'meter-fill' });
      const value = e.replaced ? null : h('span', { class: 'diag-val' }, '0,00');
      rows.push({ name: e.name, fill, value });
      const unused = !e.effective && isUnusedExpression(e.name);
      const status = unused
        ? h('div', { class: 'diag-note' }, 'leer – wird von VTube Linux nicht benötigt')
        : e.replaced
        ? h('div', { class: 'diag-note warn' }, 'leer – im Modell nicht eingerichtet (ersetzt durch automatische Zuordnung)')
        : !e.effective
          ? h('div', { class: 'diag-note warn' }, e.morphBinds + e.materialBinds + e.uvBinds === 0
            ? 'leer – im Modell nicht eingerichtet'
            : 'leer – Bindungen ohne Wirkung (Morph-Target ohne Daten)')
          : null;
      return h('div', { class: `diag-row${e.effective || unused ? '' : ' is-empty'}` },
        h('div', { class: 'diag-head' },
          h('span', { class: 'diag-name', title: e.name }, e.name),
          h('span', { class: `diag-kind kind-${e.kind}` }, KIND_LABEL[e.kind]),
          h('span', { class: 'diag-binds' }, bindText(e))),
        e.source ? h('div', { class: 'diag-note' }, `→ ${e.source}`) : null,
        e.note ? h('div', { class: 'diag-note' }, e.note) : null,
        e.isBinary && e.effective ? h('div', { class: 'diag-note' }, 'binär: Werte unter 0,5 haben keine Wirkung') : null,
        status,
        e.replaced ? null : h('div', { class: 'diag-ctl' },
          h('span', { class: 'diag-lab' }, 'Tracking'),
          h('div', { class: 'meter-track' }, fill),
          value,
          h('span', { class: 'diag-lab' }, 'Test'),
          testSlider(e.name)));
    });
    setChildren(list, els.length ? els : h('div', { class: 'diag-empty' }, 'Das Modell hat keine Ausdrücke.'));

    const total = rep.morphs.reduce((a, x) => a + x.names.length, 0);
    setText(morphSummary, `Morph-Targets (${total})`);
    setChildren(morphBody, rep.morphs.length
      ? rep.morphs.map((x) => h('div', { class: 'diag-mesh' },
        h('div', { class: 'diag-mesh-name' }, `${x.mesh} – ${x.names.length} Targets${x.primitives > 1 ? `, ${x.primitives} Teile` : ''}`),
        h('div', { class: 'diag-morph-names' }, x.names.join(', '))))
      : h('div', { class: 'diag-empty' }, 'Das Modell hat keine Morph-Targets (Blendshapes).'));
  };

  const copyDump = () => {
    const m = live.model;
    const rep = renderer.expressionReport;
    if (!m) return void toast('Kein Modell geladen.', 'warning');
    const dump = buildDump(m.info, m.fileName, rep, renderer.gpuInfo, live.lastPose?.expressions ?? null);
    try {
      window.vtube.copyToClipboard(JSON.stringify(dump, null, 2));
      toast('Diagnose kopiert – bitte an den Support schicken.', 'success', 2500);
    } catch {
      toast('Kopieren fehlgeschlagen.', 'error');
    }
  };

  const tick = () => {
    if (!details.open || !rows.length) return;
    for (const r of rows) {
      if (!r.fill || !r.value) continue;
      const v = renderer.getExpressionLevel(r.name);
      r.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, v))})`;
      setText(r.value, fmt2(v));
    }
  };

  return { el: details, render, tick };
}

export function buildDump(
  info: import('../../../shared/types').VrmInfo, fileName: string, rep: ExpressionReport | null,
  gpu: { renderer: string; maxTextureSize: number; maxArrayTextureLayers: number },
  pose: Record<string, number> | null,
): unknown {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    tool: 'VTube Linux – Ausdrucks-Diagnose',
    created: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    model: { name: info.name, file: fileName, vrmVersion: info.version === '1' ? '1.0' : '0.x', hasLookAt: info.hasLookAt },
    perfectSync: { active: info.hasPerfectSync, arkitNames: rep?.perfectSyncNames.length ?? null },
    usableExpressions: info.expressionNames,
    usableStandardExpressions: usableStandardCount(info.expressionNames),
    expressions: rep?.entries.map((e) => ({
      name: e.name, kind: e.kind, binds: { morph: e.morphBinds, material: e.materialBinds, uv: e.uvBinds },
      effective: e.effective, isBinary: e.isBinary,
      ...(e.source ? { mappedFrom: e.source } : {}), ...(e.note ? { note: e.note } : {}), ...(e.replaced ? { replaced: true } : {}),
    })) ?? null,
    repairs: rep?.repairs ?? [],
    sourceClips: rep?.sourceClips ?? null,
    morphTextureMB: rep?.morphTextureMB ?? null,
    morphTargets: rep?.morphs.map((x) => ({ mesh: x.mesh, primitives: x.primitives, count: x.names.length, names: x.names })) ?? null,
    gpu,
    lastPose: pose ? Object.fromEntries(Object.entries(pose).filter(([, v]) => v > 0.005).map(([k, v]) => [k, round(v)])) : null,
  };
}
