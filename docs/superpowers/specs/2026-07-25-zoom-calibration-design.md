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

### 2.2 The 1080p pixel formats do not share a field of view

**MJPEG 1920x1080 is a 1.201x crop of YUYV 1920x1080.** Measured directly by
fitting one against the other on a fixed scene: scale 0.83265, 621 inliers,
0.46 px residual. Same camera, same resolution, same instant — different window
onto the sensor.

This is not a curiosity, it is a trap that cost this investigation an entire
solve. An intrinsics fit over MJPEG frames returned HFOV 57.8 degrees against an
established 68, which looks exactly like a broken model until the format is
suspected. Dividing by the crop gives 67.1 — the right answer all along, viewed
through the wrong window.

Which path sees which:

| path | format | field |
|---|---|---|
| `obsbot_capture_preview` | MJPEG, pinned | **narrow (cropped)** |
| `obsbot_capture_record` | negotiated | wide |
| `obsbot_capture_snapshot` | native helper, `MEDIASUBTYPE_RGB24`, negotiated upstream | wide |

The snapshot path is confirmed wide by evidence already on record rather than
assumption: `obsbot_aim_at_pixel` was hardware-verified at u = -0.97 and landed
1.21 degrees off. Through the MJPEG crop the computed angle at that pixel would
be 33.2 degrees instead of the true 28.1 — a 5 degree miss. It measured 1.2, so
snapshots are on the wide field and the geometry constants apply to them.

**Consequence: the preview shows ~20% less of the room than snapshots, aiming
and recording do.** A user frames by eye in the preview, then aims at a pixel
from a snapshot that sees more than they were looking at. This arrived with the
1080p60 change: pinning `-vcodec mjpeg` is what makes 60fps reachable, and it
silently changed the field of view along with the frame rate. `buildRecordArgs`
pins nothing, so preview and record disagree too.

Any future measurement through ffmpeg must state its pixel format. A resolution
alone does not identify the field.

## 3. Derive the FOV constants from a single anchor

`HORIZONTAL_FOV_DEG` currently holds three independently measured values at
+/-3 degrees each. The magnification *ratios* between modes are now known ~60x
better than the absolutes, so carrying three independent absolutes throws that
precision away and lets the three drift out of proportion with each other.

Replace them with one anchor plus measured ratios:

    WIDE_HFOV_DEG = 67            // re-measured, see 3.1
    FOV_MAGNIFICATION = { wide: 1, medium: 1.15060, narrow: 1.47073 }
    hfov(mode) = 2 * atan(tan(WIDE_HFOV_DEG/2) / FOV_MAGNIFICATION[mode])

| mode | was | derived |
|---|---|---|
| wide | 68 | **67.00** |
| medium | 60 | **59.82** |
| narrow | 50 | **48.46** |

### 3.1 The anchor and the vertical correction, re-measured

A pure camera rotation induces an exact homography `H = K R K^-1`, so frames
captured at known gimbal angles determine the intrinsics outright. No distance
enters anywhere: the gimbal angle is the ruler. That is what makes this tighter
than the tape-measured letter sheet behind the original +/-3 degrees.

Six rotations (pitch +/-10, +/-20; yaw +/-10) about a static scene, 313-1243
inliers each:

| solved from | fx (HFOV) | fy | implied vertical correction |
|---|---|---|---|
| 4 rotations | 1453 (66.90) | 1512 | 0.961 |
| up-tilt only | 1452 | 1518 | 0.957 |
| down-tilt only | 1452 | 1502 | 0.967 |
| 6 rotations incl. +/-20 | 1455 (66.84) | 1520 | 0.957 |

fx varies by 0.2% across every configuration and fy by 1%.

**`VERTICAL_TANGENT_CORRECTION` becomes 0.957, from 0.898** — a 7% correction.
The old value came from a measurement this project's own history records as
inconclusive.

**The up/down asymmetry is ~1%, not the ~5% previously recorded, and one
constant captures it.** Up-only and down-only solves differ by 1.0% (0.957 vs
0.967). Do not build a two-branch vertical constant.

Neither candidate explanation for an asymmetry survived: the principal point is
effectively centred (cx, cy within a few px of 960, 540 in every solve) and
radial distortion is negligible (k1 ~= -0.02).

