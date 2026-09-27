# OBSBOT Tail 2 — HTTP control protocol

Status of this document: everything marked MEASURED was exercised against a real Tail 2
(firmware **7.2.13.1**, unit `Tail 2_bc3cbc`, MAC `10:a5:62:bc:3c:bc`, wired IP `192.168.0.132`)
on **2026-09-26**. Everything marked INFERRED comes from reading the camera's own web bundle
(`http://<ip>/assets/index-DuLYTjYY.js`, ~984 KB minified Vue/Vite SPA served by the camera)
and has not been wire-confirmed unless stated.

The Tail 2 is a completely different control animal from the Tiny 2 (see [PROTOCOL.md](./PROTOCOL.md)):
the control plane this project uses is **HTTP REST + a WebSocket status push**, with no vendor V3
frames and no native helper, which makes a transport for it pure TypeScript — one implementation
for Windows/Linux/macOS with no platform-specific code at all. The camera does have a UVC
Extension Unit and standard UVC controls when its USB-C port is in UVC mode; that surface is
documented in §11 and is not used by the `obsbot_tail2_*` tools.

---

## 1. Network surface (MEASURED 2026-09-26; full `nmap -p-` + `-sV` + UDP top-60)

| Port | Transport | Identity / notes |
|---|---|---|
| 80 / 443 | HTTP / HTTPS (self-signed) | `lighttpd/1.4.54`. Same JSON API on both. CORS fully open (`*`, all methods). |
| 554/tcp | RTSP | `Server: Remo RTSP Streaming Media Server/1.0.0`. `Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER`. Stream URL not yet identified; `rtsp.enable` currently false (§6). DESCRIBE of `/`, `/live`, `/stream` → `400 Bad Request`. |
| 5960 / 5961 | NDI\|HX | The NDI output this camera ships for (enabled). NDI name: `Obsbot_Tail2_Ndi_Device`, stream `OBSBOT`, group public, H264. 5961 emits framed binary unsolicited on connect (NDI\|HX data). |
| 5900/tcp | **raw status stream** | NOT VNC (nmap's label). Connect with any TCP client, no WebSocket handshake: the full status JSON is pushed immediately (same ~1 Hz block as `ws://…/ws/`, which is evidently a lighttpd-wrapped view of this port). |
| 27739/tcp | **`Server: Remo/Obsbot/0.2.0`** | Undocumented Remo HTTP-framed service — prime candidate for what OBSBOT Center speaks. Returns HTTP 400 (empty body) to every method/path/Host/WS-upgrade tried blind; likely gated on a client token or exact request shape. Needs a Center↔camera traffic capture to crack. |
| 29817, 31679/tcp | **ZeroMQ ZMTP 2.0** | The firmware's internal message bus, exposed on the network. Unexplored. |
| 9001/tcp | HTTP | HTTP/1.0 `403 Forbidden` to everything (not TLS). Unknown gate. |
| 9002/tcp | TLS + HTTP | Same 403 page over TLS. Unknown gate. |
| 10086/tcp | HTTP | HTTP/1.1 400 plain-text to everything. Unknown (different server signature than lighttpd). |
| 23/tcp | Telnet | **Linux login prompt** (`Tail 2_bc3cbc login:`). Factory credential pairs rejected 2026-09-26 (§9). |
| 5353/udp | mDNS | Confirmed open by UDP scan (a legacy-uniccast query from Windows went unanswered — local firewall artifact, not absence). |
| 67/udp | open\|filtered | DHCP — plausibly the camera's own WiFi-AP-mode server. |
| (USB-C) | MTP or UVC | `usb_mode` enum in the web bundle: `0=UNKNOWN, 1=UVC, 4=MTP`; this unit reported **4** when scanned, i.e. file offload (MTP) for SD footage. The port can be switched to a UVC webcam mode with its own control surface (§11). It is *not* USB-ethernet in either mode: on Linux the CDC interfaces bind no driver and no network interface appears. |

nmap also resolves the unit's hostname (`Tail_2_bc3cbc`) and identifies the MAC OUI as
**Iton Technology**.

Also present in firmware per the status block: SRT and RTMP output stacks (both currently
disabled), HDMI port flag (`is_hdmi_attached`), 3.5mm lens-module and remote-control flags
(`is_35mm_attached`, `is_remote_attached`), BLE (`is_ble_ok: true`). WiFi: the unit reports a
`wireless_ip` (192.168.55.222 on this one) alongside its wired IP — treat both as candidate
control addresses (that is exactly what OBSBOT Center does; §7).

## 2. Auth (MEASURED + INFERRED)

- **No authentication is enforced** for reads *or writes* out of the box: every GET/PUT/POST
  below succeeded from an unauthenticated `fetch` on the LAN. Anyone on the LAN can control
  the camera (including `poweroff`). MEASURED.
- A login endpoint exists: `POST /camera/sdk/login {username, password}`. The SPA pre-fills
  `username:"Admin"` and treats `password:"Admin"` as the factory default (INFERRED from
  bundle). The "hash" is plain **base64 of UTF-8** (decoded from the bundle's `gh` helper,
  2026-09-26) — not a cryptographic hash.
- Until the meaning of the login gate is decoded, assume it protects the web UI session only.

## 3. Endpoint census

47 endpoints, methods extracted from the SPA bundle (INFERRED, consistent with all probes).
Base: `http://<ip>`.

### Device & settings (GET reads — all MEASURED 200, no auth)
| Endpoint | Returns |
|---|---|
| `GET /camera/sdk/device_info` | `{device_name, wired_ip, wireless_ip, mac}` |
| `GET /camera/sdk/device_list` | `{device: []}` (purpose unclear — maybe USB-attached companions) |
| `GET /camera/sdk/get_func_capability` | `{dcf_rename_en, web_management_en}` |
| `GET /camera/sdk/setting_info` | device + SD state + firmware `{cur_ver, new_ver, update_avail, channel}` |
| `GET /camera/sdk/range` | all control ranges — see §5 |
| `GET /camera/sdk/networkconfig` | NDI + network + multicast + stream encoder params — see §6 |
| `GET /camera/sdk/get_file_folder_ext`, `setting_file_folder_ext` | file-type config (not probed) |

### PTZ
| Endpoint | Payload | Status |
|---|---|---|
| `POST /camera/sdk/ptz/reset` | `{}` | **MEASURED working** — gimbal recenter, `{"code":200,"err_idx":0}` |
| `PUT /camera/sdk/ptz/zoom` | `{"ratio": <float>, "speed": <int>}` — **both fields required** (400 with either missing) | **MEASURED working** |
| `GET /camera/sdk/ptz/zoom` | → `{"ratio": <float>}` | MEASURED |
| `PUT /camera/sdk/ptz/preset` | one endpoint, four ops (below) | **MEASURED working, all four ops** |
| `GET /camera/sdk/ptz/preset` | → `{"presetList": [{id, pitch, yaw, roll, ratio, name(base64)}]}` | MEASURED |
| `PUT /camera/sdk/ptz/presetspeed` | `{speed: <int>}` inferred from GET shape `{"speed": 5}` | GET measured |
| `PUT /camera/sdk/ptz/rollbias` | `{"angle": <float>}` | **MEASURED working** (write + readback) |

**Preset grammar** (decoded from the web bundle's `PresetControl` component after
blind-shape probing failed — all five first guesses 400'd because the discriminator
is `operation`, not `operate`/`type`/`action`; hardware-verified 2026-09-26):

```
PUT /camera/sdk/ptz/preset {"operation":"set",    "id":N, "name":<base64 utf-8>}  # save CURRENT pose (create OR overwrite)
PUT /camera/sdk/ptz/preset {"operation":"call",   "id":N}                         # recall
PUT /camera/sdk/ptz/preset {"operation":"delete", "id":N}                         # free the slot
PUT /camera/sdk/ptz/preset {"operation":"rename", "id":N, "name":<base64>}        # rename
```

- `id` is 0-based (0–2). There is **no explicit-pose write** anywhere in this API —
  a slot always captures the live pose (MEASURED: saved slot's ratio tracked the
  live zoom at save time). Absolute positioning over REST is therefore
  save-then-recall only; arbitrary yaw/pitch command isn't expressible.
- `set` on an occupied slot OVERWRITES it (MEASURED) — unlike the Tiny 2's
  create-once slots.
- The preset list lags a write by up to ~1 s (the UI sleeps 1 s after saving);
  read-verify with a ladder.
- Recall is open-loop on the gimbal axes; the only live arrival observable is the
  zoom ratio (verified: recall drove zoom 1.5 → saved 3.0).

### Rotation (no Tiny 2 equivalent)
| Endpoint | Payload | Status |
|---|---|---|
| `POST /camera/sdk/switch_portrait` | `{"enable": <bool>}` | **MEASURED working** — motorized 90° barrel rotation, verified both directions |

### AI / tracking
| Endpoint | Payload |
|---|---|
| `PUT /camera/sdk/ai/workmode` | `{"mode": "humanTrackingSingleMode"}` — MEASURED (PUT+GET round trip). Other mode strings not yet enumerated. |
| `PUT /camera/sdk/ai/trackspeed` | `{"speed": "slow"}` inferred from GET `{"speed":"slow"}` (likely `slow|standard|fast...`) |
| `PUT /camera/sdk/ai/human/onlyme` | `{"enable": <bool>}` inferred (GET measured `{"enable":true}`) |
| `PUT /camera/sdk/ai/human/zoomtype` | `{"type": "shot"}` inferred (GET measured) |
| `PUT /camera/sdk/ai/composition/horizontaloffset` / `verticaloffset` / `*lock` | offsets/locks (not probed) |
| `POST /camera/sdk/face_framing` | `{enable: <bool>}` (from bundle; GET 404s — write-only) |

### Image
`GET /camera/sdk/image` (MEASURED) returns the whole image state at once: hdr, night_mode,
mirror, focus `{focus_mode, focus_position, auto_focus_mode}`, exposure `{auto, mode,
compensate, iso_min/max, shutter_max, shutter_value, iso}`, anti_flicker, balance `{mode,
color}`, screen `{luma, contrast, saturation, sharpness, tone}`. Write endpoints (POST, from
bundle): `image_af`, `image_balance`, `image_exposure`, `image_flicker`, `image_hdr`,
`image_mirror`, `image_night_mode`, `image_screen` — payload shapes not yet probed.

### Power / system / storage / streaming
`POST poweroff`, `POST poweron`, `POST reboot`, `POST switch_portrait`, `PUT record/control`,
`POST capture/trigger`, `POST firmware_upload`, `POST setting_format_sd`,
`setting_record_split`, `setting_rename`, `setting_reset`, `event_clear`,
`update_status_clear`, `change_password`, `login`. Album (SD content): `GET/POST
/camera/album/filelist|grouplist|info|delete` (404 without SD inserted — MEASURED).

## 4. WebSocket status push — `ws://<ip>/ws/` (MEASURED)

Connect with any WS client; the camera pushes the **full status block ~1 Hz** with no
subscription message. This is the Tail 2 equivalent of the Tiny 2's selector-6 status block,
but far richer. Schema of a complete push (field names exact):

```
power_on, usb_mode(0/1/4), preview_num, rec, rec_time, switch_portrait,
ai_mode, zoom_type, only_me,
tracking_settings { speed, horizontal_auto, horizontalSpeed, vertical_auto,
                    verticalSpeed, PanAxisLock, TiltAxisLock },
composition { horizontal_offset, vertical_offset, face_framing },
preset_cnt, preset_info[ {id, pitch, yaw, roll, ratio, name(base64)} ],
preset_speed, roll_bias, zoom_ratio, focus_mode, auto_focus_mode,
ndi { enable }, rtsp { enable }, srt { enable }, rtmp { enable },
split_size, sdcard { status, format, total, available, avail_time, speed },
device_status { is_gimbal_online, is_ai_online, is_battery_online, is_lens_online,
                is_tof_online, is_sensor_ok, is_media_ok, is_ble_ok,
                is_usbwifi_attached, is_poe_attached, is_hdmi_attached,
                is_35mm_attached, is_remote_attached, is_charge, battery_cap,
                battery_temperature, battery_temperature_status, cpu_temperature,
                cpu_temperature_status, lens_temperature, lens_temperature_status }
```

**There is no live yaw/pitch/roll in the status push** — current pose is observable only by
saving a preset (the saved record carries the live pose) or by implication from moves. This
is the same "no live position feedback" limitation as the Tiny 2 on Linux, but structural:
plan moves as open-loop with clamped targets, exactly like `obsbot_gimbal_move` on Linux.

The bundle's own discovery handshake is: HTTP `GET /camera/sdk/device_info` (reachability +
identity) then `ws://<ip>/ws/` first message (liveness). Copy that pattern for probing.

