import { expect, test } from "vitest";
import { halfAngles, pixelToOffset, HORIZONTAL_FOV_DEG } from "../../src/geometry/aim.js";

const HD = { width: 1280, height: 720 };
const rad = (deg: number) => (deg * Math.PI) / 180;

test("each FOV setting carries its published horizontal angle", () => {
  expect(HORIZONTAL_FOV_DEG).toEqual({ wide: 86, medium: 78, narrow: 65 });
});

test("the horizontal half-angle is half the published field of view", () => {
  expect(halfAngles({ fov: "wide" }, HD).h).toBeCloseTo(43, 9);
  expect(halfAngles({ fov: "medium" }, HD).h).toBeCloseTo(39, 9);
  expect(halfAngles({ fov: "narrow" }, HD).h).toBeCloseTo(32.5, 9);
});

test("the vertical half-angle follows the frame aspect ratio", () => {
  // tan(V) = tan(H) * (height/width) = tan(43deg) * 0.5625 -> V ~= 27.68deg
  expect(halfAngles({ fov: "wide" }, HD).v).toBeCloseTo(27.68, 2);
});

test("a square frame makes the vertical half-angle equal the horizontal one", () => {
  const sq = halfAngles({ fov: "narrow" }, { width: 1000, height: 1000 });
  expect(sq.v).toBeCloseTo(sq.h, 9);
});

test("zoom crops the field of view by dividing the tangent, not the angle", () => {
  const oneX = halfAngles({ fov: "wide" }, HD).h;
  const twoX = halfAngles({ fov: "wide", zoom: 2 }, HD).h;
  // If zoom divided the ANGLE, 2x would give 21.5deg. It divides the TANGENT.
  expect(Math.tan(rad(twoX))).toBeCloseTo(Math.tan(rad(oneX)) / 2, 9);
  expect(twoX).toBeCloseTo(25.0, 2);
  expect(twoX).not.toBeCloseTo(21.5, 1);
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

const WIDE = { fov: "wide" as const };

test("the center pixel needs no correction", () => {
  const o = pixelToOffset(640, 360, HD, WIDE);
  expect(o.dYaw).toBeCloseTo(0, 9);
  expect(o.dPitch).toBeCloseTo(0, 9);
});

test("the right frame edge maps to exactly the horizontal half-angle, negated", () => {
  expect(pixelToOffset(1280, 360, HD, WIDE).dYaw).toBeCloseTo(-43, 9);
});

test("the left frame edge maps to a positive yaw of the same size", () => {
  expect(pixelToOffset(0, 360, HD, WIDE).dYaw).toBeCloseTo(43, 9);
});

test("halfway to the edge is NOT half the angle — the mapping is tangent, not linear", () => {
  // x=960 is u=0.5. Tangent mapping gives -25.0deg; a linear one would say -21.5deg.
  const dYaw = pixelToOffset(960, 360, HD, WIDE).dYaw;
  expect(dYaw).toBeCloseTo(-25.0, 2);
  expect(dYaw).not.toBeCloseTo(-21.5, 1);
});

test("the bottom of the frame tilts down, which is positive pitch", () => {
  expect(pixelToOffset(640, 720, HD, WIDE).dPitch).toBeCloseTo(27.68, 2);
});

test("the top of the frame tilts up, which is negative pitch", () => {
  expect(pixelToOffset(640, 0, HD, WIDE).dPitch).toBeCloseTo(-27.68, 2);
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
