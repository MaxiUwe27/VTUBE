// Expression-name helpers: case-insensitive mapping of pose expression names onto the
// names a model actually has, and ARKit ("perfect sync") detection.

/** The 52 ARKit / MediaPipe blendshape names. */
export const ARKIT_BLENDSHAPES: readonly string[] = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft',
  'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

/** Minimum number of ARKit names a model must have to count as "perfect sync". */
export const PERFECT_SYNC_MIN = 40;

/**
 * Maps incoming expression names (exact or case-insensitive) onto indices of the model's
 * expression list. Exact matches win over case-insensitive ones.
 */
export class ExpressionMap {
  readonly names: string[];
  private readonly exact = new Map<string, number>();
  private readonly lower = new Map<string, number>();
  /** Cache for names that needed the lower-case path (or were unknown => -1). */
  private readonly cache = new Map<string, number>();

  constructor(modelNames: string[]) {
    this.names = modelNames.slice();
    modelNames.forEach((n, i) => {
      this.exact.set(n, i);
      const l = n.toLowerCase();
      if (!this.lower.has(l)) this.lower.set(l, i);
    });
  }

  /** Index of the model expression for `name`, or -1 if the model lacks it. */
  indexOf(name: string): number {
    const e = this.exact.get(name);
    if (e !== undefined) return e;
    const c = this.cache.get(name);
    if (c !== undefined) return c;
    const i = this.lower.get(name.toLowerCase()) ?? -1;
    if (this.cache.size < 1024) this.cache.set(name, i);
    return i;
  }

  /** ARKit names (canonical spelling) the model provides, case-insensitively. */
  matchArkit(): string[] {
    return ARKIT_BLENDSHAPES.filter((n) => this.lower.has(n.toLowerCase()));
  }
}
