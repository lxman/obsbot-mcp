---
name: verify
description: Verify obsbot-mcp against a physically connected OBSBOT Tiny 2 — build both halves, drive the helper at its stdio surface, then run the e2e hardware sequence.
---

# Verifying obsbot-mcp

The product is camera control. Tests and typecheck prove nothing here — drive
the real camera.

## Build both halves

The Node stack loads the **prebuilt** helper, not the one next to the source.
Always rebuild both, or you will verify a stale binary (this has burned us):

```bash
npm run build              # TypeScript -> dist/
make -C native/macos       # helper.m -> native/prebuilt/darwin-arm64/obsbot-helper
```

`HelperProcess.resolveBinaryPath()` resolves
`native/prebuilt/<platform>-<arch>/obsbot-helper`.

## Is the camera actually there?

Check before blaming the code:

```bash
system_profiler SPCameraDataType                       # should list OBSBOT Tiny 2
ioreg -r -c IOUSBHostDevice -w0 | grep '"USB Product Name"'
```

**Gotcha:** the Tiny 2 does *not* enumerate through a USB-C dock — it vanishes
from `ioreg` entirely. Plug it directly into a built-in port. A Mac Studio has
no built-in camera, so an empty `SPCameraDataType` means "nothing attached",
not "broken code".

## Drive the helper directly (fastest signal, no movement)

Ops share session state, so send them down one stdin in a single process:

```bash
H=./native/prebuilt/darwin-arm64/obsbot-helper
echo '{"op":"enumerate"}' | $H
# -> {"ok":true,"devices":[{"path":"0x...","name":"OBSBOT Tiny 2"}]}

printf '{"op":"open","path":"<path-from-enumerate>"}\n{"op":"zoom_range"}\n{"op":"xu_get","selector":"6","length":"60"}\n' | $H
# -> {"ok":true,"xuNode":2}
# -> {"ok":true,"min":0,"max":100}
# -> {"ok":true,"hex":"2501...."}   60-byte status block
```

These are read-only — no gimbal motion, no capture. If `xu_get` on selector 6
returns 60 bytes, the vendor control path is healthy.

## Full hardware sequence (MOVES THE GIMBAL)

```bash
node scripts/e2e.mjs
```

Wakes, zooms 2x, pans 30° yaw, recenters, zooms out, sleeps. **Requires a human
watching** — `EXIT=0` only proves the camera ACKed each transfer over USB, not
that the motor turned. A camera will happily ACK and sit still. Always ask the
supervisor what they physically saw; that confirmation *is* the verification.

## macOS architecture gotcha (hard-won)

`UVCAssistant.systemextension` (a DriverKit dext) owns the camera's UVC
interfaces. `USBInterfaceOpen` **and** `USBInterfaceOpenSeize` on the
VideoControl interface both fail with `kIOReturnExclusiveAccess` (`0xe00002c5`)
— userspace IOUSBLib cannot take an interface a dext owns. Do not go down that
road again.

The **device** is not locked: `USBDeviceOpen` succeeds, and UVC control requests
ride the default control endpoint via `DeviceRequest`. This coexists with
UVCAssistant — the camera keeps streaming as a normal webcam while we control
it. No Zadig-style tradeoff on macOS.

`wIndex` is `(entityID << 8) | bInterfaceNumber` (VideoControl interface, 0 on
the Tiny 2). Entity in the HIGH byte. Getting this wrong silently addresses the
wrong recipient rather than erroring.

XU entity is **2**; status selector `0x06` returns 60 bytes.

## Known rough edge

`scripts/e2e.mjs` hangs and leaks the helper on the **no-camera** path: the
`try/finally` only wraps the success path, so the early `return` never calls
`helper.close()` and the child keeps Node's event loop alive. If e2e hangs with
"No OBSBOT Tiny 2 found", that's this bug, not a new one. `pkill -f obsbot-helper`
to clean up orphans.