## 5. Range constants (MEASURED, `GET /camera/sdk/range`)

| Control | Range |
|---|---|
| zoom | `zoom_min 1.0 — zoom_max 12.0` (12x — the Tiny 2 is 2x) |
| focus | `focus_abs_min 1 — focus_abs_max 100` (same 1–100 scale as the Tiny 2 tools) |
| exposure | shutter 9–34, ISO 100–6400 |
| white balance | 2000–10000 K (wider than the Tiny 2) |
| screen | luma/contrast/saturation/sharpness/tone each 0–100 |
| media | per-resolution fps/bitrate tables (720p … 4K; consult endpoint) |

## 6. Streaming configuration (MEASURED, `GET /camera/sdk/networkconfig`)

```json
{
  "ndi_enable": true,
  "ndi_param":  { "device_name": "Obsbot_Tail2_Ndi_Device", "stream_name": "OBSBOT",
                  "group_private": false, "group_desc": "Private Group" },
  "network_param":  { "ip_type": true, "ip": "…", "mask": "…", "gateway": "…" },
  "multicase_param":{ "multicase": false, "multi_netmask": "255.255.0.0", "multi_netprefix": "239.255.0.0" },
  "stream_param":   { "encoder_format": "H264", "fps": 4, "resolution": 1, "bitrate": 20.0 }
}
```

