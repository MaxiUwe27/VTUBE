// Per-user adaptive levels (robust running quantiles) and small signal helpers for the solver.
// Everything is allocation-free after construction; push() is called once per camera frame.

/**
 * Running robust estimate of two quantiles (lo/hi) of a signal: samples are decimated into a ring
 * buffer (window = size × every frames), the window quantiles are computed every `every` frames and
 * followed with an asymmetric exponential average (tauUp when the window value is above the current
 * estimate, tauDown below). During warm-up (window not full yet) the followers are faster.
 */
export class RangeTracker {
  lo: number;
  hi: number;
  private readonly buf: Float32Array;
  private readonly tmp: Float32Array;
  private n = 0;
  private head = 0;
  private count = 0;
  private dtAcc = 0;

  constructor(
    private readonly initLo: number,
    private readonly initHi: number,
    private readonly opts: {
      qLo: number; qHi: number;
      tauLoUp: number; tauLoDown: number; tauHiUp: number; tauHiDown: number;
      size?: number; every?: number;
    },
  ) {
    const size = opts.size ?? 64;
    this.buf = new Float32Array(size);
    this.tmp = new Float32Array(size);
    this.lo = initLo;
    this.hi = initHi;
  }

  /** Number of samples in the window (0 = still at the initial values). */
  get samples(): number { return this.n; }
  get warm(): boolean { return this.n >= 8; }

  reset(lo = this.initLo, hi = this.initHi): void {
    this.n = this.head = this.count = 0;
    this.dtAcc = 0;
    this.lo = lo;
    this.hi = hi;
  }

  push(x: number, dt: number): void {
    if (!Number.isFinite(x)) return;
    this.dtAcc += dt > 0 ? dt : 0;
    if (++this.count < (this.opts.every ?? 4)) return;
    this.count = 0;
    const size = this.buf.length;
    this.buf[this.head] = x;
    this.head = (this.head + 1) % size;
    if (this.n < size) this.n++;
    const n = this.n;
    const dtAcc = this.dtAcc;
    this.dtAcc = 0;
    if (n < 4) return;
    const t = this.tmp.subarray(0, n);
    t.set(this.buf.subarray(0, n));
    t.sort();
    const qv = (q: number) => t[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    const warmup = n < size ? Math.max(0.15, n / size) : 1; // faster while the window fills
    const f = (cur: number, target: number, up: number, down: number) =>
      cur + (target - cur) * (1 - Math.exp(-dtAcc / (Math.max(1e-3, (target > cur ? up : down) * warmup))));
    const o = this.opts;
    this.lo = f(this.lo, qv(o.qLo), o.tauLoUp, o.tauLoDown);
    this.hi = f(this.hi, qv(o.qHi), o.tauHiUp, o.tauHiDown);
  }

  /** (x - lo) / max(minSpan, hi - lo), clamped to 0..1. */
  norm(x: number, minSpan: number): number {
    const v = (x - this.lo) / Math.max(minSpan, this.hi - this.lo);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

/**
 * Soft deadzone ("hold until it really moves"): changes much smaller than `d` are almost ignored,
 * larger ones pass nearly 1:1. Removes micro-jitter at rest without a fixed offset during motion.
 */
export class SoftDeadzone {
  private y = 0;
  private init = false;
  reset(): void { this.init = false; }
  filter(x: number, d: number): number {
    if (!this.init || !(d > 0)) { this.init = true; this.y = x; return x; }
    const e = x - this.y, e2 = e * e;
    this.y += e * (e2 / (e2 + d * d));
    return this.y;
  }
}
