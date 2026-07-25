# Geometry Constants Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three independently-measured horizontal FOV constants with one measured anchor plus measured per-mode magnifications, and correct `VERTICAL_TANGENT_CORRECTION` from 0.898 to 0.957.

**Architecture:** `src/geometry/aim.ts` gains `WIDE_HFOV_DEG` and `FOV_MAGNIFICATION`; `HORIZONTAL_FOV_DEG` becomes derived rather than literal, so the three modes can no longer drift out of proportion with each other. Nothing else changes shape — `halfAngles`, `pixelToOffset` and `aimAtPixel` keep their signatures and read the derived table exactly as before.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, tsc.

## Global Constraints

- Source of truth for every number here: `docs/superpowers/specs/2026-07-25-zoom-calibration-design.md` §3, §3.1, §3.2.
- `WIDE_HFOV_DEG = 67` — measured, §3.1.
- `FOV_MAGNIFICATION = { wide: 1, medium: 1.15060, narrow: 1.47073 }` — measured, §1.
- `VERTICAL_TANGENT_CORRECTION = 0.957` — measured, §3.1.
- Work on branch `fix/geometry-constants`, cut from `master`. One branch per fix.
- The whole suite must stay green: 500 tests currently pass. Run `npm test`, not just the geometry file.
- Do not "simplify" the derivation into precomputed literals. The point of the change is that the three values share one anchor.

---

### Task 1: Derive the FOV table from one anchor and correct the vertical factor

Both constants move together in a single task deliberately. `tanV` is computed from `tanH`, so changing the anchor alone would force every vertical expectation to an intermediate value that was never measured and is immediately overwritten. There is no meaningful green state between the two edits.

**Files:**
- Modify: `src/geometry/aim.ts:32-134` (the two constant blocks and their doc comments), plus moving `toRad`/`toDeg` above them
- Modify: `test/geometry/aim.test.ts` (constants and every FOV-dependent expectation)
- Modify: `test/mcp/tools.test.ts:1881-1946` (the two aim offset expectations)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WIDE_HFOV_DEG: number`, `FOV_MAGNIFICATION: Record<FovType, number>`, and an unchanged-in-shape `HORIZONTAL_FOV_DEG: Record<FovType, number>` whose values are now derived. `VERTICAL_TANGENT_CORRECTION: number` keeps its name and meaning.

- [ ] **Step 1: Cut the branch**

```bash
cd /c/Users/jorda/Obsbot
git checkout master
git checkout -b fix/geometry-constants
```

- [ ] **Step 2: Write the failing tests for the new constants**

Replace the two constant tests at `test/geometry/aim.test.ts:15-17` and `:33-37` with these. The horizontal table is now derived, so it is checked with `toBeCloseTo` rather than `toEqual`.

```typescript
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

