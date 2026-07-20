# Changelog

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
