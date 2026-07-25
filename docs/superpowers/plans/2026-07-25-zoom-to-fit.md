# Zoom-to-Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make aiming work at any zoom, and add `obsbot_zoom_to_fit`, which frames a chosen region of a captured frame.

**Architecture:** `Optics` collapses from `{ fov, zoom }` to a single `{ magnification }`, because the camera has one magnification scale and the discrete FOV modes are points on it. The tool layer resolves the camera's reported state to that number. `obsbot_zoom_to_fit` then centres a region with the existing `aimAtPixel` and computes the magnification that makes it fill the frame.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, tsc.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-25-zoom-calibration-design.md` §1, §4, §5.
- Branch `feat/zoom-to-fit`, cut from `master` at or after `fd4db79` (the 0.5.0 release commit). One branch per feature.
- Measured constants, already in `src/geometry/aim.ts` — use them, do not redefine: `WIDE_HFOV_DEG = 67`, `FOV_MAGNIFICATION = { wide: 1, medium: 1.15060, narrow: 1.47073 }`, `VERTICAL_TANGENT_CORRECTION = 0.957`.
- The magnification law is `m = 3·ratio − 2` over UVC ratio `[1.0, 2.0]`, giving `m ∈ [1, 4]`. Measured to better than 0.05%.
- **Zoom is absolute, not multiplicative.** Setting a zoom ratio replaces the FOV mode's magnification; it does not multiply it. `narrow` + ratio 1.5 measured 2.509, the same as `wide` + ratio 1.5, not 1.47 × 2.5.
- The whole suite must stay green (512 tests at `fd4db79`). Run `npm test`, not one file.
- Sign conventions are hardware-verified: +yaw pans camera-LEFT, +pitch tilts DOWN, image x right, y down.

---

### Task 1: Collapse `Optics` to a single magnification

The current `{ fov, zoom }` shape invites the one mistake this subsystem cannot survive: multiplying them. Zoom is absolute, so at `fovMode: custom` the FOV mode is meaningless and `m` is `3r − 2` alone. Making `m` a single field renders the double-counting unrepresentable rather than merely warned against.

The arithmetic does not change. `HORIZONTAL_FOV_DEG[fov]` is already derived as `2·atan(tan(WIDE_HFOV_DEG/2) / FOV_MAGNIFICATION[fov])`, so today's `tan(HFOV[fov]/2) / zoom` is already exactly `tan(WIDE/2) / (FOV_MAGNIFICATION[fov] × zoom)`. This task renames and restructures; it must not move a single measured value.

**Files:**
- Modify: `src/geometry/aim.ts` — `Optics`, `halfAngleTangents`, and add the two conversion functions
- Modify: `test/geometry/aim.test.ts` — every construction of an `Optics` literal
- Modify: `src/mcp/tools.ts:946` — the one production call site
- Modify: `test/mcp/tools.test.ts` — any aim expectation constructing optics

**Interfaces:**
- Consumes: `WIDE_HFOV_DEG`, `FOV_MAGNIFICATION`, `VERTICAL_TANGENT_CORRECTION`, `toRad`, `toDeg` — all already in `aim.ts`.
- Produces:
  - `interface Optics { magnification: number; mirrored?: boolean }`
  - `magnificationFromZoomRatio(ratio: number): number`
  - `zoomRatioFromMagnification(m: number): number`
  - `MIN_MAGNIFICATION = 1`, `MAX_MAGNIFICATION = 4`
  - `halfAngles`, `pixelToOffset`, `aimAtPixel` keep their signatures apart from the `Optics` shape.

- [ ] **Step 1: Write the failing tests for the conversions**

```typescript
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/geometry/aim.test.ts -t "magnification"`
Expected: FAIL — the conversion functions do not exist and `Optics` has no `magnification` field, so the file will not type-check.

- [ ] **Step 3: Replace the `Optics` interface and the tangent computation**

