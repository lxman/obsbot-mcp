# Multi-camera support — design

**Status:** approved 2026-07-20. Not yet implemented.
**Prerequisite:** the tool-renaming design must be finished first — see §7.

## 1. Problem

The server supports exactly one camera. `DeviceManager.openFirstObsbot()` opens the first OBSBOT it
finds and offers no way to select another; no tool takes a camera argument. OBSBOT Center supports
four.

Worse, **the current code cannot open any camera when more than one is attached.** `doOpen` in
`native/macos/helper.m` matches the USB service to the AVFoundation device like this:

```c
serial = props[@"kUSBSerialNumberString"];
BOOL matches = (serial && [path localizedCaseInsensitiveContainsString:serial]) ||
               (services.count == 1);
```

The Tiny 2 has **no USB serial string** (`iSerialNumber = 0`, verified). `serial` is therefore
always nil, and the match survives only through the `services.count == 1` fallback. With two or
more cameras attached, `services.count > 1`, no branch matches, `udev` stays NULL, and `open` fails
for **every** camera. This is the actual blocker; everything else is layered on top.

## 2. Enabling discoveries

Three hardware findings make this design possible. All are recorded in `tiny2_specification.md`.

- **A stable per-unit identity exists.** `UG_GET_SN` returns a 14-character ASCII serial over the
  framed-V3 GET path (`frame[1] = 0x01`). This is the only stable identifier the device exposes.
  Reading it requires an open device plus two XU control transfers — no new helper ops.
- **`locationID` is the correct match key.** Verified: the AVFoundation uniqueID is exactly
  `"0x" + locationID(hex) + VID + PID`. For this unit, `locationID` 0x3120000 + 0x3564 + 0xfef8 =
  `0x31200003564fef8`. `locationID` is available from IORegistry, so matching is a local fix.
- **USB device open is exclusive.** Verified: a second process opening a held device fails with
  `kIOReturnExclusiveAccess` (0xe00002c5), and the failed attempt does not disturb the holder.
  This provides claim-coordination for free — no locks, no registry, no IPC.

## 3. Scope decisions

**Multi-camera, single-client.** MCP stdio spawns one server process per client, so two clients
cannot share a camera regardless of what we build here. Sharing would require an HTTP/SSE server or
a device-broker daemon, and the operational cost (lifecycle supervision, port discovery, a
localhost camera-control endpoint, wider crash blast radius) is not justified: nobody runs two
Claude clients against one camera. **Stdio is retained. No daemon.**

**One helper process per camera.** `HelperProcess` already has no shared or static state — each
instance spawns its own child — so N instances give N independent single-device helpers for free.
The alternative, a session table inside the helper, would require rewriting session handling in
three native languages (Objective-C, C, C++) on platforms verified only by pulling the branch. That
is the highest-risk shape available for the benefit of one process instead of four.

**Rejected: addressing cameras by index.** `camera: 1` silently means a different physical camera
after a replug. It is topology-guessing in a new hat, and worse than `locationID` because it looks
stable.

## 4. Architecture

### 4.1 Native — one change per platform helper

Replace the `kUSBSerialNumberString` match in `doOpen` with a `locationID` match, parsed out of the
AVFoundation uniqueID. The helper remains strictly single-device; `doOpen` already calls
`releaseSession()` first, so re-opening cleanly switches devices.

`helper.c` (Linux) and `helper.cpp` (Windows) must be audited for the same defect. They use
different enumeration APIs (V4L2, DirectShow) and may match differently; the fix is per-platform,
but the requirement is identical — match on stable topology, not on a serial string the device does
not have.

**No new helper ops.** Serial retrieval uses existing `open` + `xu_set` + `xu_get`.

### 4.2 TypeScript — `DeviceManager` becomes a registry

`openFirstObsbot(): ObsbotTransport` becomes a registry of
`Map<serial, { helper, transport, uniqueID }>`, spawning one `HelperProcess` per claimed camera.
All new logic lives here, where the test suite is.

### 4.3 Binding and rebinding

```
bind(serial?):
  enumerate candidate uniqueIDs
  for each:
    spawn helper, open(uniqueID)
      open fails with exclusiveAccess -> claimed by another process; skip
      open succeeds -> read UG_GET_SN
        matches the wanted serial (or none wanted) -> bind, done
        otherwise -> continue; the next open releases it
```

The same routine handles first bind and rebind-after-replug. A remembered serial finds its camera
in any port, in any order. Losing a race to another scanner just means re-scanning.

**Lazy, not eager.** A helper spawns on first use of a camera, not at startup. A user with four
cameras driving one pays for one helper, and startup does not claim hardware nobody asked for.