test("the vertical correction is the measured value, not a no-op", () => {
  // Solved from six known gimbal rotations (spec 3.1) and confirmed head-to-head
  // on hardware (spec 3.2): the vertical residual falls from -0.597 to +0.072
  // degrees when this changes from 0.898 to 0.957. If this ever reads 1, someone
  // has quietly reverted to square-pixel geometry, which measurement disproved.
  expect(VERTICAL_TANGENT_CORRECTION).toBeCloseTo(0.957, 3);
});
```

Add the two new names to the import at `test/geometry/aim.test.ts:2-5`:

```typescript
import {
  halfAngles, pixelToOffset, aimAtPixel,
  HORIZONTAL_FOV_DEG, VERTICAL_TANGENT_CORRECTION, GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG,
  WIDE_HFOV_DEG, FOV_MAGNIFICATION,
} from "../../src/geometry/aim.js";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/geometry/aim.test.ts`
Expected: FAIL. `WIDE_HFOV_DEG` and `FOV_MAGNIFICATION` are not exported, so the import fails to type-check and the constant assertions cannot run.

- [ ] **Step 4: Move the angle helpers above the constants**

`toRad`/`toDeg` currently sit at `src/geometry/aim.ts:136-137`, below the constants. The derivation needs them earlier. Cut those two lines and paste them immediately after the `Optics` interface (after line 30), unchanged:

```typescript
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;
```

- [ ] **Step 5: Replace the horizontal constant block**

Replace `src/geometry/aim.ts:32-98` — the whole `HORIZONTAL_FOV_DEG` doc comment and declaration — with the following. The measurement narrative is rewritten because leaving the letter-sheet prose beside corrected values would be worse than not correcting them (spec §8).

```typescript
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
```

- [ ] **Step 6: Replace the vertical correction block**

Replace the `VERTICAL_TANGENT_CORRECTION` doc comment and declaration (originally `src/geometry/aim.ts:100-134`) with:

```typescript
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
```

- [ ] **Step 7: Run the constant tests to verify they pass**

Run: `npx vitest run test/geometry/aim.test.ts -t "derived"`
Expected: the two derivation tests PASS. Other tests in the file still FAIL — they pin the old angles, which Step 8 fixes.

- [ ] **Step 8: Update every FOV-dependent expectation in the geometry tests**

In `test/geometry/aim.test.ts`, apply these value replacements. Every number is `tan`-derived from the new anchor; none is a re-measurement.

| line | was | becomes |
|---|---|---|
| 20-22 | `34`, `30`, `25` | `33.5`, `29.9098`, `24.2296` (use precision `3` for the latter two) |
| 26-30 | `20.78`, `18.81` | geometric `20.4208`, corrected `19.6110` |
| 41 | `0.505` | `0.538312` |
| 58 | `18.64` | `18.3116` |
| 87 | `-34` | `-33.5` |
| 91 | `34` | `33.5` |
| 95-97 | `-18.64` | `-18.3116` |
| 102 | `18.81` | `19.6110` |
| 106 | `-18.81` | `-19.6110` |
| 156 | `10 - 18.64` | `10 - 18.3116` |
| 176 | comment `+34deg` | `+33.5deg` |
| 183 | comment `+18.81deg` | `+19.61deg` |
| 205 | `-34` | `-33.5` |
| 206 | `18.81` | `19.6110` |

The three tests that assert a *shape* rather than a value — aspect scaling (46-51), tangent-not-angle zoom (53-60, the `not.toBeCloseTo(17.0)` arm), and antisymmetry (116-121) — need no change beyond the table above. Do not weaken them.

Update the header comment at lines 10-13, which still cites the discarded method:

```typescript
// The FOV angles are DERIVED from one measured anchor (WIDE_HFOV_DEG) and the
// measured per-mode magnifications, not taken from OBSBOT's spec sheet — the
// sheet's 86/78/65 are diagonal, full-sensor figures and do not describe the
// horizontal extent of a 16:9 capture stream. See the aim.ts doc comments for
// the intrinsics solve behind both constants and the hardware A/B that confirmed
// them.
```

- [ ] **Step 9: Update the two aim expectations in the tool tests**

In `test/mcp/tools.test.ts`, at lines 1925-1930 and 1943-1946:

```typescript
  // x=960 is u=0.5 on a 1280-wide frame; on wide (67deg) that is -18.31deg.
```
```typescript
  expect(r.offset.dYaw).toBeCloseTo(-18.3116, 2);
  expect(r.target.yaw).toBeCloseTo(-18.3116, 2);
```
```typescript
  // narrow is 48.46deg, so u=0.5 gives -12.68deg, NOT wide's -18.31deg. This is
  // the whole point of reading fovMode instead of assuming it.
  expect(r.offset.dYaw).toBeCloseTo(-12.6805, 2);
  expect(r.offset.dYaw).not.toBeCloseTo(-18.3116, 1);
```

- [ ] **Step 10: Run the full suite and the type check**

Run: `npm test && npx tsc --noEmit`
Expected: all 500+ tests PASS, tsc silent. If anything outside these two files fails, stop — it means another consumer depends on the old values and the plan missed it.

- [ ] **Step 11: Commit**

```bash
git add src/geometry/aim.ts test/geometry/aim.test.ts test/mcp/tools.test.ts
git commit -m "fix(geometry): correct the FOV anchor and vertical tangent factor

Derives the three horizontal FOV values from one measured anchor plus the
measured per-mode magnifications, instead of carrying three independent
absolutes at +/-3 degrees each. The ratios between modes are known ~60x better
than the absolutes, so three free values let the modes drift out of proportion
for no reason.

Both constants re-measured by solving the intrinsics from pure gimbal rotations,
where the gimbal angle is the ruler and no distance is measured anywhere:
WIDE_HFOV_DEG 68 -> 67, VERTICAL_TANGENT_CORRECTION 0.898 -> 0.957. The vertical
figure was 7% low, from a measurement this project recorded as inconclusive.

