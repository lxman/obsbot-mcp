# Zoom calibration, and framing a region

**Date:** 2026-07-25
**Status:** design, approved for planning

Aiming works, but only at a discrete field-of-view setting: `obsbot_aim_at_pixel`
refuses outright when a continuous zoom is active, because nothing mapped the
zoom control onto actual magnification. This closes that gap by measuring the
mapping, and then spends it on a tool that frames a chosen region.

## 1. What the hardware does

All figures below are measured against a physical Tiny 2 on 2026-07-25 by the
method in §2. Magnification `m` is always **linear magnification relative to the
wide field**, so `m = 2` means a feature sits twice as far from frame centre.

| state | m | measured |
|---|---|---|
| `wide` | 1.00000 | by definition — the reference |
| `medium` | **1.15060** | 683 inliers, 0.44 px residual |
| `narrow` | **1.47073** | 275 inliers, 0.48 px residual |
| UVC zoom ratio `r` | **m = 3r − 2** | see below |

### 1.1 The zoom law is linear

`obsbot_zoom_uvc` takes a ratio in [1.0, 2.0]. Magnification is linear in it:

    m(r) = 3r - 2          r in [1.0, 2.0]  ->  m in [1.0, 4.0]

| commanded r | predicted m | measured m | error |
|---|---|---|---|
| 1.25 | 1.75 | 1.75092 | +0.05% |
| 1.50 | 2.50 | 2.50071 | +0.03% |
| 1.75 | 3.25 | 3.28244 / 3.25448 | see §1.4 |
| 2.00 | 4.00 | 4.00035 | +0.01% |

So ratio 2.0 really is 4x linear magnification — previously carried as an
unsourced note, now measured to four figures.

Since `zoomPercent = (r − 1) × 100` exactly (verified at 0/25/50/100), the same
law in terms of the status block is `m = 1 + 0.03 × zoomPercent`.

### 1.2 Zoom is absolute, not a multiplier

Setting a zoom ratio does **not** multiply the current field of view. It sets
total magnification outright, subsuming the FOV mode:

- `wide` + ratio 1.5 -> m = 2.50071
- `narrow` + ratio 1.5 -> m = 2.50941

Those agree within the hysteresis band of §1.4. Had the crops composed, the
second would have been 1.47073 x 2.5 = 3.68. Cross-check from the narrow side:
`narrow`@1.0 -> `narrow`@1.5 measured 1.70666, which is exactly 2.50941 /
1.47073.

This explains a loose end `obsbot_aim_at_pixel` currently documents without
accounting for: `obsbot_zoom_uvc {ratio:1}` does not reliably clear `custom`,
because ratio 1.0 *is* a legitimate absolute position — the same optical state
as `wide`. The discrete modes and the continuous zoom are not two interacting
controls. They are two ways of writing to one scale, and the presets sit at
equivalent ratios 1.00000, 1.05020 and 1.15691.

### 1.3 Zoom is centre-preserving

A similarity transform maps `p -> s(p − c) + c` for a zoom about centre `c`,
which implies a translation of `c(1 − s)`. For a 1920x1080 frame that predicts
(−2880, −1620) at s = 4. Measured: (−2880.0, −1617.2). Every ratio matched its
prediction within 3 px.

The optical axis therefore does not move with zoom, which is the property that
lets aiming and zooming compose at all.

### 1.4 Hysteresis: real, reproducible, and harmless

At commanded ratio 1.75 the landing point depends on approach direction:

| approach | measured m | effective r |
|---|---|---|
| from below (1.0 -> 1.75) | 3.28024, reconfirmed 3.28244 | 1.7608 |
| from above (2.0 -> 1.75) | 3.25448 | 1.7515 |

Fitting the two frames directly against each other gives scale 1.00820, so they
are genuinely different optical states 0.8% apart, not two noisy estimates of
one. The from-below value reproduced across a 3-second and an 8-second settle,
which rules out an unsettled ramp.

**Consequence: 0.09 degrees of aim error at the frame edge** — an order of
magnitude below the +/-1 degree the gimbal position readback can resolve. It is
recorded because it is real, and then ignored because it cannot matter. Do not
add a direction-dependent correction for it.

