// Rest pose (arms down from T-pose, relaxed elbows/fingers) and idle motion.
//
// All rotations here are in the VRM 1.0 normalized convention: the avatar faces +Z, its
// left side is +X, up is +Y. For VRM 0.x models the renderer converts with `toVrm0()`.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Mirror a left-side rotation to the right side (mirror across the YZ plane). */
export function mirrorLR(q: THREE.Quaternion, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.set(q.x, -q.y, -q.z, q.w);
}

/** Convert a VRM1-convention normalized local rotation to the VRM0 one (in place). */
export function toVrm0(q: THREE.Quaternion): THREE.Quaternion {
  return q.set(-q.x, q.y, -q.z, q.w);
}

function fromEuler(x: number, y: number, z: number, order: THREE.EulerOrder = 'XYZ'): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(_e.set(x, y, z, order));
}

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;

/** Rest rotations for arms/hands/fingers (left side defined, right side mirrored). */
export function buildRestPose(armPoseDeg: number): Map<VRMHumanBoneName, THREE.Quaternion> {
  const map = new Map<VRMHumanBoneName, THREE.Quaternion>();
  const a = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(armPoseDeg, 0, 89));
  // How "lowered" the arm is (0..1) scales the secondary relaxation details.
  const k = a / THREE.MathUtils.degToRad(75);

  const set = (left: VRMHumanBoneName, right: VRMHumanBoneName, q: THREE.Quaternion) => {
    map.set(left, q);
    map.set(right, mirrorLR(q));
  };

  // Upper arm: lower around Z (negative = down for the left arm, which points to +X), then
  // bring slightly forward (rotation around parent X; negative = toward +Z / front).
  const upper = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12 * k)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -a));
  set('leftUpperArm', 'rightUpperArm', upper);
  // Shoulders slightly dropped.
  set('leftShoulder', 'rightShoulder', fromEuler(0, 0, -0.05 * k));
  // Elbow: forearm bends forward (local −Y for the left arm) a little.
  set('leftLowerArm', 'rightLowerArm', fromEuler(0, -0.32 * k, 0));
  // Hand: slight inward bend so the palm faces the thigh naturally.
  set('leftHand', 'rightHand', fromEuler(0.05 * k, -0.05 * k, -0.12 * k));

  // Fingers: gentle curl (left hand: palm faces −Y in T-pose; curl = −Z for fingers).
  for (const f of FINGERS) {
    if (f === 'Thumb') {
      set('leftThumbMetacarpal', 'rightThumbMetacarpal', fromEuler(0, -0.25 * k, 0.1 * k));
      set('leftThumbProximal', 'rightThumbProximal', fromEuler(0, -0.2 * k, 0));
      set('leftThumbDistal', 'rightThumbDistal', fromEuler(0, -0.2 * k, 0));
      continue;
    }
    const spread = f === 'Index' ? 0.06 : f === 'Ring' ? -0.04 : f === 'Little' ? -0.08 : 0;
    const curl = f === 'Index' ? 0.85 : f === 'Middle' ? 1 : f === 'Ring' ? 1.1 : 1.2;
    set(`left${f}Proximal` as VRMHumanBoneName, `right${f}Proximal` as VRMHumanBoneName,
      fromEuler(0, spread * k, -0.22 * curl * k));
    set(`left${f}Intermediate` as VRMHumanBoneName, `right${f}Intermediate` as VRMHumanBoneName,
      fromEuler(0, 0, -0.3 * curl * k));
    set(`left${f}Distal` as VRMHumanBoneName, `right${f}Distal` as VRMHumanBoneName,
      fromEuler(0, 0, -0.18 * curl * k));
  }
  return map;
}

/** Bones the idle animation touches. */
export const IDLE_BONES: readonly VRMHumanBoneName[] = [
  'spine', 'chest', 'upperChest', 'neck',
  'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
];

const TAU = Math.PI * 2;

/**
 * Idle rotations at time t (seconds), multiplied on top of tracked / rest rotations.
 * Writes into `out` (missing entries = identity). `amount` 0..1 fades the idle in/out.
 */
export function computeIdle(t: number, amount: number, out: Map<VRMHumanBoneName, THREE.Quaternion>): void {
  const get = (b: VRMHumanBoneName) => {
    let q = out.get(b);
    if (!q) { q = new THREE.Quaternion(); out.set(b, q); }
    return q;
  };
  if (amount <= 0) {
    for (const b of IDLE_BONES) get(b).identity();
    return;
  }
  // Breathing (≈ 15 breaths/min), slightly asymmetric curve: quicker inhale, slower exhale.
  const ph = (t / 4.0) % 1;
  const breath = (ph < 0.4 ? Math.sin((ph / 0.4) * Math.PI / 2) : Math.cos(((ph - 0.4) / 0.6) * Math.PI / 2)) * 2 - 1; // -1..1
  const b = breath * amount;
  // Slow body sway.
  const sway = Math.sin((TAU * t) / 7.3) * amount;
  const sway2 = Math.sin((TAU * t) / 11.1 + 1.3) * amount;

  // Inhale: chest lifts (rotation around −X = leaning back slightly), spine follows a bit.
  get('spine').setFromEuler(_e.set(-0.006 * b, 0.006 * sway2, 0.008 * sway, 'XYZ'));
  get('chest').setFromEuler(_e.set(-0.012 * b, 0, -0.004 * sway, 'XYZ'));
  get('upperChest').setFromEuler(_e.set(-0.008 * b, 0, 0, 'XYZ'));
  // Neck compensates part of the chest motion so the head stays steadier.
  get('neck').setFromEuler(_e.set(0.012 * b, 0, -0.004 * sway, 'XYZ'));
  // Shoulders rise on inhale (left: +Z raises).
  _q.setFromEuler(_e.set(0, 0, 0.018 * b, 'XYZ'));
  get('leftShoulder').copy(_q);
  mirrorLR(_q, get('rightShoulder'));
  // Arms: gentle pendulum, independent phases.
  const al = Math.sin((TAU * t) / 5.3);
  const ar = Math.sin((TAU * t) / 5.9 + 2.1);
  const fl = Math.sin((TAU * t) / 6.7 + 0.7);
  const fr = Math.sin((TAU * t) / 6.1 + 2.9);
  get('leftUpperArm').setFromEuler(_e.set(0.025 * fl * amount, 0, (0.02 * al - 0.012 * b) * amount, 'XYZ'));
  mirrorLR(_q.setFromEuler(_e.set(0.025 * fr * amount, 0, (0.02 * ar - 0.012 * b) * amount, 'XYZ')), get('rightUpperArm'));
  get('leftLowerArm').setFromEuler(_e.set(0, -0.03 * (fl * 0.5 + 0.5) * amount, 0, 'XYZ'));
  mirrorLR(_q.setFromEuler(_e.set(0, -0.03 * (fr * 0.5 + 0.5) * amount, 0, 'XYZ')), get('rightLowerArm'));
}
