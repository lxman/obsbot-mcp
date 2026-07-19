# Hardware integration test

Supervised end-to-end verification against a physically connected OBSBOT Tiny 2.

```
npm run build
npm run integration            # quick profile, ~2-3 min
npm run integration -- --deep  # adds provoked-race probes, ~5 min
```

**This moves the physical gimbal.** Run it with line of sight to the camera.
Slews are capped at ±90° yaw / ±30° pitch and the camera is always left asleep.

**It deletes all presets.** This is a test camera by explicit decision; slots are
create-once with no device-side history, so nothing is recoverable.

**Stop the MCP server first.** It holds its own helper process and device handle;
running both at once contends for the camera.

## Reading the report

Reports land in `artifacts/` as JSON plus a markdown summary. Tiers:

| Tier | Means |
|---|---|
| `VERIFIED` | proven against a channel independent of the command under test |
| `ACCEPTED` | the device took the command; nothing confirms the effect |
| `SKIPPED` | precondition absent (usually ffmpeg) |
| `MANUAL` | needs a human action the script cannot perform |

The **Downgraded** section lists checks that intended `VERIFIED` and did not get
there. That list is the point of the report: a standing inventory of what this
project cannot currently prove.

`ACCEPTED` is not a failure. Several controls are genuinely write-only on this
transport — zoom has no getter, and fov/focus/white-balance/image-control/exposure
have no readback. Those checks declare `ACCEPTED` honestly rather than aiming
higher and being downgraded.

## Why the checks have no unit tests

The harness (`harness.mjs`) and report builder (`report.mjs`) are pure logic and
are unit-tested in `test/integration-*.test.ts`. The check files are not, and
deliberately so: mocking a camera would test the mock. Their verification is
running against real hardware and reading the report.

## The transitional probes

`checks/transitions.mjs` is the reason this exists. The Tiny 2 fails in
transitional, mechanical ways that readback verification cannot catch:

- **T1** samples *during* a slew, so a cached position read fails rather than
  looking identical to a live one at rest.
- **T4** reads during a sleep transition and requires a loud failure rather than
  a false EMPTY — EMPTY authorizes an irreversible create-once write.
- **T7** saves a pose, moves away, recalls, and requires *physical arrival*.
  `preset_save` and `gimbal_position` share a tilt conversion, so a save→read
  round trip is self-consistent by construction and cannot falsify a sign error.

If this suite is ever cut down, keep those three.

## Adding a check

Add a `defineCheck({...})` entry to the relevant file in `checks/`. The `tool`
field links the check to the tool it covers and drives the coverage table — a
tool with no check appears in the report as an explicit hole.
