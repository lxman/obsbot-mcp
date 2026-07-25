import { expect, test } from "vitest";
import {
  halfAngles, pixelToOffset, aimAtPixel,
  HORIZONTAL_FOV_DEG, VERTICAL_TANGENT_CORRECTION, GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG,
  WIDE_HFOV_DEG, FOV_MAGNIFICATION,
} from "../../src/geometry/aim.js";

const HD = { width: 1280, height: 720 };
const rad = (deg: number) => (deg * Math.PI) / 180;

// The FOV angles are DERIVED from one measured anchor (WIDE_HFOV_DEG) and the
// measured per-mode magnifications, not taken from OBSBOT's spec sheet — the
// sheet's 86/78/65 are diagonal, full-sensor figures and do not describe the
// horizontal extent of a 16:9 capture stream. See the aim.ts doc comments for
// the intrinsics solve behind both constants and the hardware A/B that confirmed
// them.

test("the FOV table is derived from one anchor and the measured magnifications", () => {
  // Three independent absolutes at +/-3deg each threw away the fact that the
  // RATIOS between modes are known ~60x better than the absolutes. One anchor
  // plus measured magnifications keeps the relative structure exact.
  expect(WIDE_HFOV_DEG).toBe(67);
  expect(FOV_MAGNIFICATION).toEqual({ wide: 1, medium: 1.15060, narrow: 1.47073 });
  expect(HORIZONTAL_FOV_DEG.wide).toBeCloseTo(67.0, 6);
  expect(HORIZONTAL_FOV_DEG.medium).toBeCloseTo(59.8195, 3);
  expect(HORIZONTAL_FOV_DEG.narrow).toBeCloseTo(48.4592, 3);
});

test("the derived table really is derived, not three literals", () => {
  // If someone re-hardcodes the values, this catches it: each mode's tangent
  // must be the wide tangent divided by that mode's measured magnification.
  const tanWide = Math.tan(rad(HORIZONTAL_FOV_DEG.wide / 2));
  for (const mode of ["wide", "medium", "narrow"] as const) {
    expect(Math.tan(rad(HORIZONTAL_FOV_DEG[mode] / 2)))
      .toBeCloseTo(tanWide / FOV_MAGNIFICATION[mode], 9);
  }
});

test("the horizontal half-angle is half the measured field of view", () => {
  expect(halfAngles({ fov: "wide" }, HD).h).toBeCloseTo(33.5, 9);
  expect(halfAngles({ fov: "medium" }, HD).h).toBeCloseTo(29.9098, 3);
  expect(halfAngles({ fov: "narrow" }, HD).h).toBeCloseTo(24.2296, 3);
});

test("the vertical half-angle takes the measured correction, not bare geometry", () => {
  // Square-pixel geometry would give tan(33.5deg) * 0.5625 -> V ~= 20.4208deg.
  // Hardware says the vertical field is shorter than that, so the measured
  // correction applies and V ~= 19.6110deg. See VERTICAL_TANGENT_CORRECTION.
  expect(halfAngles({ fov: "wide" }, HD).v).toBeCloseTo(19.6110, 2);
  expect(halfAngles({ fov: "wide" }, HD).v).not.toBeCloseTo(20.4208, 1);
});

test("the vertical correction is the measured value, not a no-op", () => {
  // Solved from six known gimbal rotations (spec 3.1) and confirmed head-to-head
  // on hardware (spec 3.2): the vertical residual falls from -0.597 to +0.072
  // degrees when this changes from 0.898 to 0.957. If this ever reads 1, someone
  // has quietly reverted to square-pixel geometry, which measurement disproved.
  expect(VERTICAL_TANGENT_CORRECTION).toBeCloseTo(0.957, 3);
});

test("the measured vertical/horizontal tangent ratio is ~0.538 at 16:9", () => {
  const { h, v } = halfAngles({ fov: "wide" }, HD);
  expect(Math.tan(rad(v)) / Math.tan(rad(h))).toBeCloseTo(0.538312, 3);
  // Square-pixel geometry demands 0.5625; the camera does not deliver it.
  expect(Math.tan(rad(v)) / Math.tan(rad(h))).not.toBeCloseTo(0.5625, 2);
});