`rtsp`, `srt`, `rtmp` enable flags live in the WS status; the write path that flips them is
not yet decoded (likely `PUT networkconfig` or a sibling). **Enabling RTSP is the key to
Tail 2 snapshot/record support in obsbot-mcp**: stock ffmpeg speaks RTSP (it does not speak
NDI), so `obsbot_capture_snapshot`/`record` gain a Tail 2 path with zero extra dependencies.

## 7. Discovery model (INFERRED from bundle, consistent with probes)

OBSBOT Center identifies a Tail 2 by **MAC** (the Tiny 2 path uses the USB serial). Each
device carries candidate addresses `[{type:"wired", ip}, {type:"wireless", ip}]`; discovery
probes candidates in parallel with the device_info + WS hello handshake and races them with a
short timeout. For obsbot-mcp, a Tail 2 registry can therefore be keyed by MAC, with the
camera selector accepting either MAC or `device_name`.

## 8. Behaviors that shape the client (MEASURED 2026-09-26)

0. **AI tracking drops itself to `none`.** Observed twice: restored to
   `humanTrackingSingleMode` (verified by readback), later found `none` again with
   no tool call in between. Plausibly the firmware disables tracking after losing
   its subject for a while. Do not rely on a tracking mode persisting; read it
   back when it matters. (Unpinned — needs a controlled experiment.)

