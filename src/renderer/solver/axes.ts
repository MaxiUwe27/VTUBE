// Axis / sign conventions of the solver, in ONE place.
//
// ── Bone space (AvatarPose.bones) ────────────────────────────────────────────────────────────
// Quaternions are local rotations of three-vrm NORMALIZED humanoid bones in the VRM1 frame:
//   the avatar faces +Z (toward the default camera), +Y is up, +X is the AVATAR'S OWN LEFT.
// Verified in @pixiv/three-vrm-core 3.5.5 (VRMHumanoidRig._setupTransforms: normalized bones are
// world-axis aligned with identity rest rotation; VRMLookAtBoneApplier uses faceFront = +Z for VRM1).
// With right-handed rotations this gives:
//   rotation about +Y by +a  → head turns to the avatar's own LEFT   (forward +Z swings to +X)
//   rotation about +X by +a  → head nods DOWN                        (forward +Z swings to -Y)
//   rotation about +Z by +a  → head tilts toward the avatar's own RIGHT shoulder (up +Y swings to -X)
//
// This matches the renderer's verified convention (screenshots on VRM0 + VRM1): AvatarPose bones are
// ALWAYS in the VRM1 normalized frame; the renderer converts VRM0 models itself (three-vrm builds VRM0's
// normalized rig in the original -Z-facing frame, so it needs (x,y,z,w) → (-x,y,-z,w)).
//   look to own left by θ → (0, sin θ/2, 0, cos θ/2); look up by θ → (−sin θ/2, 0, 0, cos θ/2);
//   tilt to own left by θ → (0, 0, −sin θ/2, cos θ/2).
//
// The solver works internally with SEMANTIC avatar angles (radians):
//   yaw   > 0 : avatar turns to its own left
//   pitch > 0 : avatar looks up
//   roll  > 0 : avatar tilts toward its own left shoulder
// and converts them to a bone quaternion as Euler(x = PITCH_SIGN*pitch, y = YAW_SIGN*yaw,
// z = ROLL_SIGN*roll, order 'YXZ'). Flip one of these constants if a direction is wrong on screen.
export const YAW_SIGN = 1;    // positive semantic yaw   → rotation about +Y by +yaw
export const PITCH_SIGN = -1; // positive semantic pitch → rotation about +X by -pitch (look up)
export const ROLL_SIGN = -1;  // positive semantic roll  → rotation about +Z by -roll (tilt to own left)
export const EULER_ORDER = 'YXZ' as const;

// hipsOffset (metres, avatar frame): +x = avatar's own left, +y = up, +z = forward (toward viewer).
export const HIPS_X_SIGN = 1;
export const HIPS_Z_SIGN = 1;

// ── lookAt (AvatarPose.lookAt, degrees) ──────────────────────────────────────────────────────
// Contract (types.ts): yaw > 0 = avatar looks to its own left, pitch > 0 = up.
// (Renderer note: three-vrm's VRMLookAt.yaw/pitch & applyYawPitch use yaw > 0 = toward +X
// (= avatar's left for VRM1, same as ours) but pitch > 0 = DOWN. So the renderer must set
// vrm.lookAt.pitch = -pose.lookAt.pitch (verified in three-vrm-core: VRMLookAtBoneApplier sets
// Euler.x = +pitch for the eye bones, which rotates +Z toward -Y; the expression applier maps
// pitch < 0 to "lookUp").)
export const LOOK_YAW_SIGN = 1;
export const LOOK_PITCH_SIGN = 1;