Verified head-to-head on hardware, same feature and start pose with only the
constant differing: vertical residual -0.597 -> +0.072 deg, horizontal -0.823 ->
-0.274 deg.

The up/down asymmetry is ~1%, not the ~5% once believed, so one constant still
suffices; both candidate explanations for a real asymmetry were tested and
eliminated.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Confirm the corrected constants through the shipped tool on hardware

Task 1 proves the arithmetic. This proves the camera agrees, through `obsbot_aim_at_pixel` rather than through the geometry module in isolation — the A/B in the spec drove the gimbal directly and bypassed the tool.

**Files:**
- No source changes. Produces evidence, recorded in the commit body of Task 1's branch via an empty follow-up commit if any adjustment is needed, otherwise reported to the user.

**Interfaces:**
- Consumes: `HORIZONTAL_FOV_DEG` and `VERTICAL_TANGENT_CORRECTION` as changed in Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Rebuild and restart the MCP server, then prove the new code is live**

```bash
npm run build
```

Kill every stale node process before reloading. A stale IPC owner silently keeps executing old code while the new process advertises the new tool list, so a reload alone proves nothing — this is a documented trap in `README.md`.

Confirm via a tool whose OUTPUT changed, not its description: call `obsbot_aim_at_pixel` with `x: 960, y: 360, frameWidth: 1280, frameHeight: 720`. A live build returns `offset.dYaw` near **-18.31**; a stale one returns **-18.64**.

- [ ] **Step 2: Park the camera and confirm the pose readback is not lying**

Move to an integer pose, then read it back:

```
obsbot_gimbal_move { yaw: -17, pitch: 7 }
obsbot_gimbal_position
```

Expected: readback equals the commanded pose. If it comes back off by a degree (it reported (-16, 6) for a commanded (-16.9, 7) during the investigation), pick a different integer pose until command and readback agree. `aimAtPixel` computes `target = current + offset`, so a lying readback injects its own error into the residual and would be misattributed to the constants.

- [ ] **Step 3: Capture a reference frame and choose a high-|v| target**

Use the YUYV path — MJPEG is the cropped field and would invalidate the measurement:

```bash
ffmpeg -hide_banner -loglevel error -f dshow -rtbufsize 500M \
  -video_size 1920x1080 -pixel_format yuyv422 -framerate 30 \
  -i video="OBSBOT Tiny 2 StreamCamera" -frames:v 90 -update 1 -y ref.jpg
```

Pick a rigid, high-contrast feature at |v| > 0.7 and |u| < 0.2, so the vertical term dominates and the horizontal one cannot mask it. `scratchpad/pickfeature.py` does this and prints the chosen pixel.

- [ ] **Step 4: Aim through the tool and re-capture**

Call `obsbot_aim_at_pixel` with the chosen pixel and `frameWidth: 1920, frameHeight: 1080`. Capture a second frame with the identical ffmpeg command.

- [ ] **Step 5: Measure the residual**

Run `scratchpad/residual.py ref.jpg <x> <y> after.jpg "VERIFY"`, which locates the feature by normalised cross-correlation and converts its miss from centre into degrees through the solved focal lengths (fx 1449, fy 1515).

Expected: **|pitch residual| < 0.25 degrees**. The pre-change value at this geometry was -0.597; anything still near that means the build is stale, not that the constants are wrong — re-check Step 1.

Do not expect zero. The gimbal's pose readback quantises to whole degrees, which alone can contribute a few tenths.

- [ ] **Step 6: Restore the camera and clean up**

Return the camera to `yaw: 6, pitch: 7`, `fov: wide`, zoom ratio 1.0, and delete the captured frames — they are images of the user's room and serve no further purpose once the residual is recorded.

---

## Notes for the implementer

**CHANGELOG.** This increment changes two shipped constants, which is exactly the kind of change a release note exists for. No CHANGELOG task is included because the user has explicitly parked documentation work for now; raise it rather than silently skipping it when this lands.

**What this plan deliberately does NOT do.** `aimAtPixel` adds `dYaw` and `dPitch` as independent scalars, but the gimbal's yaw axis is world-vertical, so yawing while pitched sweeps a cone and the two rotations do not commute. That costs about a degree at pitch 7.6 / yaw 31 and is a separate, already-specified increment (spec §4.1). It will show up in Task 2's *yaw* residual if the target has any horizontal offset, which is exactly why Step 3 specifies |u| < 0.2. Do not attempt to fix it here, and do not tune the constants to absorb it.
