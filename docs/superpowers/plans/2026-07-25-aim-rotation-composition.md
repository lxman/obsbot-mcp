# Aim Rotation Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `aimAtPixel` compose the target orientation properly instead of adding yaw and pitch as independent scalars, and stop discarding the sub-degree pose precision that Linux and macOS already receive.

**Architecture:** `aimAtPixel` converts the target pixel to a ray in camera coordinates, rotates that ray into world coordinates by the camera's current orientation, and reads the target yaw/pitch off the resulting direction. `pixelToOffset` is unchanged and keeps its current meaning — it is the pure per-axis pixel-to-angle mapping, still correct and still used for reporting. The transports stop rounding arcseconds to whole degrees.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, tsc.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-25-zoom-calibration-design.md` §4.1 and §4.2.
- Branch `fix/aim-rotation-composition`, cut from `master` **after** `fix/geometry-constants` merges — this plan's expected values assume `WIDE_HFOV_DEG = 67` and `VERTICAL_TANGENT_CORRECTION = 0.957`. Cutting from an unmerged master produces failures that look like plan errors.
- Sign conventions are hardware-verified and must not be re-derived: **+yaw pans camera-LEFT, +pitch tilts DOWN**, image x grows rightward, y grows downward.
- The whole suite must stay green. Run `npm test`, not just the geometry file.
- Every numeric expectation below was generated from the reference implementation in `docs/superpowers/specs/2026-07-25-zoom-calibration-design.md` §4.1 and cross-checked against the hardware measurement. Use them verbatim; do not round further.

---

### Task 1: Compose the target orientation instead of adding scalars

**Files:**
- Modify: `src/geometry/aim.ts` — the `aimAtPixel` function and its doc comment
- Modify: `test/geometry/aim.test.ts` — the absolute-aim section
- Modify: `test/mcp/tools.test.ts` — any aim expectation whose pose has non-zero pitch

**Interfaces:**
- Consumes: `halfAngleTangents`, `toRad`, `toDeg`, `GIMBAL_YAW_LIMIT_DEG`, `GIMBAL_PITCH_LIMIT_DEG`, all already in the file.
- Produces: `aimAtPixel(x, y, frame, optics, current): Aim` — signature and return shape unchanged. `Aim.offset` now means *the rotation actually applied* (`target − current`), not the per-axis pixel mapping.

- [ ] **Step 1: Write the failing invariant tests**

These four properties are what make the composition trustworthy; three of them are cases where the new code must agree exactly with the old, which is what stops a sign error from hiding.

```typescript
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
  // pitch=0 is the case where yaw and pitch DO commute. If this drifts, the
  // rotation order or a sign is wrong.
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/geometry/aim.test.ts -t "cone"`
Expected: FAIL — the cone test reports pitch 20 where 18.947456 is required. The three invariant tests above it should already pass, since they are the cases where old and new agree; if any of those three fails, stop and report, because the baseline is not what this plan assumes.

- [ ] **Step 3: Replace `aimAtPixel`**

```typescript
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
 * is read back off that direction. At pitch 0, or at u = 0, this reduces exactly
 * to the old sum — which is what the invariant tests pin.
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
  // atan2 returns (-180, 180]; pick the representative nearest the current yaw
  // so a target past +150 reads as +183 rather than -177. Without this a
  // saturating aim clamps to the WRONG END of the range.
  let rawYaw = toDeg(Math.atan2(-wx, wz));
  rawYaw += 360 * Math.round((current.yaw - rawYaw) / 360);

  const yaw = clampTo(rawYaw, GIMBAL_YAW_LIMIT_DEG);
  const pitch = clampTo(rawPitch, GIMBAL_PITCH_LIMIT_DEG);
  return {
    target: { yaw, pitch },
    offset: { dYaw: rawYaw - current.yaw, dPitch: rawPitch - current.pitch },
    clamped: yaw !== rawYaw || pitch !== rawPitch,
  };
}
```

- [ ] **Step 4: Run the invariant tests**

Run: `npx vitest run test/geometry/aim.test.ts -t "cone"`
Expected: PASS. Other tests in the file will now fail — Step 5 fixes them.

- [ ] **Step 5: Update the absolute-aim expectations that the composition changes**

Four existing tests assert values that were only correct under the additive model. Each needs its value replaced AND a comment saying why it moved, because a bare number change here looks like a test being bent to fit.

`"the target is the current pose plus the offset"` — retitle to `"the target composes the current pose with the pixel's ray"`; from `{ yaw: 10, pitch: 5 }` at x=960 the target is now `(-8.376845, 4.746213)`, not `(10 - 18.3116, 5)`. Use precision 5. Add: `// Pitch moves even though the pixel is on the horizontal centre line: yawing from a tilted pose sweeps a cone.`

`"the returned offset matches pixelToOffset for the same inputs"` — this equality only holds when one axis is zero. Rewrite it to assert the two agree for a purely horizontal target from a level pose, and to assert they DIVERGE for an off-axis one:

```typescript
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
```

