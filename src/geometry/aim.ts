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
  /**
   * Total linear magnification relative to the WIDE field, which is 1.0.
   *
   * One number, deliberately. The camera has a single magnification scale: the
   * discrete FOV modes are points on it (FOV_MAGNIFICATION) and a continuous
   * zoom writes to it directly (magnificationFromZoomRatio). Setting a zoom
   * ratio REPLACES the mode's magnification rather than multiplying it —
   * `narrow` plus ratio 1.5 measures 2.509, the same as `wide` plus 1.5, not
   * 1.47 x 2.5. An earlier `{ fov, zoom }` shape made that double-counting easy
   * to write and had to warn against it; this shape makes it unrepresentable.
   */
  magnification: number;
  /**
   * Whether the capture path horizontally flips the preview. This inverts the
   * yaw correction, so it is an explicit input rather than a baked-in
   * assumption. Defaults to false.
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
 * inliers each, gave fx = 1452-1455 px on a 1920-wide frame across every subset
 * — a spread of 0.2% — which is HFOV 66.84-66.90. Rounded to 67. This also
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
 * CAPTURE FORMAT WARNING: at 1920x1080 this camera has two different windows
 * onto the sensor, and FRAME RATE selects between them — not the codec.
 * MEASURED 2026-07-25 at one pose and one zoom: MJPEG@30 vs YUYV@30 came out at
 * scale 1.00001, t (0.2, 0.0) over 2382 inliers at 0.12 px, i.e. the same field
 * to within a fifth of a pixel; MJPEG@60 is a 1.214x crop of BOTH (1.21422 and
 * 1.21404). An earlier revision recorded this as "MJPEG is a 1.201x crop of
 * YUYV" — that comparison was MJPEG@60 against YUYV@30 and charged the codec
 * for what the frame rate did.
 *
 * These constants describe the WIDE (30fps) field. That is what
 * `obsbot_capture_snapshot` delivers: its graph negotiates MJPG 1920x1080@30,
 * which the reply now states outright in `sourceFormat`.
 * `obsbot_capture_preview` pins 60fps to buy smooth motion and therefore shows
 * ~21% less — so preview pixels are NOT interchangeable with snapshot pixels
 * for aiming.
 *
 * Any future measurement must state pixel format AND frame rate; neither a
 * resolution nor a codec alone identifies the field.
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
 * 1.0 does not reliably clear `custom`: it is the same optical state as `wide`.
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
 * from a measurement this project's own history recorded as inconclusive: the
 * constant itself was off by about 6.2%, versus the ~4.3% effect it was trying
 * to capture — roughly 1.4x the effect itself, not an order of magnitude off.
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

/** Magnification of the wide field, and of the whole scale, at its extremes. */
export const MIN_MAGNIFICATION = 1;
export const MAX_MAGNIFICATION = 4;

/**
 * Linear magnification for a UVC zoom ratio. MEASURED 2026-07-25: magnification
 * is linear in the ratio, `m = 3r - 2`, holding to better than 0.05% at ratios
 * 1.25, 1.5 and 2.0. So ratio 2.0 is 4x linear — carried for a long time as an
 * unsourced note, now measured to four figures. See the spec's section 1.1.
 */
export const magnificationFromZoomRatio = (ratio: number): number => 3 * ratio - 2;

/** Inverse of {@link magnificationFromZoomRatio}: the ratio that yields `m`. */
export const zoomRatioFromMagnification = (m: number): number => (m + 2) / 3;

