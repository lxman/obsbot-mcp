// Pure geometry for aiming the gimbal at a point seen in a snapshot. No I/O, no
// transport, no device access — everything here is a function of its arguments,
// which is what makes it testable with no camera attached.
//
// Degrees in the public API (matching every other angle in this codebase),
// radians internal only.

import type { FovType } from "../codec/commands.js";

export interface Frame {
  width: number;
  height: number;
}

export interface Pose {
  yaw: number;
  pitch: number;
}

export interface Optics {
  fov: FovType;
  /** Zoom factor, >= 1. Zoom is a crop, so it divides the tangent. Defaults to 1. */
  zoom?: number;
  /**
   * Whether the capture path horizontally flips the preview. This inverts the
   * yaw correction, so it is an explicit input rather than a baked-in
   * assumption — see the spec's section 3. Defaults to false.
   */
  mirrored?: boolean;
}

/**
 * Horizontal field of view of the CAPTURE STREAM for each FOV setting, in
 * degrees. These are MEASURED against a physical Tiny 2 (2026-07-25), not taken
 * from OBSBOT's SDK — the two disagree, and the measured values are the ones
 * this module needs.
 *
 * The vendor's figures come from OBSBOT's own C++ SDK header,
 * `libdev_v2.1.0_8/include/dev/dev.hpp:486-488`:
 *
 *     FovType86 = 0, /// field of view 86°, wide view
 *     FovType78 = 1, /// field of view 78°, medium view
 *     FovType65 = 2, /// field of view 65°, narrow view
 *
 * The header states no AXIS — just "field of view 86°" — but OBSBOT's published
 * materials give the Tiny 2 as 85.5° **DFOV, diagonal** (checked 2026-07-25;
 * the same sources give pan as ±150°, corroborating GIMBAL_YAW_LIMIT_DEG below).
 * So the SDK's "86°" is a rounded diagonal figure.
 *
 * The diagonal reading explains about half the gap (85.5° diagonal at 16:9 gives
 * tan(H) = 0.806 vs a measured 0.673). The rest is the 16:9 crop, verified by
 * driving the camera at its native modes through ffmpeg/dshow:
 *   - 4K is NOT wider than 1080p. Same scene, fixed pose, 3840x2160 vs
 *     1920x1080: a frame-spanning feature pair measured 343 vs 337 px at equal
 *     display width. Same FOV within ~2%.
 *   - The 4:3 modes ARE wider. At 4000x3000, tan(H) ~= 0.690 and tan(V) ~= 0.518
 *     give a diagonal of ~82°, matching the published 85.5° within the ~3%
 *     precision of the measurement.
 * So 85.5° DFOV describes the full-sensor 4:3 mode, and every 16:9 mode is
 * cropped from it. The 16:9 diagonal is ~75°, which is why "86°" never
 * reconciled with anything measured here.
 *
 * SCOPE: correct for 16:9 capture at any resolution — every frame
 * obsbot_capture_snapshot produces. A 4:3 capture path would need re-measuring;
 * those are wider, and the aspect-derived tan(V) changes too. Measured against a
 * letter sheet of known width at a tape-measured distance:
 *
 *     setting   spec    measured    tan(H) measured / tan(H) spec
 *     wide      86°     67.9°       0.722
 *     medium    78°     60.2°       0.719
 *     narrow    65°     50.0°       0.731
 *
 * The ratio is constant at 0.724 ± 0.006, so the spec numbers have the correct
 * relative structure and a uniformly wrong absolute scale — one scale error, not
 * three bad values. (Measured medium/wide tangent ratio 0.865 vs the spec's
 * 0.868, agreeing to 0.3%.) Neither a 16:9 diagonal reading (which would give
 * 0.872) nor 4:3 (0.80) accounts for 0.724; the likeliest cause is that the
 * stream is a further crop of the sensor, which the Tiny 2's digital AI framing
 * would explain. The cause does not change what the module needs.
 *
 * Two independent methods agree on wide, which is what makes this trustworthy:
 *   - Panning a known gimbal angle and tracking features across the frame
 *     (distance-independent): 66.4°, reproducible across three features and two
 *     pan angles.
 *   - A letter sheet of known width at a measured distance (gimbal-independent):
 *     67.9°.
 * They share no assumptions, so their agreement also confirms the gimbal's
 * degrees are honest 1:1 — an 86° FOV would have required the gimbal to
 * under-report by 39%.
 *
 * Uncertainty is roughly ±3°, dominated by the distance measurement. Values are
 * rounded accordingly; do not add decimal places without re-measuring.
 */
export const HORIZONTAL_FOV_DEG: Record<FovType, number> = {
  wide: 68,
  medium: 60,
  narrow: 50,
};

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

