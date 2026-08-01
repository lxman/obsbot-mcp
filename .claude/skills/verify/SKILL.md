---
name: verify
description: Verify obsbot-mcp against a physically connected OBSBOT Tiny 2 — build both halves, drive the helper at its stdio surface, then run the e2e hardware sequence.
---

# Verifying obsbot-mcp

The product is camera control. Tests and typecheck prove nothing here — drive
the real camera.

**This skill covers macOS and Linux.** Steps that differ are marked; where only
one is given, it applies to both. Read the section for your platform — running
the macOS commands on Linux is a waste of a turn.

## Build both halves

The Node stack loads the **prebuilt** helper, not the one next to the source.
Always rebuild both, or you will verify a stale binary. This has burned us
repeatedly, most recently with a helper 11 days out of date — the failure is
silent, because a stale binary answers every op correctly and merely lacks
whatever you just added, so hardware checks pass against code you did not
write:

```bash
npm run build:all          # TypeScript -> dist/, AND helper -> native/prebuilt/
```

`build:all` is `build` + `build:helper`; `build:helper` (scripts/build-helper.mjs)
configures CMake for the current platform, builds, and stages the binary into
`native/prebuilt/<platform>-<arch>/`. Use it rather than invoking CMake by
hand — `HelperProcess.resolveBinaryPath()` reads only the staged copy, so a
raw `cmake --build` leaves the old binary in place.

Confirm the staged binary really is the one you just built before trusting any
result:

```bash
ls -la native/prebuilt/*/obsbot-helper          # timestamp should be seconds old
strings native/prebuilt/*/obsbot-helper | grep <a-string-you-just-added>
```

## Is the camera actually there?

Check before blaming the code.

**macOS:**

```bash
system_profiler SPCameraDataType                       # should list OBSBOT Tiny 2
ioreg -r -c IOUSBHostDevice -w0 | grep '"USB Product Name"'
```

**Linux:**

```bash
lsusb | grep -i obsbot         # -> ID 3564:fef8 ... OBSBOT Tiny 2
v4l2-ctl --list-devices        # -> /dev/videoN pair for the Tiny 2
uname -r                       # which kernel? see "Linux kernel note" below
```

The Tiny 2 exposes two video nodes; the **lower-numbered** one carries the
Extension Unit. `enumerate` lists both, and opening the wrong one gives
"no XU extension unit found" on stderr before the helper retries.

**Gotcha (macOS):** the Tiny 2 does *not* enumerate through a USB-C dock — it
vanishes from `ioreg` entirely. Plug it directly into a built-in port. A Mac
Studio has no built-in camera, so an empty `SPCameraDataType` means "nothing
attached", not "broken code".

## Drive the helper directly (fastest signal, no movement)

Ops share session state, so send them down one stdin in a single process:

```bash
H=./native/prebuilt/darwin-arm64/obsbot-helper    # macOS
H=./native/prebuilt/linux-x64/obsbot-helper       # Linux

echo '{"op":"enumerate"}' | $H
# macOS -> {"ok":true,"devices":[{"path":"0x...","name":"OBSBOT Tiny 2"}]}
# Linux -> {"ok":true,"devices":[{"path":"/dev/videoN","name":"OBSBOT Tiny 2: ..."}]}

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

Wakes, zooms 2x, pans 30° yaw with vendor frames, recenters, runs two-axis
moves through `gimbalSet`/`gimbalRecenter`, zooms out, sleeps.

**Requires a human watching** — `EXIT=0` only proves the camera ACKed each
transfer over USB, not that the motor turned. A camera will happily ACK and sit
still. Always ask the supervisor what they physically saw; that confirmation
*is* the verification.

Ask about **both axes** specifically. The failure mode that motivated the
two-axis steps is asymmetric: the gimbal swings horizontally while the tilt
stays put, which looks like a working move unless someone is watching for it.
The pose lines the script prints after each transport move are for the
supervisor to compare against — they are not assertions, because on most
kernels that readback is the driver echoing what we wrote.

## Linux kernel note

Pan/tilt readback means different things on different kernels, and it changes
what a passing check proves:

- **Stock kernel:** `camCtrlGet` returns the last value *written*, not the live
  position. It cannot distinguish a gimbal that moved from one that did not, so
  the human's observation is the only evidence.
- **Kernel with the uvcvideo volatile-position patch** (`uname -r` = a locally
  built kernel; see `UVCVIDEO-LINUX-POSITION-2026-07-21.md`): readback is a
  genuine live position, and comparing it against the commanded target is real
  evidence.

**Do not reload uvcvideo while the camera is asleep.** Asleep it does not
answer GET_INFO, so pan/tilt keep a stale `AUTO_UPDATE` flag and the second of
two single-axis writes cancels the first. Wake the camera first. Symptom: one
axis of a two-axis move silently does nothing.

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

## Exercising the no-camera path

`scripts/e2e.mjs` used to hang and leak the helper when no camera was found —
its `try/finally` did not cover the early `return`. **Fixed:** the `try` now
wraps device selection, so the path closes the helper and exits 1 cleanly.
Re-verified 2026-08-01.

You can exercise it without unplugging anything:

```bash
OBSBOT_HELPER_CMD="node test/device/fake-helper-no-obsbot.mjs" node scripts/e2e.mjs
# -> "No OBSBOT Tiny 2 found. Is it plugged in?", then "→ closing helper...", exit 1
```

If e2e ever *does* hang, check for orphans with `pgrep -af obsbot-helper` and
clear them with `pkill -f obsbot-helper` — but treat it as a new bug rather
than this old one.