1. **`{"code":200,"err_idx":0}` means acknowledged, not applied.** A `rollbias` write
   returned 200 but never landed — the camera was mid-way through the portrait motor
   rotation; the readback still showed the old value seconds later, then the stale value
   appeared in the WS push *after* the correcting write. Same failure class as the Tiny 2's
   post-replug vendor mailbox. **Every write must be verified by readback** (the codebase's
   preset tools and `verifyFraming` already model this).
2. **`POST ptz/reset` (or the portrait toggle — not yet isolated) drops `ai_mode` to
   `none`.** Observed once during the reset/portrait sequence: tracking was
   `humanTrackingSingleMode` before and `none` after. Restoring via `PUT ai/workmode`
   round-trips cleanly. Pin down which command owns the drop before relying on it.
3. **Preset records carry absolute pose in degrees + zoom ratio** (`{pitch, yaw, roll,
   ratio}`) — the Tiny 2's tool-facing units exactly. Absolute gimbal positioning over HTTP
   is therefore available as *write-preset-pose → recall*, even with no direct move endpoint
   decoded yet.
4. **Preset `name` is base64 in the API** (`RGVmYXVsdA==` = "Default"), unlike the Tiny 2's
   selector-13 base64-in-ASCII quirk — plain base64 here.

## 9. Not yet decoded (next targets)

- **The Remo control protocol on UDP 9999 — partially decoded from a Center
  capture (2026-09-26, see §11).** Protobuf payloads inside an `0xaa`-magic
  frame; file read/write operations against camera config files under
  `/app/private/` (observed: `app_ust.#6ec3f866c4e94e82a168_start_srt.json`,
  carrying SRT listener JSON); telemetry stream back with device identity
  (serial `RMOLMHI4161ONX`, model `OAB-2305-CW`, firmware `OA_E` /
  `*.CM1032.release`) and an (empty) auth-token list. Next steps: decode the
  command-ID table, the 16-byte field after file paths (token? checksum?), and
  read `…_start_rtsp.json` — which likely contains the RTSP URL.
- **RTSP output is enable-gated, not enable-served (MEASURED 2026-09-26).**
  With `rtsp.enable=true` on a freshly rebooted camera: every DESCRIBE (49
  candidate paths) still returns 400, `preview_num` never moves, and Center's
  own preview reports the device occupied. **SRT, however, WORKS (measured
  2026-09-26):** Center's SRT listener mode — fixed **port 5000**, configurable
  stream ID (default `mainstream`), optional encryption — serves immediately
  once enabled, caller-pull via
  `srt://<ip>:5000?mode=caller&latency=120&streamid=mainstream`; measured H264
  1920x1080@30 + AAC at ~20 Mbps. (An earlier note claimed a multi-minute
  startup delay — WRONG, retracted: Center only allows changing streaming
  settings while the output is OFF, so our first probes simply landed inside
  the reconfiguration window. No delay exists once the toggle is on.) Outputs
  remain mutually exclusive (enabling SRT disables NDI) and the enable does
  NOT survive a reboot.
- ~~`PUT /camera/sdk/ptz/preset` payload~~ — DECODED 2026-09-26, see §3.
- `ai/workmode` mode-string enum: partially known (`none`,
  `humanTrackingSingleMode` MEASURED; the rest bundle-verified — human group,
  animal ×2, object ×3 — but not individually wire-confirmed).
- Image write payload shapes (`image_*` POSTs) — readable state at
  `GET /image`, write shapes unprobed.
- Telnet (23): live login, factory credential pairs (root/blank, root/root,
  root/Admin, admin/Admin, Admin/Admin, root/admin) all rejected 2026-09-26.
  Not brute-forced further.
- What `preview_num` / `current_preview_res` count — no `<video>` element exists
  in any chunk, so the web UI has **no live preview**; the numbers likely refer
  to external consumers (Center/NDI). Snapshot must ride the streaming outputs.

## 10. Remo control protocol (UDP 9999) — first look, from the Center capture

OBSBOT Center talks to the Tail 2 over **UDP 9999** (plus mDNS announcements on
5353). Decoded 2026-09-26 (late-night session) from the capture via
`scripts/capture/remo-*.mjs`:

**Frame anatomy** (provisional, offsets in a 20-byte minimal request):

