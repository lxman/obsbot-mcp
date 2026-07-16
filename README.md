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
expose the diagnostics surface — the `obsbot_probe` tool (raw XU byte get/set/query) and the
`raw` 60-byte status block on `obsbot_get_status`:

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

### Device & power

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_list_devices` | — | List connected OBSBOT-compatible video capture devices. |
| `obsbot_set_run_status` | `state`: `"run" \| "sleep"` | Wake (`"run"`) or sleep the camera/gimbal. |
| `obsbot_get_status` | — | Read the live status block: `{ awake, hdr, aiMode, trackSpeed }`. Under `--debug`, also returns the raw 60-byte block as hex. |

### Gimbal (PTZ)

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_ptz_move_angle` | `yaw`, `pitch`, `roll` (degrees, `roll` defaults `0`) | Move the gimbal to an absolute angle. Positive yaw pans to the camera's left, positive pitch tilts down. Yaw clamped to `[-150, 150]`, pitch to `[-90, 90]`. Absolute 1:1 degrees, hardware-verified. |
| `obsbot_ptz_move_speed` | `yaw`, `pitch`, `roll` (deg/s, `roll` defaults `0`), `autoStopMs` (default `800`) | Drive the gimbal at a speed, then auto-stop after `autoStopMs` so it can't run away. Same yaw/pitch sign convention as `move_angle`. |
| `obsbot_gimbal_recenter` | — | Recenter the gimbal (return to home position). |
| `obsbot_gimbal_position` | — | Read the gimbal's current absolute `{ yaw, pitch }` in degrees via standard UVC Pan/Tilt. May lag a move still in progress. |

### Zoom

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_zoom_absolute` | `ratio` (`1.0`–`2.0`) | Set absolute zoom ratio, clamped to `[1.0, 2.0]`. |
| `obsbot_zoom_speed` | `ratio` (`1.0`–`2.0`), `speed` (default `0`) | Zoom to a ratio at a chosen speed: `0` = device default, `1`–`10` slow→fast, `255` = maximum. |

### AI tracking

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_ai_tracking` | `enabled` (bool), `mode` (default `"normal"`) | Enable/disable AI subject tracking and choose framing: `normal \| upper-body \| close-up \| headless \| lower-body`. Polls status and returns `{ verified, matched }` (`matched:false` = no subject tracked yet). |
| `obsbot_ai_track_speed` | `speed`: `"standard" \| "sport"` | Set the tracking-speed preset (Center's Standard/Sport): `standard` (slower follow) or `sport` (snappier). |
| `obsbot_face_focus` | `enabled` (bool) | Enable or disable face-priority autofocus. |

### Image & lens

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_fov` | `fov`: `"wide" \| "medium" \| "narrow"` | Set the field of view: wide (86°), medium (78°), narrow (65°). |
| `obsbot_hdr` | `enabled` (bool) | Toggle HDR/WDR imaging on or off. |
| `obsbot_focus` | `mode`: `"auto" \| "manual"`, `position` (`0`–`100`, default `50`) | `auto` = continuous autofocus; `manual` = set the focus motor to `position` (near→far). |
| `obsbot_exposure` | `mode`: `"auto" \| "manual"`, `level` (`0`–`100`, default `50`) | `auto` = auto-exposure; `manual` = set `level` (0 darkest → 100 brightest). |
| `obsbot_white_balance` | `mode`: `"auto" \| "manual"`, `temperature` (Kelvin, default `5000`) | `auto` = auto white balance; `manual` = set a colour temperature (clamped to device range). |
| `obsbot_image_control` | `control`, `level` (`0`–`100`) | Adjust `brightness \| contrast \| hue \| saturation \| sharpness \| gain \| backlight-compensation`; `level` maps onto the device range. |

### Capture

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_snapshot` | `maxDim` (`256`–`1920`, default `1024`), `quality` (`1`–`100`, default `80`), `settleMs` (default `600`), `source` (default `"device"`) | Grab one still frame and return it as an image (for framing/lighting/exposure checks). `source`: `device \| virtual \| ndi`. |
| `obsbot_record_start` | `durationSec` (optional), `audio` (default `true`), `outputPath` (optional), `source` (default `"device"`) | Start recording to MP4. Open-ended recordings auto-stop after 60 min; audio uses the OBSBOT mic; defaults under `Videos/OBSBOT`. Returns a `sessionId`. **Needs ffmpeg.**¹ |
| `obsbot_preview_start` | `source` (default `"device"`) | Open a live preview window. Returns a `sessionId`. **Needs ffplay.**¹ |
| `obsbot_capture_stop` | `sessionId` | Stop a recording or preview session (recordings are finalized gracefully). |
| `obsbot_capture_list` | — | List active recording/preview sessions. |

### Diagnostics (`--debug` only)

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_probe` | `mode`: `"get" \| "set" \| "query"`, plus `selector`, `length`, `hex`, `opcode`, `payloadHex` | RE/diagnostics only — raw XU byte get/set and framed table queries. Advertised only under `--debug`. |

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
