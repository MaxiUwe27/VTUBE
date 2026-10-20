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

/**
 * Positions `camera` (PerspectiveCamera with aspect already set) so that the requested
 * body part fills the view. cameraOffset.x/y are fractions of the framed height: x > 0 moves
 * the avatar to the right on screen, y > 0 moves it up. zoom > 1 moves the camera closer.
 */
export function frameCamera(camera: THREE.PerspectiveCamera, m: BodyMetrics, view: ViewSettings): void {
  const f = computeFrame(m, view.framing);
  const fov = THREE.MathUtils.clamp(view.cameraFov || 30, 5, 120);
  camera.fov = fov;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const aspect = camera.aspect > 0 && isFinite(camera.aspect) ? camera.aspect : 1;
  const distH = f.height / 2 / tanHalf;
  const distW = f.width / 2 / (tanHalf * aspect);
  const zoom = THREE.MathUtils.clamp(view.cameraOffset?.zoom || 1, 0.1, 10);
  const dist = Math.max(distH, distW) / zoom;

  const ox = (view.cameraOffset?.x || 0) * f.height;
  const oy = (view.cameraOffset?.y || 0) * f.height;
  // Moving the camera left (−X; viewer's right is +X) makes the avatar appear further right.
  const cx = f.centerX - ox;
  const cy = f.centerY - oy;

  camera.position.set(cx, cy, f.centerZ + dist);
  camera.near = Math.max(0.01, dist * 0.05);
  camera.far = Math.max(50, dist * 20);
  camera.up.set(0, 1, 0);
  camera.lookAt(cx, cy, f.centerZ);
  camera.updateProjectionMatrix();
}