```
aa                                  magic
01 | 21 | 25 | 29 | 44 | 45         frame type (request-small / request-with-body /
                                    reply / telemetry-large; 44/45 = ~895B pushes)
<seq lo> <seq hi>                   sequence, ECHOED in the reply (e8 05, e9 05, ...)
14 00 (c2s) | 1c 00 (s2c)           sender/session id — each side its own
<b2> <b2>                           per-frame bytes, unique per packet — NONCE or
                                    MAC; see replay finding below
0c <cmd...>                         command (two-byte-ish: 01 81 08, 04 04 01, ...)
02 06 <6-byte MAC>                  TLV: sender identity (camera 10:a5:62:bc:3c:bc,
                                    Center cf:bf:59:3a:c5:d2)
<more TLVs / protobuf-ish bodies>
```

**Command ids observed** (request → reply): `01 81 08` (subscribe/status → 895B
telemetry), `04 04 01` / `04 84 3f` / `04 84 54` (heartbeats/status polls → 36–52B),
`01 c1 0b` and `01 41 0c` (queries → `01 00 27 ff 01`), `01 81 0b` (**read auth
state → the `code_user_list` JSON**), plus the file read/write ops of §8/§9
(command `08 08` with path TLVs and the 16-byte trailing field).

**Replay WORKS — and the session is takeable (measured 2026-09-26 ~03:00).**
The earlier "replay blocked" conclusion was wrong: the camera answers to the
UDP port REGISTERED during the handshake, not to the datagram's source port —
replays from any other port are answered to a socket nobody is listening on.
Procedure, proven live: bind the port the real Center session used (session 3:
61604), replay the six handshake c2s frames verbatim (opener `01 01 08`,
auth-state read `01 81 0b`, query `01 41 0c`, **auth-token WRITE `01 41 0b`
(195 B, Center registers itself via a `code_user_list` JSON)**, ack `01 01 0c`,
session query `0d 08 18`) — and the camera accepts the session: every frame is
answered, telemetry (`aa 44…` ~890 B, carrying identity) streams to our socket,
queries get acks. The handshake is fully replayable; no nonce/crypto wall.

**File-content reads: DO NOT EXIST in Center's behavior (conclusively
measured, 3 captures).** Session 4 (`center-session4-settings-pages.pcapng`:
full Center start + settings-page navigation + firmware display) contains
ZERO file-op frames from Center — settings pages are populated over REST
(port 80) and telemetry; even the firmware version comes from the ~890 B
telemetry frames (`*.CM1032.release`). Across sessions 2–4 Center only ever
STAT'ed (`08 06`) and WROTE (`08 09`) config files. There is no
content-read exchange anywhere to model a client on, and our forged file
frames are silently dropped even after replaying the entire 240-frame
channel-02 negotiation chain with correct session identity (the 16-bit
validation field at header[22..23] also survived a full CRC16 parameter-space
brute force plus hash-truncation candidates — it is body-derived but not any
standard checksum). Speaking the file channel requires either firmware RE
(telnet/binaries) or push-ack choreography we haven't decoded. PARKED
2026-09-26 — snapshot support should ride SRT, RTSP-via-Center, or UVC
instead.

Session 4 also catalogued: frame type `0x49` = channel-02 UNSOLICITED PUSH
(camera pushes gimbal/AI config and file-descriptor updates — `0c 09 30`
pushes carry 16-byte descriptor tables); a third per-session client ID
(`2b 1f b5 dd 70 ac`), confirming Center randomizes its client ID every run;
and Center's TCP SYNs to port 80 (REST) — its only TCP usage.

Telemetry (camera → Center) carries device identity: `Obsbot_tail2`, `OA_E`,
`*.CM1032.release` (firmware build), `OAB-2305-CW` (model board),
`RMOLMHI4161ONX` (serial), and the auth-state JSON (`code_user_list: []`,
`main_user_token: ""` — consistent with the observed unauthenticated control
surface).

Center WRITES stream configs through this channel (the SRT JSON body appears
in Center→camera frames), which is why no streaming write exists in the REST
API. The working hypothesis for the RTSP "device occupied" deadlock: the RTSP
server only serves after the stream is started via this file mechanism, and
the URL lives in an as-yet-unread `…_start_rtsp.json`.

## 11. USB-C UVC mode (MEASURED 2026-09-26, Windows DirectShow; 2026-09-27, Linux uvcvideo)

The Tail 2's USB-C port has two modes, switched from OBSBOT Center: **MTP**
(file offload, `usb_mode=4`) and **UVC** (webcam, `usb_mode=1` or `4` with UVC
interfaces — the `usb_mode` status field does not distinguish them; the
interface set does). In UVC mode the camera enumerates as a USB Composite
Device with:

- **MI_00**: "OBSBOT Tail 2 Camera" (Camera class, UVC video)
- **MI_02**: "OBSBOT Tail2 Audio" (UAC audio)
- **MI_04**: "USB Serial Device (COM3)" — gimbal controller telemetry drain

VID/PID is **`0x3564`/`0xFEFC`** in both modes (same composite PID, different
interface sets). Added to `OBSBOT_MODEL_PIDS` in `src/device/manager.ts` and
the existing native helper enumerates/binds it normally.

### Standard UVC controls — Windows, 2026-09-26

