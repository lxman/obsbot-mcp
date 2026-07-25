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
 * Published horizontal field of view for each FOV setting, in degrees.
 *
 * The "horizontal" in the name is an ASSUMPTION, not a confirmed fact. Every
 * in-tree source of 86/78/65 (`codec/commands.ts`, `mcp/tools.ts`, `README.md`,
 * `tiny2_specification.md`) states the numbers with no axis qualifier, and they
 * trace back to OBSBOT's published spec sheet, where the Tiny series field of
 * view is listed as DIAGONAL. If that is what these numbers are, the true
 * horizontal/vertical FOV at 16:9 is 78.2°/49.1°, not 86°/55.4° — roughly 3.9°
 * of half-angle error, which is larger than the 3.5° linear-approximation error
 * the tangent mapping in this module exists to eliminate. Unresolved, this is
 * the single largest uncorrected error source in the module. See the spec's
 * §8 for the hardware check that would settle it (the existing vertical-
 * projection check does NOT catch this, since a diagonal source makes both
 * axes wrong in a correlated way that still satisfies tan(V) = tan(H) · aspect).
 */
export const HORIZONTAL_FOV_DEG: Record<FovType, number> = {
  wide: 86,
  medium: 78,
  narrow: 65,
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
 * KNOWN DISCREPANCY, not yet resolved: `transport/linux.ts` and
 * `transport/macos.ts` both record a hardware-measured `CT_PANTILT_ABSOLUTE`
 * (UVC selector 0x0D) range of ±468000/±324000 arc-seconds at 3600 arcsec per
 * degree, i.e. ±130° pan / ±90° tilt. Tilt agrees with GIMBAL_PITCH_LIMIT_DEG
 * below, but pan does not — 150 exceeds what the UVC control can carry. On
 * Linux, absolute moves go through that control, so a yaw target between 130
 * and 150 passes this module's clamp with `clamped: false` and is then
 * silently truncated to 130 by the driver: the camera lands short while this
 * module reports success. On Windows/macOS the vendor V3 frame path may
 * genuinely reach 150, but `obsbot_gimbal_position` reads back through the
 * same ±130 UVC control, so any pose past 130 reads back saturated and would
 * feed a wrong `current` into a subsequent aim. The value is left at 150 here
 * — this comment records the discrepancy rather than resolving it; the
 * consuming tool should treat ±130 as the practical yaw bound, or surface the
 * discrepancy itself. See the spec's §8.
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
