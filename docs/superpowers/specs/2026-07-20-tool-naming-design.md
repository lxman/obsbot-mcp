# Tool renaming + camera selector — design

**Status:** approved 2026-07-20. Not yet implemented.
**Ships with:** the multi-camera `camera` selector (see `2026-07-20-multi-camera-design.md`). Both
touch nearly every tool and land as **one** breaking change on **0.4.0**.

## 1. Why

The 30-tool surface grew case by case and is internally inconsistent: two names for the gimbal
(`ptz` and `gimbal`), verb-first and verb-last mixed (`list_devices` vs `preset_list`), bare-noun
setters (`fov`, `hdr`), and a capture domain split across three prefixes. The names are the primary
source of confusion when an agent picks a tool.

This is a **hard rename with no aliases**. Aliases would double the tool count the model sees and
worsen the disambiguation problem the rename exists to fix. One clean break at 0.x, before 1.0.

## 2. Rules (settled)

1. **Split vs parameter.** Split into distinct tools when the modes are different *operations* —
   a state transition (wake/sleep, record/stop), or a mode that changes which *other* parameters
   apply (focus auto vs manual). Keep one tool when the parameter is a *value* the operation acts on
   (zoom ratio, image level). Shape-matching is checkable against the schema, not argued per case.
2. **Domain-first, bare verbs for whole-device ops.** A tool scoped to a subsystem carries its
   domain (`obsbot_gimbal_move`). A whole-device action, where the device itself is the subject, is
   a bare verb (`obsbot_wake`). The bare-verb list is short and closed: `wake`, `sleep`, `status`,
   `devices`.
3. **Eight subsystem domains**, each naming a real physical part so the boundary is decidable:
   `device`(bare), `gimbal`, `zoom`, `focus`, `image`, `ai`, `preset`, `capture`. Plus `debug` for
   the one hidden diagnostic tool.

Where the rules did not settle a case, the seven judgement calls in §4 record the decision and its
reasoning.

## 3. The mapping

| # | old | new | notes |
|---|---|---|---|
| 1 | `obsbot_list_devices` | `obsbot_devices` | bare — whole-device |
| 2 | `obsbot_set_run_status` | `obsbot_wake` / `obsbot_sleep` | split: state transition |
| 3 | `obsbot_ptz_move_angle` | `obsbot_gimbal_move` | `ptz` → `gimbal` |
| 4 | `obsbot_ptz_move_speed` | `obsbot_gimbal_move_speed` | |
| 5 | `obsbot_gimbal_recenter` | `obsbot_gimbal_recenter` | unchanged |
| 6 | `obsbot_gimbal_position` | `obsbot_gimbal_position` | unchanged |
| 7 | `obsbot_zoom_absolute` | `obsbot_zoom_uvc` | see §4.6 — NOT merged |
| 8 | `obsbot_zoom_speed` | `obsbot_zoom_vendor` | see §4.6 |
| 9 | `obsbot_focus` | `obsbot_focus_auto` / `obsbot_focus_manual` | split: divergent params |
| 10 | `obsbot_face_focus` | `obsbot_focus_face` | camera-side, not AI — see §4.2 |
| 11 | `obsbot_ai_tracking` | `obsbot_ai_track` | domain already right |
| 12 | `obsbot_ai_track_speed` | `obsbot_ai_track_speed` | unchanged |
| 13 | `obsbot_fov` | `obsbot_image_fov` | domain a bare-noun setter |
| 14 | `obsbot_hdr` | `obsbot_image_hdr` | |
| 15 | `obsbot_white_balance` | `obsbot_image_wb_auto` / `obsbot_image_wb_manual` | split; `wb` is a standard term |
| 16 | `obsbot_exposure` | `obsbot_image_exposure_auto` / `obsbot_image_exposure_manual` | split |
| 17 | `obsbot_image_control` | `obsbot_image_adjust` | `control` → `adjust`; keep one tool |
| 18 | `obsbot_get_status` | `obsbot_status` | bare |
| 19 | `obsbot_preset_list` | `obsbot_preset_list` | unchanged — the reference family |
| 20 | `obsbot_preset_save` | `obsbot_preset_save` | unchanged |
| 21 | `obsbot_preset_recall` | `obsbot_preset_recall` | unchanged |
| 22 | `obsbot_preset_update` | `obsbot_preset_update` | unchanged |
| 23 | `obsbot_preset_rename` | `obsbot_preset_rename` | unchanged |
| 24 | `obsbot_preset_delete` | `obsbot_preset_delete` | unchanged |
| 25 | `obsbot_snapshot` | `obsbot_capture_snapshot` | into the capture domain — see §4.3 |
| 26 | `obsbot_record_start` | `obsbot_capture_record` | drop `_start` |
| 27 | `obsbot_preview_start` | `obsbot_capture_preview` | drop `_start` |
| 28 | `obsbot_capture_stop` | `obsbot_capture_stop` | unchanged |
| 29 | `obsbot_capture_list` | `obsbot_capture_list` | unchanged |
| 30 | `obsbot_probe` | `obsbot_debug_probe` | new `debug` domain; hidden unless `--debug` |