```typescript
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

const halfAngleTangents = (optics: Optics, frame: Frame): { tanH: number; tanV: number } => {
  const tanH = Math.tan(toRad(WIDE_HFOV_DEG / 2)) / optics.magnification;
  // Vertical starts from the horizontal half-angle scaled by the frame aspect —
  // what square-pixel geometry predicts — then takes the measured correction,
  // because hardware says the real vertical field is ~4.3% shorter than that.
  return { tanH, tanV: tanH * (frame.height / frame.width) * VERTICAL_TANGENT_CORRECTION };
};
```

- [ ] **Step 4: Update every `Optics` literal in the geometry tests**

`test/geometry/aim.test.ts` builds optics as `{ fov: "wide" }` and `{ ...WIDE, zoom: 2 }`. Replace with `{ magnification: 1 }` and `{ magnification: 2 }` respectively, and `{ fov: "narrow" }` with `{ magnification: FOV_MAGNIFICATION.narrow }`.

**Every expected angle stays exactly as it is.** `{ fov: "wide" }` and `{ magnification: 1 }` are the same optics; if a number has to move, the restructure changed the maths and you should stop rather than update the expectation.

- [ ] **Step 5: Update the production call site**

`src/mcp/tools.ts:946` currently passes `{ fov: status.fovMode, zoom: 1 }`. For now — Task 2 makes this read the real magnification — pass the mode's magnification so behaviour is unchanged:

```typescript
          { magnification: FOV_MAGNIFICATION[status.fovMode] },
```

`status.fovMode` is still narrowed to a discrete mode at that point by the existing `custom`/`unknown` refusals above it, so the index is safe. Do not remove those refusals in this task.

- [ ] **Step 6: Full suite and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all PASS, tsc silent. Any failure outside the files above means a consumer this plan missed.

- [ ] **Step 7: Commit**

```bash
git add src/geometry/aim.ts src/mcp/tools.ts test/geometry/aim.test.ts test/mcp/tools.test.ts
git commit -m "refactor(geometry): collapse optics to a single magnification

The camera has one magnification scale: the discrete FOV modes are points on it
and a continuous zoom writes to it directly. Setting a zoom ratio REPLACES a
mode's magnification rather than multiplying it, so the old { fov, zoom } shape
invited a double-count it could only warn against. One number makes that
unrepresentable.

No measured value moves. HORIZONTAL_FOV_DEG is already derived from
WIDE_HFOV_DEG and FOV_MAGNIFICATION, so tan(HFOV[fov]/2)/zoom was already
tan(WIDE/2)/(FOV_MAGNIFICATION[fov]*zoom); a test pins the two against each
other.

Adds magnificationFromZoomRatio (m = 3r-2, measured) and its inverse, which
zoom-to-fit needs to convert a required magnification back to a ratio.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Aim at any zoom

**Files:**
- Modify: `src/mcp/tools.ts` — `obsbot_aim_at_pixel`'s handler and description
- Modify: `README.md` — the `obsbot_aim_at_pixel` row and the "Aiming at what you can see" section
- Modify: `test/mcp/tools.test.ts` — the custom-zoom refusal test becomes a success test

**Interfaces:**
- Consumes: `magnificationFromZoomRatio`, `FOV_MAGNIFICATION`, `Optics` from Task 1.
- Produces: a helper the next task reuses —
  `resolveMagnification(status: { fovMode: FovType | "custom" | "unknown"; zoomPercent: number }): number | null`
  returning `null` for `unknown`. Export it from `src/mcp/tools.ts` or a small shared module; Task 3 imports it.

- [ ] **Step 1: Write the failing test**

```typescript
test("aiming works at a custom zoom, using the measured magnification", () => {
  // zoomPercent 50 is ratio 1.5, so m = 2.5. At u = 0.5 on a 1280-wide frame the
  // offset is -atan(0.5 * tan(33.5)/2.5) = -7.5344 deg, against -18.3116 at
  // wide. Aiming at wide's angle from a 2.5x zoom would overshoot by 10.8 deg.
  const transport = makeFakeTransport({ fovMode: "custom", zoomPercent: 50 });
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 960, y: 360, frameWidth: 1280, frameHeight: 720 })) as {
    ok: boolean; offset: { dYaw: number };
  };
  expect(r.ok).toBe(true);
  expect(r.offset.dYaw).toBeCloseTo(-7.5344, 3);
});
```

Follow the existing aim tests in that file for the fake-transport construction — read them first rather than inventing a harness. If the existing fake cannot express `fovMode: "custom"` with a `zoomPercent`, extend it in the same style.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/mcp/tools.test.ts -t "custom zoom"`
Expected: FAIL with `ok: false` and the "not applied here yet" refusal message.

