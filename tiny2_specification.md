# OBSBOT Tiny 2 — Device Specification

Everything hardware-verified about the OBSBOT Tiny 2 (VID `0x3564`, PID `0xFEF8`), consolidated
into one document. Every claim here was measured on a physical device unless explicitly marked
otherwise.

**Verification status is stated per claim.** "Verified" means observed on hardware in a controlled
test. "Inferred" means derived from structure or disassembly and not confirmed by measurement.
Unverified claims are called out as such rather than presented alongside measured ones.

Verified on macOS (Darwin 25.5.0) and Windows, 2026-07-18 → 2026-07-20.

---

## 1. Device identity

| property | value |
|---|---|
| VID / PID | `0x3564` / `0xFEF8` |
| iManufacturer | "Remo Tech Co., Ltd." |
| iProduct | "OBSBOT Tiny 2" |
| **iSerialNumber** | **`0` — the device exposes NO USB serial string** |

All 16 USB string descriptors (indices 1–16, langid `0x0409`) are static product and interface
labels, identical on every unit. There is nothing unit-specific in USB descriptors.

**The serial number is obtainable only over the vendor protocol** — see §4.4. It is 14 ASCII
characters (example unit: `RMOWAHG3293TTL`). A 24-byte UUID is available the same way.

This matters for multi-camera setups: without reading the vendor serial, two Tiny 2s are
distinguishable only by USB `locationID`, i.e. by which physical port they occupy. That identity
does not survive moving a camera between ports.

### 1.1 Endpoint map

From the full 978-byte configuration descriptor:

```
if0 VideoControl   (0e/01): EP 0x84 interrupt IN, mps 16, interval 8   <- the ONLY interrupt EP
if1 VideoStreaming (0e/02): EP 0x81 BULK IN, mps 512                   <- video data
if2 AudioControl   (01/01): no endpoints
if3 AudioStreaming (01/02): alt1 EP 0x82 iso IN, mps 192
```

On macOS all four interfaces are held exclusively by Apple drivers (UVCAssistant via
CoreMediaIO, audio via `usbaudiod`); `USBInterfaceOpen` fails with `0xe00002c5`. Control transfers
still work: `USBDeviceOpen` succeeds and UVC class requests go out on the default control endpoint
via `DeviceRequest`, coexisting with the system camera stack.

### 1.2 There is no autonomous telemetry stream

**Verified.** With the device captured and if0 claimed, a blocking interrupt read on EP `0x84`
across wake + recenter + yaw ±60 + pitch +20 + recenter (~24 s, motion proven concurrently over
EP0) delivered **zero packets**. Not even command ACKs appear there.

`GET_INFO` across all CT/PU/XU controls shows exactly one AUTOUPDATE-capable control on the entire
device — CT `0x0C` (`ZOOM_RELATIVE`) — so nothing position- or status-related can raise a status
interrupt.

Earlier documentation describing "a continuous interrupt-IN stream (~70 msg/s, endpoint 0x81)" is
wrong in both halves: `0x81` is the bulk video endpoint, and the real interrupt endpoint is silent.
For live state, poll the controls in §2 and §4.

---

## 2. Channel A — standard UVC controls

Plain UVC Camera Terminal controls (entity `0x01`), drivable through any OS camera API or as raw
class requests. `bmRequestType` `0x21` for SET, `0xA1` for GET.

| selector | control | size | notes |
|---|---|---|---|
| `0x04` | `CT_EXPOSURE_TIME_ABSOLUTE` | 4 | readable; **writes go through §4, not here** |
| `0x06` | `CT_FOCUS_ABSOLUTE` | 2 | range 0–100 on this device |
| `0x0B` | `CT_ZOOM_ABSOLUTE` | 2 | uint16 zoom units |
| `0x0C` | `CT_ZOOM_RELATIVE` | 3 | the only AUTOUPDATE-capable control on the device |
| **`0x0D`** | **`CT_PANTILT_ABSOLUTE`** | **8** | **live absolute position — see §2.1** |
| `0x0E` | `CT_PANTILT_RELATIVE` | 4 | direction/speed — **NOT position, see §2.2** |
| `0x0F` | — | 2 | read-only |

Processing Unit (entity `0x03`) carries the standard brightness/contrast/hue/saturation/sharpness/
white-balance/gain controls. Gamma is unsupported.

