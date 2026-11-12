// One-Euro filter (Casiez, Roussel, Vogel 2012): an adaptive low-pass filter whose cutoff rises
// with the signal speed. Slow movements → low cutoff → no jitter; fast movements → high cutoff →
// little lag. Allocation-free; `filter` is called once per camera frame per channel.

const TWO_PI = 2 * Math.PI;

function alpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (TWO_PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  /** Minimum cutoff frequency in Hz (jitter at rest ↓ when lower). */
  minCutoff: number;
  /** Speed coefficient (lag during fast motion ↓ when higher). Units: 1 / (signal units per second). */
  beta: number;
  /** Cutoff for the derivative estimate in Hz. */
  dCutoff: number;

  private x = 0;
  private dx = 0;
  private initialized = false;

  constructor(minCutoff = 1, beta = 0, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  setParams(minCutoff: number, beta: number, dCutoff = this.dCutoff): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  /** Filter sample `value`; `dt` = seconds since the previous sample (> 0). */
  filter(value: number, dt: number): number {
    if (!this.initialized || !(dt > 0)) {
      this.initialized = true;
      this.x = value;
      this.dx = 0;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  get value(): number { return this.x; }
  get ready(): boolean { return this.initialized; }

  reset(value?: number): void {
    if (value === undefined) {
      this.initialized = false;
    } else {
      this.initialized = true;
      this.x = value;
    }
    this.dx = 0;
  }
}
