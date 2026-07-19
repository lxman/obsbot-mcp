# OBSBOT Tiny 2 — Control Protocol

Device: USB VID `0x3564`, PID `0xFEF8` (composite: MI_00 UVC video / MI_02 UAC audio / MTP).

A reference for controlling the camera over its standard UVC/USB interface. There are **two
independent control channels**.

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
use two different mechanisms** on this device — reads do NOT go through the framed V3 reply path
(the vendor GET-reply path is non-functional for preset data: sending a framed GET command and
reading the reply selector just returns the flat status block, never a V3 frame). Writes DO use
framed V3 `SET_CUR` commands, same as gimbal/AI/wake commands above.

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
| BOOT_POSE ("as initial state" pose) | `0x3ec4` | `idx:u32LE` + pose (4× float32 LE) + trailing float32 `0.0` (NOT the `-1000` ADD/UPDATE sentinel) |
| BOOT_FLAGS ("as initial state" flags) | `0x3e44` | 40-byte captured flag block, no slot index (the target slot is conveyed by the preceding BOOT_POSE frame); internal field meanings undecoded |

Notes:
- `idx` is always the 0-based slot index (`slot - 1`), little-endian `uint32`, matching selector
  12/13's slot indexing.
- ADD/UPDATE/BOOT_POSE all carry the same 4-float pose (pan, tilt, roll, zoom) but differ in their
  trailing sentinel float — do not merge their encoders.
- `obsbot_preset_save`/`obsbot_preset_update` with `asInitialState:true` send BOOT_POSE then
  BOOT_FLAGS as two additional frames after ADD/UPDATE.

---

## Telemetry (Channel C, informational)
The device pushes a continuous interrupt-IN stream (~70 msg/s, endpoint 0x81) carrying live gimbal / AI /
zoom state — the ground-truth source for `get_status`. Decode deferred; not required to send commands.
