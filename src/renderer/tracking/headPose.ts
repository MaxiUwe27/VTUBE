// MediaPipe facial transformation matrix → head rotation/position from the USER's own perspective.
//
// MediaPipe "metric space" (face_geometry): right-handed, camera at the origin looking along -Z,
// +X = image right, +Y = image up, units = cm. The image is NOT mirrored by MediaPipe, so for a
// user facing the camera, image right is the user's OWN LEFT. The canonical face model looks along
// +Z (toward the camera) with +Y up, so its +X is also the user's left (verified on real photos:
// column 0 of the matrix points toward landmark 263 = the user's left eye corner, see report).
//
// The matrix maps canonical face → camera space, i.e. it is the head orientation in a frame where
// the user faces +Z and +X is the user's left — the same layout as the VRM1 avatar frame. Decomposing
// its rotation as intrinsic Euler 'YXZ' (yaw, then pitch, then roll — natural for a head):
//   rotation about +Y by +a : face swings from +Z toward +X  = turns to the user's own LEFT → yaw = +a
//   rotation about +X by +a : face swings from +Z toward -Y  = looks DOWN                    → pitch = -a
//   rotation about +Z by +a : top of head swings toward -X   = tilts to the user's RIGHT     → roll = -a
// Translation is the face origin in camera space: x > 0 = toward the user's left, y up, z < 0 is in
// front of the camera (z increases when the user moves toward the camera).

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../../shared/types';

/** Flip if the camera frame ever turns out mirrored (e.g. a MediaPipe change). */
export const CAMERA_X_IS_USER_LEFT = true;

const m4 = new Matrix4();
const pos = new Vector3();
const quat = new Quaternion();
const scl = new Vector3();
const eul = new Euler();

/** `data`: 16 numbers, column-major (MediaPipe Matrix.data). Returns false if invalid. */
export function matrixToHeadPose(data: ArrayLike<number>, outRot: Vec3, outPos: Vec3): boolean {
  if (!data || data.length < 16) return false;
  m4.fromArray(data as number[]);
  m4.decompose(pos, quat, scl);
  if (!Number.isFinite(quat.x + quat.y + quat.z + quat.w + pos.x + pos.y + pos.z)) return false;
  if (!CAMERA_X_IS_USER_LEFT) {
    // Reflect across the YZ plane: x → -x for positions, rotation (x, y, z, w) → (x, -y, -z, w).
    quat.set(quat.x, -quat.y, -quat.z, quat.w);
    pos.x = -pos.x;
  }
  eul.setFromQuaternion(quat, 'YXZ');
  outRot.x = -eul.x; // pitch > 0: user looks up
  outRot.y = eul.y;  // yaw   > 0: user turns to own left
  outRot.z = -eul.z; // roll  > 0: user tilts toward own left shoulder
  outPos.x = pos.x;
  outPos.y = pos.y;
  outPos.z = pos.z;
  return true;
}
