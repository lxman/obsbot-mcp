# OBSBOT Tiny 2 — Control Protocol

Device: USB VID `0x3564`, PID `0xFEF8` (composite: MI_00 UVC video / MI_02 UAC audio / MTP).

A reference for controlling the camera over its standard UVC/USB interface. There are **two
independent control channels**.

> **See also [`tiny2_specification.md`](tiny2_specification.md)** — the consolidated,
> hardware-verified device specification. Where the two disagree, the specification is newer and
> takes precedence. It covers material this document does not: the framed-V3 GET flavour
> (`frame[1] = 0x01`) that makes vendor replies readable, the rule that a SET payload must mirror
> its GET counterpart's shape, the boot-pose family, device serial retrieval, and the command
> hazards that can drop the device off the USB bus.

---

## Channel A — Zoom: STANDARD UVC (no vendor protocol)

Plain UVC Camera-Terminal control. Drivable on every OS via standard camera-control APIs.

| field | value |
|-------|-------|
| Request | `SET_CUR` (0x01) / `GET_CUR`/`GET_MIN`/`GET_MAX` |
| bmRequestType | `0x21` (set) / `0xA1` (get) |
| Control Selector | `0x0B` = `CT_ZOOM_ABSOLUTE` |
| Entity/Unit | `0x01` (camera terminal) |
| Data | `uint16` LE, zoom units |

**Ratio → device-units formula:**
```
units = round( min + (max - min) * (ratio - 1.0) + 0.001 )
```
`min`/`max` = UVC `GET_MIN`/`GET_MAX` on selector 0x0B. Implement zoom via the OS standard
camera-control API (Win `IAMCameraControl`; Linux `V4L2_CID_ZOOM_ABSOLUTE`; mac UVC) OR a raw
`CT_ZOOM_ABSOLUTE` SET_CUR of the computed uint16 — identical on the wire.

### Gimbal position readback — standard UVC `CT_PANTILT_ABSOLUTE`

Live absolute pan/tilt is a plain Camera-Terminal control, readable unprivileged and
concurrently with the OS camera stack.

| field | value |
|-------|-------|
| Control Selector | `0x0D` = `CT_PANTILT_ABSOLUTE` |
| Entity/Unit | `0x01` (camera terminal) |
| Data | 8 bytes: `dwPanAbsolute` int32 LE, `dwTiltAbsolute` int32 LE — **arc-seconds** (÷3600 → degrees) |
| Range | pan ±468000 asec (±130°), tilt ±324000 asec (±90°) |
| GET_RES | 3600 asec (1°) — settle accuracy is ±1° |
| GET_INFO | `0x03` (GET+SET); `GET_LEN` stalls, standard for CT controls |

The firmware updates this control itself, live: polled at 50 ms it streams 1° steps throughout a
slew, and it tracks motion the host never commanded through this control — vendor speed moves and
recenters both read back correctly. It is not a setpoint echo.

Sign convention: UVC pan positive = vendor yaw positive = camera's left. UVC tilt positive = up,
which is the negation of the vendor/tool `pitch` convention (pitch positive = down).

> Selector `0x0E` is `CT_PANTILT_RELATIVE` — a 4-byte
> `{bPanRelative, bPanSpeed, bTiltRelative, bTiltSpeed}` direction/speed control, **not** position.
> The speed bytes carry the live slew rate in °/s and the relative bytes read a constant `0x0B` on
> this firmware, so reading it as position yields `0x000B` at every pose. This repo made exactly
> that mistake; see `update.md` (2026-07-20).
>
> On Linux, note that uvcvideo serves `VIDIOC_G_CTRL` from a cache of values it has written for
> controls without the AUTO_UPDATE quirk, so V4L2 pan/tilt readback echoes the setpoint rather than
> reading the hardware. Reaching the raw `0x0D` register there needs its own route.

---

## Channel B — Gimbal / AI / camera vendor commands: Extension Unit

Vendor Extension Unit, addressed via UVC XU control:

| field | value |
|-------|-------|
| bmRequestType | `0x21` (set) / `0xA1` (get) |
| Control Selector | `0x02` |
| Entity/Unit | `0x02` (extension unit, `bUnitID` 2, 19 controls) |
| XU descriptor GUID | `{9A1E7291-6843-4683-6D92-39BC7906EE49}` |
| Data | 60-byte `V3` frame (below), zero-padded |

On Windows the XU is reached via DirectShow `IKsTopologyInfo` → find the KS node whose type GUID
matches the XU GUID above → `IKsControl::KsProperty(Set=<XU GUID>, Id=2, Flags=SET|TOPOLOGY,
NodeId=node)` with the 60-byte frame as the property data.