- [ ] **Step 3: Resolve the magnification and delete the refusal**

Add the helper:

```typescript
/**
 * The camera's total magnification relative to wide, from its reported state.
 *
 * A discrete FOV mode and a continuous zoom are two ways of writing to one
 * scale, so this returns one number either way. Returns null for an undecodable
 * mode — that is a state to refuse on, not to guess at.
 */
export function resolveMagnification(
  status: { fovMode: FovType | "custom" | "unknown"; zoomPercent: number },
): number | null {
  if (status.fovMode === "unknown") return null;
  if (status.fovMode === "custom") {
    return magnificationFromZoomRatio(1 + status.zoomPercent / 100);
  }
  return FOV_MAGNIFICATION[status.fovMode];
}
```

Delete the `status.fovMode === "custom"` refusal block entirely — it is not special-cased, it is gone. Keep the `unknown` refusal, driven by `resolveMagnification` returning null. Pass `{ magnification }` to `aimAtPixel`.

- [ ] **Step 4: Update the tool description and README**

Both currently say aiming refuses on a custom zoom. Remove that from the refusal list in the `obsbot_aim_at_pixel` description in `src/mcp/tools.ts` and from `README.md`'s tool row and its "Aiming at what you can see" prose, and state instead that the tool reads the camera's magnification — discrete mode or continuous zoom alike — and needs no zoom argument.

- [ ] **Step 5: Full suite, type check, commit**

```bash
npm test && npx tsc --noEmit
git add src/mcp/tools.ts README.md test/mcp/tools.test.ts
git commit -m "feat(aim): aim at any zoom, not just the discrete FOV modes

obsbot_aim_at_pixel refused whenever a continuous zoom was set, because the
zoom-to-magnification mapping was unmeasured. It has since been measured
(m = 3*ratio-2, better than 0.05%), so the refusal is deleted rather than
special-cased: the tool resolves the camera's reported state to one
magnification, discrete mode or continuous zoom alike.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `obsbot_zoom_to_fit`

**Files:**
- Modify: `src/mcp/tools.ts` — the new tool
- Modify: `README.md` — a row in the Gimbal section and a paragraph in "Aiming at what you can see"
- Modify: `test/mcp/tools.test.ts` — the tool's tests

**Interfaces:**
- Consumes: `resolveMagnification` (Task 2), `aimAtPixel`, `zoomRatioFromMagnification`, `MIN_MAGNIFICATION`, `MAX_MAGNIFICATION` (Task 1).
- Produces: the tool `obsbot_zoom_to_fit`, returning
  `{ ok, target: { yaw, pitch }, ratio, magnification, clamped, settled }`.

- [ ] **Step 1: Write the failing tests**

```typescript
test("fitting a region computes the magnification that makes it fill the frame", () => {
  // A 480x270 region in a 1920x1080 frame is a quarter of each axis, so it needs
  // 4x more magnification; the default 10% margin backs that off to 3.6364,
  // which is ratio 1.8788.
  //
  // Note the aspect terms cancel: the required magnification is
  //   m' = m * min(frameW/width, frameH/height) / (1 + margin)
  // on BOTH axes, because tanV is tanH scaled by the same aspect and correction
  // on each side of the equation. The vertical correction does not enter the fit
  // at all — only the aim. Do not "fix" this by reintroducing it.
});