// The tangents are the useful form for every downstream calculation, so they are
// computed once here and the degree-valued halfAngles() is a thin wrapper. Going
// through degrees would mean an atan followed immediately by a tan.
//
// This is also the ONE place every public entry point (halfAngles, pixelToOffset,
// aimAtPixel) funnels through, which is why the magnification bound is enforced
// here rather than trusted from the caller. A magnification of 0 divides out to
// tanH = Infinity, which atan silently resolves to a 90-degree half-angle; a
// negative value flips the half-angle's sign with no error; NaN propagates all
// the way through aimAtPixel's output. Before this guard MIN_MAGNIFICATION/
// MAX_MAGNIFICATION were exported but enforced nowhere — decorative constants
// that a malformed device reading (this module's callers now derive magnification
// from a reported zoomPercent) could silently violate. Callers that already
// validate their own input (resolveMagnification in src/mcp/tools.ts) should
// never actually trip this; it exists as the backstop for whichever caller
// doesn't.
const halfAngleTangents = (optics: Optics, frame: Frame): { tanH: number; tanV: number } => {
  if (
    !Number.isFinite(optics.magnification) ||
    optics.magnification < MIN_MAGNIFICATION ||
    optics.magnification > MAX_MAGNIFICATION
  ) {
    throw new RangeError(
      `optics.magnification must be finite and within [${MIN_MAGNIFICATION}, ${MAX_MAGNIFICATION}], got ${optics.magnification}`,
    );
  }
  const tanH = Math.tan(toRad(WIDE_HFOV_DEG / 2)) / optics.magnification;
  // Vertical starts from the horizontal half-angle scaled by the frame aspect —
  // what square-pixel geometry predicts — then takes the measured correction,
  // because hardware says the real vertical field is ~4.3% shorter than that.
  // See VERTICAL_TANGENT_CORRECTION for the intrinsics solve over six gimbal
  // rotations behind it.
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
 * that point to the center of frame, treating each axis independently.
 *
 * PER-AXIS ONLY — this does NOT account for axis coupling. The gimbal's yaw
 * axis is world-vertical, so yawing while pitched sweeps a cone; the two axes
 * commute only at zero pitch or zero horizontal offset (see `aimAtPixel`,
 * which composes a rotation instead and is what every tool actually points
 * the camera with). Adding this function's dYaw/dPitch to a pose that is not
 * level reproduces the additive bug `aimAtPixel` was fixed to remove. It is
 * used only by tests now, to pin the per-axis tangent mapping in isolation
 * from the coupling — do not reach for it as a general "point the camera"
 * answer.
 *
 * A rectilinear lens maps angle through a tangent: tan(theta) = u * tan(hfov/2),
 * where u is the normalized offset from center. The linear approximation is
 * exact at the center and again at the edge, and wrong in between — always low,
 * peaking near 1.58 degrees at u ~= 0.55 on the wide setting (WIDE_HFOV_DEG =
 * 67). That error is the difference between landing on target and visibly
 * hunting, so the tangent form is not optional.
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
  /**
   * The rotation REQUESTED to reach the raw, unclamped target —
   * `rawTarget - current` — not the rotation actually applied. When `clamped`
   * is true, `target` stops short of `current + offset`; `offset` still
   * reports what was asked for, not what the gimbal was told to do.
   */
  offset: Offset;
  /** True if either axis saturated, meaning the target was not reachable. */
  clamped: boolean;
  /**
   * True when the target ray's horizontal direction points opposite the
   * camera's current heading — an "over the top" solution. The pixel lies
   * past vertical from the current pose and is not reachable by any rotation
   * that keeps the image upright; clamping it to the nearest yaw would slew
   * the camera toward the far side of the room, not toward the target.
   */
  overTheTop: boolean;
}

const clampTo = (value: number, limit: number): number =>
  Math.min(limit, Math.max(-limit, value));