| Control | Range | Live readback | Notes |
|---|---|---|---|
| Pan/tilt (`CT_PANTILT_ABSOLUTE`) | ±130° / ±90° | **YES** | Absolute moves; polled during slew caught intermediate values. Descriptor range under-reports mechanism (±150°/±90° per geometry/aim.ts; Linux measured further, see below). |
| Zoom (`CT_ZOOM_ABSOLUTE`) | 0–100 | yes | Maps to the camera's 1.0–12.0 ratio scale |
| Focus (`CAMERA_CONTROL_FOCUS`) | 0–100 | yes | Auto mode (flags:1) supported. On Linux this readback only echoes the last write (below); whether the Windows check saw an auto-chosen value is unconfirmed. |
| White balance (`VIDEOPROCAMP_WHITEBALANCE`) | 2000–10000 K | yes | Same range as the REST API. Same caveat as focus. |
| Snapshot (MJPEG) | 1920×1080@30 | — | Through the existing native helper; 38 KB frame at 640px |

### Standard UVC controls — Linux, 2026-09-27

Measured on kernel 7.2.0-rc4+ with `uvcvideo`, USB `bcdDevice` 4.19, UVC 1.00, SuperSpeed. All
moves went through standard V4L2 controls; no vendor commands were sent.

The Camera Terminal control bitmap (`0x00023e3e`) and the vendor Extension Unit (GUID
`9a1e7291-6843-4683-6d92-39bc7906ee49`, 19 controls) are identical to the Tiny 2's, and so is the
GET_INFO defect: `CT_PANTILT_ABSOLUTE`, `CT_PANTILT_RELATIVE` and `CT_ZOOM_ABSOLUTE` answer `0x03`
(GET and SET, AUTOUPDATE clear), so `uvcvideo` serves them from its cache. **Without a kernel fixup
entry for `3564:fefc`, position readback on Linux is the last commanded value, not the live one.**
`CT_ZOOM_RELATIVE` correctly answers `0x0f`, `CT_ROLL_ABSOLUTE` `0x01`, `CT_EXPOSURE_TIME_RELATIVE`
`0x00`.

"Live readback" below is with a probe build of `uvcvideo` that restores AUTO_UPDATE for the control.

| Control (V4L2 name) | Writable | Live readback | Notes |
|---|---|---|---|
| `pan_absolute`, `tilt_absolute` | yes | **yes** | Tracks commanded moves and AI tracking. Advertised ±130° / ±90°. |
| `pan_speed`, `tilt_speed` | yes | **yes** | Reads actual speed magnitude, unsigned, with accel/decel ramps. Commanded 40 reads 37–38; commanded 80 reads 42–43. Positive `pan_speed` *decreases* `pan_absolute`. Under `pan_speed` the gimbal reached −174°, past the advertised ±130°; tilt stopped itself at 86°. |
| `zoom_absolute` | yes | **yes** | Tracks commanded moves and zoom changed at the camera. Readback tops out at 36 for commanded 50 and 100. |
| `zoom_continuous` | — | no | Reads a constant 245, outside its advertised −100..100. |
| `exposure_time_absolute`, `gain` | yes | until first manual write | Live under auto exposure on a camera that has never had a manual exposure write. After one manual write both latch the written values permanently, across USB re-enumeration and a power cycle, while auto exposure keeps running. |
| `white_balance_temperature`, `red_balance`, `blue_balance` | yes | no | Reads back the last written value with auto re-enabled. |
| `focus_absolute` | yes | no | Reads back the last written value with autofocus re-enabled. |
| `hue` | yes | no | Constant; no auto mode. |
| `CT_ROLL_ABSOLUTE` | no | no | GET-only, range ±180° step 90°. Not mapped by `uvcvideo`. Read 0 under roll trim, AI tracking on and off, and the landscape/portrait switch; writes return success and change nothing. |
| brightness, contrast, saturation, sharpness, backlight compensation, power line frequency | yes | not tested | Effect on the image not verified. |

Values written over UVC are stored by the camera and survive a power cycle.

For comparison, the user manual (v1.0) gives the controllable range as pan ±160°, tilt −65° to 32°,
roll ±120°, and the mechanical range as pan ±175°, tilt ±90°. The −174° measured under `pan_speed`
is the mechanical limit; the UVC descriptor's ±130° under-reports the controllable range.

Flipping the camera's landscape/portrait switch makes it drop off USB and re-enumerate (about one
second each way).

Not controllable through the standard UVC controls: AI tracking and its mode, tracking speed,
presets, portrait rotation, roll trim, and the streaming outputs. Tracking, its mode, tracking
speed and Auto Zoom are controllable through the vendor Extension Unit (next section). The two
audio interfaces and the CDC interfaces bind no driver on Linux.

### Vendor XU protocol (MEASURED 2026-09-27, Linux, `UVCIOC_CTRL_QUERY`)

The camera has a vendor Extension Unit: unit 2, GUID
`9a1e7291-6843-4683-6d92-39bc7906ee49`, the same GUID as the Tiny 2. The Tiny 2's **status block
layout and V3 command frames do not apply** — the Tiny 2 decoder produces plausible-looking but
wrong values on selector 6 (coincidental byte alignments). No V3 frame was sent to the Tail 2.

