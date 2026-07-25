import { expect, test } from "vitest";
import {
  halfAngles, pixelToOffset, aimAtPixel,
  HORIZONTAL_FOV_DEG, VERTICAL_TANGENT_CORRECTION, GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG,
  WIDE_HFOV_DEG, FOV_MAGNIFICATION,
  magnificationFromZoomRatio, zoomRatioFromMagnification,
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

test("magnification is linear in the UVC zoom ratio", () => {
  // m = 3r - 2, measured to better than 0.05% (spec section 1.1). Ratio 2.0 is
  // 4x linear, not 2x — a note this project carried unsourced until it was
  // measured.
  expect(magnificationFromZoomRatio(1.0)).toBeCloseTo(1.0, 9);
  expect(magnificationFromZoomRatio(1.25)).toBeCloseTo(1.75, 9);
  expect(magnificationFromZoomRatio(1.5)).toBeCloseTo(2.5, 9);
  expect(magnificationFromZoomRatio(2.0)).toBeCloseTo(4.0, 9);
});

test("the ratio conversion round-trips", () => {
  for (const r of [1.0, 1.1, 1.25, 1.5, 1.75, 1.9, 2.0]) {
    expect(zoomRatioFromMagnification(magnificationFromZoomRatio(r))).toBeCloseTo(r, 9);
  }
});

test("the FOV presets sit on the same magnification scale as the zoom", () => {
  // The discrete modes are not a separate control — they are points on the zoom
  // scale, which is why obsbot_zoom_uvc {ratio:1} does not clear `custom`:
  // ratio 1.0 IS wide.
  expect(zoomRatioFromMagnification(FOV_MAGNIFICATION.wide)).toBeCloseTo(1.0, 9);
  expect(zoomRatioFromMagnification(FOV_MAGNIFICATION.medium)).toBeCloseTo(1.05020, 4);
  expect(zoomRatioFromMagnification(FOV_MAGNIFICATION.narrow)).toBeCloseTo(1.15691, 4);
});

test("magnification divides the tangent, and the wide field is the reference", () => {
  const wide = halfAngles({ magnification: 1 }, HD);
  const twice = halfAngles({ magnification: 2 }, HD);
  expect(wide.h).toBeCloseTo(33.5, 9);
  expect(Math.tan(rad(twice.h))).toBeCloseTo(Math.tan(rad(wide.h)) / 2, 9);
});

test("the collapsed optics reproduce the derived per-mode fields exactly", () => {
  // Guards the restructure: passing a mode's magnification must give exactly the
  // half-angle the derived HORIZONTAL_FOV_DEG table gives. If this drifts, the
  // rename moved a measured value.
  for (const mode of ["wide", "medium", "narrow"] as const) {
    expect(halfAngles({ magnification: FOV_MAGNIFICATION[mode] }, HD).h)
      .toBeCloseTo(HORIZONTAL_FOV_DEG[mode] / 2, 9);
  }
});

test("the horizontal half-angle is half the measured field of view", () => {
  expect(halfAngles({ magnification: 1 }, HD).h).toBeCloseTo(33.5, 9);
  expect(halfAngles({ magnification: FOV_MAGNIFICATION.medium }, HD).h).toBeCloseTo(29.9098, 3);
  expect(halfAngles({ magnification: FOV_MAGNIFICATION.narrow }, HD).h).toBeCloseTo(24.2296, 3);
});

test("the vertical half-angle takes the measured correction, not bare geometry", () => {
  // Square-pixel geometry would give tan(33.5deg) * 0.5625 -> V ~= 20.4208deg.
  // Hardware says the vertical field is shorter than that, so the measured
  // correction applies and V ~= 19.6110deg. See VERTICAL_TANGENT_CORRECTION.
  expect(halfAngles({ magnification: 1 }, HD).v).toBeCloseTo(19.6110, 2);
  expect(halfAngles({ magnification: 1 }, HD).v).not.toBeCloseTo(20.4208, 1);
});

test("the vertical correction is the measured value, not a no-op", () => {
  // Solved from six known gimbal rotations (spec 3.1) and confirmed head-to-head
  // on hardware (spec 3.2): the vertical residual falls from -0.597 to +0.072
  // degrees when this changes from 0.898 to 0.957. If this ever reads 1, someone
  // has quietly reverted to square-pixel geometry, which measurement disproved.
  expect(VERTICAL_TANGENT_CORRECTION).toBeCloseTo(0.957, 3);
});

test("the measured vertical/horizontal tangent ratio is ~0.538 at 16:9", () => {
  const { h, v } = halfAngles({ magnification: 1 }, HD);
  expect(Math.tan(rad(v)) / Math.tan(rad(h))).toBeCloseTo(0.538312, 3);
  // Square-pixel geometry demands 0.5625; the camera does not deliver it.
  expect(Math.tan(rad(v)) / Math.tan(rad(h))).not.toBeCloseTo(0.5625, 2);
});

test("the vertical half-angle still scales with the frame aspect ratio", () => {
  // The correction multiplies the aspect term, it does not replace it.
  const tall = halfAngles({ magnification: FOV_MAGNIFICATION.narrow }, { width: 1000, height: 1000 });
  const flat = halfAngles({ magnification: FOV_MAGNIFICATION.narrow }, { width: 1000, height: 500 });
  expect(Math.tan(rad(tall.v))).toBeCloseTo(2 * Math.tan(rad(flat.v)), 9);
});

test("zoom crops the field of view by dividing the tangent, not the angle", () => {
  const oneX = halfAngles({ magnification: 1 }, HD).h;
  const twoX = halfAngles({ magnification: 2 }, HD).h;
  // If zoom divided the ANGLE, 2x would give 17deg. It divides the TANGENT.
  expect(Math.tan(rad(twoX))).toBeCloseTo(Math.tan(rad(oneX)) / 2, 9);
  expect(twoX).toBeCloseTo(18.3116, 2);
  expect(twoX).not.toBeCloseTo(17.0, 1);
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

const WIDE = { magnification: 1 };

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
  const twoX = pixelToOffset(960, 360, HD, { magnification: 2 }).dYaw;
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

test("the target composes the current pose with the pixel's ray", () => {
  // Pitch moves even though the pixel is on the horizontal centre line: yawing
  // from a tilted pose sweeps a cone.
  const aim = aimAtPixel(960, 360, HD, WIDE, { yaw: 10, pitch: 5 });
  expect(aim.target.yaw).toBeCloseTo(-8.376845, 5);
  expect(aim.target.pitch).toBeCloseTo(4.746213, 5);
  expect(aim.clamped).toBe(false);
});

test("aiming at the centre pixel leaves any pose untouched, however tilted", () => {
  const aim = aimAtPixel(640, 360, HD, WIDE, { yaw: 10, pitch: 5 });
  expect(aim.target.yaw).toBeCloseTo(10, 9);
  expect(aim.target.pitch).toBeCloseTo(5, 9);
});

test("a purely vertical target is exact even from a tilted pose", () => {
  // u=0 means the ray lies in the camera's vertical plane, so yawing is not
  // involved and the composed answer must equal the simple sum.
  const aim = aimAtPixel(640, 540, HD, WIDE, { yaw: 10, pitch: 5 });
  expect(aim.target.yaw).toBeCloseTo(10, 9);
  expect(aim.target.pitch).toBeCloseTo(15.101305, 5);
});

test("from a level pose the composition reduces to the simple sum", () => {
  // pitch=0 is the case where YAW reduces to the old sum, for any pixel — yaw
  // and pitch commute at zero tilt. The resulting pitch of 0 here is NOT
  // general evidence that pitch reduces to the sum from a level pose: it holds
  // only because v=0 (this pixel sits on the horizontal centre line, x=960 is
  // u=0.5). Away from u=0, composed pitch (asin(dy/n), where n includes dx)
  // differs from the old atan(dy) even when the starting pitch is 0 — see "a
  // purely vertical target is exact even from a tilted pose" above, which pins
  // the actual condition (u=0), and the level-pose case is testable directly
  // in "the offset matches pixelToOffset only when one axis is zero" below. If
  // this drifts, the rotation order or a sign is wrong.
  const aim = aimAtPixel(960, 360, HD, WIDE, { yaw: 10, pitch: 0 });
  expect(aim.target.yaw).toBeCloseTo(-8.311589, 5);
  expect(aim.target.pitch).toBeCloseTo(0, 9);
});

test("yawing from a tilted pose sweeps a cone, so pitch changes too", () => {
  // THE BUG THIS TASK FIXES. Adding scalars gives (-8.311589, 20); the gimbal's
  // yaw axis is world-vertical, so the real answer is over a degree away in both
  // axes. Hardware measured 0.98 deg of pitch error at a comparable geometry.
  const aim = aimAtPixel(960, 360, HD, WIDE, { yaw: 10, pitch: 20 });
  expect(aim.target.yaw).toBeCloseTo(-9.401344, 5);
  expect(aim.target.pitch).toBeCloseTo(18.947456, 5);
  expect(aim.target.pitch).not.toBeCloseTo(20, 1);
});

test("aiming at the center pixel leaves the pose alone", () => {
  const aim = aimAtPixel(640, 360, HD, WIDE, { yaw: -37, pitch: 12 });
  expect(aim.target.yaw).toBeCloseTo(-37, 9);
  expect(aim.target.pitch).toBeCloseTo(12, 9);
  expect(aim.clamped).toBe(false);
});

test("the offset matches pixelToOffset only when one axis is zero", () => {
  // Same thing along a single axis from a level pose...
  const direct = pixelToOffset(960, 360, HD, WIDE);
  const aim = aimAtPixel(960, 360, HD, WIDE, { yaw: 0, pitch: 0 });
  expect(aim.offset.dYaw).toBeCloseTo(direct.dYaw, 9);
  expect(aim.offset.dPitch).toBeCloseTo(direct.dPitch, 9);

  // ...but NOT for a target offset in both axes, even from a level pose: the
  // vertical angle to an off-axis point is smaller than the on-axis mapping
  // says, because the ray is longer. pixelToOffset is per-axis by definition;
  // aimAtPixel composes. This divergence is correct, not a regression.
  const both = aimAtPixel(300, 200, HD, WIDE, { yaw: 0, pitch: 0 });
  expect(both.target.yaw).toBeCloseTo(19.373036, 5);
  expect(both.target.pitch).toBeCloseTo(-8.496571, 5);
  expect(both.target.pitch).not.toBeCloseTo(-8.998417, 2);
});

test("a yaw target beyond the limit is clamped and reported", () => {
  // Left edge gives +33.5deg; from yaw 149 that would be 182.5deg.
  const aim = aimAtPixel(0, 360, HD, WIDE, { yaw: 149, pitch: 0 });
  expect(aim.target.yaw).toBe(150);
  expect(aim.clamped).toBe(true);
});

test("aiming past vertical yields the over-the-top solution, and clamps", () => {
  // From pitch 85, the bottom edge of frame is 104.6 deg down — past straight
  // down. That direction is reachable only by yawing 180 and pitching 75.4,
  // which is geometrically correct and beyond the yaw limit, so it clamps
  // there instead of on pitch. The additive model produced pitch 104.6 and
  // clamped it to 90, which pointed somewhere the target was not.
  const aim = aimAtPixel(640, 720, HD, WIDE, { yaw: 0, pitch: 85 });
  expect(aim.target.pitch).toBeCloseTo(75.388952, 5);
  expect(aim.target.yaw).toBe(-150);
  expect(aim.clamped).toBe(true);
});

test("the past-vertical case reports overTheTop, not just clamped", () => {
  // Same geometry as above: the target ray points behind the camera's current
  // heading, so this is not an ordinary out-of-range clamp — clamping the yaw
  // to the nearest limit would slew 150 degrees toward the opposite side of
  // the room, not toward the target. Callers must check this separately from
  // `clamped` and refuse rather than move.
  const aim = aimAtPixel(640, 720, HD, WIDE, { yaw: 0, pitch: 85 });
  expect(aim.overTheTop).toBe(true);
});

test("an ordinary out-of-range clamp is NOT overTheTop", () => {
  // Left edge from yaw 149 clamps to 150, but the target is still roughly
  // where the camera is already heading — a little past the yaw limit, not
  // behind the camera. Ordinary clamping must keep moving to the nearest
  // reachable pose.
  const aim = aimAtPixel(0, 360, HD, WIDE, { yaw: 149, pitch: 0 });
  expect(aim.clamped).toBe(true);
  expect(aim.overTheTop).toBe(false);
});

test("clamping at the negative end is reported too", () => {
  // The top-right corner from pitch -80 is likewise past vertical: the
  // composed solution goes over the top, clamping on yaw and leaving pitch
  // unclamped, rather than the additive model's pitch beyond -90.
  const aim = aimAtPixel(1280, 0, HD, WIDE, { yaw: -140, pitch: -80 });
  expect(aim.target.yaw).toBe(-150);
  expect(aim.target.pitch).toBeCloseTo(-56.789344, 5);
  expect(aim.clamped).toBe(true);
});

test("saturating one axis does not falsely clamp the other", () => {
  // Pitch no longer comes through unchanged even though the pixel sits on the
  // horizontal centre line (v=0): the target is off-axis in x (the left
  // edge), so the composed ray's y-component is diluted by that horizontal
  // offset before the asin, same cone effect as the invariant tests above.
  // Only zero pitch or zero horizontal offset reproduces the additive value.
  const aim = aimAtPixel(0, 360, HD, WIDE, { yaw: 149, pitch: 3 });
  expect(aim.target.yaw).toBe(150);
  expect(aim.target.pitch).toBeCloseTo(2.501309, 5);
  expect(aim.clamped).toBe(true);
});

test("a target inside the limits is never reported as clamped", () => {
  // Pitch is not the simple sum here either: the target (bottom-right corner)
  // is off-axis in both x and y, so even from a level pose the composed
  // vertical angle is smaller than pixelToOffset's per-axis atan() — the ray
  // to a corner is longer than the ray to an edge, same effect documented on
  // "the offset matches pixelToOffset only when one axis is zero" above.
  const aim = aimAtPixel(1280, 720, HD, WIDE, { yaw: 0, pitch: 0 });
  expect(aim.target.yaw).toBeCloseTo(-33.5, 9);
  expect(aim.target.pitch).toBeCloseTo(16.547452, 5);
  expect(aim.clamped).toBe(false);
});
