# Aim Geometry Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, hardware-free `src/geometry/aim.ts` that converts a pixel in a camera snapshot into an absolute gimbal pose.

**Architecture:** One small module of pure functions layered in three steps — effective half-angles from the FOV setting and zoom, then pixel to angular offset through a rectilinear tangent mapping, then offset plus current pose to a clamped absolute target. No I/O, no transport, no device access, so the whole thing is unit-testable with no camera attached. The gimbal's mechanical limits move here from bare literals in the tool layer and are imported back by `tools.ts`, so one definition serves both.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-aim-geometry-design.md`

## Global Constraints

- **Module purity:** `src/geometry/aim.ts` must not import from `transport/`, `device/`, `ipc/`, or `mcp/`. Its only permitted project import is the `FovType` type from `../codec/commands.js`.
- **Module resolution is NodeNext:** every relative import must carry a `.js` extension, even in `.ts` source. `from "../../src/geometry/aim.js"` is correct; `from "../../src/geometry/aim"` will not compile.
- **Degrees in the public API, radians internal only.** This matches every other angle in the codebase.
- **Sign conventions are hardware-verified. Do not re-derive them.** Positive yaw pans to the camera's **left**. Positive pitch tilts **down**. Image `x` increases rightward, `y` increases downward. Consequence: the yaw term carries a negation, the pitch term does not.
- **Gimbal bounds:** yaw `[-150, 150]`, pitch `[-90, 90]`. Hardware-verified. After Task 3 these must exist as exactly one definition — no second copy of the numbers anywhere in `src/`.
- **Horizontal FOV angles:** wide 86°, medium 78°, narrow 65°.
- **Test style:** `import { expect, test } from "vitest";` with flat `test()` calls. Tests live at `test/<area>/<name>.test.ts`. Match the existing style in `test/codec/commands.test.ts`.
- **TypeScript is `strict`.** No implicit `any`, no unused locals slipping through.

---

### Task 1: Half-angle geometry

Establishes the module, its types, the FOV angle table, and the effective half-angle calculation including zoom and aspect ratio.

**Files:**
- Create: `src/geometry/aim.ts`
- Create: `test/geometry/aim.test.ts`

**Interfaces:**
- Consumes: `FovType` (`"wide" | "medium" | "narrow"`) from `src/codec/commands.ts:251`.
- Produces:
  - `interface Frame { width: number; height: number }`
  - `interface Pose { yaw: number; pitch: number }`
  - `interface Optics { fov: FovType; zoom?: number; mirrored?: boolean }`
  - `HORIZONTAL_FOV_DEG: Record<FovType, number>`
  - `halfAngles(optics: Optics, frame: Frame): { h: number; v: number }` — both in degrees

- [ ] **Step 1: Write the failing test**

Create `test/geometry/aim.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/geometry/aim.test.ts`

Expected: FAIL — the module does not exist, so the import cannot resolve.

- [ ] **Step 3: Write the minimal implementation**

Create `src/geometry/aim.ts`:

```ts
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

/** Published horizontal field of view for each FOV setting, in degrees. */
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/geometry/aim.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Verify it compiles under strict TypeScript**

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/geometry/aim.ts test/geometry/aim.test.ts
git commit -m "feat(geometry): effective half-angles from FOV, zoom and aspect"
```

---

### Task 2: Pixel to angular offset

Converts a pixel coordinate into a yaw/pitch delta using the rectilinear tangent mapping, applying the verified sign conventions and the mirroring flag.

**Files:**
- Modify: `src/geometry/aim.ts` (append)
- Modify: `test/geometry/aim.test.ts` (append)

**Interfaces:**
- Consumes: `halfAngleTangents` (module-private), `Frame`, `Optics` from Task 1.
- Produces:
  - `interface Offset { dYaw: number; dPitch: number }`
  - `pixelToOffset(x: number, y: number, frame: Frame, optics: Optics): Offset` — degrees

- [ ] **Step 1: Write the failing test**

Append to `test/geometry/aim.test.ts`. Note the import line at the top of the file must be extended to include `pixelToOffset` and the `Offset` type is not needed by the tests.

```ts
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
```

Also update the import at the top of the test file to:

```ts
import { halfAngles, pixelToOffset, HORIZONTAL_FOV_DEG } from "../../src/geometry/aim.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/geometry/aim.test.ts`

Expected: FAIL — `pixelToOffset` is not exported from the module.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/geometry/aim.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/geometry/aim.test.ts`

Expected: PASS, 17 tests.

- [ ] **Step 5: Verify it compiles under strict TypeScript**

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/geometry/aim.ts test/geometry/aim.test.ts
git commit -m "feat(geometry): pixel to angular offset via rectilinear tangent mapping"
```

---

### Task 3: Absolute aim, shared gimbal bounds

Composes the offset with the current pose into a clamped absolute target that reports saturation, and moves the gimbal's mechanical limits out of `tools.ts` literals into a single shared definition.

**Files:**
- Modify: `src/geometry/aim.ts` (append)
- Modify: `src/mcp/tools.ts` (import the limits; replace the literals at lines 475-476 and 480-481)
- Modify: `test/geometry/aim.test.ts` (append)

