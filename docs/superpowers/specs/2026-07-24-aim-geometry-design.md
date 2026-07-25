# Aim geometry module — design

**Status:** approved 2026-07-24. Not yet implemented.
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
is 86°, so the offset is 0.4 × 43°. A rectilinear lens does not map that way. The correct relation
is

```
tan(θ) = u · tan(hfov / 2)
```

where `u` is the normalized offset from center, `u ∈ [−1, 1]`.

The linear form is exact at `u = 0` and exact again at `u = ±1`, and wrong everywhere between —
always *under*-estimating. On the wide (86°) setting the error peaks at **≈3.5°** at `u ≈ 0.53`; on
narrow (65°) it peaks at **≈1.4°**. At two meters, 3.5° is roughly 12 cm of miss — the difference
between landing on target in one move and visibly hunting.

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
baked-in assumption, which confines the residual risk to the single hardware check in §8.

## 4. The math

Normalized coordinates, with the optical axis at frame center:

```
u = 2x / width  − 1
v = 2y / height − 1
```

Effective half-angles. Base horizontal FOV comes from the `fov` enum — wide 86°, medium 78°,
narrow 65° (`tools.ts:753`). Zoom is a crop, so it divides the tangent:

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

**Golden values** — hand-computed, wide (86°), 1280×720:

| input | expected |
|---|---|
| center `u = 0` | `dYaw = 0` |
| right edge `u = 1` | `dYaw = −43°` (edge maps to exactly half the FOV) |
| `u = 0.5` | `dYaw = −25.0°` (linear would say −21.5°) |
| vertical half-angle | `V ≈ 27.7°`, so `vfov ≈ 55.4°` at 16:9 |

**Properties:**

- Center pixel yields zero offset at every FOV, zoom, and aspect ratio.
- Frame edge yields exactly the half-angle — this pins the tangent form against the linear one.
- Monotonic: increasing `x` strictly decreases `dYaw`; increasing `y` strictly increases `dPitch`.
- Symmetric: mirroring a pixel about the center negates its offset.
- Doubling zoom halves `tan(H)`.
- `mirrored: true` negates `dYaw` and leaves `dPitch` untouched.
- Saturation sets `clamped` and never returns an out-of-range pose.

## 8. Open hardware questions

None of these block this module — each is a caller-supplied parameter, which is the point of
keeping the module pure. They block the *tool* that will consume it.

- **Mirroring.** Does the capture path flip the preview horizontally? One snapshot with an object
  clearly to one side settles it.
- **Zoom readback.** The status block decodes `{ awake, hdr, faceAe, aiMode, trackSpeed }` — no
  zoom. `CameraControl_Zoom` is index 3 in the same DirectShow enum that already supplies Pan=0,
  Tilt=1, Exposure=4, Focus=6 (`commands.ts:346`), and `camCtrlGet` is already wired. Likely a
  one-line addition, but unverified against the Tiny 2.
- **FOV readback.** No path exists today. The undecoded offsets in the raw 60-byte status block are
  the obvious place to look. Deferred: the consuming tool takes `fov` as a parameter.
- **Vertical projection.** Whether `tan(V) = tan(H) · aspect` holds at the wide end.
- **Yaw limit vs. the UVC pan range.** `GIMBAL_YAW_LIMIT_DEG = 150` is documented as
  hardware-verified, but `transport/linux.ts` and `transport/macos.ts` both record a
  hardware-measured `CT_PANTILT_ABSOLUTE` range of ±468000 arcsec pan / ±324000 arcsec tilt at 3600
  arcsec per degree — **±130° pan, ±90° tilt**. Tilt agrees with the 90° limit above; pan does not.
  Linux drives absolute moves through that same UVC control, so a yaw target between 130° and 150°
  passes `aimAtPixel` with `clamped: false` and is then silently truncated to 130° by the driver —
  the camera lands 10° short while this module reports success, which is exactly the "aimed and
  missed" failure clamping exists to prevent. On Windows/macOS the vendor V3 frame path may
  genuinely reach 150°, but `obsbot_gimbal_position` reads back through the same ±130° UVC control,
  so any pose past 130° reads back saturated and would feed a wrong `current` into the next aim.
  Not resolved here — `GIMBAL_YAW_LIMIT_DEG` stays at 150 pending a decision on whether the
  consuming tool should treat ±130° as the practical yaw bound or surface the discrepancy itself.
- **FOV axis: horizontal or diagonal?** `HORIZONTAL_FOV_DEG` (86°/78°/65°) asserts the axis in its
  name, but every in-tree source of those numbers (`codec/commands.ts`, `mcp/tools.ts`,
  `README.md`, `tiny2_specification.md`) states them with no axis qualifier, and they trace to
  OBSBOT's published spec sheet, where the Tiny series FOV is listed as **diagonal**. If 86° is
  diagonal, the true horizontal FOV at 16:9 is 78.2° and vertical is 49.1°, against this module's
  assumed 86°/55.4° — roughly **3.9° of half-angle error**, larger than the 3.5° linear-
  approximation error the entire tangent mapping exists to eliminate. This would present as a
  consistent overshoot that grows toward the frame edge. Critically, **the vertical-projection
  check above would NOT catch this**: a diagonal source makes both axes wrong in a correlated way,
  so `tan(V) = tan(H) · aspect` still appears to hold. This needs its own check: place an object at
  the exact right edge of frame on the wide setting and aim at it — one snapshot. A constant sourced
  from diagonal FOV overshoots past center by a repeatable margin.

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