**Firmware quirk:** undefined CT/PU selectors do **not** STALL — they return the 60-byte vendor
status block. A mis-mapped selector therefore reads as plausible garbage rather than failing
loudly. Undefined *XU* selectors (20–31) return zeros.

### 2.1 Gimbal position — `CT_PANTILT_ABSOLUTE` (0x0D)

**Verified.** This is the live absolute pan/tilt readout.

| field | value |
|---|---|
| Data | 8 bytes: `dwPanAbsolute` int32 LE, `dwTiltAbsolute` int32 LE |
| Units | **arc-seconds** (÷3600 → degrees) |
| Range | pan ±468000 asec (±130°), tilt ±324000 asec (±90°) |
| `GET_RES` | 3600 asec (1°) |
| `GET_INFO` | `0x03` (GET+SET). `GET_LEN` stalls — standard for CT controls |

Measured behaviour:

- **Live during motion.** Polled at 50 ms it streams 1° steps throughout a slew, with a visible
  trapezoidal velocity profile (fast mid-travel, asymptotic on approach).
- **Tracks motion the host never commanded** — vendor speed moves, recenter, and physical
  hand-movement of the gimbal all read back correctly.
- **Not a setpoint echo.** The host never writes this control; the firmware populates it. A
  commanded 40 °/s speed move for 1.2 s measured −69° → −21° = 48° = exactly 40 °/s, independently
  reproducing the commanded velocity from position readings alone.
- **Settle accuracy ±1°**, consistent with `GET_RES`.

Sign conventions (measured): UVC **pan positive = camera's left** = vendor yaw positive.
UVC **tilt positive = up = −(vendor pitch)**; the vendor/tool convention is pitch positive = down.

`SET_CUR` on `0x0D` has **not** been characterized. Absolute moves go through vendor frames (§4).

### 2.2 Selector `0x0E` is not position

`CT_PANTILT_RELATIVE` is a 4-byte `{bPanRelative, bPanSpeed, bTiltRelative, bTiltSpeed}`
direction/speed control. On this firmware the relative bytes read a constant `0x0B` and the speed
bytes carry live slew rate in °/s. Read as position it yields `0x000B` (= 11) at every pose, with
the speed byte in the high half during motion. Any code treating `0x0E` as position is wrong.

---

## 3. Channel B — vendor Extension Unit

| field | value |
|---|---|
| Entity / Unit | `0x02` (`bUnitID` 2, 19 controls) |
| XU descriptor GUID | `{9A1E7291-6843-4683-6D92-39BC7906EE49}` |
| `GET_LEN` | **60 for every selector 1–19** |
| `GET_INFO` | `0x03` for every selector 1–19 |
| selectors 20–31 | return all zeros — the XU has 19 real controls |

Known selector roles:

| selector | role |
|---|---|
| `0x02` | framed V3 command channel **and** reply mailbox (§4) |
| `0x06` | 60-byte status block; also the target for raw `uvcExt` writes (§5) |
| `0x08` | ASCII product name, NUL-padded ("OBSBOT Tiny 2 StreamCamera") |
| `0x0C` / `0x0D` (12/13) | gimbal preset list and entry cursor |

---

## 4. The framed V3 protocol

### 4.1 Frame layout — 60 bytes, zero-padded

```
off  size  field
 0     1   magic 0xAA
 1     1   FLAGS          <- 0x25 = SET w/ nested payload; 0x01 = header-only GET
 2     2   seq (u16 LE)
 4     2   len = 12 (u16 LE)
 6     2   header CRC-16/USB over bytes [0,12) with bytes 6-7 treated as zero
 8     1   sender    (host = 0x0A)
 9     1   receiver  (subsystem id)
10     2   cmd / wireCmd (u16 LE)
--- nested payload segment, present only when the payload is non-empty ---
12     2   len2 = payload length (u16 LE)
14     2   payload CRC-16/USB over [12, 16+len2) with bytes 14-15 treated as zero
16   len2  payload
```

Replies use the same layout with **sender and receiver swapped** and a reply flags byte of `0x29`.
A reply parses with the same parser as a request.

### 4.2 The flags byte — the key to readback

**Verified on both macOS and Windows.** The flags byte at offset 1 selects the frame flavour:

- **`0x25`** — SET commands carrying a nested payload. Correct for every write.
- **`0x01`** — header-only GET requests. **The device does not answer a GET framed with `0x25`.**

This single byte is the difference between a zero-filled reply and real data. Every historical
conclusion that "the vendor GET path is a passive echo / returns zeros" traces to sending GETs with
`0x25`. Do **not** change the constant globally — `0x25` must remain for SETs.

GETs work on a **sleeping** camera, so device identification requires no wake, no gimbal movement,
and no wake latency.

### 4.3 Reading a reply — three traps

1. **The mailbox retains the previous reply.** Reading selector `0x02` returns whatever was last
   placed there. A stale success is indistinguishable from a fresh one unless checked. **Always
   validate that the reply's `cmd` AND `seq` match the request.** This trap produced the original
   wrong "everything echoes" conclusion and is easy to fall into repeatedly.
2. **Reply latency varies** and exceeds 80 ms. A fixed sleep will read the *previous* command's
   reply. Poll the mailbox (~6 × 50 ms) until cmd and seq match.
3. **Validate CRCs.** Use a real frame parser: check magic `0xAA`, the header CRC, and the payload
   CRC, and reject payload lengths that exceed the frame (a 60-byte frame with payload at offset 16
   cannot carry more than 44 bytes). A no-reply typically presents as a zeroed frame.

Recipe: `SET_CUR` the request frame on XU selector `0x02`, then `GET_CUR` selector `0x02` for 60
bytes, then parse.

### 4.4 Device serial and UUID

| command | wireCmd | receiver | reply |
|---|---|---|---|
| `UG_GET_SN` | `0x18C8` | `0x0D` | 14 ASCII bytes |
| `UG_GET_UUID` | `0x1808` | `0x0D` | 24 bytes |

Both require the `0x01` GET flavour. These are the only stable per-unit identifiers the device
exposes and are the correct basis for multi-camera identity.

### 4.5 SET payload rule

**A framed-V3 SET payload must mirror the shape of its GET counterpart. A mismatched payload is
SILENTLY DISCARDED — no error, no state change, no indication of failure.**

Verified cases:

| command | correct payload | notes |
|---|---|---|
| `CAM_SET_FACE_FOCUS` | 4 B `i32le` | matches its 4-byte GET |
| `AI_SET_GIM_BOOT_POS` | **24 B** (six float32) | a 20-byte payload is discarded |
| `CAM_SET_EXPOSURE_TINY2` | **5 B** `[mode:u8][value:u32le]` | a 4-byte payload is discarded; sets mode *and* value |

Shape-matching is **necessary but not sufficient**: `CAM_SET_EXPOSURE_MODE` matches widths with its
GET and is still inert, apparently superseded by the combined exposure command. Treat the rule as a
strong working hypothesis and a fix procedure, not a proven law — it rests on four audited
encoders.

**Consequence:** any encoder written from disassembly without readback verification may be silently
failing. With §4.2 available, every SET can now be verified by write → read back → compare.

---

## 5. The `uvcExt` family — raw writes to selector 6

Distinct from framed V3. These write a raw 60-byte payload to XU selector `0x06`:

```
[tag] [valueLen] [value...] + zero pad to 60
```

| tag | control | value |
|---|---|---|
| `0x01` | HDR / WDR | `0`/`1` |
| `0x03` | face-priority AE | `0` global / `1` face (requires auto-exposure on) |
| `0x04` | field of view | `0` wide 86° · `1` medium 78° · `2` narrow 65° |
| `0x16` | AI tracking | 2-byte: `[enable]` (`0x02` on / `0x00` off), `[framing]` (0 normal · 1 upper-body · 2 close-up · 3 headless · 4 lower-body) |

These are verified through the status block on selector `0x06` and are **not** subject to the §4.5
payload rule. AI tracking specifically does *not* use the framed channel — `AI_SET_AI_TRACK_MODE`
on selector 2 is acknowledged and ignored.

---

## 6. Gimbal state and boot pose

### 6.1 Boot pose — `GIM_BOOT_POS` family

**Verified causally** by write → physical replug → read.