Caveat kept in view: rms is 2.4-2.8 px, not sub-pixel, so something is
unmodelled. The likeliest cause is the entrance pupil sitting off the rotation
axes, which translates the lens as the gimbal turns; that is depth-dependent and
no intrinsic matrix can absorb it. Sampling was symmetric, so it should not bias
fx or fy, but it caps the precision claimable here.

### 3.2 Both constants verified head-to-head on hardware

Same feature, same start pose, same approach direction, only the constant
differing. Residual measured by locating the feature after the move and
converting its miss from centre through the solved focal lengths.

| test | target | shipped (0.898 / 68) | measured (0.957 / 67) |
|---|---|---|---|
| vertical | u=-0.14, v=-0.83 | pitch **-0.597** | pitch **+0.072** |
| horizontal | u=+0.91, v=+0.03 | yaw **-0.823** | yaw **-0.274** |

Vertical error falls 8x, horizontal 3x. The shipped vertical constant missed in
the direction a too-small `tanV` predicts (undershoot), and the shipped anchor
overshot, both as expected.

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

### 4.1 Yaw and pitch do not compose by addition

`aimAtPixel` computes `dYaw` and `dPitch` independently and adds each to the
current pose. The gimbal's yaw axis is world-vertical, so yawing while pitched
sweeps a **cone**: the two rotations do not commute, and adding them separately
is exact only for small angles or at zero pitch.

Measured during the constant verification above. A target at v = +0.03 — where
the vertical term is almost nothing — still landed 0.98 degrees off in pitch,
identically under both constant sets, so it is not a constants error:

| | shipped | measured |
|---|---|---|
| yaw residual | -0.823 | -0.274 |
| pitch residual | **-0.980** | **-0.986** |

The error is predictable as `pitch * (1 - cos yaw)`: at pitch 7.6 and yaw 31.1
that is 1.09 degrees against 0.98 measured.

| | yaw 10 | yaw 20 | yaw 30 | yaw 45 |
|---|---|---|---|---|
| pitch 5 | 0.08 | 0.30 | 0.67 | 1.46 |
| pitch 10 | 0.15 | 0.60 | 1.34 | 2.93 |
| pitch 20 | 0.30 | 1.21 | 2.68 | 5.86 |

Negligible near frame centre or near level, and the dominant error term for a
far-off-axis target on a tilted camera. It also explains the original aim
verification's 1.21 degree yaw residual at u = -0.97, which was attributed to
accumulated edge error; the pose was pitched 7 degrees and the yaw offset large,
which this predicts almost exactly.

**Fix: compose the rotation properly** — build the target orientation from the
current orientation and the pixel's ray, then read yaw and pitch off the
composed result, instead of adding two independently computed scalars. This is a
change to `aimAtPixel` and therefore to `obsbot_aim_at_pixel` and
`obsbot_zoom_to_fit` alike.

Whether it lands in this increment or the next is a scoping call, but it must
not be silently inherited: `zoom_to_fit` magnifies the consequence, since after
zooming by `m` a residual of this size is `m` times more visible in frame.

### 4.2 The pose that aim adds its offset to is floored, not rounded

`aimAtPixel` computes `target = current + offset`, where `current` comes from
`camCtrlGet` on the UVC Pan/Tilt controls. That readback **floors** the true
position rather than rounding it, so the fractional degree is lost in one
direction only — aim always under-rotates, never over.

The readback is not lying and the gimbal is not inaccurate. Both were tested:

- Commanded/readback pairs (-17,7)->(-16,6), (-16,6)->(-15,5), (-16.5,6.5)->
  (-16,6), (-16.05,6.05)->(-15,5), (-40,20)->(-39,19) all fit `floor(actual)`
  with the true position sitting slightly below the command.
- The gimbal tracks commands faithfully: a commanded 0.45 degree pitch step
  produced 0.4387 degrees of real rotation (11.6 px measured against 11.90 px
  predicted at fy = 1515), where a full degree would have been 26.4 px.
- Floor rather than round is confirmed independently, not merely pattern-fitted:
  the end-to-end residual below implies a true start pitch of 5.956 where the
  readback reported 5. A rounding readback would have reported 6.

**Measured end-to-end through `obsbot_aim_at_pixel`** at a target of
u = -0.074, v = -0.765, with the corrected constants of section 3: pitch
residual **+0.956** degrees, yaw **+1.176**. The pitch figure is the quantisation
loss almost exactly, leaving ~0.006 degrees attributable to the constants. (This
also re-confirms section 3 through the shipped tool: the old constants would have
computed a 0.638 degree smaller rotation and left a residual near +0.32.)

