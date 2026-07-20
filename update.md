# RE session results — live absolute gimbal position on macOS (2026-07-20)

> ## ⚠ SUPERSEDED — read [`tiny2_specification.md`](tiny2_specification.md) instead
>
> This is a session report, kept for its evidence trail and narrative. Its central finding (CT
> `0x0D` is live absolute position) is correct and was implemented. **But one of its conclusions is
> now known to be wrong, and several of its prescriptions have been overtaken.**
>
> **§4.2 is WRONG.** "The framed V3 GET path is a passive echo" is false. The path works — it
> requires the header-only flags byte `frame[1] = 0x01` instead of the SET flavour `0x25`. Every
> probe in §4.2 was sent with `0x25`, which the device does not answer, so the echo was an artifact
> of the request framing. Four of the exact opcodes §4.2 cites as proof (`CAM_GET_SYS_TIME`,
> `CAM_GET_AUDIO_VOLUME`, `AI_GET_QUICK_STATUS`, `AI_GET_GIM_STATE`) return real data once framed
> correctly. 26 of 79 Camera GETs and 18 of 33 Ai GETs answer.
>
> §4.2 also notes the mailbox "persists until cleared by reading a different selector" — that part
> is real, and it is a trap: a stale reply reads as a fresh success unless the reply's `cmd` **and**
> `seq` are checked against the request. That is most likely how the echo conclusion survived
> scrutiny at the time.
>
> **Still valid:** §1 (the `0x0D` discovery, ranges, sign conventions), §4.1 (XU selector sweep
> carries no pose data), §4.3 (endpoint map), §4.4 (EP `0x84` is silent), §4.5 (GET_INFO/GET_LEN
> survey). §4.5's remark that undefined selectors return the status block holds for **CT/PU**
> selectors; undefined **XU** selectors 20–31 return zeros.
>
> **Overtaken:** §2.4's list of `PROTOCOL.md` corrections has been applied and extended. §2.6's
> working-tree inventory is stale. §3's verification plan was carried out and passed.
>
> **What this document could not have known:** a SET payload must mirror its GET counterpart's
> shape or the device silently discards it. On that basis `AI_SET_GIM_BOOT_POS` and both exposure
> setters ship broken. Also, `CAM_GET_ISO_THRESHOLD` (`0x3D82`) drops the device off the USB bus —
> do not send it, and do not blind-sweep the command surface.

**Headline: the OBSBOT Tiny 2 exposes live absolute pan/tilt position through the standard UVC
`CT_PANTILT_ABSOLUTE` control — selector `0x0D` on the Camera Terminal. The repo has been reading
selector `0x0E`, which is `CT_PANTILT_RELATIVE` (a direction/speed control), and every
"no readable position" conclusion — including the uncommitted shadow-tracking in the working
tree — grew from that one wrong constant.**

All findings below are hardware-verified on this machine (macOS, Darwin 25.5.0, Tiny 2
VID 0x3564 PID 0xFEF8) on 2026-07-20. Verification tools and raw run data are preserved in
`scripts/re-tools/`.

---

## 1. The central discovery

### 1.1 The selector mix-up

UVC 1.5 Camera Terminal control selectors (Table A-12):

| selector | control | size | layout |
|---|---|---|---|
| `0x0D` | **CT_PANTILT_ABSOLUTE** | 8 | `dwPanAbsolute` int32 LE, `dwTiltAbsolute` int32 LE — **arc-seconds** (1/3600°) |
| `0x0E` | **CT_PANTILT_RELATIVE** | 4 | `bPanRelative` (1B), `bPanSpeed` (1B), `bTiltRelative` (1B), `bTiltSpeed` (1B) |

`native/macos/helper.m` maps pan/tilt (camctrl properties 0/1) to **`0x0E`** (`camctrlSel()`,
~line 394, comment "CT_PANTILT_ABSOLUTE") and parses the 4 bytes as two int16s
(pan = bytes[0:2], tilt = bytes[2:4]). What those int16s actually contain is
`bPanRelative | bPanSpeed<<8` and `bTiltRelative | bTiltSpeed<<8`. On this firmware
`bPanRelative`/`bTiltRelative` read as a constant `0x0B`, and the speed bytes carry the live
axis slew rate. Hence every historical observation:

- "position" reads `(speed << 8) | 0x0B`, i.e. `0x000B` (= 11) at rest **for every pose**;
- during a slew the value ramps then decays (trapezoidal velocity profile), e.g. pan pinned at
  `0x18`–`0x19` (24–25 °/s cruise) through a 120° traverse, tilt decaying `0x29 → 0x01`;
- magnitude only — no direction sign;
- the old poll scripts' `panDeg = value >> 8` was extracting the **speed byte**, not degrees.

### 1.2 What `0x0D` actually returns (measured)

Plain `GET_CUR` on EP0 — **works unprivileged, coexists with UVCAssistant** (device-level
`DeviceRequest`, same access path the helper already uses):

```
bmRequestType 0xA1, bRequest 0x81 (GET_CUR), wValue 0x0D00, wIndex 0x0100, wLength 8
→ int32 LE pan_arcsec, int32 LE tilt_arcsec       (÷3600 → degrees)
```

Measured properties (`scripts/re-tools/ct0d_verify.m`, full output reproduced in §5.5):

| request | pan | tilt |
|---|---|---|
| GET_MIN | −468000 asec = **−130°** | −324000 asec = **−90°** |
| GET_MAX | +468000 asec = **+130°** | +324000 asec = **+90°** |
| GET_RES | 3600 asec = **1°** | 3600 asec = **1°** |
| GET_DEF | 0 | 0 |
| GET_INFO | 0x03 (GET+SET supported) | — |
| GET_LEN | (stalls; standard for CT controls) | — |

Behavior, all verified in one run:

1. **Live during slews.** Polled every 50 ms during a center→(−50,−10) vendor absolute move:
   pan streamed 0 → −1 → −4 → −8 → … → −49 in 1° steps over ~2.1 s, tilt 0 → +10
   concurrently. Same on the return leg to (+50,+10). This is a live encoder-side readout,
   not a settle-only latch.
2. **Tracks vendor SPEED moves.** After `AI_SET_GIM_SPEED` (yaw −30 °/s float, ~1.5 s, then
   zero-speed stop) from pan +50°: register read **+95°**. The uncommitted shadow-tracking
   declares position unknowable after speed moves — with `0x0D` it is simply read back.
   (Note the vendor speed-command sign moved the gimbal in the *positive* UVC pan direction;
   vendor speed sign ≠ vendor absolute-move sign. Not further characterized.)
3. **Tracks recenter.** Live 95 → 0 sweep, settling at exactly 0/0.
4. **Not an echo.** The host never wrote `0x0D` in any run (all moves went through vendor V3
   frames on the XU). The firmware populates it itself. Readback also *differs* from the
   command where the mechanics differ (see sign table below) — a setpoint echo would not.
5. **Settle accuracy ±1°** (consistent with GET_RES = 1°): commanded −50 settled at −49;
   +50 at exactly +50; pitch +10 settled at tilt −9, pitch −10 at tilt +10.

### 1.3 Sign conventions (measured)

| vendor `AI_SET_GIM_MOTOR_DEG` command | UVC 0x0D readback |
|---|---|
| yaw −50, pitch −10 | pan **−49**, tilt **+10** |
| yaw +50, pitch +10 | pan **+50**, tilt **−9** |