`"a pitch target beyond the limit is clamped and reported"` — from `{ yaw: 0, pitch: 85 }` the bottom edge is past vertical, so the composed solution goes over the top: target `(-180, 75.388952)` before clamping, which clamps on YAW to -150 rather than on pitch. Replace with:

```typescript
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
```

`"clamping at the negative end is reported too"` — from `{ yaw: -140, pitch: -80 }` the top-right corner is likewise past vertical: composed `(-244.990984, -56.789344)`, clamping yaw to -150 and leaving pitch unclamped. Replace the two target assertions with `expect(aim.target.yaw).toBe(-150)` and `expect(aim.target.pitch).toBeCloseTo(-56.789344, 5)`, keeping `clamped` true, and add the same over-the-top explanation.

Leave `"a yaw target beyond the limit is clamped and reported"` and `"saturating one axis does not falsely clamp the other"` alone — both use pitch 0 or 3 with a purely horizontal target, where old and new agree. If either fails, the yaw unwrap is wrong.

- [ ] **Step 6: Update any tool test whose aim pose has non-zero pitch**

Run `npx vitest run test/mcp/tools.test.ts` and fix only the aim expectations that move. Tests whose fake transport reports pitch 0 must NOT change; if one does, the composition is wrong at the level case and you should stop rather than update it.

- [ ] **Step 7: Full suite and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all tests PASS, tsc silent.

- [ ] **Step 8: Commit**

```bash
git add src/geometry/aim.ts test/geometry/aim.test.ts test/mcp/tools.test.ts
git commit -m "fix(aim): compose the target orientation instead of adding scalars

The gimbal's yaw axis is world-vertical, so yawing while pitched sweeps a cone
and the two rotations do not commute. Adding dYaw and dPitch as independent
scalars was exact only at zero pitch or zero horizontal offset, and cost 0.98
degrees at pitch 7.6 / yaw 31 on hardware against pitch*(1-cos yaw) = 1.09
predicted.

aimAtPixel now rotates the target ray into world coordinates by the current
orientation and reads the pose off the result. At pitch 0, or u = 0, it reduces
exactly to the old sum, which the invariant tests pin.

Two consequences worth naming. Aim.offset now means the rotation actually
applied rather than the per-axis pixel mapping, so it equals pixelToOffset only
when one axis is zero. And aiming past vertical now yields the over-the-top
solution, which clamps on yaw rather than producing a pitch beyond 90 that
pointed somewhere the target was not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stop discarding the sub-degree pose on Linux and macOS

The device reports pan/tilt in arcseconds. `linux.ts` and `macos.ts` divide by 3600 and `Math.round` the result, throwing away precision the hardware already provided. Windows has a different problem with a different fix (see "Deferred" below); this task does not touch it.

**Files:**
- Modify: `src/transport/linux.ts:96-102`
- Modify: `src/transport/macos.ts:97-100`
- Modify: `test/transport/linux.test.ts` and `test/transport/macos.test.ts` — the camCtrlGet pan/tilt expectations

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `camCtrlGet(property)` returning `{ value: number; flags: number }` where `value` for pan (0) and tilt (1) is now degrees as a **float** rather than a rounded integer. Every consumer already treats it as a number; none re-rounds it.

- [ ] **Step 1: Write the failing test**

In `test/transport/linux.test.ts`, alongside the existing camCtrlGet tests:

```typescript
test("pan/tilt keep their sub-degree precision", () => {
  // The device reports arcseconds. 3600 arcsec = 1 deg, so 21510 arcsec is
  // 5.975 deg. Rounding that to 6 discards real precision the hardware gave us,
  // and aimAtPixel adds its offset to whatever this returns.
  // 21510 / 3600 = 5.975
});
```

Write it against the same fake-helper harness the neighbouring camCtrlGet tests use — read them first and follow their setup exactly rather than inventing a new one. Assert `value` comes back `5.975`, not `6`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/transport/linux.test.ts -t "sub-degree"`
Expected: FAIL, receiving 6 where 5.975 is required.

- [ ] **Step 3: Drop the rounding in both transports**

In `src/transport/linux.ts`, replace the pan/tilt conversion in `camCtrlGet`:

```typescript
      // Degrees as a float. The device reports arcseconds, and rounding to whole
      // degrees here threw away precision it already gave us — aimAtPixel adds
      // its offset to this value, so every discarded fraction became aim error.
      // The RANGE below still rounds: min/max are advertised bounds, not a live
      // pose, and no arithmetic accumulates on them.
      result.value = result.value / ARCSEC_PER_DEG;
```

Apply the identical change in `src/transport/macos.ts`. Leave both `zoomRange`/`camCtrlRange` roundings alone.

- [ ] **Step 4: Run both transport suites**

Run: `npx vitest run test/transport/linux.test.ts test/transport/macos.test.ts`
Expected: the new test PASSes. Any existing test asserting a rounded whole-degree pose must be updated to the exact float — but read each one first: if it asserts a round number because the fake returns an exact multiple of 3600, it needs no change at all.

