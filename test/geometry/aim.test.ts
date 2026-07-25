import { expect, test } from "vitest";
import { halfAngles, HORIZONTAL_FOV_DEG } from "../../src/geometry/aim.js";

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
