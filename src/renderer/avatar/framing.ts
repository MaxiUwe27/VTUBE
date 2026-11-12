// Automatic camera framing based on the avatar's rest-pose skeleton.
import * as THREE from 'three';
import type { ViewSettings } from '../../shared/settings';

/** Rest-pose measurements in scene space (metres). The avatar faces +Z. */
export interface BodyMetrics {
  head: THREE.Vector3;      // head bone (base of skull)
  neckY: number;
  chestY: number;
  hipsY: number;
  headTopY: number;         // top of head incl. hair (clamped estimate)
  eyeY: number;
  feetY: number;            // lowest point (floor)
  shoulderWidth: number;    // distance between upper-arm joints
}

const DEFAULT_METRICS: BodyMetrics = {
  head: new THREE.Vector3(0, 1.45, 0),
  neckY: 1.38,
  chestY: 1.2,
  hipsY: 0.95,
  headTopY: 1.65,
  eyeY: 1.52,
  feetY: 0,
  shoulderWidth: 0.3,
};

export function defaultMetrics(): BodyMetrics {
  return { ...DEFAULT_METRICS, head: DEFAULT_METRICS.head.clone() };
}

interface Frame { centerX: number; centerY: number; centerZ: number; height: number; width: number }

function computeFrame(m: BodyMetrics, framing: ViewSettings['framing']): Frame {
  const shoulders = Math.max(0.2, m.shoulderWidth);
  let top: number;
  let bottom: number;
  let width: number;
  switch (framing) {
    case 'head': {
      const headH = Math.max(0.12, m.headTopY - m.neckY);
      top = m.headTopY + headH * 0.12;
      bottom = m.neckY - headH * 0.25;
      width = Math.max(headH * 1.1, shoulders * 0.9);
      break;
    }
    case 'fullBody': {
      const h = m.headTopY - m.feetY;
      top = m.headTopY + h * 0.04;
      // feet/toes stick out toward the camera and appear lower in perspective
      bottom = m.feetY - h * 0.07;
      width = Math.max(shoulders * 2.6, h * 0.42);
      break;
    }
    case 'upperBody':
    default: {
      top = m.headTopY + (m.headTopY - m.neckY) * 0.18;
      // a bit below the chest, roughly at the waist
      bottom = m.hipsY + (m.chestY - m.hipsY) * 0.25;
      width = shoulders * 2.4;
      break;
    }
  }
  const height = Math.max(0.1, top - bottom);
  return { centerX: m.head.x, centerY: (top + bottom) / 2, centerZ: m.head.z, height, width };
}

/** Orbit limits (degrees). Yaw wraps around (−180, 180]; pitch is clamped so the camera never
 *  goes below the floor-ish or straight overhead (both look broken with an auto-framed avatar). */
export const ORBIT_PITCH_MIN = -30;
export const ORBIT_PITCH_MAX = 60;

/** Wraps an angle in degrees into (−180, 180]. Non-finite → 0. */
export function wrapYaw(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = ((deg + 180) % 360 + 360) % 360 - 180; // [−180, 180)
  if (d === -180) d = 180;
  return d;
}

/** Sanitised orbit (yaw wrapped, pitch clamped, NaN → 0). */
export function normalizeOrbit(o: { yaw?: number; pitch?: number } | null | undefined): { yaw: number; pitch: number } {
  const pitch = Number.isFinite(o?.pitch) ? (o!.pitch as number) : 0;
  return { yaw: wrapYaw(o?.yaw ?? 0), pitch: THREE.MathUtils.clamp(pitch, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX) };
}

/**
 * Unit vector from the orbit target towards the camera (scene space, avatar faces +Z, its left is +X).
 * yaw > 0 moves the camera toward +X (the avatar's left = the viewer's right), pitch > 0 lifts it.
 */
export function orbitDirection(yawDeg: number, pitchDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const y = THREE.MathUtils.degToRad(yawDeg);
  const p = THREE.MathUtils.degToRad(pitchDeg);
  return out.set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
}

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pt = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Positions `camera` (PerspectiveCamera with aspect already set) so that the requested
 * body part fills the view. cameraOffset.x/y are fractions of the framed height: x > 0 moves
 * the avatar to the right on screen, y > 0 moves it up. zoom > 1 moves the camera closer.
 * view.orbit rotates the camera around the framed centre at the same distance (see orbitDirection);
 * the offsets are applied in screen space afterwards, so they behave the same from every angle.
 */
export function frameCamera(camera: THREE.PerspectiveCamera, m: BodyMetrics, view: ViewSettings): void {
  const f = computeFrame(m, view.framing);
  const fov = THREE.MathUtils.clamp(view.cameraFov || 30, 5, 120);
  camera.fov = fov;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const aspect = camera.aspect > 0 && isFinite(camera.aspect) ? camera.aspect : 1;
  const orbit = normalizeOrbit(view.orbit);
  // Seen from the side the shoulders are narrow, so the width demand shrinks; never below the
  // head/torso depth though (≈ 45 % of the frontal width), otherwise a profile gets cropped.
  const sideness = Math.abs(Math.sin(THREE.MathUtils.degToRad(orbit.yaw)));
  const width = f.width * (1 - 0.55 * sideness);
  const distH = f.height / 2 / tanHalf;
  const distW = width / 2 / (tanHalf * aspect);
  const zoom = THREE.MathUtils.clamp(view.cameraOffset?.zoom || 1, 0.1, 10);
  const dist = Math.max(distH, distW) / zoom;

  const dir = orbitDirection(orbit.yaw, orbit.pitch, _dir);
  // Camera basis: right = forward × up (forward = −dir), up = right × forward.
  _right.crossVectors(WORLD_UP, dir).normalize();          // = (−dir) × up
  _up.crossVectors(dir, _right).normalize();               // = right × (−dir)

  const ox = (view.cameraOffset?.x || 0) * f.height;
  const oy = (view.cameraOffset?.y || 0) * f.height;
  // Moving the camera left (−right) makes the avatar appear further right; down makes it appear higher.
  _target.set(f.centerX, f.centerY, f.centerZ).addScaledVector(_right, -ox).addScaledVector(_up, -oy);

  camera.position.copy(_target).addScaledVector(dir, dist);
  camera.near = Math.max(0.01, dist * 0.05);
  camera.far = Math.max(50, dist * 20);
  camera.up.set(0, 1, 0);
  camera.lookAt(_target);
  camera.updateProjectionMatrix();

  // Viewed from above/below the head can drift toward the frame edge (it is closer to the camera
  // than the framed centre). Without user offsets, nudge the view so the top of the head stays in.
  if (orbit.pitch !== 0 && !ox && !oy) {
    camera.updateMatrixWorld(true);
    _pt.set(m.head.x, m.headTopY, m.head.z).project(camera);
    const limit = 0.94;
    if (_pt.y > limit && _pt.z < 1) {
      const shift = (_pt.y - limit) * dist * tanHalf;       // NDC → world units at target distance
      _target.addScaledVector(_up, shift);
      camera.position.addScaledVector(_up, shift);
      camera.lookAt(_target);
      camera.updateProjectionMatrix();
    }
  }
}
