# Changelog

## [Unreleased]

### Fixed

- Mid-session device-loss recovery now works on **Windows**. `DEVICE_LOST_SIGNATURES` had entries
  for macOS and Linux but none for Windows, because the DirectShow removal code had never been
  observed — so a camera unplugged mid-session stranded the binding until the server restarted,
  exactly as it had on macOS before that platform was fixed. Measured on hardware (Tiny 2, cable
  pull with the device held open): the code is `0x800701b1` = `HRESULT_FROM_WIN32(433)`
  `ERROR_DEV_NOT_EXIST`, and **both** DirectShow surfaces — the KS/XU vendor property path and
  `IAMCameraControl` — report it identically, so one pattern covers both. None of the plausible
  guesses (`0x8007001F`, `0x800705B4`, `0x8007048F`, `VFW_E_NOT_CONNECTED`) was correct, which is
  why this was observed rather than inferred.

  Verified end to end across a same-port replug: the device-lost error is detected, the stale
  binding is pruned and re-scanned within ~500 ms, and the camera re-binds automatically once it
  returns — no restart, no manual `invalidate()`.

- `obsbot_ai_track` no longer reports `verified:"hand", matched:false` on framing writes that
  actually succeeded. `AI_MODE_TABLE` mapped the status tuple `"6,0"` to `hand` (a defensive
  mapping taken from the Tiny4Linux reference), but on this firmware `m=6` is the transient the
  device parks at mid-switch — `hand` is `m=3`. Because `verifyFraming()` treats anything other
  than `unknown` as a settled landing, decoding the transient as a real framing ended the poll
  early and reported a false negative. Confirmed on hardware by polling XU selector 6 at 60 ms
  across a `normal -> upper-body` switch: `m=2,n=0` (before) -> `m=6,n=0` (~200 ms transient) ->
  `m=2,n=1` (landed). The transient is ~200 ms wide and the poll interval is 200 ms, so whether it
  was sampled was a coin flip — hence the intermittency. Verified over 10 real framing switches on
  one camera: the old decode gave 7/10 with 3 false negatives, the fix gives 10/10.

- The MCP server handshake and all three native helpers reported version `0.1.0` while the package
  was at `0.4.0`. All four now report the real version.

