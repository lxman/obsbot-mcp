# Bus notifications: proactive camera arrival/removal — design

**Date:** 2026-07-21
**Status:** implemented and hardware-verified on macOS (see Result below).
Linux and Windows still learn about changes only by failing.

## Goal

The server currently learns that the camera changed only by *failing*. A tool call
returns `0xe00002c0`, that marks the binding dead, and a later call re-binds. Two
user-visible consequences:

1. The first call after a replug always fails (2 calls same-port, 3 across ports).
2. `obsbot_devices` reports a phantom `status:"bound"` entry with a serial for a
   camera that is physically unplugged, until something else fails first. The prune
   is reactive, and `listCameras()` deliberately does not re-open bound entries.

Make the helper *notice* instead: run a run loop, observe AVFoundation device
arrival/removal, and push events to the Node side so `DeviceManager` reacts before
anyone calls a tool.

## Measurements this design rests on

All from hardware probes on macOS 26.5 (2026-07-21), not from reasoning:

- **IOKit fires ~96 ms before AVFoundation.** At the instant
  `kIOMatchedNotification` fires, a discovery session cannot see the camera; 96 ms
  later `AVCaptureDeviceWasConnectedNotification` arrives and
  `deviceWithUniqueID` resolves immediately. That 96 ms gap *is* the
  `open: missing path` window. **AVFoundation is therefore the correct signal** —
  IOKit alone would wake us straight into the failure.
- **Removal fires on both within 3 ms.** Either would do; AVFoundation is used for
  symmetry.
- **A secondary-thread run loop does NOT work.** With observers registered up
  front and `CFRunLoopRun()` on a background thread, a real unplug/replug produced
  **zero** notifications and the main thread's `enumerate` stayed frozen on the
  stale device for the whole test. AVFoundation drives device-change detection off
  the **main** run loop; if `main()` never services it, nothing is ever posted.
  This killed the surgical option and is why `main()` itself must change.
- **The Tiny 2 also registers a microphone** (`OBSBOT Tiny2 Microphone`) arriving
  76 ms after the camera. `obsbot_capture_record` with audio depends on it.

## Architecture

### 1. `native/macos/helper.m` — run loop instead of a blocking read

Replace the blocking `[stdinHandle availableData]` loop with a
`dispatch_source_t` read source on `STDIN_FILENO` attached to the **main queue**,
then `CFRunLoopRun()`.

The op-dispatch chain moves inside the source handler **unchanged**. Ops still
execute serially on the main thread exactly as today, so there is **no new
concurrency and no locking**. What changes is only how bytes arrive.

This single change does two things at once: it makes the run loop live (so
AVFoundation's registry stays fresh, fixing the stale-view problem at its root
rather than working around it with helper discards) and it makes notifications
possible at all.

### 2. Helper emits push events

Registered at startup, for the process lifetime:

```
AVCaptureDeviceWasConnectedNotification    -> {"event":"camera_arrived", "path":"<uniqueID>", "name":"..."}
AVCaptureDeviceWasDisconnectedNotification -> {"event":"camera_departed","path":"<uniqueID>", "name":"..."}
```

**No protocol break.** `HelperProcess`'s stdout handler ignores any JSON line
whose `ok` is not a boolean *without shifting the response queue* — a guard
written for stray log lines. Event lines carry no `ok`, so existing clients
ignore them safely and cannot desync.

Only camera devices are reported; the microphone arrival is filtered out (it is
noise for binding purposes, and is recorded here only so a future audio-capture
fix knows it exists).

### 3. `HelperProcess` — surface events

Parse `{"event":...}` lines and expose them as typed callbacks
(`onCameraArrived` / `onCameraDeparted`). No change to `rpc()` or the queue.

### 4. `DeviceManager` — react

- **departed:** drop any registry entry whose `path` matches, closing its helper
  (same close-then-delete as `pruneDeadEntries`, for the same reason: a helper
  left running keeps holding the device). `obsbot_devices` becomes correct
  immediately, with no probe-per-call cost.
- **arrived:** re-bind **only if this process previously held a binding** — i.e.
  the serial is in `everBound` and is not currently bound. A server that has never
  bound anything stays hands-off. This preserves "never grab a camera unasked",
  which matters on a device Zoom / OBS / OBSBOT Center also want, while still
  removing the failed first call after a replug.

### 5. `helperFactory` — subscribe every helper

`DeviceManager` spawns helpers through a factory, and there is no single
long-lived one: the scratch scanner is promoted into the registry on bind and the
next scan spawns another. So the subscription belongs in the factory
(`src/device/helper-factory.ts`), where whichever process is alive when the cable
moves is the one that reports it.

Two details that are not free choices:

- **Subscribe before `start()`.** After it, a camera plugged in during spawn emits
  into nothing and the arrival is lost.