| command | wireCmd | receiver |
|---|---|---|
| `AI_SET_GIM_BOOT_POS` | `0x3844` | `0x04` |
| `AI_GET_GIM_BOOT_POS` | `0x3884` | `0x04` |
| `AI_RST_GIM_BOOT_POS` | `0x38C4` | `0x04` |
| `AI_TRG_GIM_BOOT_POS` | `0x3904` | `0x04` |

Payload is **24 bytes — six float32 LE**:

```
[0.0] [yaw] [pitch] [roll] [zoom] [0.0]
```

Slot 0 is `0x00000000` when set; `0xFFFFFFFF` (NaN) appears as an unset sentinel in the sibling
records `AI_GET_ZONE_TRACK_INIT_POS` and `AI_GET_HAND_TRACK_INIT_POS`, which share this layout.

Proof: original read `[0, 0.4, 11.5, 0, 1, 0]`, camera booted to yaw 0° / pitch +10°. Wrote
`[0, −35, −20, 0, 1, 0]`, replugged, and the camera came up at **yaw −34° / pitch −20°** — matching
within settling and the 1° quantization. Original restored byte-identically.

**The boot pose lives here, not in OBSBOT Center's As-Initial-State preset-binding record.**
`AI_GET_BOOT_PRESETS_ACTIONS` (`0x3E84`) returns 40 bytes reading `-2, -1, -128, -1, 0, -1, 0…` —
sentinel values, i.e. unset — while the camera demonstrably boots to the `GIM_BOOT_POS` value.

The camera comes up **awake** on cold plug-in, at its stored boot pose. Soft sleep/wake does not
re-enumerate USB; only a physical replug does.

### 6.2 Gimbal state blocks (undecoded)

| command | wireCmd | reply | status |
|---|---|---|---|
| `AI_GET_GIM_STATE` | `0x6604` | 24 B | field layout undecoded |
| `GIM_GET_STATE` | — | 32 B | field layout undecoded |
| `AI_GET_QUICK_STATUS` | `0x0104` | 12 B | field layout undecoded |

Decoding these needs differential sampling — read at several known poses and diff. The SDK suggests
`AI_GET_GIM_STATE` carries both euler and motor angle triplets.

### 6.3 Zone / hand tracking limits (decoded)

Float32 values, verified:

| control | value |
|---|---|
| zone track pan | −100.0 … +100.0 |
| zone track pitch | −30.0 … +30.0 |
| hand track pan | −45.0 … +45.0 |
| hand track pitch | −30.0 … +30.0 |

---

## 7. Exposure

`CAM_GET_EXPOSURE_TINY2` returns `[mode:u8][value:u32le]`.
`CAM_GET_EXPOSURE_RANGE_TINY2` returns `[mode:u8][min:u32][max:u32][cur:u32]`.

Measured: range **1 … 2500**, current **330**. Value 330 corresponds to 33 ms ≈ 1/30 s, and matches
the UVC `CT_EXPOSURE_TIME_ABSOLUTE` read exactly — two independent channels agreeing.

**Units are 0.1 ms**, so the 1…2500 range is 0.1 ms … 250 ms.

**The device snaps to supported shutter values.** Verified: 250 → 250 (1/40 s), 500 → 500 (1/20 s),
1000 → 1000 (1/10 s) and 2000 → 2000 (1/5 s) all land exactly, but **700 → 667** (1/15 s). A
readback that differs from what was written is therefore not necessarily a failed write — check
whether the returned value is a neighbouring standard shutter speed before concluding anything.

Writes go through `CAM_SET_EXPOSURE_TINY2` with the **5-byte** `[mode:u8][value:u32le]` payload,
which sets mode and value together. The separate `CAM_SET_EXPOSURE_MODE` command is inert.

**Mode readback encodes 1/2, not 0/1.** Writing mode byte `0` reads back as `2`; writing `1` reads
back as `1`. Most likely 1 = manual, 2 = auto, but this is **not confirmed**.

---

## 8. GET surface coverage

Probed with the `0x01` flavour, validated per §4.3.

| subsystem | probed | answering |
|---|---|---|
| Camera (indices 0–78) | 78 of 79 | **26** |
| Ai (79–111) | 33 | **18** |
| SysMg, TXBle, PrimaryBle, Upgrade | not probed — see §9 | — |

