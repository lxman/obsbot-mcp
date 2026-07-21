# obsbot-mcp

A cross-platform [Model Context Protocol](https://modelcontextprotocol.io) server that controls an
**OBSBOT Tiny 2** camera over its standard UVC/USB interface — pan/tilt/roll the gimbal, zoom, AI
subject tracking, focus/exposure/white-balance/image controls, HDR and field-of-view, plus snapshot,
preview, and recording — without any vendor SDK.

## Install

```bash
npm install obsbot-mcp
```

## MCP client configuration

Add a stdio server entry pointing at the installed binary (or directly at `dist/index.js`):

```json
{
  "mcpServers": {
    "obsbot": {
      "command": "obsbot-mcp"
    }
  }
}
```

If you're running from a local checkout instead of an npm install, point `command`/`args` at
`node` and the built entry point instead:

```json
{
  "mcpServers": {
    "obsbot": {
      "command": "node",
      "args": ["path/to/obsbot-mcp/dist/index.js"]
    }
  }
}
```

### Debug / diagnostics tools

By default the server advertises only the normal control surface. Pass `--debug` to additionally
expose the diagnostics surface — the `obsbot_debug_probe` tool (raw XU byte get/set/query) and the
`raw` 60-byte status block on `obsbot_status`:

```json
{
  "mcpServers": {
    "obsbot": {
      "command": "node",
      "args": ["path/to/obsbot-mcp/dist/index.js", "--debug"]
    }
  }
}
```

With the installed binary, use `"command": "obsbot-mcp"` and `"args": ["--debug"]`.

## Tools

34 tools total. All names below are current as of v0.4.0 — **every tool was renamed in this
release and there is no backward-compatible alias**; see [CHANGELOG.md](./CHANGELOG.md) for the
full old→new mapping if you're updating a caller.

### The `camera` selector

Every camera-addressing tool accepts an optional `camera` parameter: the target camera's serial
number. Omit it with a single camera attached and nothing changes — this matches the server's
pre-v0.4.0, single-camera behaviour exactly. With more than one camera attached, a call that omits
`camera` fails with an error naming every attached serial, so you always know what to pass next.

**Exempt** (no `camera` parameter, ever): `obsbot_devices` (enumerates the whole fleet),
`obsbot_capture_stop` / `obsbot_capture_list` (address a `sessionId`, not a device), and
`obsbot_debug_probe` (operates on the current diagnostics transport). Two more tools honor it only
partially — see **Capture** below.

Multi-camera support is new in v0.4.0. It's exercised by the unit test suite against fakes; running
two physical Tiny 2s at once has not yet been hardware-verified (see
[Known limitations](#known-limitations)).

`obsbot_devices` is the way to discover the serials you pass as `camera`: it reports each attached
camera's `serial` (where obtainable — reading it requires briefly opening the camera), `name`, and
`status` (`available` | `bound` | `busy`). A camera another process already holds comes back `busy`
with no serial, since it can't be opened to read one.

### Device & power

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_devices` | — | List attached OBSBOT cameras with each one's serial (where obtainable), name, and status (`available`/`bound`/`busy`). A `busy` camera is held by another process. |
| `obsbot_wake` | `camera`? | Wake the camera/gimbal (sends `"run"`). |
| `obsbot_sleep` | `camera`? | Sleep the camera/gimbal (sends `"sleep"`). |
| `obsbot_status` | `camera`? | Read the live status block: `{ awake, hdr, aiMode, trackSpeed }`. Under `--debug`, also returns the raw 60-byte block as hex. |

### Gimbal (PTZ)

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_gimbal_move` | `yaw`, `pitch`, `roll` (degrees, `roll` defaults `0`), `camera`? | Move the gimbal to an absolute angle. Positive yaw pans to the camera's left, positive pitch tilts down. Yaw clamped to `[-150, 150]`, pitch to `[-90, 90]`. Absolute 1:1 degrees, hardware-verified. |
| `obsbot_gimbal_move_speed` | `yaw`, `pitch`, `roll` (deg/s, `roll` defaults `0`), `autoStopMs` (default `800`), `camera`? | Drive the gimbal at a speed, then auto-stop after `autoStopMs` so it can't run away. Same yaw/pitch sign convention as `gimbal_move`. |
| `obsbot_gimbal_recenter` | `camera`? | Recenter the gimbal (return to home position). |
| `obsbot_gimbal_position` | `camera`? | Read the gimbal's current absolute `{ yaw, pitch }` in degrees via standard UVC Pan/Tilt. Valid during a move as well as after one. |

### Gimbal presets

Three on-device preset slots (1–3). Slots are **create-once**: `obsbot_preset_save` requires an
empty slot (delete first to reuse one); every other preset tool requires the slot to already be
occupied. Each tool re-reads the slot list after writing and returns a structured `{ ok:false }`
failure if the device didn't land the change.

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_preset_list` | `camera`? | Read the three preset slots: occupied/empty, name, and pose in degrees. |
| `obsbot_preset_save` | `slot` (`1`\|`2`\|`3`), `camera`? | Save the gimbal's current live pose into an **empty** slot. |
| `obsbot_preset_recall` | `slot` (`1`\|`2`\|`3`), `camera`? | Recall an **occupied** slot, driving the gimbal to its saved pose. |
| `obsbot_preset_update` | `slot` (`1`\|`2`\|`3`), `camera`? | Overwrite an **occupied** slot with the gimbal's current live pose. |
| `obsbot_preset_rename` | `slot` (`1`\|`2`\|`3`), `name`, `camera`? | Rename an **occupied** slot (names over 40 bytes are truncated). |
| `obsbot_preset_delete` | `slot` (`1`\|`2`\|`3`), `camera`? | Delete an **occupied** slot, freeing it for `obsbot_preset_save`. |

### Zoom

Two tools, not one — they ride different transports (standard UVC vs. the vendor command frame)
and produce different physical zoom at the same commanded `ratio`, so merging them would silently
change what `ratio` means. Pick by which behaviour you need.

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_zoom_uvc` | `ratio` (`1.0`–`2.0`), `camera`? | Standard UVC zoom: set an absolute zoom ratio, clamped to `[1.0, 2.0]`. Snaps to the requested target exactly. |
| `obsbot_zoom_vendor` | `ratio` (`1.0`–`2.0`), `speed` (default `0`), `camera`? | Vendor zoom path with adjustable speed: zoom to a ratio at a chosen speed (`0` = device default, `1`–`10` slow→fast, `255` = maximum). **Its ratio scale differs from `obsbot_zoom_uvc`'s** and may not land exactly on the requested target — see [Known limitations](#known-limitations). |

### AI tracking

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_ai_track` | `enabled` (bool), `mode` (default `"normal"`), `camera`? | Enable/disable AI tracking and choose the mode: a human framing (`normal \| upper-body \| close-up \| headless \| lower-body`) or a scene mode (`group \| whiteboard \| desk \| hand`). Polls status and returns `{ verified, matched }` (`matched:false` = no subject tracked yet). |
| `obsbot_ai_track_speed` | `speed`: `"standard" \| "sport"`, `camera`? | Set the tracking-speed preset (Center's Standard/Sport): `standard` (slower follow) or `sport` (snappier). |
| `obsbot_focus_face` | `enabled` (bool), `camera`? | Enable or disable face-priority autofocus. |

### Image & lens

Focus, white balance, and exposure each split into a dedicated `_auto` and `_manual` tool in
v0.4.0 (previously one tool with a mode parameter) — auto and manual take different parameters, so
splitting them lets each schema say exactly what it needs.

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_image_fov` | `fov`: `"wide" \| "medium" \| "narrow"`, `camera`? | Set the field of view: wide (86°), medium (78°), narrow (65°). |
| `obsbot_image_hdr` | `enabled` (bool), `camera`? | Toggle HDR/WDR imaging on or off. |
| `obsbot_focus_auto` | `camera`? | Enable continuous autofocus. |
| `obsbot_focus_manual` | `position` (`0`–`100`, default `50`), `camera`? | Set the focus motor to `position` (near→far). |
| `obsbot_image_exposure_auto` | `priority` (`"global" \| "face"`, optional), `camera`? | Enable auto-exposure; optional `priority` selects global vs face metering. |
| `obsbot_image_exposure_manual` | `level` (`0`–`100`, default `50`), `camera`? | Set exposure `level` (0 darkest → 100 brightest). |
| `obsbot_image_wb_auto` | `camera`? | Enable auto white balance. |
| `obsbot_image_wb_manual` | `temperature` (Kelvin, default `5000`), `camera`? | Set a colour temperature (clamped to device range). |
| `obsbot_image_adjust` | `control`, `level` (`0`–`100`), `camera`? | Adjust `brightness \| contrast \| hue \| saturation \| sharpness \| gain \| backlight-compensation`; `level` maps onto the device range. |

### Capture

**`obsbot_capture_record` and `obsbot_capture_preview` do not take `camera`.** They select a device
by `source` (`device`/`virtual`/`ndi`) through ffmpeg/ffplay, not by serial — there is no
serial-to-ffmpeg-device mapping yet. **`obsbot_capture_snapshot` honors `camera` only for
`source:"device"`**; for `source:"virtual"`/`"ndi"` the pixel source is still resolved by device
name, independent of `camera`.

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_capture_snapshot` | `resolution` (`256`–`1920`, default `640`), `quality` (`1`–`100`, default `80`), `settleMs` (default `600`), `source` (default `"device"`), `camera`? (source:"device" only) | Grab one still frame and return it as an image (for framing/lighting/exposure checks). `resolution` is the longest edge in pixels — larger costs proportionally more tokens. `source`: `device \| virtual \| ndi`. |
| `obsbot_capture_record` | `durationSec` (optional), `audio` (default `true`), `outputPath` (optional), `source` (default `"device"`) | Start recording to MP4. Open-ended recordings auto-stop after 60 min; audio uses the OBSBOT mic; defaults under `Videos/OBSBOT`. Returns a `sessionId`. **Needs ffmpeg.**¹ No `camera`. |
| `obsbot_capture_preview` | `source` (default `"device"`) | Open a live preview window. Returns a `sessionId`. **Needs ffplay.**¹ No `camera`. |
| `obsbot_capture_stop` | `sessionId` | Stop a recording or preview session (recordings are finalized gracefully). No `camera`. |
| `obsbot_capture_list` | — | List active recording/preview sessions. No `camera`. |

### Diagnostics (`--debug` only)

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_debug_probe` | `mode`: `"get" \| "set" \| "query"`, plus `selector`, `length`, `hex`, `opcode`, `payloadHex` | RE/diagnostics only — raw XU byte get/set and framed table queries. Advertised only under `--debug`. No `camera`. |

¹ `record`/`preview` shell out to **ffmpeg**/**ffplay** (install: `winget install Gyan.FFmpeg`
on Windows, `brew install ffmpeg` on macOS, `apt install ffmpeg` on Linux). `snapshot` does **not**
need ffmpeg — it grabs the frame through the native helper.

## Supported platforms

- **Windows x64** — supported today. The native helper is built from source in `native/windows/`
  (CMake + MSVC); the published npm package ships a prebuilt binary so end users need no toolchain.
- **Linux x64** — supported from v0.2. The native helper is in `native/linux/` (CMake + GCC);
  it uses **V4L2** for standard UVC controls (zoom, focus, exposure, pan/tilt, white balance,
  image controls) and `UVCIOC_CTRL_QUERY` for vendor Extension Unit commands (gimbal, AI tracking,
  wake/sleep, HDR, FOV). Snapshots capture a MJPEG or YUYV frame via V4L2 mmap streaming and encode
  to JPEG using **libjpeg**. The `linux-x64` prebuilt binary ships with the published npm package.
  Build dependencies: `build-essential cmake libjpeg-dev libv4l-dev`.
- **macOS 14+ (Apple Silicon and Intel)** — supported. The native helper is in `native/macos/`
  (Objective-C + **IOKit**/**AVFoundation**). It uses IOKit USB control transfers for both standard
  UVC controls and vendor Extension Unit commands, and AVFoundation for enumeration and snapshots.
  Both `darwin-arm64` and `darwin-x64` prebuilt binaries ship with the published npm package
  (`darwin-x64` also covers Apple Silicon running Node under Rosetta, where `process.arch` reports
  `x64`). macOS 14 is the floor because the helper uses `AVCaptureDeviceTypeExternal`; the build
  pins `-mmacosx-version-min` so the binary does not inherit the build machine's OS as its
  minimum.

  Note on macOS specifically: `UVCAssistant` (a DriverKit system extension) owns the camera's UVC
  *interfaces* exclusively, so `USBInterfaceOpen` — and even `USBInterfaceOpenSeize` — fail with
  `kIOReturnExclusiveAccess`. The helper therefore opens the USB *device*, which is not locked, and
  issues UVC control requests on its default control endpoint. This coexists with `UVCAssistant`:
  the camera keeps working as a normal webcam while under control, so no driver-replacement step
  is needed.

### Building the native helper (Linux)

```bash
cd native/linux
mkdir build && cd build
cmake ..
make -j$(nproc)
make install  # copies to native/prebuilt/linux-x64/
```

### Building the native helper (macOS)

```bash
make -C native/macos    # -> native/prebuilt/darwin-arm64/obsbot-helper
```

Requires the Xcode command line tools. CMake works too (`cmake -S native/macos -B
native/macos/build && cmake --build native/macos/build`), which is what CI uses.

## Known limitations

What has actually been exercised against hardware, and what hasn't:

| Platform | Status |
|---|---|
| `win32-x64` | Builds in CI |
| `linux-x64` | Builds in CI |
| `darwin-arm64` | **Hardware-verified** — control, gimbal movement **and per-axis position readback**, zoom, snapshot, USB vid/pid candidacy, serial readback and serial-keyed binding, single-owner IPC coordination, and helper-death recovery, on a real Tiny 2 |
| `darwin-x64` | **Build-verified only** — compiles with the right architecture and deployment target, never executed |

- **The Intel (`darwin-x64`) helper has never been run.** No Intel Mac was available to test it. It
  cross-compiles cleanly and is packaged, but nothing has confirmed it talks to a camera. It also
  covers Apple Silicon running Node under Rosetta, where `process.arch` reports `x64` — likewise
  untested. Reports from Intel users are welcome.
- **macOS 14 or newer is required**, and macOS runtime is verified on **26.5 only**. The helper uses
  `AVCaptureDeviceTypeExternal` (macOS 14+), so the build pins `-mmacosx-version-min=14.0`. The
  binary will *load* on 14 through 25, but behavior there is untested — in particular the UVC
  control path relies on `UVCAssistant` holding the camera's UVC interfaces while leaving the USB
  device itself openable. That is how current macOS behaves; older releases are unconfirmed.
- **The first snapshot on macOS raises a camera permission prompt.** The helper is a plain CLI tool
  with no bundle identifier, so macOS attributes camera access to whichever app spawned it — your
  MCP client — and that app is named in the prompt and holds the grant. Approve once; the grant
  survives helper updates, since it is keyed to the client rather than to the helper's signature.
- **AI tracking overrides manual gimbal moves.** When AI tracking is active (the Tiny 2's default
  on wake), a commanded pan/tilt executes and is then pulled back to the tracked subject —
  `obsbot_gimbal_position` shows the yaw/pitch move out and decay back to rest. This is the camera's
  behaviour, not a bug: turn tracking off for unopposed manual control.
- **The camera may not enumerate through a USB hub or dock.** A Tiny 2 connected through a USB-C
  dock was invisible to `ioreg` and `system_profiler` entirely — not just to this server. If
  `obsbot_devices` comes back empty, try a direct connection before assuming a software fault.
- **Only the OBSBOT Tiny 2 is supported.** On Windows and macOS candidacy is gated on the Remo USB
  vendor ID plus a known-model product ID (`0x3564`/`0xFEF8`), so no other model is detected at
  all — and a name-matching software source, such as the "OBSBOT Virtual Camera" that OBSBOT Center
  registers, is rejected because it reports no vid/pid. Linux still matches by name, because its
  helper does not report vid/pid yet, so a different OBSBOT may be *found* there — but the vendor
  command set is Tiny 2 specific either way. (On macOS the virtual camera cannot appear at all: the
  helper enumerates USB devices through the IORegistry, which a software camera never enters.)
- **One macOS bind failure has been seen once and never reproduced.** On 2026-07-21 a Tiny 2
  entered a state where the vendor reply mailbox (XU selector 2) returned only the host's own
  echoed request frame — magic byte `0xaa` cleared to `0x00`, every other byte identical — for a
  continuous 3.2 s of polling. `readSerial()` therefore threw, `bind()` found no serial, and every
  tool that needs a bound camera failed with "no OBSBOT camera found" while the device was plainly
  healthy: it enumerated with the correct vid/pid, opened, returned XU node 2, and kept serving a
  live status block on selector 6. It has not recurred in roughly fifty subsequent trials, and the
  trigger is unknown. Ruled out: reply latency (polled 3.2 s), the wrong extension unit (the
  VideoControl interface exposes exactly one, `bUnitID 2`), the wrong `wLength` (every XU selector
  is 60 bytes by `GET_LEN`), the reply arriving on another selector (1–19 swept), camera sleep
  state, and contention from OBSBOT Center. If you hit it, the symptom is a mailbox read equal to
  the frame you just sent with byte 0 zeroed; the bind error now names the rejected candidate and
  the reason rather than reporting an absent camera.
- **Two-camera operation is not yet hardware-verified.** The `camera` selector and the
  per-camera device registry are covered by the unit test suite against fake transports; running
  two physical Tiny 2s attached at once has not been confirmed on real hardware (a second unit
  wasn't available). Single-camera use is unaffected either way.
- **`obsbot_zoom_vendor`'s ratio scale doesn't match `obsbot_zoom_uvc`'s at the same `ratio`.** A
  hardware snapshot comparison at `ratio: 2.0` showed the vendor path framed tighter than the UVC
  path. Whether the vendor-side ratio encoding is off by a scale factor, or the two zoom controls
  simply have different physical ranges, isn't determined yet — one comparison isn't enough to
  tell. Tracked separately; use `obsbot_zoom_uvc` if you need the ratio to land exactly.

## No proprietary SDK

This project speaks the camera's USB protocol directly through the OS's standard UVC driver stack and
does **not** use, link, bundle, or ship any vendor SDK. See [`PROTOCOL.md`](./PROTOCOL.md) for the
protocol reference (frame format, checksum, command table).

## How it works

The camera exposes two independent control surfaces, both reachable through the OS's standard UVC
(USB Video Class) driver stack — this project never talks to the USB device directly, so the OS keeps
mediating access and the camera remains usable as a normal webcam at the same time commands are sent:

- **Standard UVC controls** — zoom (`CT_ZOOM_ABSOLUTE`), focus and exposure (`IAMCameraControl`),
  gimbal position readback (UVC Pan/Tilt), and the image controls plus white balance
  (`IAMVideoProcAmp`) — are the camera's built-in UVC properties, driven via DirectShow on Windows.
- **Vendor commands** — gimbal moves, recenter, wake/sleep, AI tracking, HDR, and field of view —
  are sent through the camera's UVC Extension Unit, driven via `IKsControl::KsProperty` against the
  XU's topology node on Windows.

Both are issued through a small native helper process (`obsbot-helper.exe` on Windows, `obsbot-helper`
on Linux) that the Node server spawns and talks to over a line-delimited JSON-RPC protocol on
stdin/stdout. The helper is the only platform-specific piece; the codec (frame encoding, CRC-16/USB
checksum, command table), transport abstraction, device manager, and MCP tool definitions are all pure
TypeScript/JavaScript and shared across platforms.

## Verifying against real hardware

`scripts/e2e.mjs` drives the built stack (`dist/`) against a physically connected camera: it wakes the
device, zooms in, pans the gimbal, recenters, zooms back out, and puts the camera to sleep, with a short
pause and console log before each step so a human can watch it happen. **This moves the physical gimbal —
only run it under supervision:**

```bash
npm run build
node scripts/e2e.mjs
```
