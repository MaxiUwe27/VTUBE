// Geometric eye / iris / lip measurements from the MediaPipe face mesh (478 landmarks incl. iris).
// Input: FaceFrame.landmarks (x, y, z interleaved, normalized to the NON-mirrored image) and
// FaceFrame.aspect (image width / height, so x and y distances are comparable).
// Output is from the USER's perspective ("L" = the user's anatomical left eye, ARKit convention).
//
// Landmark indices (MediaPipe face mesh, verified on test video: iris 468 sits between 33/133,
// iris 473 between 263/362):
//   user's right eye: corners 33 (outer) / 133 (inner), lids 160/144, 158/153 (EAR pairs), 159/145
//   user's left eye:  corners 263 (outer) / 362 (inner), lids 385/380, 387/373, 386/374
//   iris centres: 468 (right eye), 473 (left eye); inner lips 13 (upper) / 14 (lower)

export interface FaceGeometry {
  /** Eye aspect ratio (lid opening / eye width), ≈ 0.2-0.3 open, < 0.05 closed. */
  earL: number; earR: number;
  /** Iris centre relative to the eye centre, in eye widths. x > 0 = toward the user's own left,
   *  y > 0 = up (in the face's own frame, i.e. head roll removed). */
  irisLX: number; irisLY: number; irisRX: number; irisRY: number;
  /** Inner-lip gap divided by the eye-corner distance (≈ 0 closed, 0.3-0.6 wide open). */
  lipGap: number;
}

export function makeGeometry(): FaceGeometry {
  return { earL: 0, earR: 0, irisLX: 0, irisLY: 0, irisRX: 0, irisRY: 0, lipGap: 0 };
}

/** Number of landmarks required (face mesh + iris). */
export const N_LANDMARKS = 478;

/** Fills `out`; returns false (out untouched) when landmarks are missing or degenerate. */
export function computeGeometry(lm: ArrayLike<number> | undefined, aspect: number | undefined, out: FaceGeometry): boolean {
  if (!lm || lm.length < N_LANDMARKS * 3) return false;
  const ax = aspect && aspect > 0 && Number.isFinite(aspect) ? aspect : 4 / 3;
  const X = (i: number) => lm[i * 3] * ax;
  const Y = (i: number) => lm[i * 3 + 1];
  const dist = (a: number, b: number) => Math.hypot(X(a) - X(b), Y(a) - Y(b));

  // Face axis: from the user's right outer eye corner to the left one (image +x = user's left).
  let ux = X(263) - X(33), uy = Y(263) - Y(33);
  const iod = Math.hypot(ux, uy);
  if (!(iod > 1e-4)) return false;
  ux /= iod; uy /= iod;
  // "Up" in the face frame (image y grows downward): rotate u by -90°.
  const vx = uy, vy = -ux;

  const wR = dist(33, 133), wL = dist(263, 362);
  if (!(wR > 1e-5 && wL > 1e-5)) return false;
  out.earR = (dist(160, 144) + dist(158, 153)) / (2 * wR);
  out.earL = (dist(385, 380) + dist(387, 373)) / (2 * wL);

  const iris = (c: number, a: number, b: number, w: number, isLeft: boolean) => {
    const cx = 0.5 * (X(a) + X(b)), cy = 0.5 * (Y(a) + Y(b));
    const dx = X(c) - cx, dy = Y(c) - cy;
    const h = (dx * ux + dy * uy) / w, v = (dx * vx + dy * vy) / w;
    if (isLeft) { out.irisLX = h; out.irisLY = v; } else { out.irisRX = h; out.irisRY = v; }
  };
  iris(468, 33, 133, wR, false);
  iris(473, 263, 362, wL, true);
  out.lipGap = dist(13, 14) / iod;
  return Number.isFinite(out.earL + out.earR + out.irisLX + out.irisLY + out.irisRX + out.irisRY + out.lipGap);
}
