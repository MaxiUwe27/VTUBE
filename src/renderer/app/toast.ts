// Toast notifications (bottom-left). Errors stay longer and can be dismissed by click.

import { h, icon } from './dom';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

let host: HTMLElement | null = null;
const recent = new Map<string, number>();

function getHost(): HTMLElement {
  if (!host) {
    host = document.getElementById('toasts') ?? document.body.appendChild(h('div', { id: 'toasts' }));
    host.setAttribute('aria-live', 'polite');
  }
  return host;
}

const ICON: Record<ToastKind, string> = { info: 'info', success: 'check', error: 'warning', warning: 'warning' };

export function toast(message: string, kind: ToastKind = 'info', durationMs?: number): void {
  // Suppress identical messages fired in quick succession (e.g. repeated device errors).
  const now = performance.now();
  const key = `${kind}:${message}`;
  if ((recent.get(key) ?? -Infinity) > now - 1500) return;
  recent.set(key, now);

  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', title: 'Klicken zum Schließen' },
    icon(ICON[kind], 'toast-icon'), h('div', { class: 'toast-msg' }, message));
  const hostEl = getHost();
  hostEl.appendChild(el);
  while (hostEl.children.length > 5) hostEl.firstElementChild?.remove();

  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', close);
  setTimeout(close, durationMs ?? (kind === 'error' ? 9000 : kind === 'warning' ? 6500 : 3500));
}

/** German, user-facing text for an unknown error value. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