- **`getMgr` is a thunk.** The manager is constructed *with* this factory, so it
  does not exist when the factory is built; it is resolved when an event fires.

The factory takes an injectable helper constructor purely so this is testable —
left inline in `startServer()` nothing covered it, and deleting the two
subscriptions broke no test while disabling the whole feature.

## Non-goals

- Linux (`udev_monitor_new_from_netlink`) and Windows (`CM_Register_Notification`)
  are out of scope for this branch. The Node side is written so those helpers can
  emit the same event lines later.
- No change to the snapshot resolution path or the multi-camera uniqueID hazard.

## Risks

- **Nested run loops in `doSnapshot`.** It already pumps `CFRunLoopRunInMode`
  while a capture completes. With a run loop live on main, that nesting must keep
  working. Nested modes are normal on macOS, but snapshot is the op that would
  break *silently*, so it gets explicit hardware verification.
- **Event/RPC interleaving.** Mitigated by the `ok`-guard above; a test asserts an
  event line arriving mid-request does not disturb the response.
- **Re-bind storms.** A device flapping could trigger repeated re-binds. The
  `everBound` gate plus the existing single-attempt rebind bound this; if it
  proves noisy, add a debounce.

## Testing

- **Unit:** event-line parsing; an event mid-request does not desync the queue;
  departed drops the binding and closes the helper; arrived re-binds only when
  previously bound; arrived for an unknown serial does nothing.
- **Hardware:** the existing replug procedure — expect **zero** failed calls after
  a replug, and `obsbot_devices` correct with no preceding failed call. Plus a
  snapshot before/after a replug to prove the nested run loop still works.

## Success criteria

1. After an unplug, `obsbot_devices` reports `[]` **without** a prior failed call.
2. After a replug, the next tool call **succeeds** — no `0xe00002c0`, no
   `open: missing path`.
3. Snapshot still works, including immediately after a replug.
4. No helper leak; no regression in the 400-test suite.

## Result — all four met on hardware (2026-07-21, macOS 26.5, Tiny 2 `RMOWAHG3293TTL`)

Physical unplug/replug on the same port, driven through the real `mcp__obsbot__*`
tools against the running server:

| | before | after |
|---|---|---|
| `obsbot_devices` after unplug, no failed call first | phantom `bound` + serial | `{"cameras":[]}` |
| `obsbot_devices` after replug, before any camera call | nothing bound | already `bound` |
| first real tool call after replug | failed (`0xe00002c0`) | succeeded |
| `obsbot_capture_snapshot` immediately after replug | — | real frame, nested run loop intact |
| helper processes at rest | — | 2 (registry + scan), no accumulation |

The re-bind is attributable to the arrival event, not to the call that observed
it: `listCameras()` only *reads* the registry, and `status:"bound"` can only be
written by `promote()`, which only `bind()` calls. Nothing invoked between the
replug and that reading binds.

Run twice — once with the subscription inline in `startServer()`, then again
after extracting `helperFactory` — because the second refactor changed the
runtime path the first run had verified.

### Follow-up: the port-change case, and why the re-bind now retries

Same-port replug was clean 3/3. **Different-port replug failed 2/2** — the
arrival fired, `bind()` ran, and it lost, silently, because arrival was treated
as a hint with exactly one attempt.

Probing found the cause is not the port and not the event: for several seconds
after ANY USB re-enumeration the vendor reply mailbox is intermittently
not-ready — the reply slot reads back with its magic byte zeroed. Polling
`readSerial` every 50 ms across a replug failed **22 of 80** attempts spread
over the first 14 s, against **0 of 120** in steady state. So a single attempt
on arrival is roughly a 1-in-4 coin flip and the same-port/different-port split
was luck.

Killed along the way, each having looked convincing first:

| hypothesis | killed by |
|---|---|
| stale per-process view of an unfamiliar uniqueID | the same helper read a brand-new uniqueID at t+49 ms |
| the device needs warm-up time | the attempt that FAILED (t+274 ms) was later than one that worked (t+49 ms) |
| re-opening the device disturbs it | 0/40 with re-open, 0/40 without |
| the per-transport seq counter restarting at 1 | 0/80 across two arms |

The first read after arrival held the host's own request with the magic byte
zeroed — the exact signature of the 3.2 s bind failure previously recorded as
unexplained in the README. That entry now has a reproducible trigger.

Two changes followed: `handleCameraArrived` retries on a bounded ladder
(`[0, 400, 1200, 3000]` ms, so ~4.5 s and then it stops), and `readSerial`'s
error reports what the mailbox actually held instead of only "no valid reply" —
the missing datum that left the original failure unexplained for a day.

Hardware after the fix: a different-port replug self-healed to `bound` before
any tool call. That run's first attempt succeeded on its own, so it confirms
the path but does not by itself exercise the retry; the retry rests on the
22/80 measurement and unit tests.