test("the vertical half-angle still scales with the frame aspect ratio", () => {
  // The correction multiplies the aspect term, it does not replace it.
  const tall = halfAngles({ fov: "narrow" }, { width: 1000, height: 1000 });
  const flat = halfAngles({ fov: "narrow" }, { width: 1000, height: 500 });
  expect(Math.tan(rad(tall.v))).toBeCloseTo(2 * Math.tan(rad(flat.v)), 9);
});

test("zoom crops the field of view by dividing the tangent, not the angle", () => {
  const oneX = halfAngles({ fov: "wide" }, HD).h;
  const twoX = halfAngles({ fov: "wide", zoom: 2 }, HD).h;
  // If zoom divided the ANGLE, 2x would give 17deg. It divides the TANGENT.
  expect(Math.tan(rad(twoX))).toBeCloseTo(Math.tan(rad(oneX)) / 2, 9);
  expect(twoX).toBeCloseTo(18.3116, 2);
  expect(twoX).not.toBeCloseTo(17.0, 1);
});

test("omitted zoom is treated as 1x", () => {
  expect(halfAngles({ fov: "wide" }, HD).h).toBeCloseTo(halfAngles({ fov: "wide", zoom: 1 }, HD).h, 9);
});

// --- pixel -> angular offset ---
//
// The sign conventions under test are hardware-verified and must not be
// re-derived: +yaw pans camera-LEFT, +pitch tilts DOWN, image x grows rightward
// and y grows downward. So a target on the RIGHT of frame needs a NEGATIVE yaw
// delta, and a target BELOW center needs a POSITIVE pitch delta. That asymmetry
// is the single most likely place for a sign bug.
//
// Not-mirrored is confirmed on hardware (2026-07-25): panning the gimbal to
// negative yaw swept the scene LEFT across the frame, which is what an unmirrored
// capture path does.

const WIDE = { fov: "wide" as const };

test("the center pixel needs no correction", () => {
  const o = pixelToOffset(640, 360, HD, WIDE);
  expect(o.dYaw).toBeCloseTo(0, 9);
  expect(o.dPitch).toBeCloseTo(0, 9);
});

test("the right frame edge maps to exactly the horizontal half-angle, negated", () => {
  expect(pixelToOffset(1280, 360, HD, WIDE).dYaw).toBeCloseTo(-33.5, 9);
});

test("the left frame edge maps to a positive yaw of the same size", () => {
  expect(pixelToOffset(0, 360, HD, WIDE).dYaw).toBeCloseTo(33.5, 9);
});

test("halfway to the edge is NOT half the angle — the mapping is tangent, not linear", () => {
  // x=960 is u=0.5. Tangent mapping gives -18.3116deg; a linear one would say -17deg.
  const dYaw = pixelToOffset(960, 360, HD, WIDE).dYaw;
  expect(dYaw).toBeCloseTo(-18.3116, 2);
  expect(dYaw).not.toBeCloseTo(-17.0, 1);
});

test("the bottom of the frame tilts down, which is positive pitch", () => {
  expect(pixelToOffset(640, 720, HD, WIDE).dPitch).toBeCloseTo(19.6110, 2);
});

test("the top of the frame tilts up, which is negative pitch", () => {
  expect(pixelToOffset(640, 0, HD, WIDE).dPitch).toBeCloseTo(-19.6110, 2);
});

test("a mirrored capture inverts yaw and leaves pitch untouched", () => {
  const normal = pixelToOffset(960, 500, HD, WIDE);
  const flipped = pixelToOffset(960, 500, HD, { ...WIDE, mirrored: true });
  expect(flipped.dYaw).toBeCloseTo(-normal.dYaw, 9);
  expect(flipped.dPitch).toBeCloseTo(normal.dPitch, 9);
});

test("offsets are antisymmetric about the frame center", () => {
  const left = pixelToOffset(300, 200, HD, WIDE);
  const right = pixelToOffset(1280 - 300, 720 - 200, HD, WIDE);
  expect(right.dYaw).toBeCloseTo(-left.dYaw, 9);
  expect(right.dPitch).toBeCloseTo(-left.dPitch, 9);
});

test("dYaw decreases monotonically as x increases", () => {
  const xs = [0, 200, 400, 640, 900, 1100, 1280];
  const yaws = xs.map((x) => pixelToOffset(x, 360, HD, WIDE).dYaw);
  for (let i = 1; i < yaws.length; i++) expect(yaws[i]).toBeLessThan(yaws[i - 1]);
});