Other ratios showed no comparable effect (errors <= 0.05% regardless of
approach), so this is a property of particular commanded values landing near a
control step, not a uniform backlash.

### 1.5 Scaling is isotropic, so the vertical correction is zoom-independent

The similarity fit forces a single scale on both axes. Residuals stayed at
0.44–0.9 px across the whole range; an axis-dependent zoom would have shown up
there. `VERTICAL_TANGENT_CORRECTION` therefore needs no per-zoom re-measurement.

## 2. How it was measured, and why no lab was needed

Magnification is a **ratio** measurement. The earlier FOV work needed absolute
angles, hence a letter sheet of known width at a tape-measured distance;
magnification needs none of that, because a ray at angle theta lands at
normalised offset `u = tan(theta)/tan(HFOV/2)`, so `u` scales linearly with `m`
and the scale factor between two frames of one static scene *is* the
magnification ratio.

Method: park the gimbal, capture a frame per zoom state via ffmpeg/dshow, match
SIFT descriptors between frames, and fit a similarity transform with RANSAC. The
recovered scale is `m`.

Three properties make this the right instrument, and each was earned:

- **It separates magnification from camera drift.** The camera shifts bodily by
  ~0.5 px between captures. Fitting translation as a free parameter turns that
  from an error source into a fitted value.
- **It rejects non-rigid scene content automatically.** Live screen content
  fails the consensus and drops out as outliers. No landmark has to be
  identified by hand.
- **It is precise.** ~0.15 px residual over hundreds of correspondences puts
  scale precision near 1 part in 10^5.

### 2.1 Two traps, both hit

**Optical flow is the wrong tool.** Lucas-Kanade is a local tracker; at 2x
magnification edge features move hundreds of pixels and it lost every one,
returning zero correspondences. That is a method failure, not a hardware result.
SIFT matching is displacement-agnostic and covers the whole range.

**The scene must be static where the zoom is looking.** Features do not need to
be permanently static — only static for the duration of one pair. The first
attempt failed because at 2x the frame was filled entirely by monitors showing
live output, leaving nothing rigid to match: a *null* pair at ratio 2.0 (same
zoom, seconds apart) returned scale 0.98 on 12 inliers where truth is 1.0.

The fix needed nothing physical. A rigidity map over the wide view — grid the
frame, score each cell on keypoint count and inter-frame change — found a static
textured region at u = +0.625, and pointing the gimbal there (dYaw −22.9) lifted
the null-pair fit to scale 1.00007 on 368 inliers. **Calibration does not care
what the camera looks at, only that it holds still**, so scene selection is an
autonomous gimbal move, not a request to the user.

Sharpness drops ~3x at ratio 2.0 (Laplacian variance 141 -> 44), consistent with
digital zoom upscaling rather than a native sensor crop. Partly confounded by
differing content, so it is noted, not claimed.

## 3. Derive the FOV constants from a single anchor

`HORIZONTAL_FOV_DEG` currently holds three independently measured values at
+/-3 degrees each. The magnification *ratios* between modes are now known ~60x
better than the absolutes, so carrying three independent absolutes throws that
precision away and lets the three drift out of proportion with each other.

Replace them with one anchor plus measured ratios:

    WIDE_HFOV_DEG = 68            // absolute anchor, +/-3, unchanged
    FOV_MAGNIFICATION = { wide: 1, medium: 1.15060, narrow: 1.47073 }
    hfov(mode) = 2 * atan(tan(WIDE_HFOV_DEG/2) / FOV_MAGNIFICATION[mode])

| mode | was | derived |
|---|---|---|
| wide | 68 | 68.00 |
| medium | 60 | **60.76** |
| narrow | 50 | **49.27** |

Both new values fall inside the old stated uncertainty, so nothing shipped was
wrong. This removes two error sources and makes the relative structure exact.

The anchor's +/-3 degrees still propagates — at 65/68/71 the derived medium is
57.95/60.76/63.59 — but it now moves all three together, which is the honest
representation of what is known.

## 4. Aiming composes with zoom

Today `obsbot_aim_at_pixel` refuses on `fovMode: custom`, and for discrete modes
passes `zoom: 1` because `HORIZONTAL_FOV_DEG` already carries each mode's crop.
That is two paths with a standing double-counting hazard the code has to warn
about.