The cause differs by platform, and so does the fix:

| platform | readback path | sub-degree precision |
|---|---|---|
| Linux, macOS | device reports arcseconds; `linux.ts:96-102` / `macos.ts:97-100` then do `Math.round(value / 3600)` | **available, and discarded by our own code** |
| Windows | `windows.ts:73-74` passes the helper straight through; the helper uses `IAMCameraControl`, whose pan/tilt units are whole degrees | not available through that interface |

So on Linux and macOS this is lossless to fix: stop rounding, carry degrees as a
float. On Windows the root-cause fix is to read `CT_PANTILT_ABSOLUTE` off the
Camera Terminal node through `IKsControl` — the same UVC control Linux reads via
V4L2, in the same arcsecond units. The helper already holds an `IKsControl` and
already walks the topology for the XU node, so this is a new read against
existing infrastructure rather than a new subsystem.

Do NOT paper over this with a +0.5 degree constant. That would be a plausible
estimator for a floored quantity, but it treats the symptom while real precision
sits unread one interface away, and it would leave Linux and macOS still
discarding data they already have.

Note the interaction with section 4.1: both defects push aim off target, they are
independent, and they are of comparable size (about a degree each in the geometry
measured here). Fixing one alone will roughly halve the end-to-end error, not
eliminate it, so neither is verifiable by "the residual got smaller" — each needs
its own predicted magnitude checked.

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

**The default margin covers the residual vertical asymmetry**, which §3.1
measured at ~1% rather than the ~5% previously believed. A 10% margin absorbs it
comfortably. The larger vertical error was never the asymmetry — it was the
constant, and that is now fixed.

## 6. Testing

**Unit** — the law at each measured ratio; `magnificationFromZoomRatio` and its
inverse round-tripping; derived FOV values against the table in §3; fit
magnification taking the `min` of the two axes; margin; clamping reported at both
ends; region-validation rejections.

**Hardware** — aim at a pixel *while zoomed*, which is impossible today, at both
a discrete mode and a custom zoom; a fit against a known object, verifying it
lands inside the frame with margin; a fit demanding more than 4x, verifying
`clamped: true` and that the pose still changed.

**A note on verifying anything through `obsbot_aim_at_pixel` before sections 4.1
and 4.2 are fixed.** Two systematics of about a degree each sit in that path, so
an end-to-end residual is not a clean signal about anything else. Verify by
predicting the residual and checking the measurement against the prediction —
which is what section 3.2 and section 4.2 both did — or bypass the tool and drive
the gimbal directly from commanded angles, which is what section 3.2's A/B did.
"The residual looks small" is not a result.

## 7. Out of scope

- **The vendor/UVC zoom discrepancy.** `obsbot_zoom_vendor` uses a different
  ratio scale. It can now be characterised by exactly this method, which is what
  the calibration makes cheap. Separate increment.
- **A direction-dependent hysteresis correction** (§1.4).
- **The preview's cropped field** (§2.2). A real defect, but in the capture
  subsystem rather than the geometry one, and fixing it means re-opening the
  60fps trade: the MJPEG pin is what buys 60fps, so restoring the full field may
  cost the frame rate that change was made for. It deserves its own decision
  rather than being bundled here.

Now settled, previously listed here: re-measuring `VERTICAL_TANGENT_CORRECTION`
and the up/down asymmetry (§3.1, §3.2).

## 8. Documentation this obligates

`README.md` (the new tool, aim no longer refusing on zoom, the magnification
table, and the preview/snapshot field-of-view difference in §2.2 —
that one is a user-visible trap and belongs with the other two live-testing
traps already documented there), `tiny2_specification.md` (the `0x04` FOV write
tag still presents 86/78/65 unqualified — those are diagonal full-sensor figures
and reading them as 16:9 horizontal is the exact error this project already
corrected once), and `CHANGELOG.md`.

The constants change in §3 also obliges updating the measurement narrative in
`src/geometry/aim.ts`'s comments, which currently document the letter-sheet
method and the ~5% asymmetry as the state of knowledge. Leaving that prose in
place beside corrected values would be worse than not correcting them.