### Frame layout (`V3` frame)
```
off 0    : 0xAA                  magic
off 1    : 0x25                  version/flags (send path: b &= 0xFD; b |= 0x01; bit 0x60 ⇒ nested segment)
off 2-3  : seq    u16 LE         increments per sent frame
off 4-5  : len    u16 LE = 0x0C  # bytes covered by the token (magic..cmd = 12)
off 6-7  : token  u16 LE         checksum (see below)
off 8    : sender   = 0x0A
off 9    : receiver = 0x04
off 10-11: cmd    u16 LE         command id (e.g. 0xA0C2, 0x6484)
off 12+  : payload              command-specific float32/int params, LE.
                                 When flags&0x60: nested segment {len2 u16 @12, token2 u16 @14, data @16}
                                 with token2 computed the same way over the nested segment.
```

### Token (checksum) — **CRC-16/USB**
Standard **CRC-16/USB**: poly `0xA001` (reflected 0x8005), init `0xFFFF`, refin=refout=true,
xorout `0xFFFF`.
- Computed over `frame[0 : len]` (i.e. the first 12 bytes) **with the token field (6-7) set to 0x0000**.
- Stored little-endian at `frame[6:8]`.
- Nested segments use the same CRC over their own `[start : start+len2]` with their token field zeroed.

```python
def token(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc ^ 0xFFFF   # low byte -> frame[6], high byte -> frame[7]
```

### Command table
Each command is a fixed wire `cmd` (bytes at offset 10-11, little-endian) with a `sender`/`receiver`
pair and a payload. Gimbal payloads longer than 12 bytes are carried in the **nested segment**.

| Command | wire `cmd` [10:12] LE | bytes[10,11] | receiver [9] | sender [8] | payload (nested segment) |
|---------|:---:|:---:|:---:|:---:|---|
| wake / sleep | `0xA0C2` | `C2 A0` | 0x02 | 0x0A | `data[0] = (state != run) ? 1 : 0` (wake=0, sleep=1) |
| recenter / home | `0x00C3` | `C3 00` | 0x03 | 0x0A | 6 zero bytes |
| gimbal speed | `0x6484` | `84 64` | 0x04 | 0x0A | roll, pitch, yaw — 3× float32 LE (deg/s) |
| gimbal move-to-angle | `0x6444` | `44 64` | 0x04 | 0x0A | roll, pitch, yaw — 3× float32 LE (motor degrees) |
| gimbal euler-angle | `0x6404` | `04 64` | 0x04 | 0x0A | roll, pitch, yaw — 3× float32 LE (euler degrees) |
| zoom | *standard UVC `CT_ZOOM_ABSOLUTE`* | — | — | — | uint16 units (formula in Channel A) |

Notes:
- **Wake/sleep inversion:** run(wake) → `data[0]=0`; sleep → `data[0]=1`.
- **Gimbal payload float order = roll, pitch, yaw** (3× float32 LE), 12 bytes. Because `len`(0x18) > 12,
  the payload is carried in the **nested segment**.
- **Nested payload segment** (present when `len>12`, i.e. all gimbal/run commands): at wire offset 12:
  `len2 u16` @12, `token2 u16` @14 = CRC-16/USB over the nested bytes `[12 : 12+len2+4]` with token2
  zeroed, `data` @16.

---

## Gimbal presets (Channel B, flat selectors + V3 write commands)

Three on-device preset slots (indices 0-2 on the wire, presented as slots 1-3). **Reads and writes
use two different mechanisms** in the implementation below: reads go through flat XU selectors
12/13, writes through framed V3 `SET_CUR` commands, same as gimbal/AI/wake commands above.

> **Correction (2026-07-20).** This section previously justified the flat-selector read path by
> asserting "the vendor GET-reply path is non-functional … just returns the flat status block,
> never a V3 frame". **That is wrong.** The framed GET path works; it requires the header-only
> flags byte `frame[1] = 0x01` instead of the SET flavour `0x25`. Framed GETs sent with `0x25` are
> not answered, which is what produced the original conclusion. `AI_GET_GIMBAL_PRESET_LIST`
> (`0x3b44`) does reply, returning an occupied-slot count.
>
> The flat-selector protocol below remains hardware-verified and is what the code ships, so it is
> documented as-is. But it is no longer the *only* option, and the framed alternative has not been
> fully explored — the per-entry lookups (`AI_GET_GIMBAL_PRESET_ID_VALUE`, `…_ID_NAME`) stay silent
> on a header-only GET and probably need a payload index. See `tiny2_specification.md` §4.

### Read protocol: flat XU selectors 12 (list) + 13 (entry cursor)

Both are raw `GET_CUR`/`SET_CUR` on the XU (bmRequestType `0xA1`/`0x21`, Entity/Unit `0x02`,
Control Selector = the selector number itself, not `0x02`), NOT V3 frames — no magic byte, no CRC,
no cmd field. Three-step read:

1. **`GET_CUR` selector 12** → `<count:u8> <slotIdx:u8> × count`. `count` is how many of the 3
   slots are occupied; each following byte is a 0-based occupied slot index (0, 1, and/or 2).
2. **`SET_CUR` selector 12**, echoing back exactly the bytes just read in step 1. This resets
   selector 13's entry cursor to the start. Hardware-verified as load-bearing and provably
   non-destructive for a genuine echo; writing anything else (zeros, synthesized bytes) to
   selector 12 has **undecoded** semantics — don't.
