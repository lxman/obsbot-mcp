# obsbot_aim_at_pixel — design

**Status:** approved 2026-07-25. Not yet implemented.
**Depends on:** `src/geometry/aim.ts` (merged 2026-07-25, `8804bf6`) and its spec
`docs/superpowers/specs/2026-07-24-aim-geometry-design.md`.
**Scope:** one new MCP tool plus the status decoding it needs. No capture changes, no new geometry.

## 1. Problem

The geometry module converts a pixel to an absolute gimbal pose, but nothing calls it. This tool is
the consumer: it lets a model that can *see* through the camera point the camera at what it sees.

The loop is snapshot → locate → aim → snapshot to verify. **This tool owns only the aim step.** The
model composes the rest, because the verify step needs vision the server does not have — the server
cannot look at a frame and decide whether the mug is centered. A tool that tried to close the loop
itself would have to call back into the model, which the MCP protocol does not offer.

## 2. What the camera can tell us — measured 2026-07-25

The aim geometry spec's §8 listed FOV readback and zoom readback as open questions. Both are now
answered, and the answers remove parameters from this tool's surface rather than adding them.

**The status block carries both.** Diffing the raw 60-byte block (`--debug` exposes it) across
control changes:

| state | `block[0x04]` | `block[0x11]` |
|---|---|---|
| wide, 1× | 0 | **0** |
| medium, 1× | 5 | **1** |
| narrow, 1× | 15 | **2** |
| wide, 1.5× | 50 | **3** |
| wide, 2.0× | 100 | **3** |

- **`block[0x11]` is the FOV mode**, matching the enum already in `codec/commands.ts`
  (`FOV_VALUE = { wide: 0, medium: 1, narrow: 2 }`). Value **3** matches the vendor SDK's
  `FovTypeNull` — the camera reports it when a continuous zoom has overridden the discrete modes.
- **`block[0x04]` is zoom position**, 0–100 across the UVC ratio range 1.0–2.0.

**A caveat that cost the first attempt:** the initial test showed *no* change at all, because the
camera had gone to sleep and was serving a stale block. A sleeping camera answers; it just lies.
Any use of these fields must check `awake` first.

## 3. Tool surface

```
obsbot_aim_at_pixel({ x, y, frameWidth, frameHeight, camera? })
```

**No optics parameters.** An earlier draft took `fov` and `zoom` from the caller, which would have
made a wrong value a silent 36% aiming error. §2 makes that unnecessary: the tool reads the real
values from the device.

`frameWidth`/`frameHeight` stay caller-supplied because they are **not a camera property**. They
belong to the caller's capture request — `obsbot_capture_snapshot` takes `resolution` and the helper
picks a format from it, so there is no persistent frame size on the device to read. This is not a
guess on the caller's part: `obsbot_capture_snapshot` returns `{ width, height }` in the same result
as the image, so passing them back is a copy.

## 4. Preconditions — all refusals, none silent

**Sleep is handled by the existing gate, and refused if it had to wake the camera.**
`obsbot_gimbal_move` already goes through `gate(camera)` → `ensureReady`, which wakes a sleeping
camera, waits for it to settle, and self-heals a dropped connection. This tool uses the same gate,
so the §2 stale-*status-block* hazard is removed by construction: status is read after the gate
returns, when the camera is known awake.

That removes only one of the two staleness problems here, though. Waking the gimbal un-stows and
levels it — a real physical move — and this tool's pose reading happens *after* that move, while the
caller's `x`/`y` were measured against a frame captured *before* it. Reading the pose after the gate
makes the status block fresh, but it does nothing for the frame's provenance: the frame and the pose
now describe two different moments, and the tool would aim confidently at the wrong place with no way
to tell. So `ensureReady` reports whether it had to wake the camera (`woke`), and this tool refuses
when it did, rather than silently aiming on a pose the caller's frame doesn't match. An earlier draft
refused on `awake: false` before the gate ran, which would have been both unfriendly (refusing a case
the gate can just handle) and insufficient (it didn't address the frame-provenance problem the wake
itself creates).

One `recvStatus()` call then supplies the remaining checks.

| condition | action |
|---|---|
| gate fails (`unreachable` / `wake-timeout`) | return the gate's own error unchanged |
| gate succeeded but had to wake the camera (`woke: true`) | refuse — the wake moved the gimbal after the caller's frame was captured; ask for a fresh snapshot |
| `aiMode` ≠ `no-tracking` | refuse, naming the mode, and point at `obsbot_ai_track` |
| `fovMode` is 0/1/2 | proceed, using that mode's measured constant |
| `fovMode` is 3 | refuse — custom zoom active, magnification uncalibrated |
| `fovMode` is anything else | refuse — an unrecognised mode means the block is not what we think it is, and guessing a constant is exactly the failure this tool exists to avoid |

**Why refuse on tracking rather than disable it.** Tracking drives the gimbal on its own, so the
pose goes stale the instant it moves, and it would fight the aim afterward (geometry spec §5).
Auto-disabling would make the loop "just work" at the cost of silently changing a setting the user
may have deliberately enabled, with no path to restore it. Loud beats convenient — the same
reasoning that makes `clamped` a reported flag rather than a silent truncation.

