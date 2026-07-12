// projection.js — the 3D→2D math for the trajectory view.
//
// A point lives in "feature space": x, y, z each in [-1, 1] (the axis cube).
// To put it on screen we:
//   1. spin it around the vertical (Y) axis by the camera angle — this is
//      the slow auto-rotation;
//   2. tip it forward by a small fixed tilt around X, so we look slightly
//      down onto the cube instead of dead edge-on;
//   3. perspective-divide: points farther from the camera shrink toward the
//      screen center, exactly like a pinhole camera.
//
// That is the entire pipeline — a few lines of trig, no matrix library.
// Because the camera sits CAMERA_DIST away and the cube only reaches √3 from
// center, no point can ever get behind the camera, so there is no culling.

// Camera distance from the cube's center, in cube units. Smaller = more
// dramatic perspective distortion; larger = flatter, more orthographic look.
export const CAMERA_DIST = 3.2;

// Fixed downward tilt (radians). Negative pitches the cube's top toward us.
const TILT = -0.32;
const COS_T = Math.cos(TILT);
const SIN_T = Math.sin(TILT);

// Project one 3D point. cosA/sinA are the camera angle's cosine/sine (the
// caller computes them once per frame, not once per point). cx/cy is the
// screen center in px, viewScale is px per cube unit. Writes into `out`
// (reused by the caller) instead of allocating:
//   out.x, out.y  — screen position (px)
//   out.scale     — perspective size multiplier (~0.75 far … ~1.4 near)
//   out.depth     — distance beyond cube center; SMALLER = closer to viewer
export function project(x, y, z, cosA, sinA, cx, cy, viewScale, out) {
  // 1. Rotate around Y (the spin).
  const rx = x * cosA + z * sinA;
  const rz = -x * sinA + z * cosA;

  // 2. Rotate around X (the fixed tilt).
  const ry = y * COS_T - rz * SIN_T;
  const rz2 = y * SIN_T + rz * COS_T;

  // 3. Perspective divide.
  const persp = CAMERA_DIST / (CAMERA_DIST + rz2);
  out.x = cx + rx * persp * viewScale;
  out.y = cy - ry * persp * viewScale; // minus: screen Y grows downward
  out.scale = persp;
  out.depth = rz2;
}