What works instead is a set of **flat selectors**: plain `GET_CUR` / `SET_CUR` on the selector
itself, 60-byte payload zero-padded, no magic byte, no sequence number, no CRC.

Method: every value below was found by changing one setting at the camera and diffing reads, then
(where marked written) by writing a value the camera had been seen to report. Measured on USB
`bcdDevice` 4.19.

#### Selector map

Selectors 1–16 and 19 exist; 17, 18 and 20+ do not. All are 60 bytes and all answer `GET_INFO`
`0x03`, including the ones that ignore writes. `GET_MIN` / `MAX` / `DEF` / `RES` return zeros
everywhere, so the camera gives no range hints.

| Selector | Read | Write |
|---|---|---|
| 3 | Tracking on/off: `00` / `01` | Accepted, ignored (status mirror of selector 9) |
| 6 | Status block (below) | Not tried |
| 7 | `06`, then six 9-byte entries tagged `ff fe fd fc fb fa`. Never changed. Undecoded | Not tried |
| 9 | Tracking mode (below) | Yes |
| 10 | Tracking settings block (below) | Yes, as `[index, value]` |
| 12 | Preset count, then slot indexes (Tiny 2 layout). `01 00` in landscape, `00` in portrait | Not tried |
| 13 | Next preset entry; reading advances a cursor (Tiny 2 behaviour). `02` = exhausted | Not tried |
| 14 | `06 80 07`. Never changed, including across orientation. Undecoded | Not tried |
| 1, 2, 4, 5, 8, 11, 15, 16, 19 | All zeros | Not tried |

#### Selector 9 — tracking mode

| Value | Mode | Read | Written |
|---|---|---|---|
| `00` | Tracking off | yes | yes |
| `01` | Human tracking, single | yes | yes |
| `02` | Human tracking, group | yes | yes |
| `ff` | Animal tracking, normal **and** close-up | yes | no |

`ff` is a catch-all: the two animal modes are byte-identical in every selector. Object tracking
was not read (it needs a box-select in the preview window).

**The camera only activates a mode when a matching subject is already in frame.** With nobody in
frame the write is accepted and nothing changes. Writing `02` while an animal mode was running,
with no human in frame, switched tracking off. A client must read selector 9 (or 3) back after
writing, and treat "did not stick" as "no subject in frame".

On a successful write selector 9 reads the new value within 10 ms, selector 3 follows within
0.3 s, and the gimbal starts moving within about 1 s.

#### Selector 10 — tracking settings

Read layout:

| Byte | Setting | Values |
|---|---|---|
| 0 | Tracking speed | `00` Super Lazy, `01` Lazy, `02` Slow, `03` Fast, `04` Crazy, `ff` Custom |
| 1 | Unknown | Always `01` |
| 2 | Auto Zoom level | `00`–`07` = Off, 3, 5, 7, 9, 10, 16, 24 |
| 3 | Unknown | `00` in landscape, `01` in portrait |

**The write layout is not the read layout.** A write is `[index, value]`: byte 0 is the position
of the setting in the read block, byte 1 is the new value, and the rest is ignored.

| Payload | Effect |
|---|---|
| `00 00` … `00 04` | Tracking speed (all five written and read back) |
| `02 01`, `02 07` | Auto Zoom level 1, level 7 (written and read back; zoom responded) |

Writing the read block back verbatim is a trap: `02 01 07` is parsed as index 2, value 1, and
sets Auto Zoom to level 1.

Speed names for `02` and `03` were confirmed against the app; `00`, `01` and `04` follow the
manual's order and were not checked on the display. The app's display follows USB writes.

Custom speed reads `ff`; its per-axis pan and tilt values and its two per-axis "Auto" buttons
are not visible in any selector. Indexes 1 and 3 have not been written.

Settings are kept per orientation: portrait read `03 01 00 01`, the factory defaults (Fast, Auto
Zoom off), while landscape held the values set during the session, and returned to them exactly
when the camera was switched back.

#### Selector 6 — status block

60 bytes, read-only as far as tested. Decoded offsets:

| Offset | Meaning | How established |
|---|---|---|
| `0x05` bit 3 (`0x08`) | Portrait | `a0` landscape, `a8` portrait, one full cycle |
| `0x06` bit 3 (`0x08`) | Manual focus | `06` autofocus on, `0e` off, one cycle |
| `0x07` bit 1 (`0x02`) | Autofocus busy | Never set with autofocus off; set during zoom and focus hunting with it on |
| `0x0a` | Zoom, same scale as UVC `zoom_absolute` | Within 2 of the UVC reading in every paired sample (about 2,000, read ~50 ms apart) |
| `0x2a` | Counter of tracking events; resets at power-on | Steps during tracking, not on commanded moves |

Tracking on/off and mode are **not** in this block. `0x13` read `0x28` once and `00` since;
unexplained. Unlike the Tiny 2's, this block changes live.

Reference block (landscape, tracking off, autofocus on, zoom 0):