// The tangents are the useful form for every downstream calculation, so they are
// computed once here and the degree-valued halfAngles() is a thin wrapper. Going
// through degrees would mean an atan followed immediately by a tan.
const halfAngleTangents = (optics: Optics, frame: Frame): { tanH: number; tanV: number } => {
  const zoom = optics.zoom ?? 1;
  const tanH = Math.tan(toRad(HORIZONTAL_FOV_DEG[optics.fov] / 2)) / zoom;
  // Vertical follows from horizontal and the aspect ratio, assuming the same
  // projection in both axes. True for a rectilinear lens; weakest at the wide end.
  return { tanH, tanV: tanH * (frame.height / frame.width) };
};

/** Effective half-angles of the visible field, in degrees, after zoom and aspect. */
export function halfAngles(optics: Optics, frame: Frame): { h: number; v: number } {
  const { tanH, tanV } = halfAngleTangents(optics, frame);
  return { h: toDeg(Math.atan(tanH)), v: toDeg(Math.atan(tanV)) };
}

export interface Offset {
  dYaw: number;
  dPitch: number;
}

/**
 * Convert a pixel in a captured frame to the yaw/pitch delta that would bring
 * that point to the center of frame.
 *
 * A rectilinear lens maps angle through a tangent: tan(theta) = u * tan(hfov/2),
 * where u is the normalized offset from center. The linear approximation is
 * exact at the center and again at the edge, and wrong in between — always low,
 * peaking near 3.5 degrees at u ~= 0.53 on the wide setting. That error is the
 * difference between landing on target and visibly hunting, so the tangent form
 * is not optional.
 *
 * Signs: +yaw pans camera-LEFT and image x grows rightward, so the yaw term is
 * negated. +pitch tilts DOWN and image y grows downward, so the pitch term is
 * not. Both conventions are hardware-verified.
 */
export function pixelToOffset(x: number, y: number, frame: Frame, optics: Optics): Offset {
  const { tanH, tanV } = halfAngleTangents(optics, frame);
  const u = (2 * x) / frame.width - 1;
  const v = (2 * y) / frame.height - 1;
  const uEff = optics.mirrored ? -u : u;
  return {
    dYaw: -toDeg(Math.atan(uEff * tanH)),
    dPitch: toDeg(Math.atan(v * tanV)),
  };
}

/**
 * Mechanical limits of the Tiny 2's gimbal, in degrees. Hardware-verified.
 *
 * These live here rather than in the tool layer so there is exactly one
 * definition: `obsbot_gimbal_move` imports them for its own clamping. Two copies
 * of a bound that must agree is a defect waiting to happen.
 *
 * ±150 is the mechanical yaw range on EVERY platform, and these limits are not
 * platform-conditional. Measured 2026-07-25: commanded 145 reads back 145, and
 * 150 reads back 149. Position feedback comes from the camera's physical
 * encoder, which is a property of the hardware and does not vary by OS.
 *
 * Do not "fix" this to 130. `transport/linux.ts` and `transport/macos.ts` record
 * a `CT_PANTILT_ABSOLUTE` range of ±468000 arcsec = ±130°, which reads like a
 * conflict and was raised as one during review. It is not: that is the range the
 * UVC control *advertises* — a descriptor value that under-reports the mechanism
 * it describes — not where the gimbal stops. Nothing clamps to it either;
 * `LinuxTransport.gimbalSet` writes `yawDeg * ARCSEC_PER_DEG` unclamped, so the
 * arcsec figure lives only in comments. See the spec's §8.
 */
export const GIMBAL_YAW_LIMIT_DEG = 150;
export const GIMBAL_PITCH_LIMIT_DEG = 90;

export interface Aim {
  target: Pose;
  offset: Offset;
  /** True if either axis saturated, meaning the target was not reachable. */
  clamped: boolean;
}

const clampTo = (value: number, limit: number): number =>
  Math.min(limit, Math.max(-limit, value));

/**
 * Absolute pose that brings the given pixel to the center of frame.
 *
 * Saturation is REPORTED, not silent: if the target lies outside the gimbal's
 * range the caller has to know it landed short rather than assume the aim
 * succeeded, since a silent clamp presents as "the camera aimed and missed".
 *
 * `current` must be where the camera actually was when the frame was captured.
 * The module cannot verify that — see the spec's section 5 for what breaks it.
 */
export function aimAtPixel(
  x: number,
  y: number,
  frame: Frame,
  optics: Optics,
  current: Pose,
): Aim {
  const offset = pixelToOffset(x, y, frame, optics);
  const rawYaw = current.yaw + offset.dYaw;
  const rawPitch = current.pitch + offset.dPitch;
  const yaw = clampTo(rawYaw, GIMBAL_YAW_LIMIT_DEG);
  const pitch = clampTo(rawPitch, GIMBAL_PITCH_LIMIT_DEG);
  return { target: { yaw, pitch }, offset, clamped: yaw !== rawYaw || pitch !== rawPitch };
}