Collapse to one. Resolve the camera's state to a single `m`:

- discrete mode -> `FOV_MAGNIFICATION[mode]`
- `custom` -> `magnificationFromZoomRatio(1 + zoomPercent/100)`

then compute from the wide half-angle divided by `m`. One path, no
double-counting, and the custom-zoom refusal is deleted rather than special-cased.

`fovMode: unknown` still refuses — an undecodable state is not a state to aim on.

## 5. `obsbot_zoom_to_fit`

Frames a region of a captured frame.

**Parameters:** `x`, `y`, `width`, `height` (region in frame pixels),
`frameWidth`, `frameHeight`, optional `margin` (default 0.1), optional `camera`.

**Behaviour:**

1. Read status and pose; resolve current `m` as in §4.
2. Centre the region: `aimAtPixel` on the region's centre.
3. Required magnification:
   `m' = m * min(frameWidth/width, frameHeight/height) / (1 + margin)`
   The `min` fits the whole region; the larger factor would crop it.
4. Clamp `m'` to [1, 4]. **Report** clamping, never silently.
5. Convert with `zoomRatioFromMagnification`, issue the gimbal move **then** the
   zoom.
6. Return target pose, chosen ratio, resulting `m`, and `clamped`.

**Move before zoom.** Zoom is centre-preserving but not target-preserving:
zooming first can throw the target out of frame entirely, after which the move
is aiming at a pixel that no longer means what it did.

**Refusals** match `obsbot_aim_at_pixel`: AI tracking active, camera asleep,
non-`device` source, `fovMode: unknown`. A region outside the frame, or of
non-positive size, is rejected.

### 5.1 Wait for the zoom to arrive

Zoom ramps. Commanding ratio 1.5 and reading the status block immediately
returns `zoomPercent` 33 in transit before settling at 50 — a transient that,
during this investigation, was very nearly fitted as an elegant magnification
law before a re-read exposed it.

That is fatal for the intended loop, where the caller snapshots straight after
framing: a frame captured mid-ramp is at an unknown magnification, and every
pixel measured in it is wrong. So the tool must not return the moment it writes
the control.

`zoomPercent` tracks actual travel, not the commanded value — which is exactly
what makes it a usable arrival signal. Poll it until it matches the commanded
ratio, with a bounded timeout, and report `settled: false` if the timeout wins
rather than pretending otherwise. The camera moving slower than expected is
information the caller needs, not an error to swallow.

**The default margin absorbs the vertical asymmetry.** Fitting a box leans on
`tanV` at both edges, where the ~5% up/down asymmetry lives (down 0.344, up
0.362). A 10% margin covers it. Do not add a two-branch vertical constant on the
strength of the existing measurement.

## 6. Testing

**Unit** — the law at each measured ratio; `magnificationFromZoomRatio` and its
inverse round-tripping; derived FOV values against the table in §3; fit
magnification taking the `min` of the two axes; margin; clamping reported at both
ends; region-validation rejections.

**Hardware** — aim at a pixel *while zoomed*, which is impossible today, at both
a discrete mode and a custom zoom; a fit against a known object, verifying it
lands inside the frame with margin; a fit demanding more than 4x, verifying
`clamped: true` and that the pose still changed.

## 7. Out of scope

- **Re-measuring `VERTICAL_TANGENT_CORRECTION`.** The method built here could
  measure the up/down asymmetry properly for the first time, against known
  tilts. Worth doing; not this increment.
- **The vendor/UVC zoom discrepancy.** `obsbot_zoom_vendor` uses a different
  ratio scale. It can now be characterised by exactly this method, which is what
  the calibration makes cheap. Separate increment.
- **A direction-dependent hysteresis correction** (§1.4).

## 8. Documentation this obligates

`README.md` (the new tool, aim no longer refusing on zoom, the magnification
table), `tiny2_specification.md` (the `0x04` FOV write tag still presents 86/78/65
unqualified — those are diagonal full-sensor figures and reading them as 16:9
horizontal is the exact error this project already corrected once), and
`CHANGELOG.md`.