3. **`GET_CUR` selector 13**, `count` times. Each read returns the next preset entry and advances
   the cursor, until the exhausted marker.

**Selector-13 entry layout** (60-byte reply, only the first ~10+name bytes meaningful):

| offset | field | notes |
|---|---|---|
| 0 | status | `0x02` = cursor exhausted (no more entries; the fields below are not present) |
| 1 | slotIdx | 0-based (0/1/2 → slot 1/2/3) |
| 2-3 | reserved | unobserved |
| 4-5 | pitch | `int16` LE, hundredths of a degree (÷100 → tilt in degrees) |
| 6-7 | yaw | `int16` LE, hundredths of a degree (÷100 → pan in degrees) |
| 8 | zoom | `uint8`, hundredths of ratio (÷100 → zoom, e.g. `100` → `1.0`) |
| 10.. | name | base64 ASCII, NUL-terminated (or running to the end of the buffer) |

### Write commands (framed V3, `SET_CUR` on selector `0x02`, receiver `0x04`, sender `0x0A`)

| Command | wire `cmd` [10:12] LE | payload |
|---|:---:|---|
| ADD (create) | `0x3944` | `idx:u32LE` (slot-1) + pose (pan, tilt, roll, zoom — 4× float32 LE) + trailing float32 `-1000` sentinel |
| UPDATE (overwrite) | `0x3e04` | same payload shape as ADD |
| RECALL | `0x39c4` | `idx:u32LE` + four float32 `1.0` |
| DELETE | `0x3984` | `idx:u32LE` only (4 bytes) |
| SET_NAME (rename) | `0x3a84` | `idx:u32LE` + name, ASCII (write side — NOT base64; matches the captured OBSBOT Center frame, but not yet independently hardware-confirmed) |
| `AI_SET_BOOT_PRESET_UPDATE_ONLY` | `0x3ec4` | `idx:u32LE` + pose (4× float32 LE) + trailing float32 `0.0` (NOT the `-1000` ADD/UPDATE sentinel) |
| `AI_SET_BOOT_PRESETS_ACTIONS` | `0x3e44` | 40-byte actions record, no slot index (the target slot is conveyed by the preceding frame) |

Notes:
- `idx` is always the 0-based slot index (`slot - 1`), little-endian `uint32`, matching selector
  12/13's slot indexing.
- The last two carry the same 4-float pose shape as ADD/UPDATE but differ in their trailing
  sentinel float — do not merge their encoders.

> **Corrections (2026-07-20).**
>
> **Names.** These two were previously called `BOOT_POSE` and `BOOT_FLAGS`. Those names were
> invented and actively misleading. Their real firmware names are above: `0x3ec4` *binds an
> existing preset* as the boot preset (hence Center's preset-identifying step before it), and
> `0x3e44` writes a "boot presets actions" record. `src/codec/preset.ts` resolves both by real name
> from the generated opcode table.
>
> **"Undecoded" is obsolete.** The 40-byte actions record is now readable via
> `AI_GET_BOOT_PRESETS_ACTIONS` (`0x3e84`) with the `0x01` GET flavour. On this device it reads all
> sentinel values (`-2, -1, -128, -1, 0, -1, 0…`) — i.e. **unset**.
>
> **This is not where the boot pose lives.** The active boot pose is in the `GIM_BOOT_POS` family
> (`AI_SET_GIM_BOOT_POS` `0x3844` / `AI_GET_GIM_BOOT_POS` `0x3884`), proven by writing a distinct
> pose, physically replugging, and observing the camera come up there. Its payload is 24 bytes —
> six float32 — and the 20-byte payload the repo shipped was silently discarded. See
> `tiny2_specification.md` §6.1.

---

## Telemetry (Channel C) — no autonomous stream on this device

Endpoint map from the full configuration descriptor:

```
if0 VideoControl   (0e/01): EP 0x84 interrupt IN, mps 16, interval 8   ← the only interrupt EP
if1 VideoStreaming (0e/02): EP 0x81 BULK IN, mps 512                   ← video data, not telemetry
if2 AudioControl   (01/01): no endpoints
if3 AudioStreaming (01/02): alt1 EP 0x82 iso IN, mps 192
```

An earlier revision of this document described "a continuous interrupt-IN stream (~70 msg/s,
endpoint 0x81) carrying live gimbal / AI / zoom state". Both halves are wrong: `0x81` is the bulk
video endpoint, and the real interrupt endpoint `0x84` is silent. With the device captured and if0
claimed, a blocking interrupt read across wake + recenter + yaw ±60 + pitch +20 + recenter (~24 s,
motion proven concurrently over EP0) delivered **zero packets** — not even command ACKs. `GET_INFO`
across all CT/PU/XU controls shows one AUTOUPDATE-capable control on the whole device, CT `0x0C`
(`ZOOM_RELATIVE`), so nothing position-related can raise a status interrupt.

If some host does receive that stream, whatever enables it was not identified. For live gimbal
state, read `CT_PANTILT_ABSOLUTE` (Channel A) instead.