**Tool count: 30 → 34.** Four tools each split one-into-two (`set_run_status` → wake/sleep,
`focus` → auto/manual, `white_balance` → auto/manual, `exposure` → auto/manual) = **+4**. No
merges: the zoom pair stays two tools, and the `image_control` split was rejected. Every other
tool is a 1:1 rename. 30 + 4 = **34**.

## 4. Judgement calls (rules did not settle these)

1. **Split white balance and exposure by mode.** Both have a mode that changes which parameters
   apply, so rule 1 splits them. Confirmed rather than carved out — an exception is how the current
   set drifted. Yields `image_wb_auto` / `image_wb_manual(temperature)` and
   `image_exposure_auto(priority)` / `image_exposure_manual(level)`.
2. **`face_focus` → `obsbot_focus_face`, in the `focus` domain, not `ai`.** Verified on hardware
   2026-07-20: with AI tracking explicitly disabled (`aiMode: "no-tracking"`), enabling face focus
   was accepted and read back as 1. `CAM_SET_FACE_FOCUS` is receiver 0x02 (Camera subsystem), not
   0x04 (AI). It is a focus-motor control; AI is not required. (Caveat: this proves the *control* is
   AI-independent, not that face *detection* drives the motor without a face in frame — untestable
   here, but not needed for the naming.)
3. **`snapshot` joins the `capture` domain** → `obsbot_capture_snapshot`. It is a one-shot with no
   session, unlike record/preview which spawn ffmpeg and return a `sessionId`, so it shares the
   noun but not the lifecycle. Grouping chosen over a bare verb for a tidier surface.
4. **`probe` gets a `debug` domain** → `obsbot_debug_probe`. Makes "not a normal tool" visible in
   the name. Ninth domain, but justified: it is a category (hidden diagnostics), not a stretch to
   fit one tool into `image`/`gimbal`.
5. **`image_control` → `obsbot_image_adjust(control, level)`.** Seven procamp knobs (brightness,
   contrast, hue, saturation, sharpness, backlight-compensation, gain) stay one tool — `control` is
   a value, not a mode. "adjust" is an action where "control" named nothing.
6. **Zoom stays two tools, `obsbot_zoom_uvc(ratio)` and `obsbot_zoom_vendor(ratio, speed?)`.** They
   look mergeable but are NOT the same operation: they ride different transports (UVC
   `CT_ZOOM_ABSOLUTE` vs a vendor V3 frame) AND produce different zoom at the same commanded ratio.
   Verified by snapshot 2026-07-20: UVC at 2.0x framed tighter than the vendor path at 2.0x, so the
   ratio scales differ. Merging would silently change what `ratio` means. Named by transport
   deliberately — not self-describing, but it lets the operator pick the path; the *descriptions*
   must carry the difference the names cannot. See §6 for the open bug this exposes.
7. **Capture verbs drop `_start`.** `record`/`preview` already imply starting.
   `obsbot_capture_record`, `obsbot_capture_preview`, `obsbot_capture_stop`, `obsbot_capture_list`,
   `obsbot_capture_snapshot`.

## 5. The `camera` selector

From the multi-camera design. Every tool that addresses a camera gains an optional `camera`
parameter (the serial). Resolution: absent + one camera → that camera; absent + several → error
listing serials; given + match → use it; given + no match → error listing serials.

**Exempt** (do not take `camera`): `obsbot_devices` (enumerates the fleet), `obsbot_capture_stop`
and `obsbot_capture_list` (address a `sessionId`, not a device), and `obsbot_debug_probe` (raw
diagnostics on the already-open transport). Everything else takes it.

The single-camera experience must not regress: one camera → never type a selector, never see a
serial.

## 6. Related bug (not part of this rename)

The zoom investigation surfaced a real defect: `encodeZoomWithSpeed(ratio*100, …)` does not reach
the same physical zoom as the UVC path at the same `ratio`. Either the vendor ratio encoding is
wrong (off by a scale factor) or the two controls have genuinely different zoom ranges. One
hardware comparison is not enough to tell which. File separately; characterize by sweeping the
vendor path across several ratios and reading the framing from snapshots.

## 7. Testing

- Every renamed tool: a test asserting the new name resolves and the old name does **not** (proves
  the hard break).
- The four splits: each new tool exercises its path; the removed combined tool is gone.
- `camera` selector: covered by the multi-camera spec's tests.
- Descriptions: `obsbot_zoom_uvc` / `obsbot_zoom_vendor` descriptions must state the ratio-scale
  difference, since the names do not.

## 8. Migration

- `README.md` tool table rewritten to the new names.
- `CHANGELOG.md`: a 0.4.0 entry with the full old→new table (this document's §3), flagged BREAKING.
- No alias shim. Callers update or break, by design.