Commands that answer return real, self-consistent data. Commands that stay silent fall into two
groups: features this hardware lacks (all NDI controls, `MODULE_ACTIVATE` — Tail Air hardware), and
commands that require a payload parameter and ignore a header-only GET (white balance group,
`FIELD_VIEW`, preset ID/name lookups). The payload-parameter hypothesis is **untested**.

Notable working reads beyond those already covered: `CAM_GET_SYS_TIME` (returns a Unix timestamp,
but the clock is unset/factory-set — read `1689984608` = 2023-07-22 — **do not trust it as a time
source**), `CAM_GET_AUDIO_VOLUME`, `CAM_GET_SUSPEND_TIME` (600 s), `CAM_GET_WDR_MODE`,
`CAM_GET_MIRROR_FLIP`, `CAM_GET_ROTATION_DEG`, `AI_GET_GIMBAL_PRESET_LIST`.

---

## 9. Hazards — do not send these

**`CAM_GET_ISO_THRESHOLD` (wireCmd `0x3D82`, receiver `0x02`) hard-kills the camera.** The device
drops off the USB bus entirely — absent from the OS device tree — and only a physical replug
recovers it. Verified: the `SET_CUR` succeeded and the following `GET_CUR` 60 ms later returned
`kIOReturnNoDevice`. This is an ordinary Camera-subsystem opcode, so the hazard is **not** confined
to exotic subsystems.

**Do not blind-sweep the command surface.** A single pass over all 161 GET opcodes took the device
off the bus. The Upgrade subsystem's state machine (`UG_GET_STATE`, `UG_GET_RESULT`,
`UG_GET_UG_RESULT`, `UG_GET_HDMI_TIMING`) is the leading suspect for that first incident — probing a
firmware-upgrade gate plausibly transitions the device into a DFU state. `UG_GET_SN` and
`UG_GET_UUID` are safe and repeatedly exercised; the rest of that subsystem is not worth exploring
on hardware with no recovery path but a replug.

**Treat as off-limits:** SysMg (WiFi/Ethernet — hardware the Tiny 2 lacks), TXBle and PrimaryBle
(BLE radios), and the Upgrade subsystem beyond the two identity reads.

When probing anything new: batch small, liveness-check between opcodes, save results incrementally,
and wrap every transfer. A crash mid-sweep otherwise destroys the evidence needed to identify what
caused it.

---

## 10. Operational notes

- **Idle sleep.** The camera sleeps after roughly a minute of inactivity. Reads still work while
  asleep, but **writes are silently ignored** — always wake before a SET, and heartbeat during long
  polling loops. A sleeping camera returns stale or zero data but cannot physically move, so
  observed motion remains the trust anchor for any gimbal test.
- **Replug invalidates handles.** After re-enumeration a stale device handle causes writes to fail
  silently; the helper or server must reopen the device.
- **macOS TCC** attaches the camera grant to the responsible process (Terminal, Claude Desktop),
  not to the helper binary — so helper rebuilds and ad-hoc signatures do not invalidate consent.
- **Linux caveat.** `uvcvideo` serves `VIDIOC_G_CTRL` from a cache of values it has written for
  controls without the AUTO_UPDATE quirk, so V4L2 pan/tilt readback echoes the setpoint rather than
  reading hardware. Reaching the raw `0x0D` register on Linux needs a different route (libusb
  detach, or a kernel quirk patch) and is **unverified**.

---

## 11. Open questions

- Field layouts of `AI_GET_GIM_STATE` (24 B), `GIM_GET_STATE` (32 B), `AI_GET_QUICK_STATUS` (12 B).
- Whether the silent GETs accept a payload parameter, and its shape.
- `AI_GET_GIMBAL_PRESET_LIST` structure with presets actually populated (it reads count 0 when the
  slots are empty).
- Whether `AI_RST_GIM_BOOT_POS` and `AI_TRG_GIM_BOOT_POS` (empty payloads) suffer the §4.5 defect.
- The remaining unaudited SET encoders: the five preset commands, boot flags, zoom-with-speed,
  AI track speed.
- Exposure mode semantics: confirming 1 = manual and 2 = auto.
- `SET_CUR` behaviour on `CT_PANTILT_ABSOLUTE` (0x0D).
- Whether OBSBOT Center distinguishes two identical cameras across a port swap by reading the
  vendor serial, or by some other means.