- A helper process that died or wedged hung the server indefinitely instead of failing. `rpcRaw()`
  built a resolve-only promise and `HelperProcess` registered no `exit`/`error` handler, so a
  request sent to a dead helper could never settle — the tool call simply never returned, with no
  error and no timeout. Requests now reject when the child dies, and a per-request timeout (10s
  default; 30s plus the caller's `settleMs` for `snapshot`) covers the other shape, a helper that
  stays alive but stops answering — the likelier form of a driver-level fault, which no death
  handler can catch. On timeout the queue slot is kept as a tombstone, since responses correlate by
  position and dropping it would desync every later call.

  This also restores automatic recovery. `ensureReady()` already self-heals on a thrown error
  (`invalidate()` → re-bind → fresh helper), so a hang was silently disabling the respawn path that
  already existed. Verified on hardware: killing the helper mid-session now recovers in ~800 ms with
  `reconnected: true`. Recovery stays bounded — `ensureReady` self-heals exactly once per call, so a
  permanently broken helper costs one spawn attempt per call (measured: ~60 ms, always
  `reason: "unreachable"`) rather than looping.

- `DeviceManager` no longer hands out a cached scan helper whose process has died. `invalidate()`
  drops only registry entries, so a helper that died mid-scan — before `promote()` moved it into the
  registry — stayed cached and every later scan talked to a dead process.

- Every tool now recovers from a helper death, not just the eleven that route through the readiness
  gate. `DeviceManager.get()` drops a bound entry whose helper has died so the next resolve re-binds.
  Previously only `ensureReady()` called `invalidate()`, so the other ~19 call sites (`obsbot_status`,
  `obsbot_gimbal_position`, …) returned the same dead transport indefinitely and recovery depended on
  the caller happening to invoke a *different* tool. Since the caller is an LLM, that hidden
  dependency meant a weaker model would retry the failing tool or report broken hardware that was
  actually fine. A death between calls is now invisible; a death mid-request costs one error, and the
  next call succeeds. Live bindings are untouched, so there is no per-call spawn churn.

- Transport error messages are written for the model that reads them: they state what happened and
  what to do next ("the connection resets automatically — retry this call") instead of surfacing bare
  internals like `helper process exited (code 1, signal none)`.

- A camera that enumerates and opens but cannot be identified no longer reports as no camera at all.
  `DeviceManager.bind()` and `listCameras()` discarded every candidate failure in a bare
  `catch { continue }`, so a device whose `readSerial()` failed produced the same
  `no OBSBOT camera found` a caller gets with nothing plugged in, plus a `status: "busy"` entry with
  no indication of which of two very different causes applied — another process holding the device,
  or the vendor mailbox going quiet. Rejection reasons now aggregate into the thrown error
  (`no OBSBOT camera found — 1 candidate(s) rejected: <path>: readSerial: no valid UG_GET_SN reply`)
  and into an optional `reason` on each `busy` entry from `obsbot_devices`. The genuinely-empty case
  still throws the bare message, pinned by a test. Found while debugging exactly this situation on
  macOS hardware, where recovering the reason the code already had and threw away cost most of a
  session.

- `obsbot_debug_probe`'s `mode: "query"` polled the vendor reply mailbox with no delay between
  attempts — the same defect `read-serial.ts` was fixed for earlier, never backported. All eight
  attempts complete in roughly 1–2 ms, so for any command the device does not answer almost
  immediately the loop finishes inside the reply gap and reports `no valid reply` for a command
  that was in fact answered correctly. The impact is opcode-dependent, which is why it went
  unnoticed: cached state such as `AI_GET_QUICK_STATUS` came back fast enough that even the
  un-delayed loop caught it (3 of 3 attempts), while anything reading persistent storage is slower.
  Measured on `darwin-arm64` hardware over 25 trials of `UG_GET_SN`: 24 failures (96%) without the
  delay, 0 with it. The loop now waits 30 ms before each read, matching `read-serial.ts`.

- The camera binding now survives an unplug/replug. Recovery keyed exclusively on helper *process*
  death, but an unplug kills only the USB handle — the helper stays alive and healthy — so the
  stale registry entry was never dropped and every later call failed indefinitely; `pkill
  obsbot-helper` was the only way out. `HelperProcess` now flags `deviceLost` from `rpc()`, the one
  choke point every device op crosses (which also covers tools that swallow failures into
  `{ ok: false }` rather than throwing), and the existing prune-and-rebind path does the rest. The
  signature list is deliberately narrow — darwin `kIOReturnNoDevice`, linux `ENODEV` — with a test
  pinning that an ordinary error does NOT condemn a healthy binding; Windows is absent because its
  device-removal code has not been observed and a wrong guess would drop working cameras. Two
  further defects surfaced only on hardware: pruning had to *close* the helper rather than merely
  forget it (dropping the reference alone leaked the process, which kept holding the device so the
  replacement could never open it), and a failed bind has to discard the scratch helper, because
  the macOS helper derives `path` from AVFoundation — whose view lags the USB bus and, in a
  long-lived process, did not refresh at all, leaving a helper spawned while the camera was absent
  reporting it with vid/pid but an empty path for over two minutes. Verified on hardware across
  three unplug/replug cycles: recovery is unaided in ~15s, same serial, control confirmed working
  afterwards, no leaked helpers.

- `obsbot_devices` no longer reports an unplugged camera as `status: "bound"` with a serial.
  `listCameras()` reads registry entries without re-opening them, so a stale entry was
  indistinguishable from a healthy camera — a caller reads that as "present and ready" when the
  camera is not attached at all.

- White balance no longer ignores the temperature you ask for on macOS. Every Processing Unit
  transfer was issued at 4 bytes while the Tiny 2 declares these controls as 2 (`GET_LEN`), and the
  surplus bytes returned uninitialised junk in the high half that *varied between calls* — `0x0200`,
  `0x0001` and `0x00010000` all observed — so every `GET_MIN`/`GET_MAX` carried a large, unstable
  offset. `obsbot_image_wb_manual` clamps an absolute Kelvin value against that range, so any sane
  temperature fell below the corrupted minimum and pinned to it: 5600K requested, 2000K delivered.
  `obsbot_image_adjust` survived only by luck — it maps a 0–100 percentage onto `[min,max]`, so a
  constant offset cancels in the low bytes the device actually reads, leaving just a visibly wrong
  `value` (33554482 for "brightness 50"). Both now size their transfers from `GET_LEN`, which
  doubles as a support check: `gain` and `backlight-compensation` report length 0 on this device and
  are refused instead of returning success for a write that does nothing.

- `obsbot_gimbal_move_speed` documents its unit and bounds its input. It was the only tool that made
  the caller reverse-engineer the scale — every other tool takes a human unit and converts
  internally, but this one passed yaw/pitch straight to the firmware with no clamp and a description
  that never said speed in *what*. Measured against the live position readback, it is degrees per
  second and linear across the band. Past the limit the firmware does not saturate, it silently
  ignores the command: 180, 200 and 300 each produced exactly 0° of motion while still returning
  `ok: true`. Requests are now clamped to ±150 °/s (150/160/170 all verified to drive the gimbal;
  the true cutoff lies in 170–180) and the result echoes the speeds actually used.

### Internal

- Added `test/mcp/framing-seam.test.ts`, which drives raw 60-byte status blocks through the real
  `decodeStatus` into the real `verifyFraming`. Both existing suites stayed green through the
  framing regression above because neither crossed that seam: the codec tests asserted the
  tuple-to-label mapping while the framing tests hand-fed the literal string `"unknown"` as the
  transient. Each half was self-consistent; only the join was wrong.

- Added `test/version-sync.test.ts`, which fails if the version declared in `src/mcp/server.ts` or
  any of the three native helpers drifts from `package.json`. The helpers compile separately and
  `src/` cannot import `package.json` (`rootDir: "src"`), so the string has to be duplicated — this
  makes the duplication safe rather than silent.

- The `obsbot_debug_probe` tests now model the device's *latency*, not just its wire protocol. Every
  existing probe test used a fake that answers instantly, which is precisely why none of them caught
  the missing poll delay above; a fake that replies only after a set interval fails against the old
  loop and passes against the new one. A companion test pins that a device which never answers still
  gives up rather than hanging, so the delay cannot turn a real timeout into a stall.

- Added `scripts/procamp-check.mjs`, a non-destructive hardware check for the image-adjust /
  white-balance path, alongside `e2e.mjs` and `ipc-hw-smoke.mjs`. Control ranges are the sharpest
  signal and need no readback path: a mis-sized transfer shows up immediately as an absurd min/max.
  It was verified to FAIL 8/8 against the pre-fix helper and pass after, so it genuinely guards the
  regression rather than merely passing — the vitest suite cannot reach native code, which is why
  this guard lives in a script.

- `darwin-arm64` is now hardware-verified for USB vid/pid candidacy, serial readback and the
  serial-keyed bind path, single-owner IPC coordination over the Unix socket, and transparent
  helper-death recovery — none of which had been executed on a Mac before. The IORegistry vid/pid
  emission in `native/macos/helper.m` had been written on Windows and never compiled on macOS; it
  proved correct as written. See the README's platform table for the current state.

## [0.4.0] — 2026-07-20

### BREAKING: every tool renamed, no aliases

The entire tool surface was renamed for internal consistency (one gimbal name instead of two,
domain-first naming, a closed bare-verb list for whole-device ops) and reorganized into eight
subsystem domains (`device`, `gimbal`, `zoom`, `focus`, `image`, `ai`, `preset`, `capture`) plus a
hidden `debug` domain. **There is no backward-compatible alias for any old name — every caller must
update.** This was a deliberate one-time break: aliases would have doubled the tool count the model
sees, working against the disambiguation problem the rename exists to fix.

Four tools that mixed two distinct operating modes under one schema were also split into a pair
each, so each new tool's parameters describe only the mode it actually needs. Net effect: the
30-tool surface becomes 34 tools.

#### Old → new name mapping

Every old name below is gone; only tools listed as a rename or split target exist now. Any old
tool not listed here kept its name unchanged (see below the table).

| Old tool | New tool(s) |
|---|---|
| `obsbot_list_devices` | `obsbot_devices` |
| `obsbot_set_run_status` | `obsbot_wake` **+** `obsbot_sleep` (split: state transition) |
| `obsbot_ptz_move_angle` | `obsbot_gimbal_move` |
| `obsbot_ptz_move_speed` | `obsbot_gimbal_move_speed` |
| `obsbot_zoom_absolute` | `obsbot_zoom_uvc` |
| `obsbot_zoom_speed` | `obsbot_zoom_vendor` |
| `obsbot_focus` | `obsbot_focus_auto` **+** `obsbot_focus_manual` (split: divergent params) |
| `obsbot_face_focus` | `obsbot_focus_face` |
| `obsbot_ai_tracking` | `obsbot_ai_track` |
| `obsbot_fov` | `obsbot_image_fov` |
| `obsbot_hdr` | `obsbot_image_hdr` |
| `obsbot_white_balance` | `obsbot_image_wb_auto` **+** `obsbot_image_wb_manual` (split) |
| `obsbot_exposure` | `obsbot_image_exposure_auto` **+** `obsbot_image_exposure_manual` (split) |
| `obsbot_image_control` | `obsbot_image_adjust` |
| `obsbot_get_status` | `obsbot_status` |
| `obsbot_snapshot` | `obsbot_capture_snapshot` |
| `obsbot_record_start` | `obsbot_capture_record` |
| `obsbot_preview_start` | `obsbot_capture_preview` |
| `obsbot_probe` | `obsbot_debug_probe` (debug-gated; see below) |

**Unchanged names** (already fit the new scheme, kept as-is): `obsbot_gimbal_recenter`,
`obsbot_gimbal_position`, `obsbot_ai_track_speed`, `obsbot_preset_list`, `obsbot_preset_save`,
`obsbot_preset_recall`, `obsbot_preset_update`, `obsbot_preset_rename`, `obsbot_preset_delete`,
`obsbot_capture_stop`, `obsbot_capture_list`.

`obsbot_debug_probe` (renamed from `obsbot_probe`) is still advertised only under `--debug` — it
was never part of the default tool surface and stays that way in v0.4.0.

### Added: multi-camera support

The server can now bind and drive more than one attached camera in the same process (previously it
opened whichever camera it found first and offered no way to pick another).

- Every camera-addressing tool gained an optional `camera` parameter — the target camera's serial
  number. Omit it with a single camera attached and behavior is unchanged from pre-0.4.0. With
  several attached, a call that omits `camera` fails with an error naming every attached serial.
  Exempt: `obsbot_devices`, `obsbot_capture_stop`, `obsbot_capture_list`, `obsbot_debug_probe`.
  `obsbot_capture_record` and `obsbot_capture_preview` also don't take it — they select a device by
  `source`, not by serial. `obsbot_capture_snapshot` honors it only for `source:"device"`.
- Camera identity is the device's serial (read via `UG_GET_SN`), not USB topology — a remembered
  serial finds its camera after a replug or a port change.
- One native helper process is spawned per bound camera, lazily on first use, so a multi-camera
  setup doesn't pay the cost of a camera nobody addressed yet.
- **Not yet hardware-verified with two cameras.** This path is covered by the unit test suite
  against fake transports; running two physical Tiny 2s at once hasn't been confirmed on real
  hardware (a second unit wasn't available for this branch). Single-camera behavior is unaffected
  either way.

### Fixed

- `obsbot_debug_probe`'s `query` mode now frames a bare GET with the header-only flavor
  (`flags 0x01`) the device actually answers; previously a payload-less query used the SET framing
  (`flags 0x25`) and could return a stale echo instead of a real reply. The reply is now also
  validated against the sent command/sequence before being trusted, guarding against the reply
  mailbox's previous-value-until-overwritten behavior.