**Serial cache is a hint, never truth.** If `locationID → serial` is cached to speed rescans, it is
revalidated on open. An unvalidated cache reintroduces precisely the topology-guessing that finding
the serial eliminated.

## 5. Tool-facing API

**Selector: the serial.** Optional, named `camera`, accepted by every tool that addresses a camera.

Exempt are the tools that address something other than a camera: `obsbot_list_devices` (enumerates
the fleet), and the capture-session tools that address a session id rather than a device
(`obsbot_capture_stop`, `obsbot_capture_list`). Every other tool takes the selector.

```
obsbot_gimbal_move({ yaw: 30, pitch: 0, camera: "RMOWAHG3293TTL" })
```

**Resolution rules:**

| situation | behaviour |
|---|---|
| omitted, one camera attached | use it |
| omitted, several attached | error listing available serials |
| given, matches a camera | use it |
| given, no match | error listing available serials |

**The single-camera experience must not regress.** A user with one camera never types a selector
and never sees a serial. This is a hard constraint on the design, not a nicety.

**The ambiguity error must name the fleet**, e.g.
`multiple cameras attached; specify one of: RMOWAHG3293TTL, RMOWBBK7741PQZ`. It is the recovery path
for an agent that called a tool without knowing what is attached, so it must carry enough
information to retry correctly.

**`obsbot_list_devices`** is the discovery tool and the only one that never takes a selector. Per
camera it returns serial (where obtainable), uniqueID, name, and status: `available`, `bound`, or
`busy` (held outside this server — OBSBOT Center being the realistic case).

Note that **serial resolution requires claiming a camera**. A camera held by another application is
enumerable but not identifiable, and is reported `busy` with no serial rather than omitted.

**Aliases: designed for, deferred.** `camera: "desk"` beats a 14-character serial with four
cameras, and is the natural phrasing for an LLM. But it requires a persistence store and a naming
tool, and nobody with one camera needs it. The parameter therefore accepts **a string resolved
alias-first, then serial**, so aliases land later as a purely additive change. Not built now.

## 6. Error handling

- **Camera disappears mid-session** (unplug): operations fail; the next call triggers a rebind scan
  by remembered serial. If it is not found, the error says so plainly rather than silently
  retargeting another camera.
- **Stale handle after replug**: known failure mode where writes fail *silently*. The rebind scan
  is the fix; a helper whose camera vanished must be torn down and respawned, not reused.
- **Helper death**: per-camera helpers must be independently health-tracked and restartable. A
  wedged helper for camera 3 must not stall a call to camera 1 — otherwise N processes give N times
  the exposure rather than containment.
- **Camera asleep**: reads work, **writes are silently ignored**. Wake before any SET. This is
  per-camera now, so a "wake all" is N round trips.

## 7. Sequencing — this depends on the renaming work

Adding a `camera` parameter touches nearly every one of the 30 tools. The tool-renaming design
touches the same 30. Shipping them as two separate breaking changes would break users twice, when the renaming design
explicitly chose a hard rename with no aliases in order to break them **once**.

**Therefore: the rename and the camera selector land together, in one breaking change, on one
version bump.**

The renaming design's rules are already settled: split on lifecycle transitions and divergent
parameters; domain-first names with bare verbs for whole-device operations; eight domains
(`device`(bare), `gimbal`, `zoom`, `focus`, `image`, `ai`, `preset`, `capture`); hard rename with no
aliases. Only the concrete 30-name mapping was left undrafted. **That mapping must be finished
before either change can be implemented.**

## 8. Testing

- **Unit** (`DeviceManager` registry): binding, rebinding by serial, the `exclusiveAccess` skip
  path, ambiguity errors, single-camera default. All against a fake helper — no hardware needed.
- **Unit** (uniqueID parsing): `locationID` extraction, verified against the known-good
  `0x31200003564fef8` → `locationID` 0x3120000, VID 0x3564, PID 0xfef8.
- **Hardware, single camera**: no regression — every tool works with no selector.
- **Hardware, single camera**: replug into a *different port*, confirm rebind by serial.
- **Hardware, two cameras** (requires a second unit): both bind, selectors address the right
  physical camera (verify by moving one and observing which one moves), ambiguity error when the
  selector is omitted.

The two-camera tests cannot run until a second Tiny 2 is available. Until then the multi-camera path
is **unverified on hardware** and must be described as such.

## 9. Open questions

- Do `helper.c` and `helper.cpp` have the same matching defect? Unaudited.
- Does the Linux/Windows uniqueID encode `locationID` the same way? The AVFoundation format is
  macOS-specific; the other platforms need their own stable-topology key.
- Should a camera that stops responding be retried automatically, or surfaced immediately? Leaning
  surfaced — silent retries against hardware that may have moved ports risk targeting the wrong
  camera.