/**
 * Absolute pose that brings the given pixel to the centre of frame.
 *
 * Composes a rotation rather than adding two scalars. The gimbal's yaw axis is
 * world-vertical, so yawing while pitched sweeps a CONE: the two rotations do
 * not commute, and `target = current + offset` is exact only at zero pitch or
 * zero horizontal offset. Adding them cost 0.98 degrees at pitch 7.6 / yaw 31 on
 * hardware, against `pitch * (1 - cos yaw)` = 1.09 predicted.
 *
 * The ray to the target in camera coordinates (x right, y down, z forward) is
 * rotated into world coordinates by the current orientation, and the target pose
 * is read back off that direction. The two axes reduce to the old additive sum
 * under DIFFERENT conditions, not the same one: yaw reduces exactly to the old
 * sum whenever pitch = 0, for any pixel, because yaw and pitch commute at zero
 * tilt. Pitch reduces to the old sum only when u = 0 (the pixel sits on the
 * vertical centre line) — composed pitch is asin(dy/n) where n includes dx, so
 * away from u = 0 it differs from the old atan(dy) even when pitch is 0. That is
 * what the invariant tests pin.
 *
 * Saturation is REPORTED, not silent: if the target lies outside the gimbal's
 * range the caller has to know it landed short rather than assume the aim
 * succeeded, since a silent clamp presents as "the camera aimed and missed".
 *
 * `current` must be where the camera actually was when the frame was captured.
 * The module cannot verify that — see the spec's section 5 for what breaks it.
 * Note that on Windows the pose the caller reads is FLOORED to whole degrees
 * (spec section 4.2), which costs up to another degree; that is a separate
 * defect in the pose source, not in this function.
 */
export function aimAtPixel(
  x: number,
  y: number,
  frame: Frame,
  optics: Optics,
  current: Pose,
): Aim {
  const { tanH, tanV } = halfAngleTangents(optics, frame);
  const u = (2 * x) / frame.width - 1;
  const v = (2 * y) / frame.height - 1;
  const uEff = optics.mirrored ? -u : u;

  // Ray to the target, in camera coordinates: x right, y down, z forward.
  const dx = uEff * tanH;
  const dy = v * tanV;
  const dz = 1;
  const n = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const cy = Math.cos(toRad(current.yaw));
  const sy = Math.sin(toRad(current.yaw));
  const cp = Math.cos(toRad(current.pitch));
  const sp = Math.sin(toRad(current.pitch));

  // Pitch first, about the camera's own x-axis (+pitch tilts DOWN)...
  const px = dx / n;
  const py = (dy * cp + dz * sp) / n;
  const pz = (-dy * sp + dz * cp) / n;
  // ...then yaw, about the world vertical (+yaw pans camera-LEFT).
  const wx = px * cy - pz * sy;
  const wy = py;
  const wz = px * sy + pz * cy;

  const rawPitch = toDeg(Math.asin(Math.max(-1, Math.min(1, wy))));
  // atan2 returns [-180, 180] — -180 IS included, and is exactly the case the
  // following paragraph handles. Pick the representative nearest the current
  // yaw so a target past +150 reads as +183 rather than -177. Without this a
  // saturating aim clamps to the WRONG END of the range.
  //
  // This is a modulo wrap rather than `Math.round((current.yaw - rawYaw) /
  // 360)`: at an exact 180-degree difference — dead behind the camera, which
  // happens for real at u = 0 aiming past vertical — that rounds ties toward
  // +Infinity regardless of sign (JS's Math.round(0.5) is 1, not 0), which
  // silently flips -180 to +180 and clamps on the wrong end. The wrap below
  // always resolves an exact tie to the lower edge of the window instead.
  const rawYawAtan2 = toDeg(Math.atan2(-wx, wz));
  const rawYaw = current.yaw + (((rawYawAtan2 - current.yaw + 180) % 360 + 360) % 360 - 180);

  const yaw = clampTo(rawYaw, GIMBAL_YAW_LIMIT_DEG);
  const pitch = clampTo(rawPitch, GIMBAL_PITCH_LIMIT_DEG);

  // Over the top: the target ray's horizontal direction points opposite the
  // camera's current heading. (hx, hz) is that heading; (wx, wz) is the target
  // direction, both already computed above. A negative dot product means the
  // only way to face the target while keeping the image upright is to go past
  // vertical — clamping the resulting yaw to the nearest limit would slew the
  // camera toward the OPPOSITE side of the room, not toward the target, so the
  // caller must refuse this case rather than clamp-and-move it.
  const hx = -sy;
  const hz = cy;
  const overTheTop = hx * wx + hz * wz < 0;

  return {
    target: { yaw, pitch },
    offset: { dYaw: rawYaw - current.yaw, dPitch: rawPitch - current.pitch },
    clamped: yaw !== rawYaw || pitch !== rawPitch,
    overTheTop,
  };
}