test("dPitch increases monotonically as y increases", () => {
  const ys = [0, 100, 300, 360, 500, 700, 720];
  const pitches = ys.map((y) => pixelToOffset(640, y, HD, WIDE).dPitch);
  for (let i = 1; i < pitches.length; i++) expect(pitches[i]).toBeGreaterThan(pitches[i - 1]);
});

test("zooming in shrinks the offset for the same pixel", () => {
  const oneX = pixelToOffset(960, 360, HD, WIDE).dYaw;
  const twoX = pixelToOffset(960, 360, HD, { ...WIDE, zoom: 2 }).dYaw;
  expect(Math.abs(twoX)).toBeLessThan(Math.abs(oneX));
});

// --- absolute aim ---
//
// aimAtPixel computes target = current + offset. That is sound only if `current`
// is where the camera actually was when the snapshot fired; AI tracking, an
// unsettled gimbal, or another controller all break it silently. The module
// takes `current` as a parameter and cannot police any of that — holding the
// invariant is the calling tool's job. See spec section 5.

test("the gimbal limits are the hardware-verified bounds", () => {
  expect(GIMBAL_YAW_LIMIT_DEG).toBe(150);
  expect(GIMBAL_PITCH_LIMIT_DEG).toBe(90);
});

test("the target is the current pose plus the offset", () => {
  const aim = aimAtPixel(960, 360, HD, WIDE, { yaw: 10, pitch: 5 });
  expect(aim.target.yaw).toBeCloseTo(10 - 18.3116, 2);
  expect(aim.target.pitch).toBeCloseTo(5, 9);
  expect(aim.clamped).toBe(false);
});

test("aiming at the center pixel leaves the pose alone", () => {
  const aim = aimAtPixel(640, 360, HD, WIDE, { yaw: -37, pitch: 12 });
  expect(aim.target.yaw).toBeCloseTo(-37, 9);
  expect(aim.target.pitch).toBeCloseTo(12, 9);
  expect(aim.clamped).toBe(false);
});

test("the returned offset matches pixelToOffset for the same inputs", () => {
  const direct = pixelToOffset(300, 200, HD, WIDE);
  const aim = aimAtPixel(300, 200, HD, WIDE, { yaw: 0, pitch: 0 });
  expect(aim.offset.dYaw).toBeCloseTo(direct.dYaw, 9);
  expect(aim.offset.dPitch).toBeCloseTo(direct.dPitch, 9);
});

test("a yaw target beyond the limit is clamped and reported", () => {
  // Left edge gives +33.5deg; from yaw 149 that would be 182.5deg.
  const aim = aimAtPixel(0, 360, HD, WIDE, { yaw: 149, pitch: 0 });
  expect(aim.target.yaw).toBe(150);
  expect(aim.clamped).toBe(true);
});

test("a pitch target beyond the limit is clamped and reported", () => {
  // Bottom edge gives +19.61deg; from pitch 85 that would be 104.61deg.
  const aim = aimAtPixel(640, 720, HD, WIDE, { yaw: 0, pitch: 85 });
  expect(aim.target.pitch).toBe(90);
  expect(aim.clamped).toBe(true);
});

test("clamping at the negative end is reported too", () => {
  const aim = aimAtPixel(1280, 0, HD, WIDE, { yaw: -140, pitch: -80 });
  expect(aim.target.yaw).toBe(-150);
  expect(aim.target.pitch).toBe(-90);
  expect(aim.clamped).toBe(true);
});

test("saturating one axis does not falsely clamp the other", () => {
  const aim = aimAtPixel(0, 360, HD, WIDE, { yaw: 149, pitch: 3 });
  expect(aim.target.yaw).toBe(150);
  expect(aim.target.pitch).toBeCloseTo(3, 9);
  expect(aim.clamped).toBe(true);
});

test("a target inside the limits is never reported as clamped", () => {
  const aim = aimAtPixel(1280, 720, HD, WIDE, { yaw: 0, pitch: 0 });
  expect(aim.target.yaw).toBeCloseTo(-33.5, 9);
  expect(aim.target.pitch).toBeCloseTo(19.6110, 2);
  expect(aim.clamped).toBe(false);
});