- UVC **pan positive = vendor yaw positive** (camera's left).
- UVC **tilt positive = up = − vendor pitch** (vendor/tool convention is pitch positive = down).
  This matches the negation already present in `tools.ts` (`pitch = -(camCtrlGet(TILT))`), and
  the tilt sign convention the uncommitted `macos.ts` shadow was emulating.

### 1.4 Why Linux "confirmed" the wrong conclusion

The reservoir memory "V4L2 pan_absolute readback echoes setpoint" is explained by the kernel,
not the firmware: **uvcvideo caches control values it has written and serves `VIDIOC_G_CTRL`
from that cache** (controls without the AUTO_UPDATE quirk are never re-read from hardware).
The raw `0x0D` register was almost certainly never actually read on Linux. Also note the prior
memory that `UVCIOC_CTRL_QUERY` is restricted to XU entities on Linux, so a raw CT read needs
a different route there (libusb detach, or a kernel quirk patch) — **the Linux fix needs its
own investigation**; do not assume the macOS result transfers through the V4L2 API as-is.

Windows: `usbvideo.sys`/DirectShow maps `CameraControl_Pan/Tilt` onto CT `0x0D` (degrees at the
API). The Windows transport probably *has been* returning live position all along. The comment
in the uncommitted `macos.ts` claiming the Windows driver serves "driver-tracked state, not a
raw register" is unverified and now presumed wrong.

---

## 2. Corrections required (file by file)

### 2.1 `native/macos/helper.m` — the real fix

`camctrlSel()` (~line 392) currently:

```c
case 0: case 1: return 0x0E; // CT_PANTILT_ABSOLUTE   ← WRONG: 0x0E is PANTILT_RELATIVE
case 4:          return 0x0D; // CT_EXPOSURE_TIME_ABSOLUTE ← WRONG: 0x0D is PANTILT_ABSOLUTE
case 6:          return 0x10; // PU_FOCUS_ABSOLUTE     ← WRONG: see §2.5
```

Required:

- **Pan/tilt (props 0/1) → selector `0x0D`, 8-byte transfers.**
  - `doCamCtrlGet` (~line 730): read 8 bytes `{int32 pan; int32 tilt;}`, return the requested
    axis. Decide the unit at the helper boundary deliberately: the TS layer
    (`tools.ts` gimbal_position/preset handlers) consumes **degrees** (Windows helper returns
    degrees via DirectShow; Linux transport divides mdeg→deg). Simplest: helper converts
    asec→deg (`value / 3600`, rounded), keeping the helper's existing "returns degrees on
    macOS" contract. Alternatively return arc-seconds and scale in `macos.ts` the way
    `linux.ts` scales mdeg — either way, make transport × helper consistent and documented.
  - `doCamCtrlSet` (~line 692): currently writes `int16 buf[2] = {value, 0}` for BOTH axes —
    besides the wrong selector, the tilt value goes into the pan slot (latent bug). If a
    camctrl-based absolute move is wanted at all, `0x0D` SET_CUR is 8 bytes
    `{pan_asec, tilt_asec}` and **SET_CUR on 0x0D was NOT tested this session** — moves
    already work via vendor V3 frames, so the safe change is to make pan/tilt camctrl_set
    an error (or route it to the vendor path) rather than ship an untested write.
  - `doCamCtrlRange` (~line 712): works unchanged against `0x0D` (GET_MIN/MAX succeed,
    verified) but must apply the same 8-byte/per-axis and unit handling.
- **Do not touch selector `0x0E`** except to stop calling it "absolute". If the raw
  rate readout is worth keeping for diagnostics, it is `{bPanRelative, bPanSpeed,
  bTiltRelative, bTiltSpeed}` with the speed bytes in °/s.

### 2.2 `src/transport/macos.ts` — delete the shadow

The uncommitted shadow-tracking (fields `shadowYaw`/`shadowPitch`, the `camCtrlGet` intercept,
the invalidate-on-speed-move logic, and the long comments asserting "the firmware has NO
readable settled-position register / hardware-verified 2026-07-19") is **built on the wrong
selector and should be removed**, not merged. `camCtrlGet(0|1)` should pass through to the
helper (like focus/exposure do) once the helper reads `0x0D`. `gimbalSpeed` no longer needs to
invalidate anything; `gimbalRecenter`/`gimbalSet` no longer need to record anything.

`camCtrlGetRaw` (added across all transports in the uncommitted diff) loses its purpose once
`camCtrlGet` is truthful; keep it only if the `obsbot_pan_tilt_raw` diagnostics tool is kept,
and if kept, point it at `0x0E` explicitly as a *rate* readout with an honest description.

### 2.3 `src/mcp/tools.ts`

- `obsbot_gimbal_position` (~line 650): revert the uncommitted description ("shadow-tracks the
  last commanded pose … reported as 0,0 after a speed move"). New truth: reads live absolute
  position from the standard UVC control on every platform; ±1° resolution; valid during and
  after any move including speed moves and physical/external motion.
- `obsbot_preset_save` (~line 690): revert description likewise — the pose saved is now the
  real measured pose.
- `obsbot_pan_tilt_raw` (uncommitted, ~line 1098): drop, or reword as a rate/diagnostics tool.
- The `pitch = -tilt` negations at ~715/802 are **correct** for the measured sign convention —
  keep them.

### 2.4 `PROTOCOL.md`

- Add to "Channel A"-style standard-UVC documentation: pan/tilt absolute position = CT selector
  `0x0D`, 8 bytes, int32 LE ×2, arc-seconds, ±130°/±90°, RES 1°, live during motion.
- Fix the Telemetry section: the interrupt endpoint is **EP 0x84** on the VideoControl
  interface (mps 16, interval 8 → host polls at 62.5 Hz); **EP 0x81 is the bulk video-streaming
  endpoint** (if=1, mps 512). The "~70 msg/s interrupt stream carrying live gimbal state" claim
  is wrong on this hardware: EP 0x84 delivered **zero packets** across a 24 s captured run with
  motion proven concurrently (§5.4). If the number came from an OBSBOT-Center-attached capture
  on another OS, whatever enabled it was never identified; no enable command was found.
- Optionally document the V3 reply-mailbox behavior (§4.2) — it corrects the existing "reads
  just return the flat status block" note with the actual mechanism.

### 2.5 Adjacent latent bugs in `helper.m` (audit before fixing)

Found while surveying; **not** exercised end-to-end this session:

- `camctrlSel(4)` (exposure) returns `0x0D` — as of this discovery that reads **pan** as
  exposure. Standard `CT_EXPOSURE_TIME_ABSOLUTE` is selector `0x04` (4 bytes; confirmed present
  on this device: GET_LEN=4, GET_CUR ok). No current `tools.ts` caller uses camctrl exposure
  (exposure goes via vendor frames), so this is dormant — but fix or delete the mapping.
- `camctrlSel(6)`/`camctrlEnt(6)` map focus to **PU selector 0x10**, which is not a valid PU
  control on this device (survey: unsupported quirk-response). Standard `CT_FOCUS_ABSOLUTE` is
  **CT selector 0x06** (2 bytes; confirmed present: GET_LEN=2, GET_CUR ok, GET_INFO 0x03).
  `tools.ts` *does* call `camCtrlSet(FOCUS)`/`camCtrlRange(FOCUS)` (~lines 641–646) — whatever
  the integration run measured for the focus tool should be re-examined after remapping.
- `doCamCtrlSet` pan/tilt writes `{value, 0}` regardless of axis (tilt value lands in the pan
  field) — moot once §2.1 lands, listed for completeness.

### 2.6 Uncommitted working-tree state (inventory)

`git status` at session start: modified `src/mcp/tools.ts`, `src/transport/{linux,macos,transport,windows}.ts`;
untracked `scripts/integration/keep-awake.mjs`, `scripts/poll-gimbal.ts`. The transport/tools
modifications are the shadow-tracking wave described above (plus `camCtrlGetRaw` and the
`obsbot_pan_tilt_raw` tool) — superseded by this discovery. This session added (untracked):
`scripts/re-position-sweep.ts`, `scripts/re-mailbox-v2.ts`, `scripts/re-tools/*`, `update.md`.

---

## 3. Suggested verification for the fix (repo conventions: TDD, hardware verify)

1. Unit: codec/helper-protocol tests for the 8-byte `{pan,tilt}` asec parse + unit conversion
   and per-axis extraction (regression: axis-mixing, the old 4-byte read bug).
2. Hardware (extend the integration harness / `verify` skill):
   - wake → recenter → `gimbal_position` ≈ (0,0) ±1°;
   - absolute move (+50, +10) → settle → position ≈ (50, 10) ±1° (tool convention, pitch+=down);
   - **speed move** (the case shadow-tracking could never answer) → position changes and is
     self-consistent with a subsequent absolute move;
   - poll during a slew → monotonic 1°-step progression (proves live readout);
   - `preset_save` at a hand-picked pose → recall → position round-trips within ±1°.
3. Camera sleep gotcha still applies: wake before reading; a sleeping camera returns stale/zero
   data but cannot move (physical motion remains the trust anchor).

---

## 4. Dead ends — surfaces verified to NOT carry position (do not re-probe)

These results remain valid and are worth keeping documented; they were all obtained with the
motion/wake confounds controlled.

### 4.1 All 19 XU selectors, three settled poses
`GET_CUR` (60 B; GET_LEN is uniformly 60 for all XU selectors 1–0x1F) at center, (+60, 0),
(−60, +20), plus a repeated same-pose sweep to identify noise: **zero pose-dependent bytes,
zero noisy bytes** — byte-identical across all four sweeps. Data:
`scripts/re-tools/re-sweep-1.json`.

### 4.2 The framed V3 "GET" path (XU selector 2) is a passive echo — ⚠ WRONG, see the banner above

> **This entire subsection is refuted.** The path is not an echo; the probes below were framed with
> `frame[1] = 0x25` (the SET flavour), which the device does not answer. With `0x01` they return
> real data. Retained verbatim as a record of how the wrong conclusion was reached — note that the
> "validation GETs" listed below were treated as decisive precisely because they *should* have
> returned data, and they now do.
Sending any framed V3 command makes `GET_CUR` selector 2 return that same frame back
(byte 0 zeroed, version 0x25 at offset 1, **same seq, same cmd, same sender/receiver `0a/04`**,
payload bytes echoed untouched — zeros stay zeros). It persists until cleared by reading a
*different* selector, then selector 2 reverts to an "empty" pattern (status-block tail with the
live 0x0E rate bytes at offsets 1–3). Confirmed over ~4000 tight-loop reads: **no delayed data
reply ever arrives, no NTY frames ever surface, no other XU selector changes after a GET**
(wide before/after sweep of all 19). Validation GETs that must return data if the path worked
(CAM_GET_SYS_TIME, CAM_GET_AUDIO_VOLUME, CAM_GET_FIELD_VIEW, AI_GET_ZONE_TRACK_PAN_MIN,
AI_GET_QUICK_STATUS, AI_GET_GIM_BOOT_POS, AI_GET_GIM_STATE with 0/4/12-byte payloads, at rest
and mid-slew): all echo-only. Data: `scripts/re-tools/re-mailbox2.json`.

### 4.3 Endpoint map (from the full configuration descriptor, 978 bytes)
```
if0 VideoControl  (0e/01): EP 0x84 interrupt IN, mps 16, interval 8   ← the ONLY interrupt EP
if1 VideoStreaming(0e/02): EP 0x81 BULK IN, mps 512                   ← video data, not telemetry
if2 AudioControl  (01/01): no EPs
if3 AudioStreaming(01/02): alt1 EP 0x82 iso IN, mps 192
```
All four interfaces are exclusively held by Apple drivers (UVCAssistant pid-visible as
`_cmiodalassistants`, from CoreMediaIO.framework; audio via `usbaudiod`); `USBInterfaceOpen`
fails `0xe00002c5` normally.

### 4.4 EP 0x84 carries no autonomous telemetry
With the device captured (sudo) and if0 claimed, a blocking interrupt read ran through
wake + recenter + yaw −60 + yaw +60 + pitch +20 + recenter (~24 s) while the main thread
concurrently polled the (then-misidentified) 0x0E register over EP0 and observed the motors
slewing (19–35 register changes per move window): **0 packets total**. Even command ACKs do not
appear there. Log: `scripts/re-tools/ep84-decisive-run.log`. GET_INFO across all CT/PU/XU
controls shows exactly one AUTOUPDATE-capable control: CT `0x0C` (ZOOM_RELATIVE) — nothing
position-related can generate status interrupts.

### 4.5 GET_INFO / GET_LEN survey (for the record)
CT: standard control sizes confirmed (0x02:1, 0x03:1, 0x04:4, 0x06:2, 0x08:4(nonstd), 0x0B:2,
0x0C:3 [AUTOUPDATE], 0x0D:8, 0x0E:4, 0x0F:2 read-only). PU: standard (brightness…WB, gamma
unsupported). Undefined selectors don't STALL on this firmware — they return the 60-byte status
block (quirk worth knowing when probing). XU: every selector 1–0x1F answers GET_LEN=60,
GET_INFO=0x03.

---

## 5. Session narrative + evidence trail (chronological)

1. **`scripts/re-position-sweep.ts`** (helper-driven, EP0): XU selector sweep × poses (→ §4.1),
   first mailbox probes, during-slew polling. Discovered the V3 echo behavior and that the
   "position" register tracked *rates* (pan pinned ~24–25 during a 179°-target move — the
   number that later identified it as °/s cruise).
2. **`scripts/re-mailbox-v2.ts`**: characterized the echo mailbox exhaustively (→ §4.2).
3. **`scripts/re-tools/usb_map.m`**: full config descriptor + claim test (→ §4.3). Corrected
   PROTOCOL.md's EP 0x81 story to EP 0x84.
4. **`scripts/re-tools/ep84_capture.m`** (sudo, ×2 runs): device capture worked; first run
   failed on `ReadPipeTO` (bulk-only API — interrupt pipes need blocking `ReadPipe`; returns
   `kIOReturnBadArgument` otherwise). Fixed in second run: total silence on EP 0x84.
5. **`scripts/re-tools/ep84_decisive.m`** (sudo): same, with concurrent EP0 register polling to
   close the "was it even moving?" confound (→ §4.4). Full log preserved.
6. **`scripts/re-tools/ep0_deep.m`** (unprivileged): the re-examination pass that found it —
   GET_LEN/GET_INFO/GET_CUR across CT/XU/PU × two poses. CT `0x0D` was the only control that
   differed: `00000000 00000000` at center vs `20bf0200 7081ffff` (= 180000, −32400 asec =
   +50°, −9°) at (+50, +10). Also ran the wide post-GET sweep (→ §4.2 closure).
7. **`scripts/re-tools/ct0d_verify.m`** (unprivileged): full characterization of `0x0D`
   (§1.2–1.3): ranges, live-during-slew at 50 ms cadence, speed-move tracking (+50 → +95 after
   a −30 °/s × 1.5 s vendor speed command), recenter tracking to exact 0/0.

Build line for the `.m` tools:
`xcrun clang -fobjc-arc -framework IOKit -framework Foundation -o <name> <name>.m`
(`ep84_*` additionally need sudo at runtime; they restore the device via a normal re-enumeration
on exit including Ctrl-C, verified after every run — camera re-enumerates healthy.)

### 5.5 Key raw excerpts

`ep0_deep` pose diff (the discovery):
```
DIFF CT sel=0x0d:
  center: 0000000000000000
  y50p10: 20bf02007081ffff        # int32 LE: 180000 asec = 50.000°, −32400 asec = −9.0°
```

`ct0d_verify` ranges:
```
GET_MIN pan=-468000 (-130°) tilt=-324000 (-90°)
GET_MAX pan= 468000 ( 130°) tilt= 324000 ( 90°)
GET_RES pan=3600 tilt=3600          GET_DEF pan=0 tilt=0
```

`ct0d_verify` live slew (center → yaw −50, pitch −10; 50 ms polls, excerpt):
```
[4374]  pan= -1.00° tilt= 1.00°
[4537]  pan= -8.00° tilt= 4.00°
[4980]  pan=-31.00° tilt= 8.00°
[5535]  pan=-46.00° tilt=10.00°
[7033]  settled pan=-176400 asec (-49.000°) tilt=36000 asec (10.000°)
```

`ct0d_verify` speed move + recenter:
```
after AI_SET_GIM_SPEED yaw=-30°/s ×1.5s from pan=+50°:
[13522] pan=342000 asec (95.000°) tilt=-32400 asec (-9.000°)
recenter: live 95→0 in 1° steps, settled pan=0 tilt=0 exactly
```

Old “position” register during a 120° traverse (actually 0x0E rate bytes, from
`ep84-decisive-run.log`): pan cruise `0x18/0x19` (24–25 °/s), decay `…0x04,0x03,0x02,0x01,0x00`,
rest value `0x000B` at every pose.

---

## 6. Memory/doc corrections already made this session

- Project memory updated: `live-position-found-ct-0x0d.md` (the discovery) and the corrected
  dead-ends file `macos-no-live-position-all-surfaces.md` (slug `macos-no-live-position-dead-ends`).
  Note: several auto-captured reservoir memories still assert "no live gimbal position",
  "pan_absolute echoes setpoint", "gimbal position via CT_PANTILT_ABSOLUTE 0x0E", and
  "gimbal position readback uses per-axis int16 fields" — **all superseded by this document**;
  expect them to keep surfacing until re-captured.
- Nothing in `src/`, `native/`, or `PROTOCOL.md` has been changed by this session — the
  corrections in §2 are all still to do, deliberately left for the follow-up implementation
  pass. The working tree still contains the (now obsolete) shadow-tracking diff.
