# Locating the camera serial number

**Question:** when multiple OBSBOT cameras are installed, how do we get a per-device
serial number to tell them apart?

**Answer (hardware-verified, Tiny 2, 2026-07-20):** the serial is returned by the
device over USB via the **`UG_GET_SN`** command as a **14-character ASCII string**.
It maps directly to the libdev SDK's `Device::devSn()`:

> `include/dev/dev.hpp:1527` — *"Get the current SN of the device, which is used to
> uniquely identify the device. Returns a string of 14 characters."*

On the test unit the serial is **`RMOWAHG3293TTL`**.

## Where it lives on the wire

| field       | value                                             |
|-------------|---------------------------------------------------|
| command     | `UG_GET_SN`                                        |
| wireCmd     | `0x18C8`                                           |
| subsystem   | Upgrade (`CMD_SET_UPGRADE = 0x05`)                |
| receiver    | `0x0D` (`DEV_UPGRADE`)                             |
| transport   | UVC XU **entity 2, selector 2** (control IN/OUT)  |
| reply size  | 14 ASCII bytes                                     |

It is **not** in the sel-6 status block, the device-name selector (8), or any of the
flat selectors. It only comes back as the reply to the `UG_GET_SN` GET frame.

## The catch — and the fix

The long-standing "vendor V3 GET-reply path returns all zeros" problem is a **wrong
flags byte**, not a wrong selector or endpoint. `buildFrame` (`src/codec/frame.ts`)
hardcodes:

```ts
frame[1] = 0x25;   // flags: UVC + nested payload (const for v1 cmds)
```

The device only answers Upgrade-subsystem GETs when **`frame[1] = 0x01`**. That single
byte is the difference between a zero-filled reply and the real serial. Confirmed by
replaying OBSBOT Center's own startup capture and by an isolation test that stripped
OC's trailing session token (the token is not required).

## Proven live recipe

1. **SET_CUR** to XU entity 2, selector 2 with a 60-byte frame:

   ```
   aa 01 <seqLE> 00 0c 00 <hdrCRC16LE> 0a 0d c8 18   + zero-pad to 60
   ```
   `0a` = sender (host), `0d` = receiver (Upgrade), `c8 18` = wireCmd 0x18C8.
   Header CRC is CRC-16/USB over bytes `[0,12)` with bytes 6–7 treated as zero
   (exactly what `buildFrame`/`parseFrame` already do).

2. **GET_CUR** selector 2, 60 bytes. Reply:

   ```
   aa 29 <seq> 00 0c 00 <crc> 0d 0a c8 18 0e 00 <crc2> 52 4d 4f 57 41 48 47 33 32 39 33 54 54 4c 00 …
                                             len=0x0e        └──────── "RMOWAHG3293TTL" ────────┘
   ```

3. The reply is a standard FrameV3 — `parseFrame()` decodes it with no changes:
   `cmd = 0x18C8`, `payload =` the 14 ASCII bytes. Decode the payload as ASCII.

## Bonus: UUID / MAC, same mechanism

The same `frame[1] = 0x01` trick works for the rest of the Upgrade-subsystem GETs,
so multi-camera disambiguation has more than one key available:

- **`UG_GET_UUID`** (`0x1808`) → reply `aa 29 … 08 18 18 00 <crc2> <24 bytes>`,
  `len2 = 0x18 = 24`, payload ending in **`b8 cd 31 c6 9e b0`** — the device
  UUID/MAC (the same value OBSBOT Center appends to some frames as a session token).
- `UG_GET_DEV_INFO` (`0x1948`) and the version GETs are the same subsystem/flavor and
  should behave identically (not yet replayed).

## Suggested integration

- Add a GET-frame builder variant that sets `frame[1] = 0x01` (recompute the header
  CRC), do SET+GET on selector 2, `parseFrame` the reply, and read the payload as
  ASCII (SN) or raw bytes (UUID). **No native helper change is needed** — this uses
  the same `xu_get`/`xu_set` control-transfer surface the transport already has.
- `obsbot_list_devices` currently keys only on the DirectShow friendly name, so two
  identical "OBSBOT Tiny 2" entries are indistinguishable. Attaching the serial (and
  optionally the UUID) to each enumerated device gives a stable per-unit identity for
  the multi-camera case.

## Required change to `recvVendor` / `obsbot_probe`

Both the `recvVendor` transport method and the `obsbot_probe mode:query` tool are
non-functional for GETs today, and it's the **same one-byte root cause**. To make
serial (and any other GET) readback work, one real fix is needed.

**Root cause.** `buildFrame` (`src/codec/frame.ts:9`) hardcodes `frame[1] = 0x25`
("flags: UVC + nested payload") for *every* vendor frame. That flavor is correct for
the working SET commands (wake, zoom, gimbal, HDR…), which all carry a nested payload.
The header-only GET requests need `frame[1] = 0x01` instead — the device simply does
not answer a GET framed with `0x25`, which is why `recvVendor` and `obsbot_probe`
have always read back zeros.

**Do NOT flip the constant.** Changing `0x25 → 0x01` globally would break every
working SET. The value must stay `0x25` for SETs; `0x01` is specifically the
header-only / GET flavor.

**The change:**

1. **`buildFrame`** — add an optional flags-byte parameter, defaulting to the current
   value so existing callers are unaffected:
   ```ts
   export interface FrameOpts { seq: number; cmd: number; receiver: number;
                                payload: Buffer; sender?: number; flags?: number; }

   // in buildFrame:
   frame[1] = o.flags ?? 0x25;   // 0x25 = UVC + nested payload (SETs); 0x01 = header-only GET
   ```
   The header CRC is recomputed over `[0,12)` *after* the fields are set, so passing
   `flags: 0x01` yields a correct CRC automatically — no hand computation.

2. **`recvVendor`** — build the GET request with `flags: 0x01`. The selector is
   already correct: my live test did both the SET and the GET on selector 2 and the
   reply came back, so `RESPONSE_SELECTOR = 0x02` stays (this supersedes the earlier
   "should be 0x06" hypothesis — 0x06 is the flat status block, not a reply frame).
   The reply then feeds straight into `parseFrame` unchanged.

3. **`obsbot_probe mode:query`** — have `encodeVendorProbe` (or the probe handler)
   emit the `0x01` GET flavor so the diagnostic actually returns replies. This is the
   tool you'll want for retesting the rest of the GET surface.

**Scope / open item.** `frame[1] = 0x01` is hardware-verified only for the
Upgrade-subsystem GETs (SN `0x18C8`, UUID `0x1808`). The AI/CAM-subsystem GETs that
previously read zeros — preset LIST, face focus, quick status, face AE — have not
been retested with `0x01`. They may respond to the same fix or use a different
mechanism; that's a quick follow-up experiment once the parameterized builder exists.