test("the tighter axis wins, so the whole region fits", () => {
  // 960x270 needs 2x horizontally and 4x vertically. Taking the MAX would crop
  // the region's sides; min() fits all of it. -> m' = 2/1.1 = 1.8182
});

test("a fit demanding more than 4x is clamped and reported", () => {
  // 192x108 wants 10x. The scale stops at 4. clamped:true, ratio 2.0, and the
  // camera still moves and still zooms to the limit — a partial fit beats none.
});

test("a region already filling the frame clamps at the wide end", () => {
  // From m=1 a full-frame region wants 1/1.1 = 0.909, below the 1.0 floor.
  // clamped:true, ratio 1.0.
});

test("the region's centre is what gets aimed at", () => {
  // Region (100,100,200,200) centres on (200,200), so the aim must match
  // aimAtPixel(200, 200, ...) for the same optics and pose.
});

test.each([
  ["negative width", { x: 0, y: 0, width: -10, height: 100 }],
  ["zero height", { x: 0, y: 0, width: 100, height: 0 }],
  ["off the right edge", { x: 1900, y: 0, width: 100, height: 100 }],
  ["off the bottom", { x: 0, y: 1000, width: 100, height: 200 }],
])("rejects a region that is not inside the frame: %s", () => {
  // ok:false, no gimbal move, no zoom write.
});
```

Fill in each body following the existing tool tests' harness. Every numeric expectation above is stated in its comment; compute the rest from `m' = m · min(frameW/width, frameH/height) / (1 + margin)`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/mcp/tools.test.ts -t "fit"`
Expected: FAIL — the tool does not exist.

- [ ] **Step 3: Implement the tool**

Schema: `x`, `y`, `width`, `height`, `frameWidth`, `frameHeight`, `margin` (default `0.1`), `camera` optional. Reject non-finite numbers the way `obsbot_aim_at_pixel` does — reuse its validation rather than writing a second one.

Behaviour, in order:

1. Refuse on the same conditions as `obsbot_aim_at_pixel`: AI tracking active, camera asleep (waking moves the gimbal and invalidates the frame), `fovMode: unknown`. Reuse those checks.
2. Reject a region that is not strictly inside the frame, or has non-positive size.
3. Resolve current magnification with `resolveMagnification`.
4. Aim at the region's centre with `aimAtPixel`. **If it reports `overTheTop`, refuse without moving**, exactly as `obsbot_aim_at_pixel` does — the region's centre is unreachable and zooming into a wrong pose is worse than not moving.
5. `required = m * Math.min(frameWidth / width, frameHeight / height) / (1 + margin)`.
6. Clamp to `[MIN_MAGNIFICATION, MAX_MAGNIFICATION]`; set `clamped` if either the fit or the aim clamped.
7. **Move first, then zoom.** Zoom is centre-preserving but not target-preserving: zooming before the move can push the target out of frame entirely, after which the move is aiming at a pixel that no longer means what it did.
8. Wait for the zoom to arrive (Step 4), then return `{ ok: true, target, ratio, magnification, clamped, settled }`.

- [ ] **Step 4: Wait for the zoom to arrive**

Zoom ramps. Reading the status block immediately after commanding ratio 1.5 returns `zoomPercent` 33 in transit before settling at 50 — a transient that was very nearly fitted as a magnification law during the investigation before a re-read exposed it.

That is fatal for the intended loop, where the caller snapshots straight after framing: a frame captured mid-ramp is at an unknown magnification and every pixel measured in it is wrong.

`zoomPercent` tracks actual travel rather than the commanded value, which is what makes it a usable arrival signal. Poll it until it matches the commanded ratio within a tolerance of 1 percentage point, at roughly 100 ms intervals, up to a 3 second bound. Return `settled: true` when it arrives and **`settled: false` when the bound wins** — do not throw, and do not report success as though it had settled. A camera moving slower than expected is information the caller needs.

