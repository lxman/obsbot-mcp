# Aim geometry module — design

**Status:** approved 2026-07-24. Implemented on `feat/aim-geometry`. FOV constants corrected against
hardware 2026-07-25 — see §8.
**Scope:** the pure geometry module only. No new tool, no transport changes, no demo.

## 1. Problem

`obsbot_capture_snapshot` returns a real `type: "image"` content block (`src/mcp/tools.ts:1188`),
so the model driving the server can *see* through the camera. `obsbot_gimbal_move` takes absolute
yaw/pitch in degrees and `obsbot_gimbal_position` reads the live pose back. Those three together
close a loop that nothing else in the OBSBOT ecosystem closes: look, decide, move, look again.

What is missing is the conversion in the middle. A model can reliably report *where in the frame*
something sits — "the mug is at (820, 300) in a 1280×720 image" — but has no principled way to turn
that into a gimbal angle. Today it can only guess and iterate.

This module supplies that conversion. It is deliberately the whole deliverable: it is the first
substantial piece of this project that is fully testable without hardware attached.

## 2. Why the naive version is not good enough

The tempting conversion is linear: the target is 40% of the way to the frame edge, the field of view
is 68°, so the offset is 0.4 × 34°. A rectilinear lens does not map that way. The correct relation
is

```
tan(θ) = u · tan(hfov / 2)
```

where `u` is the normalized offset from center, `u ∈ [−1, 1]`.

The linear form is exact at `u = 0` and exact again at `u = ±1`, and wrong everywhere between —
always *under*-estimating. At the **measured** field of view (§8), the error peaks at **≈1.65°** at
`u ≈ 0.55` on wide, **≈1.12°** on medium, and **≈0.64°** on narrow. At two meters that is 5.8 cm of
miss on wide.

Worth stating plainly, because it cuts against this section's own argument: the original spec quoted
**3.5°** here, computed from an assumed 86° field of view that hardware measurement later disproved.
At the true 68° the case for the tangent mapping is weaker than it first appeared — 5.8 cm rather
than 12 cm. It is still the right choice: the error is systematic rather than random, it grows toward
the frame edge where a miss is most visible, and correcting it costs one `atan`. But it no longer
dwarfs other error sources the way the inflated figure suggested, and nobody should re-derive the
3.5° number from this document.

## 3. Conventions

These are fixed by the existing tool surface, **hardware-verified**, and must not be re-derived.
The 1:1 degree mapping and the bounds are confirmed on real hardware (`obsbot_gimbal_move`'s own
description records it), and the pitch sign was established by observing physical motion rather
than by readback — which matters on this camera, since `obsbot_gimbal_position` and the preset save
path share a conversion and therefore cannot falsify each other.

- **Yaw:** positive pans to the camera's **left**. Clamped to `[−150, 150]` (`tools.ts:480`).
- **Pitch:** positive tilts **down**. Clamped to `[−90, 90]` (`tools.ts:481`).
- **Image coordinates:** `x` increases rightward, `y` increases downward, origin top-left.

Combining these: a target on the **right** of the frame (`u > 0`) requires the camera to turn right,
which is a **decrease** in yaw. A target **below** center (`v > 0`) requires tilting down, which is
an **increase** in pitch. The yaw term therefore carries a negation and the pitch term does not.
This asymmetry is the single most likely source of a sign bug and is called out in the tests.

Note what is and is not settled by the hardware verification above. The gimbal's conventions are
verified; the negation on the yaw term is not a restatement of them but a *composition* of the
verified convention with the image coordinate convention. That composition inverts if the capture
path mirrors the preview. Mirroring is therefore an explicit `mirrored` input (§6) rather than a
baked-in assumption. **That check has since been run: the capture path is not mirrored** (§8), so the
composition above holds as derived and `mirrored: false` is the correct default.

## 4. The math

Normalized coordinates, with the optical axis at frame center:

```
u = 2x / width  − 1
v = 2y / height − 1
```

Effective half-angles. Base horizontal FOV comes from the `fov` enum — **measured** as wide 68°,
medium 60°, narrow 50° (§8; these are *not* the 86/78/65 in `tools.ts:753`, which do not describe
the capture stream). Zoom is a crop, so it divides the tangent:

```
tan(H) = tan(hfov / 2) / zoom
tan(V) = tan(H) · (height / width)
```

The vertical half-angle is derived from the horizontal one and the frame aspect ratio, on the
assumption that the projection is the same in both axes. That holds for a rectilinear lens and is
weakest at the wide end; §8 records it as a hardware question rather than a settled fact.

Angular offsets:

```
dYaw   = −atan( u · tan(H) )
dPitch = +atan( v · tan(V) )
```

Target pose, clamped to the gimbal's limits:

```
yaw   = clamp(current.yaw   + dYaw,   −150, 150)
pitch = clamp(current.pitch + dPitch, −90,  90)
```

**Clamping is reported, not silent.** If either axis saturates, the target is not reachable and the
caller must know that it landed short rather than assume the aim succeeded. Silent clamping here
would present as "the camera aimed and missed," which is exactly the failure the module exists to
prevent.

## 5. What the math assumes about the current pose

`aimAtPixel` computes `target = current + offset`. That is sound only if `current` is where the
camera actually was **at the moment the snapshot was taken**. Three things break that, and they
break it silently — the arithmetic stays correct while the result points at nothing.

- **AI tracking.** Tracking drives the gimbal on its own, so any pose the server last commanded
  goes stale the instant tracking moves the camera — and tracking would fight the aim afterward
  regardless. Aiming and tracking are mutually exclusive by construction.
- **An unsettled gimbal.** A snapshot taken mid-slew shows a pose the gimbal is passing *through*,
  not the one it was commanded to. The image and the assumed pose disagree, so the offset gets
  measured against the wrong reference.
- **Another controller.** OBSBOT Center, or the camera's own self-centering after wake, moves the
  gimbal without the server knowing.

**This is where the platform difference bites.** `CT_PANTILT_ABSOLUTE` genuinely tracks live
position on this camera — a raw USB read shows a slew progressing in real time — but on Linux
`uvcvideo` caches the control and serves the cache, because the firmware never sends the UVC
Control Change interrupt that would invalidate it. So `obsbot_gimbal_position` returns the last
*commanded* value there, and a violation is **undetectable**: the readback will confidently report
a pose the camera is not in. On Windows and macOS the reading is live, so the same violations are
self-correcting on the next look.

The module takes `current` as a parameter and cannot police any of this. That is the right split —
this section records an obligation on the *caller*, not a behavior of the module. The consuming
tool will have to hold the invariant: tracking off, gimbal settled, snapshot and pose read close
together.

Also an obligation on the caller: **degenerate input is unguarded.** `width: 0` or `zoom: 0` yields
`Infinity`/`NaN` inside the module, and because `NaN !== NaN` the clamp path then reports
`{ target: { yaw: NaN }, clamped: true }` — a garbage pose presented as merely saturated rather than
as an error. Leaving the pure module unguarded is correct — validation belongs at the boundary, not
scattered through arithmetic — but the obligation has to land somewhere. The consuming tool must
enforce `zoom >= 1`, `width`/`height >= 1`, and finite `x`/`y` at its zod boundary, or it inherits
this failure mode.

Related, and worth stating because it looks like a gap and is not one: **`obsbot_gimbal_move_speed`
does not exist on Linux.** It is filtered out of the tool list entirely rather than refused at
runtime (`tools.ts:1290`), because a speed×duration burst has no target to clamp without live
feedback. The aim path is unaffected — it issues an absolute `obsbot_gimbal_move`, whose target is
known and clamped before it is sent, and which is available on every platform.

## 6. API surface

`src/geometry/aim.ts`. Pure functions, no I/O, no imports from `transport/` or `device/`. Degrees
throughout the public API to match the rest of the codebase; radians internal only.

```ts
export interface Frame  { width: number; height: number }
export interface Pose   { yaw: number; pitch: number }
export interface Optics {
  fov: FovType;        // reuses FOV_TYPES from codec/
  zoom?: number;       // ≥ 1, default 1
  mirrored?: boolean;  // default false; flips the u term only
}
export interface Offset { dYaw: number; dPitch: number }
export interface Aim    { target: Pose; offset: Offset; clamped: boolean }

halfAngles(optics: Optics, frame: Frame): { h: number; v: number }
pixelToOffset(x: number, y: number, frame: Frame, optics: Optics): Offset
aimAtPixel(x: number, y: number, frame: Frame, optics: Optics, current: Pose): Aim
```