- [ ] **Step 5: Full suite and type check, then commit**

```bash
npm test && npx tsc --noEmit
git add src/transport/linux.ts src/transport/macos.ts test/transport/linux.test.ts test/transport/macos.test.ts
git commit -m "fix(transport): keep the sub-degree pose Linux and macOS already report

The device reports pan/tilt in arcseconds; both transports divided by 3600 and
rounded to whole degrees, discarding precision the hardware had already given
us. aimAtPixel adds its offset to this value, so every discarded fraction became
aim error directly.

Ranges still round — min/max are advertised bounds rather than a live pose, and
nothing accumulates on them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Verify on hardware, against predicted residuals

Both defects in the spec's §4.1 and §4.2 push aim off target, they are independent, and they are of comparable size. So "the residual got smaller" proves nothing. Each measurement below states what it should read *before* it is taken.

**Files:** none. Produces evidence.

- [ ] **Step 1: Rebuild and prove the new code is live**

```bash
npm run build
```

Kill stale node processes owning the MCP server, then reload it. A stale IPC owner runs old code while advertising the new tool list — confirm via a tool whose OUTPUT changed. Call `obsbot_aim_at_pixel` with `x: 960, y: 360, frameWidth: 1280, frameHeight: 720` at a **tilted** pose: the composed build returns a pitch that differs from the current pose, the old one returns the pitch unchanged.

- [ ] **Step 2: Isolate the composition fix by driving the gimbal directly**

This bypasses the pose readback, so the §4.2 floor cannot contaminate it — the same technique the constants A/B used.

Park at a tilted pose with a large horizontal offset available, capture a YUYV 1920x1080 reference with the ffmpeg invocation in `docs/superpowers/plans/2026-07-25-geometry-constants.md` Task 2 Step 3, and pick a rigid feature at |u| > 0.8 with `scratchpad/pickfeature.py`.

Compute both target poses — the additive one and the composed one — from the *commanded* pose, drive `obsbot_gimbal_move` to each in turn, and measure each residual with `scratchpad/residual.py`.

Expected: the additive target leaves roughly `pitch * (1 - cos dYaw)` of pitch error — about a degree at pitch 20 and a 30 degree yaw offset — and the composed target leaves under 0.3 degrees. If the composed residual is not clearly smaller, stop: the sign of a rotation term is likely wrong, and no amount of re-measuring will fix that.

- [ ] **Step 3: Measure end-to-end through the tool, and predict first**

Aim through `obsbot_aim_at_pixel` from a tilted pose. On Windows the pose is still floored, so predict the residual before measuring: it should be approximately the fractional degree lost by the floor — `actual_pitch - floor(actual_pitch)` — and no longer carry the coupling term. Record both the prediction and the measurement.

On Linux or macOS after Task 2, the floor term is gone and the residual should fall under 0.3 degrees outright.

- [ ] **Step 4: Restore and clean up**

Return the camera to `yaw: 6, pitch: 7`, wide, zoom 1.0. Delete captured frames — they are images of the user's room.

---

## Deferred, with the reason

**The Windows pose floor (spec §4.2) is not planned here, because no Windows interface is known to expose the fraction.** This was checked against primary documentation rather than assumed:

- UVC's `CT_PANTILT_ABSOLUTE` is specified in arc seconds (1/3600 degree, range ±180×3600), which is why Linux and macOS have the precision that Task 2 recovers.
- Windows' `CameraControl_Pan` is documented as *"the camera's pan setting, in degrees. Values range from –180 to +180"*, and `KSPROPERTY_CAMERACONTROL_PAN` as *"a LONG ... expressed in degrees."* A `LONG` in degrees cannot carry a fraction, and the device's readbacks are degree-scale (−15, −39), not arcsecond-scale.

So the obvious root-cause fix — reading `CT_PANTILT_ABSOLUTE` through `IKsControl` — is likely a dead end, because the Windows UVC driver is what performs the arcsecond-to-degree conversion. One caveat keeps it open: Microsoft notes *"some drivers define a custom range of pan values and custom step values that might not be based on typical units."*

**The cheap experiment that settles it, and should come before any native code:** read the advertised range and step for pan/tilt on this device. A range near ±468000 means arcseconds are reaching us after all and the fix is small; ±180 means they are not, and the increment has to choose between the two candidates below.

- Read the finer control directly, **if** the range check says it exists.
- Have the server remember the last commanded pose and prefer it when the device's floored readback is consistent with it, falling back to the readback when anything else moved the gimbal. This uses better information we genuinely have rather than estimating, but it adds state and needs careful invalidation on wake, recenter, and tracking.

Do NOT add a +0.5 degree constant. It is a defensible estimator for a floored quantity, but it treats the symptom, and on Linux and macOS it would paper over precision that Task 2 recovers exactly.

Sources: <https://learn.microsoft.com/windows/win32/api/strmif/ne-strmif-cameracontrolproperty>, <https://learn.microsoft.com/windows-hardware/drivers/stream/ksproperty-cameracontrol-pan>.