```
0x00: 32 00 08 00 20 a0 06 00
0x08: 00 01 00 a0 00 00 ff 03
0x10: 01 01 1e 00 00 00 32 32
0x18: 32 32 32 00 01 64 3f 00
0x20: 00 00 00 00 00 00 b8 0b
0x28: 00 02 0a 06 03 00 00 00
```

#### Not found over USB

- **Roll trim**: moving the app's spinner from 0.0° to 5.0° changed no selector and no status byte.
- **Orientation control**: readable (status `0x05`), no write found. Flipping it re-enumerates
  the camera and swaps the UVC frame sizes (1920x1080 becomes 1080x1920, and so on).
- **Custom speed detail** and the settings the manual lists but the app did not show in UVC
  mode (Only Me, Tracking Lock, Face Framing, Automatically track new person).

### Serial port (COM3, MI_04)

Not a console — a one-shot gimbal-controller telemetry drain. Opens with a
flood of ~20-byte frames (incrementing sequence, encoder/IMU payloads), then
goes silent. Not queryable (no response to CR/LF, Remo magic bytes, or text
commands). The initial flood corresponds to gimbal motion accumulated while
the port was closed. Potentially useful for sub-degree telemetry during
slewing (reopen while moving), but not a control surface.

### Platform status

- **Windows**: the Windows table and serial port findings verified via
  DirectShow (IAMCameraControl / IAMVideoProcAmp / IKsProperty). The flat
  vendor selectors have not been exercised on Windows.
- **Linux**: measured 2026-09-27 (table above). The Tail 2 has the same
  GET_INFO defect as the Tiny 2, so a stock kernel reads cached pan, tilt and
  zoom. The uvcvideo series submitted upstream for the Tiny 2 matches
  `3564:fef8` only; the Tail 2 needs its own `3564:fefc` entries for
  pan/tilt absolute, pan/tilt relative and zoom absolute.
- **macOS**: IOKit UVC stack is completely different — no reason to expect
  the cache issue, but unverified.

### Architecture implication

The USB-C path provides the physical control surface (gimbal, zoom, focus, WB,
snapshot) with zero vendor RE and zero streaming toggles; live gimbal and zoom
feedback comes with it on Windows, and on Linux only with the kernel fixup.
The vendor selectors add tracking on/off, human tracking mode, tracking speed
and Auto Zoom over USB. HTTP remains the only route for presets, portrait,
roll trim, animal and object mode selection, and discovery. A future USB
transport alongside the HTTP one would let the Tail 2 module choose per
command — but only after cross-platform verification.

- Web bundle + lazy chunks cached at `Temp\opencode\tail2-*.js` (session
  scratch — re-downloadable from the camera via `/assets/…`).
- **Center capture** (2026-09-26): `artifacts/tail2/center-session2-rtsp-enable.pcapng`
  — camera reboot, Center reconnect + RTSP re-apply, failed preview attempts.
  NOTE: capture session 1 (the original RTSP toggle + manual PTZ jog actions)
  was lost to an in-place filename overwrite before it could be banked; the jog
  capture must be redone in the next protocol session. pktmon filter:
  `192.168.0.132`, all protocols; dissect with `scripts/capture/pcap-streams.mjs`
  and `scripts/capture/udp9999-datagrams.mjs`.
- **Handshake capture**: `artifacts/tail2/center-session3-handshake.pcapng` — a
  clean Center launch→detect→session, captured start-to-finish; the six-frame
  handshake and its replies are events 0–16 of
  `scripts/capture/remo-session3-chronology.mjs`.
- **Replay evidence**: `artifacts/tail2/replay-attempt4-observed.pcapng` — the
  capture that solved it (camera replies addressed to the registered port).
  Working takeover: `scripts/capture/remo-session-takeover.mjs` (binds 61604,
  replays the handshake, receives telemetry).
- **Settings-navigation capture**: `artifacts/tail2/center-session4-settings-pages.pcapng`
  — proves Center never reads file content (§10's PARKED note). Full chain
  replay attempt: `scripts/capture/remo-channel02-replay.mjs`; checksum
  brute force: `scripts/capture/remo-checksum-brute.mjs`.
- Host notes for future sessions: run node via the real nvm binary path
  (`…\nvm\installs\v24.18.0\node.exe`) — the `.nodejs` junction path dodges the
  firewall allow rules; and the Ethernet profile is Public, so any new tool
  needs its own inbound allow.
- **NDI Webcam bridge (host app) lessons, 2026-09-26:** force-killing
  Webcam.exe corrupts its output-slot configuration (close it via its UI
  only); probing its DirectShow devices with ffmpeg disrupts the app; and its
  user-configured output slots delivered uniformly black frames (YAVG=YMAX=16)
  to ffmpeg while unconfigured slots hung. The bridge therefore is NOT an
  automated snapshot source — SRT is. `ndiWebcamSnapshot()` in
  `src/tail2/snapshot.ts` remains for manual/verified use.
- Camera left in its found state after each experiment: landscape, `roll_bias 0`,
  `ai_mode humanTrackingSingleMode`, zoom 2.0 (its value when found).

## 12. Source material