Add a test that a fake whose `zoomPercent` never reaches the target returns `settled: false` rather than hanging or throwing.

- [ ] **Step 5: Document it**

Add the tool to `README.md`'s Gimbal table and extend "Aiming at what you can see" with the fit loop: snapshot, pick a bounding box, `obsbot_zoom_to_fit`, snapshot again. Say plainly that the margin defaults to 10% and why `settled: false` can come back.

- [ ] **Step 6: Full suite, type check, commit**

---

### Task 4: Verify on hardware

**Files:** none. Produces evidence.

- [ ] **Step 1: Rebuild and get a non-stale server**

```bash
npm run build
```

The running MCP server is **known stale** — it carries the constants fix but not the rotation composition merged afterwards. Kill the stale owner (identify it by command line: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'obsbot' }` — do not kill unrelated node processes) and have the user reload with `/mcp`.

Confirm the new code is live via a tool whose OUTPUT changed, not its description: `obsbot_aim_at_pixel` at a **custom zoom** must now succeed where it previously refused.

- [ ] **Step 2: Verify aiming at a zoom actually lands**

Set `obsbot_zoom_uvc {ratio: 1.5}` (m = 2.5). Park, capture a YUYV 1920×1080 reference:

```bash
ffmpeg -hide_banner -loglevel error -f dshow -rtbufsize 500M \
  -video_size 1920x1080 -pixel_format yuyv422 -framerate 30 \
  -i video="OBSBOT Tiny 2 StreamCamera" -frames:v 90 -update 1 -y ref.jpg
```

**Use YUYV, not MJPEG.** MJPEG 1080p is a 1.201× crop of YUYV on this camera and would invalidate the measurement.

Pick a rigid feature with `scratchpad/pickfeature.py`, aim at it, re-capture, and measure with **`scratchpad/residual_h.py`** — the homography-based one. `residual.py` uses template matching and fails at large rotations: it reported a 418 px miss where the truth was 38 px, because perspective distortion of an edge patch defeats fixed-orientation correlation.

Predict before measuring. Expected residual is dominated by the 1° pose floor, not by the zoom: under a degree. **If it is near 10°, the magnification is not being applied** — that is the difference between aiming at wide's angle and at 2.5×'s.

- [ ] **Step 3: Verify the fit**

Pick a real object, get its bounding box from a snapshot, call `obsbot_zoom_to_fit`, then snapshot again and confirm the object fills the frame with roughly the margin requested and is not cropped. Check the reported `ratio` matches `zoomPercent` after settling.

Then ask for a fit that needs more than 4× and confirm `clamped: true`, that the camera still moved and zoomed to the limit, and that the reported magnification is 4.

- [ ] **Step 4: Verify the settle contract**

Command a large zoom change through the tool and confirm that by the time it returns, an immediately captured frame is at the final magnification — measure it against a reference with `scratchpad/scalefit.py`. This is the property unit tests cannot cover: a fake transport settles instantly.

- [ ] **Step 5: Restore and clean up**

Return the camera to `fov: wide`, ratio 1.0, a neutral pose. Delete captured frames — they are images of the user's room.

---

## Notes for the implementer

**Why `min` and not `max` in the fit.** `min(frameW/width, frameH/height)` makes the *whole* region fit; `max` would fill the frame and crop the region's other axis. If a caller wants fill-and-crop that is a different tool, not a flag.

**Why the vertical correction does not appear in the fit.** `tanV = tanH · (h/w) · 0.957` on both sides of the fit equation, so the aspect and correction terms cancel and the required magnification depends only on the pixel ratios. This is worth knowing because it looks like an omission: `VERTICAL_TANGENT_CORRECTION` matters for *aiming* at the region's centre and not at all for deciding how far to zoom.

**What this task does not fix.** The pose readout is whole degrees on every platform (spec §4.2), which costs up to a degree of aim error and is unaffected by anything here. Do not try to compensate for it inside `zoom_to_fit`.