`mirrored` exists because the capture path may horizontally flip the preview, which would invert
the yaw correction and send the gimbal away from the target. Making it an explicit input means the
module is correct either way and the ambiguity is resolved once, at the call site, by a hardware
check.

The yaw and pitch limits must be **shared with** `tools.ts`, not duplicated as fresh literals. Two
copies of a bound that must agree is a defect waiting to happen. The codebase already has the
pattern: `obsbot_gimbal_move_speed` clamps against a named `GIMBAL_MAX_SPEED_DPS` (`tools.ts:511`)
while `obsbot_gimbal_move` uses bare literals. Promoting the position bounds to named constants
alongside it is consistent with what is already there, not a new convention.

## 7. Testing

All offline. No camera required.

**Golden values** — hand-computed, wide (68°, measured — §8), 1280×720:

| input | expected |
|---|---|
| center `u = 0` | `dYaw = 0` |
| right edge `u = 1` | `dYaw = −34°` (edge maps to exactly half the FOV) |
| `u = 0.5` | `dYaw = −18.64°` (linear would say −17°) |
| vertical half-angle | `V ≈ 20.78°`, so `vfov ≈ 41.6°` at 16:9 |

**Properties:**

- Center pixel yields zero offset at every FOV, zoom, and aspect ratio.
- Frame edge yields exactly the half-angle — this pins the tangent form against the linear one.
- Monotonic: increasing `x` strictly decreases `dYaw`; increasing `y` strictly increases `dPitch`.
- Symmetric: mirroring a pixel about the center negates its offset.
- Doubling zoom halves `tan(H)`.
- `mirrored: true` negates `dYaw` and leaves `dPitch` untouched.
- Saturation sets `clamped` and never returns an out-of-range pose.

## 8. Hardware questions — measured 2026-07-25

Run against a physical Tiny 2 on Windows. Three of the four original questions are settled; the
answers changed a module constant, so this section is now a record of measurements rather than a
list of unknowns.

### Settled

**Mirroring — the capture path is NOT mirrored.** Panning to negative yaw swept the entire scene
*left* across the frame, which is what an unmirrored path does. `mirrored: false` is the correct
default and §3's sign composition holds as derived.

**Field of view — the spec sheet's numbers do not describe the capture stream.** Measured with a
letter sheet of known width at a tape-measured distance, centered on-axis:

| setting | spec sheet | measured HFOV | measured `tan(H)` | measured / spec |
|---|---|---|---|---|
| wide | 86° | **67.9°** | 0.673 | 0.722 |
| medium | 78° | **60.2°** | 0.582 | 0.719 |
| narrow | 65° | **50.0°** | 0.466 | 0.731 |

The ratio is constant at **0.724 ± 0.006**, so the spec numbers carry the correct *relative*
structure with a uniformly wrong absolute scale — one scale error, not three bad values. The
measured medium/wide tangent ratio of 0.865 matches the spec's 0.868 to 0.3%.

Neither candidate explanation fits: a 16:9 diagonal reading predicts 0.872, 4:3 predicts 0.80. The
likeliest cause is that the stream is a further crop of the sensor, which the Tiny 2's digital AI
framing would account for. The cause does not matter for this module — what it needs is the
horizontal extent of the frames the server actually receives.

`HORIZONTAL_FOV_DEG` is now **68 / 60 / 50**, rounded to the ±3° measurement uncertainty.

**The gimbal's degrees are honest 1:1.** This falls out of two independent methods agreeing on
wide — a known-angle pan tracking features across the frame (distance-independent, 66.4°,
reproducible over three features and two pan angles) and the paper measurement (gimbal-independent,
67.9°). For the spec-sheet 86° to have been correct, the gimbal would have had to under-report by
39% *and* the tape measure to be wrong by 13 inches, in mutually compensating directions.

