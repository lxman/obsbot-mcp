# Changelog

## [0.7.0] — 2026-08-28

### Added: Linux detects a live-reading kernel and closes the loop on gimbal moves

Pan/tilt reads on Linux mean two different things depending on the kernel. Stock uvcvideo
serves this camera's `CT_PANTILT_ABSOLUTE` from its cache (the firmware's `GET_INFO` stub
strips the `AUTO_UPDATE` flag), so a read returns the last *commanded* pose. With the uvcvideo
fix now under review on linux-media — a flags fixup for 3564:fef8, sent as
`[PATCH 0/3] media: uvcvideo: live pan/tilt position on the OBSBOT Tiny 2` — the same read
returns the *live* position, mid-slew or after the gimbal is moved by hand.

Two things quietly depended on the cached meaning, and now behave correctly on both kernels:

- **Pose composition settles first.** `obsbot_aim_at_pixel` and preset save/update compose a
  new absolute target from the current pose. Read mid-slew, that target was short by the travel
  remaining (five reads after a 90° pan returned 0, 18, 37, 60, 79°). They now wait for two reads
  a beat apart to agree within one degree before composing.
- **Moves are closed-loop.** The firmware occasionally sends one axis to a *previously*
  commanded pose instead of the one just sent. On a stock kernel this is invisible; with live
  reads it is detectable, so a Linux move now settles, compares against the target within one
  step, and re-sends once.

Both turn on automatically when reads are live. Detection is by **read latency**, measured in
the native helper (new `read_latency` op): a cached read is a ~2µs memcpy, a live one is a
~150µs+ USB `GET_CUR`, a ~70× gap with no overlap. That detects the property itself rather
than a kernel version, so it works for the fixup, for stable/distro backports of it, and for
any future kernel that reads live. `OBSBOT_LIVE_POSE` is tri-state: `1` forces on, `0` forces
off, unset auto-detects. macOS and Windows honour only the override and default off. An older
helper without the op degrades to off, never throws.

`obsbot_gimbal_position` itself is unchanged — it is a report, and already promises a value
valid during a move.

### Changed: hardware verification

`gimbal.move.absolute` now records where the gimbal actually was when a move times out, and
`ai.tracking.enable` is re-tiered MANUAL: whether tracking engages depends on whether someone is
in frame, which an automated check cannot control.


### Added: OBSBOT Tail 2 support (network cameras)

The server now also controls the **OBSBOT Tail 2** — the network PTZ camera — alongside the Tiny 2.
These tools use the Tail 2's network control plane, an HTTP REST API plus a WebSocket status push,
reverse-engineered from the camera's own web application and documented in
[`TAIL2-PROTOCOL.md`](./TAIL2-PROTOCOL.md). Sixteen `obsbot_tail2_*` tools cover discovery
(`devices`, `scan`, `status`, `info`), zoom (on the camera's own **1.0–12.0** ratio scale — six
times the Tiny 2's range), gimbal recenter, AI tracking (the camera's own mode enum, including
object tracking), tracking speed (`superLazy…crazy`, not the Tiny 2's standard/sport), **motorized
90° portrait rotation** and **roll bias** (neither exists on the Tiny 2), the full preset
family (`list`/`save`/`recall`/`delete`/`rename`, slots renumbered 1–3 to match the Tiny 2's
tools), and **snapshot** — a live still frame via the camera's SRT output (ffmpeg SRT caller),
hardware-verified end to end including a returned image. Snapshot requires SRT listener mode
enabled in OBSBOT Center (exclusive with NDI, cleared by reboots; Center only allows changing
streaming settings while the output is off, so a probe failing mid-configuration just means
re-enable and retry — it serves immediately once on. On this firmware the RTSP output's enable
flag never actually serves, measured, so SRT is the one working network output alongside NDI). The preset grammar — `{"operation":"set"|"call"|"delete"|"rename", "id", "name":base64}`
on a single endpoint — was decoded from the web UI's `PresetControl` component after blind
shape-probing failed, and every operation is hardware-verified, including recall arrival via the
zoom readback. Two Tail 2 semantic differences the tools encode: `save` **overwrites** occupied
slots (no create-once), and there is **no pose-by-value write** in the API at all — a slot always
captures the live pose, so absolute positioning is aim-then-save-then-recall.

Because the transport is HTTP/WS, the entire module is pure TypeScript — no native helper, no
per-platform builds, and Windows/Linux/macOS behave identically by construction. Cameras are
identified by MAC (as OBSBOT Center identifies them), discovered either by the `obsbot_tail2_scan`
subnet sweep (the same probe Center uses), the `OBSBOT_TAIL2_HOSTS` environment variable, or by
passing a camera's IP as the `camera` parameter on first use.

Two hardware behaviors shaped the client and are baked into every write:

- **`{"code":200}` means acknowledged, not applied.** Measured on a live unit: a roll-bias write
  returned success while the portrait motor was in motion and never landed. Every setter therefore
  verifies by readback on a ladder sized for its actuator and reports `settled` — mirroring
  `obsbot_zoom_uvc`'s contract rather than pretending acknowledgement is truth.
- **A tool call can kill the process if WebSocket teardown races the camera's 1 Hz status push.**
  The first live smoke crashed the server: stripping event listeners at settle left an unhandled
  `'error'` when a teardown frame arrived after the one-shot status read had finished. The socket
  is now terminated outright on success and stray events are no-ops; a rapid-read regression test
  and the `scripts/e2e-tail2.mjs` teardown-race step pin it.

Verified on live hardware (firmware 7.2.13.1) via `node scripts/e2e-tail2.mjs` (which, unlike the
Tiny 2 e2e, does not move the camera — its write step is a true no-op: the camera's own reported
zoom, written straight back) and `node scripts/e2e-tail2-presets.mjs` (save/recall/rename/delete
round trip on the empty slot, factory preset untouched).

Still open for the Tail 2 (see TAIL2-PROTOCOL.md §9): image-control writes, and the Remo
file-transfer channel (UDP 9999 protobuf) — the session handshake is fully takeable (proven by
replay), but file-content delivery never appears in any Center capture and forged file ops are
dropped; PARKED. The camera's HTTP API is also unauthenticated: treat a Tail 2 on a shared LAN
as world-writable.