**Interfaces:**
- Consumes: `pixelToOffset`, `Offset`, `Pose`, `Frame`, `Optics` from Tasks 1-2.
- Produces:
  - `GIMBAL_YAW_LIMIT_DEG = 150`
  - `GIMBAL_PITCH_LIMIT_DEG = 90`
  - `interface Aim { target: Pose; offset: Offset; clamped: boolean }`
  - `aimAtPixel(x: number, y: number, frame: Frame, optics: Optics, current: Pose): Aim`

- [ ] **Step 1: Write the failing test**

Append to `test/geometry/aim.test.ts`:

```ts
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
  expect(aim.target.yaw).toBeCloseTo(10 - 25.0, 2);
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
  // Left edge gives +43deg; from yaw 149 that would be 192deg.
  const aim = aimAtPixel(0, 360, HD, WIDE, { yaw: 149, pitch: 0 });
  expect(aim.target.yaw).toBe(150);
  expect(aim.clamped).toBe(true);
});

test("a pitch target beyond the limit is clamped and reported", () => {
  // Bottom edge gives +27.68deg; from pitch 85 that would be 112.68deg.
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
  expect(aim.target.yaw).toBeCloseTo(-43, 9);
  expect(aim.target.pitch).toBeCloseTo(27.68, 2);
  expect(aim.clamped).toBe(false);
});
```

Also update the import at the top of the test file to:

```ts
import {
  halfAngles, pixelToOffset, aimAtPixel,
  HORIZONTAL_FOV_DEG, GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG,
} from "../../src/geometry/aim.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/geometry/aim.test.ts`

Expected: FAIL — `aimAtPixel`, `GIMBAL_YAW_LIMIT_DEG` and `GIMBAL_PITCH_LIMIT_DEG` are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/geometry/aim.ts`:

```ts
/**
 * Mechanical limits of the Tiny 2's gimbal, in degrees. Hardware-verified.
 *
 * These live here rather than in the tool layer so there is exactly one
 * definition: `obsbot_gimbal_move` imports them for its own clamping. Two copies
 * of a bound that must agree is a defect waiting to happen.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/geometry/aim.test.ts`

Expected: PASS, 26 tests.

- [ ] **Step 5: Point `tools.ts` at the shared limits**

In `src/mcp/tools.ts`, add to the imports near the top (alongside the other `../codec/` and local imports):

```ts
import { GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG } from "../geometry/aim.js";
```

Then replace the `obsbot_gimbal_move` handler's clamps at lines 480-481. Change:

```ts
        const yaw = clamp(parsed.yaw, -150, 150);
        const pitch = clamp(parsed.pitch, -90, 90);
```

to:

```ts
        const yaw = clamp(parsed.yaw, -GIMBAL_YAW_LIMIT_DEG, GIMBAL_YAW_LIMIT_DEG);
        const pitch = clamp(parsed.pitch, -GIMBAL_PITCH_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG);
```

The tool description at lines 474-476 states the same bounds as literal text, which is a third copy. Template it from the constants so the documentation the model reads cannot drift from the behavior. Change:

```ts
      description:
        "Move the gimbal to an absolute yaw/pitch angle (degrees); positive yaw pans to the " +
        "camera's left, positive pitch tilts down. Yaw is clamped to [-150,150], pitch to " +
        "[-90,90]. Absolute positioning (1:1 degrees), verified on hardware.",
```

to:

```ts
      description:
        "Move the gimbal to an absolute yaw/pitch angle (degrees); positive yaw pans to the " +
        `camera's left, positive pitch tilts down. Yaw is clamped to ` +
        `[-${GIMBAL_YAW_LIMIT_DEG},${GIMBAL_YAW_LIMIT_DEG}], pitch to ` +
        `[-${GIMBAL_PITCH_LIMIT_DEG},${GIMBAL_PITCH_LIMIT_DEG}]. ` +
        "Absolute positioning (1:1 degrees), verified on hardware.",
```

This produces a byte-identical string. The existing description tests in `test/mcp/tools.test.ts` use `toMatch` against regexes rather than exact equality, so they are unaffected either way — but verify that in the next step rather than assuming it.

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npx vitest run`

Expected: PASS, all suites. Pay particular attention to `test/mcp/tools.test.ts` — any failure there means the description templating or the clamp swap changed observable behavior, which it must not.

- [ ] **Step 7: Confirm no duplicate bound literals remain**

Run: `grep -rn -- "-150, 150\|-90, 90" src/`

Expected: no matches. If anything appears, replace it with the shared constants.

- [ ] **Step 8: Verify it compiles under strict TypeScript**

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/geometry/aim.ts src/mcp/tools.ts test/geometry/aim.test.ts
git commit -m "feat(geometry): absolute aim with reported clamping, shared gimbal bounds"
```

---

## Out of Scope

Named here so an implementer does not helpfully add them:

- **`obsbot_aim_at_pixel`** — the MCP tool that consumes this module. Next increment. This plan ships no new tool and changes no tool behavior.
- **Zoom-to-fit / frame-a-region.** The math is nearly free once this module exists, but it is speculation stacked on unverified trig until aiming works against real hardware.
- **Zoom and FOV readback.** `Optics` takes both as parameters precisely so the module does not depend on them. Do not add `camCtrlGet` calls here — that would break module purity.
- **Resolving the mirroring question.** `mirrored` stays an explicit input. Settling it is a hardware check that belongs with the consuming tool.
- **Stereo depth from two cameras.** Recorded in spec section 9.
