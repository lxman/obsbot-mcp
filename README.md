# obsbot-mcp

A cross-platform [Model Context Protocol](https://modelcontextprotocol.io) server that controls an
**OBSBOT Tiny 2** camera over its standard UVC/USB interface — pan/tilt/roll the gimbal, zoom, and
wake/sleep the device — without any vendor SDK.

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

| Tool | Parameters | Description |
|------|------------|-------------|
| `obsbot_list_devices` | — | List connected OBSBOT-compatible video capture devices. |
| `obsbot_set_run_status` | `state`: `"run" \| "sleep"` | Wake or sleep the camera/gimbal. |
| `obsbot_ptz_move_angle` | `yaw`, `pitch`, `roll` (degrees, `roll` defaults to `0`) | Move the gimbal to an absolute yaw/pitch/roll angle. Yaw is clamped to `[-150, 150]`, pitch to `[-90, 90]`. |
| `obsbot_ptz_move_speed` | `yaw`, `pitch`, `roll` (deg/s, `roll` defaults to `0`), `autoStopMs` (default `800`) | Drive the gimbal at a yaw/pitch/roll speed, then automatically send a stop command after `autoStopMs` so it can't run away. |
| `obsbot_gimbal_recenter` | — | Recenter the gimbal (return to home position). |
| `obsbot_zoom_absolute` | `ratio` (`1.0`–`2.0`) | Set absolute zoom ratio, clamped to `[1.0, 2.0]`. |

## Supported platforms

- **Windows x64** — supported today. The native helper is built from source in `native/windows/`
  (CMake + MSVC); the published npm package ships a prebuilt binary so end users need no toolchain.
- **Linux / macOS** — not yet implemented. The design is platform-agnostic (see [`PROTOCOL.md`](./PROTOCOL.md));
  adding support means writing an equivalent native helper for each OS's UVC control APIs
  (`V4L2` on Linux, `AVFoundation`/`IOKit` on macOS) behind the same JSON-RPC-over-stdio contract used by
  the Windows helper. Contributions welcome.

## No proprietary SDK

This project speaks the camera's USB protocol directly through the OS's standard UVC driver stack and
does **not** use, link, bundle, or ship any vendor SDK. See [`PROTOCOL.md`](./PROTOCOL.md) for the
protocol reference (frame format, checksum, command table).

## How it works

The camera exposes two independent control surfaces, both reachable through the OS's standard UVC
(USB Video Class) driver stack — this project never talks to the USB device directly, so the OS keeps
mediating access and the camera remains usable as a normal webcam at the same time commands are sent:

- **Zoom** is a standard UVC Camera Terminal control (`CT_ZOOM_ABSOLUTE`), driven via
  `IAMCameraControl::put_Zoom` (DirectShow) on Windows.
- **Gimbal moves, recenter, and wake/sleep** are vendor commands sent through the camera's UVC Extension
  Unit, driven via `IKsControl::KsProperty` against the XU's topology node on Windows.

Both are issued through a small native helper process (`obsbot-helper.exe` on Windows) that the Node
server spawns and talks to over a line-delimited JSON-RPC protocol on stdin/stdout. The helper is the
only platform-specific piece; the codec (frame encoding, CRC-16/USB checksum, command table), transport
abstraction, device manager, and MCP tool definitions are all pure TypeScript/JavaScript and shared across
platforms.

## Verifying against real hardware

`scripts/e2e.mjs` drives the built stack (`dist/`) against a physically connected camera: it wakes the
device, zooms in, pans the gimbal, recenters, zooms back out, and puts the camera to sleep, with a short
pause and console log before each step so a human can watch it happen. **This moves the physical gimbal —
only run it under supervision:**

```bash
npm run build
node scripts/e2e.mjs
```