**Yaw range — no ±130° ceiling on Windows.** Commanded/read-back pairs: 120→120, 130→129,
**145→145**, 150→149, −150→−147. Readback is live, not an echo: a poll mid-slew caught 68° in
transit to 120°. `GIMBAL_YAW_LIMIT_DEG = 150` is correct for this path. The ±468000 arcsec figure in
`transport/linux.ts` and `transport/macos.ts` describes the **V4L2/UVC control's advertised range on
those platforms**, not a universal mechanical stop — Windows reaches ±150 via DirectShow. Minor
asymmetry worth knowing: the negative end lands ~3° short (−150 → −147) while the positive end is
within 1°.

### Still open

- **The ±130° UVC ceiling on Linux and macOS.** Untested — the measurements above are Windows-only.
  Linux drives absolute moves through the UVC control whose advertised range is ±130°, so a yaw
  target between 130° and 150° may still be truncated there while this module reports
  `clamped: false`. The consuming tool should either clamp to ±130° on those platforms or surface
  the discrepancy.
- **`obsbot_zoom_uvc` ratio is not linear magnification.** Requesting `ratio: 2.0` produced a
  measured **4.0×** linear magnification (the same sheet went 327 px → 1310 px at a fixed pose and
  distance). `Optics.zoom` in this module is defined as a linear factor dividing the tangent, so the
  consuming tool must convert rather than passing the UVC ratio through. Whether the relationship is
  exactly quadratic over the whole 1.0–2.0 range is unmeasured — only the endpoint was checked.
- **Vertical projection.** Whether `tan(V) = tan(H) · aspect` holds. Only the *horizontal* extent was
  measured; the vertical is still derived from it by aspect ratio. Note this check is now more
  valuable than it was, not less: it is no longer redundant with the axis question, since the axis
  question was answered without ever confirming the vertical.
- **Zoom readback.** The status block decodes `{ awake, hdr, faceAe, aiMode, trackSpeed }` — no
  zoom. `CameraControl_Zoom` is index 3 in the same DirectShow enum that supplies Pan=0, Tilt=1,
  Exposure=4, Focus=6 (`commands.ts:346`), and `camCtrlGet` is already wired. Untested.
- **FOV readback.** No path exists today. The undecoded offsets in the raw 60-byte status block are
  the obvious place to look. The consuming tool takes `fov` as a parameter.

### Method note

The measurement went wrong twice before it went right, and both failures are worth recording because
they will recur. A handheld sheet at an *estimated* "about 3 feet" gave 64°; the same sheet taped
down and tape-measured gave 78.7° — because it was inset in a folder whose trim hid part of its
width, and a too-narrow sheet inflates the computed FOV. Only when the full sheet was exposed,
centered on-axis, and measured against a known distance did the paper method converge with the
distance-independent pan method. **Any single measurement here is untrustworthy; the confidence comes
entirely from two methods with disjoint assumptions agreeing.**

## 9. Out of scope

- `obsbot_aim_at_pixel` — the tool that calls this module. Next increment.
- Zoom-to-fit / frame-a-region. The math is nearly free once this module exists, but it is
  speculation stacked on unverified trig until aiming works on real hardware.
- **Stereo depth from two cameras.** Recorded here so the reasoning is not lost. It works, and a
  vision model in the loop removes the hard half of it — correspondence, matching the same physical
  point across two images, becomes the model saying "that is the same mug."

  The precision argument favors *parking* over verging. Triangulating from two gimbal poses is
  limited by pose readback, which passes the UVC pan value straight through as integer degrees;
  depth error goes as `z²ε / b`, so a half-meter baseline at two meters with a degree of slop gives
  roughly ±14 cm. Fixing both gimbals at a known pose and measuring disparity in *pixels* instead
  gives ~0.067°/px at 86° over 1280 px, or roughly ±1 cm at the same range — the gimbal quantization
  becomes a one-time calibration constant rather than a per-measurement error. The gimbals acquire;
  the pixels measure.

  Blocked on hardware nobody owns, and on two real obstacles: baseline/orientation calibration
  between the units, and the absence of hardware sync between two independent USB cameras, which
  smears anything in motion. Note that v0.4.0's multi-camera path is exercised only against fakes
  and has never been run against two physical Tiny 2s, so a second unit would serve both purposes.
