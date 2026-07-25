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

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Horizontal field of view of the CAPTURE STREAM for each FOV setting, in
 * degrees — DERIVED, not three separate measurements.
 *
 * Earlier revisions carried wide/medium/narrow as three independently measured
 * absolutes at +/-3 degrees each. That threw away the most precise thing known
 * about them: the RATIOS between the modes are measured to ~0.05%, roughly 60x
 * better than any of the absolutes, so three free values let the modes drift out
 * of proportion with each other for no reason.
 *
 * One anchor plus measured magnifications instead. The anchor's uncertainty
 * still propagates, but it now moves all three together, which is the honest
 * representation of what is known.
 *
 * MEASURED 2026-07-25 by solving the camera intrinsics from pure gimbal
 * rotations. A camera that only rotates induces an exact homography
 * H = K R K^-1 between views, with no dependence on scene depth, so frames at
 * known gimbal angles determine the focal lengths outright. No distance is
 * measured anywhere — the gimbal angle is the ruler. That is what makes this
 * tighter than the tape-measured letter sheet behind the old +/-3 degrees.
 *
 * Six rotations (pitch +/-10, +/-20; yaw +/-10) over a static scene, 313-1243
 * inliers each, gave fx = 1449-1455 px on a 1920-wide frame across every subset
 * — a spread of 0.2% — which is HFOV 66.8-67.1. Rounded to 67. This also
 * independently reproduces an earlier pan-and-track measurement of 66.4.
 *
 * The per-mode magnifications come from fitting a similarity transform between
 * frames at each setting on a fixed scene (275 and 683 inliers, 0.48 and 0.44 px
 * residual). They are pure ratios, so they are unaffected by which capture
 * format the measurement went through — which matters, because the 1080p pixel
 * formats do NOT share a field of view (see the note on the capture path below).
 *
 * Verified head-to-head on hardware, same feature and same start pose with only
 * the constant differing: a target at u = +0.91 left a yaw residual of -0.823
 * degrees under the old 68 and -0.274 under 67.
 *
 * CAPTURE FORMAT WARNING: MJPEG 1920x1080 is a 1.201x crop of YUYV 1920x1080 on
 * this camera — same resolution, different window onto the sensor. These
 * constants describe the WIDE field, which is what `obsbot_capture_snapshot`
 * delivers. `obsbot_capture_preview` pins MJPEG and therefore shows ~20% less.
 * Any future measurement through ffmpeg must state its pixel format; a
 * resolution alone does not identify the field.
 *
 * SCOPE: 16:9 capture at any resolution. A 4:3 path would need re-measuring.
 */
export const WIDE_HFOV_DEG = 67;

/**
 * Linear magnification of each FOV setting relative to the wide field.
 *
 * MEASURED 2026-07-25. These are the precise part of the pair: the ratios are
 * good to ~0.05% where the anchor above is good to perhaps 0.5%.
 *
 * The continuous zoom writes to this same scale rather than multiplying on top
 * of it — `narrow` plus zoom ratio 1.5 measures 2.509, the same as `wide` plus
 * 1.5 (2.501), not 1.47 x 2.5. The discrete modes and the zoom control are two
 * ways of writing to one magnification scale, which is why setting zoom ratio
 * 1.0 never clears `custom`: it is the same optical state as `wide`.
 */
export const FOV_MAGNIFICATION: Record<FovType, number> = {
  wide: 1,
  medium: 1.15060,
  narrow: 1.47073,
};

export const HORIZONTAL_FOV_DEG: Record<FovType, number> = {
  wide: 2 * toDeg(Math.atan(Math.tan(toRad(WIDE_HFOV_DEG / 2)) / FOV_MAGNIFICATION.wide)),
  medium: 2 * toDeg(Math.atan(Math.tan(toRad(WIDE_HFOV_DEG / 2)) / FOV_MAGNIFICATION.medium)),
  narrow: 2 * toDeg(Math.atan(Math.tan(toRad(WIDE_HFOV_DEG / 2)) / FOV_MAGNIFICATION.narrow)),
};

/**
 * Empirical correction applied on top of the aspect-derived vertical half-angle.
 * MEASURED, not geometric.
 *
 * Square-pixel geometry says tan(V) = tan(H) * (height/width) — 0.5625 at 16:9.
 * Hardware says the vertical field is shorter than that; this factor carries the
 * difference.
 *
 * MEASURED 2026-07-25 from the same intrinsics solve as WIDE_HFOV_DEG above.
 * fy came out 1502-1520 px across every subset of six rotations, implying this
 * factor at 0.957-0.967. Rounded to 0.957.
 *
 * This REPLACES an earlier value of 0.898, which was 7% low. That figure came
 * from a measurement this project's own history recorded as inconclusive, and it
 * was wrong by far more than the effect it was trying to capture.
 *
 * The up/down asymmetry is ~1%, not the ~5% once believed: solving from the
 * up-tilt alone gives 0.957 and from the down-tilt alone 0.967. One constant
 * captures that comfortably. Do NOT reintroduce a two-branch vertical constant
 * on the strength of the old figure. Both candidate explanations for a genuine
 * asymmetry were tested and eliminated — the principal point is centred (cx, cy
 * within a few px of frame centre in every solve) and radial distortion is
 * negligible (k1 ~= -0.02).
 *
 * Verified head-to-head on hardware, same feature and same start pose with only
 * this constant differing: a target at v = -0.83 left a pitch residual of -0.597
 * degrees under 0.898 and +0.072 under 0.957, an 8x improvement that lands
 * inside the noise.
 *
 * Known limit: the intrinsics fit carries 2.4-2.8 px rms, not sub-pixel, so
 * something is unmodelled — most likely the entrance pupil sitting off the
 * gimbal's rotation axes, which translates the lens as it turns and is
 * depth-dependent. Sampling was symmetric so it should not bias fx or fy, but do
 * not claim more precision than that.
 *
 * SCOPE: measured on the 16:9 capture path. A 4:3 path needs its own measurement.
 */
export const VERTICAL_TANGENT_CORRECTION = 0.957;

// The tangents are the useful form for every downstream calculation, so they are
// computed once here and the degree-valued halfAngles() is a thin wrapper. Going
// through degrees would mean an atan followed immediately by a tan.
const halfAngleTangents = (optics: Optics, frame: Frame): { tanH: number; tanV: number } => {
  const zoom = optics.zoom ?? 1;
  const tanH = Math.tan(toRad(HORIZONTAL_FOV_DEG[optics.fov] / 2)) / zoom;
  // Vertical starts from the horizontal half-angle scaled by the frame aspect —
  // what square-pixel geometry predicts — then takes the measured correction,
  // because hardware says the real vertical field is ~10% shorter than that.
  // See VERTICAL_TANGENT_CORRECTION for the ten measurements behind it.
  return { tanH, tanV: tanH * (frame.height / frame.width) * VERTICAL_TANGENT_CORRECTION };
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
