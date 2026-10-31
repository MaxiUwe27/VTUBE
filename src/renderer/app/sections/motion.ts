// 3. Bewegung: mirror, smoothing, head rotation/position scale, body follow, eye tracking.

import type { AppContext, SectionModule } from '../context';
import { fmt, more, section } from '../controls';

export function motionSection(ctx: AppContext): SectionModule {
  const { ui } = ctx;
  const sec = section('motion', 'Bewegung', 'move', false,
    ui.toggle({
      label: 'Spiegeln',
      hint: 'Avatar bewegt sich wie ein Spiegelbild (empfohlen)',
      get: (s) => s.tracking.mirror,
      set: (v) => ({ tracking: { mirror: v } }),
    }),
    ui.slider({
      label: 'Glättung',
      hint: 'Niedrig = direkter, aber zittriger · Hoch = ruhiger, aber verzögert',
      min: 0, max: 1, step: 0.01, format: fmt.pct,
      get: (s) => s.tracking.smoothing,
      set: (v) => ({ tracking: { smoothing: v } }),
    }),
    ui.slider({
      label: 'Kopfdrehung',
      hint: 'Stärke der Kopfdrehung (1× = wie in echt)',
      min: 0, max: 2, step: 0.05, format: fmt.times,
      get: (s) => s.tracking.headRotationScale,
      set: (v) => ({ tracking: { headRotationScale: v } }),
    }),
    ui.toggle({
      label: 'Augen-Tracking',
      hint: 'Blickrichtung der Augen auf den Avatar übertragen',
      get: (s) => s.tracking.eyeTracking,
      set: (v) => ({ tracking: { eyeTracking: v } }),
    }),
    more('motion',
      ui.slider({
        label: 'Kopfposition',
        hint: 'Wie stark Vor-/Seitwärtsbewegungen auf den Körper übertragen werden (0 = aus)',
        min: 0, max: 2, step: 0.05, format: fmt.times,
        get: (s) => s.tracking.headPositionScale,
        set: (v) => ({ tracking: { headPositionScale: v } }),
      }),
      ui.slider({
        label: 'Körper folgt',
        hint: 'Anteil der Kopfdrehung, den Wirbelsäule und Brust mitmachen',
        min: 0, max: 1, step: 0.01, format: fmt.pct,
        get: (s) => s.tracking.bodyFollow,
        set: (v) => ({ tracking: { bodyFollow: v } }),
      }),
      ui.slider({
        label: 'Augen-Stärke',
        hint: 'Wie weit die Augen der Blickrichtung folgen',
        min: 0, max: 2, step: 0.05, format: fmt.times,
        get: (s) => s.tracking.eyeGazeScale,
        set: (v) => ({ tracking: { eyeGazeScale: v } }),
        enabled: (s) => s.tracking.eyeTracking,
      }),
    ),
  );
  return { el: sec.el, isOpen: () => sec.open };
}