**Why refuse on custom zoom.** The UVC ratio is not linear magnification: `ratio: 2.0` was measured
at **4×**. A square law fits that one point, but not the others — narrow's implied ratio of 1.15
predicts 1.32× against a measured 1.44×. With the mapping uncalibrated, aiming on a zoomed frame
would be arithmetic applied to a crop factor we do not know. This means **`obsbot_zoom_uvc` and
aiming do not compose**, which is a real limitation and is stated in the tool description.

**Why zoom is not passed to the module.** The measured `HORIZONTAL_FOV_DEG` values were taken in
exactly the three discrete FOV states, so each constant already includes whatever inherent crop that
mode applies (visible as `block[0x04]` reading 0/5/15). The tool therefore passes `zoom: 1` and lets
the constant carry it. Passing the mode's zoom again would double-count.

## 5. Validation

The geometry module is pure and deliberately unguarded — `width: 0` yields `NaN` and reports it as
merely `clamped` (geometry spec §5). Holding the boundary is this tool's job:

- `frameWidth`, `frameHeight`: finite, ≥ 1.
- **Aspect must be 16:9**, accepted when `|frameWidth / frameHeight − 16/9| ≤ 0.02`. That tolerance
  admits the rounding in small frames (256×144 is exactly 1.7778, 640×360 exactly 1.7778) while
  rejecting 4:3 (1.333) and a transposition (0.5625) by a wide margin. The capture path preserves
  16:9 at every resolution — verified at 256×144, 1280×720 and 1920×1080 — so a non-16:9 pair is a
  transposition or a typo, and rejecting it is free.
- `x`, `y`: finite, and within `[0, frameWidth]` / `[0, frameHeight]`.

**What validation cannot catch, and must therefore be documented:** if the caller passes `x, y` from
one frame and `frameWidth, frameHeight` from another, both pairs are 16:9 and the aim silently lands
at the wrong offset. Nothing server-side can detect it. The tool description must say plainly: pass
the width and height from the same result as the pixel.

## 6. Behavior and return

Read status (§4), read the current pose via the same UVC path `obsbot_gimbal_position` uses, call
`aimAtPixel`, and move through the same clamped path as `obsbot_gimbal_move`.

Returns `{ target, offset, clamped, fovMode, current }`. `current` and `fovMode` are included
deliberately: they let the caller see what the tool believed about the world, which is what makes a
miss diagnosable rather than mysterious.

`clamped: true` means the target was outside the gimbal's range and the camera landed short — the
caller must not read a successful move as a successful aim.

## 7. Status decoding

`decodeStatus()` in `codec/commands.ts` gains two fields, with offsets as named constants beside the
existing `STATUS_OFF_*` set:

- `fovMode`: `"wide" | "medium" | "narrow" | "custom" | "unknown"` from `block[0x11]`, where 3 maps
  to `"custom"`.
- `zoomPercent`: `block[0x04]`, 0–100.

`CameraStatus` gains both, so `obsbot_status` reports them for every caller — an improvement
independent of this tool.

## 8. Testing

Against fakes, in the existing `test/mcp/tools.test.ts` style:

- Each refusal path returns `ok: false` with a message naming the cause: tracking active (with the
  mode), custom zoom, unrecognised FOV mode.
- A sleeping camera is woken by the gate and then **refused**: a fake whose first status read reports
  asleep must produce `ok:false` with an error mentioning a fresh snapshot, and must never call
  `gimbalSet` — the wake moved the gimbal out from under the frame the caller measured.
- Each discrete FOV mode selects the matching constant — a fake reporting narrow must produce an
  offset consistent with 50°, not 68°. This is the test that would have caught the original
  parameter-guessing design.
- Validation rejects: zero/negative dimensions, non-16:9 aspect, non-finite `x`/`y`, out-of-frame
  pixels.
- A centered pixel produces no pose change; an off-center pixel produces the offset `pixelToOffset`
  gives for the same inputs.
- Saturation propagates `clamped: true` and never commands an out-of-range pose.
- `decodeStatus` maps `block[0x11]` 0/1/2/3 to wide/medium/narrow/custom and reads `zoomPercent`.

Hardware verification is a separate step and is **not** a substitute for the above: point the camera
at a target, aim at its pixel, and confirm it lands centered.

## 9. Known limitations

- **Zoom and aiming do not compose** (§4). Lifting this needs the UVC ratio → magnification mapping
  calibrated at several points; one point is known (2.0 → 4×).
- **Stale pose on Linux.** `obsbot_gimbal_position` returns the last commanded value there, because
  `uvcvideo` caches the control and this firmware never sends the invalidating interrupt. A violated
  precondition is undetectable on that platform (geometry spec §5). **A kernel patch is in progress;
  if it lands, this tool becomes correct on Linux with no change here**, since it reads the pose
  through the same call that would become live.
- **Frame-mismatch is undetectable** (§5).
- **Constants are 16:9-only.** A 4:3 capture path would need both the FOV constants and the vertical
  correction re-measured.

## 10. Out of scope

- Zoom-to-fit / frame-a-region. Still speculation until aiming is proven on hardware.
- Any iterate-until-centered tool (§1).
- Calibrating the zoom ratio mapping.
- Stereo depth (geometry spec §9).
