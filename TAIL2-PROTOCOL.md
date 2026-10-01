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
| 5353/udp | mDNS | **The discovery channel** — the camera ANNOUNCES here every few seconds and answers no queries; see §7a. |
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
| `POST /camera/sdk/ptz/gimbalcontrol` | `{stop, pitch, roll, yaw}` — each axis −178..178, sign = direction, **magnitude = speed**; `stop:true` (zeros) halts | **MEASURED working 2026-09-30** — from the vendor REST doc (`SDKs/obsbot_tail_2_res_tful.zip`). Command 20 ≈ 7.9°/s; a POSITIVE yaw command DECREASES the recorded yaw. Continuous: the camera moves until stopped. |
| `GET/PUT /camera/sdk/ptz/gimbalinvert` | `{enable: boolean}` | GET measured 200; PUT per vendor doc (readback-verified in the client) |
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
- **Pose validity gate (from Center's own UI, census 2026-09-30):** a preset
  FAILS unless pan is within ±150° and tilt within ±60° — in both landscape
  and portrait. Tighter than the gimbalcontrol speed range (±178) and tighter
  than the physical gimbal; worth respecting client-side before a save.

### Rotation (no Tiny 2 equivalent)

### The 2026-09-30 vendor-doc surface (all MEASURED against firmware 7.2.13.1)

Found in the vendor's own REST doc (`SDKs/obsbot_tail_2_res_tful.zip`, unopened until 2026-09-30),
then hardware-verified endpoint by endpoint. Every write below is readback-verified by the client.
Uniform GET/PUT shape `{key: value}` unless noted:

| Endpoint | Shape | Notes |
|---|---|---|
| `GET/PUT /record/control` | `{"recording":"on"\|"off"}` | state readable with no SD card; starting needs one |
| `POST /capture/trigger` | empty body | still photo to storage |
| `GET/PUT /image/af/mode` | `{"mode":"afc"\|"afs"\|"mf"}` | |
| `GET/PUT /image/af/motorposition` | `{"position":0-100}` | **mode-gated: HTTP 500 unless mf** |
| `GET/PUT /image/af/trackmode` | `{"mode":global\|face\|foreground}` | AFC-only. MEASURED 2026-09-30: reads `face` |
| `GET/PUT /image/af/windowcenter` | `{"x":0.01-0.99,"y":0.01-0.99}` | **tap-to-focus**: setting it moves the focus window AND starts a point focus. AFC/AFS only. MEASURED: reads `{0.452,0.616}` |
| `GET/PUT /ndi-rtsp-srt/encoder` | `{"encoder":h264\|h265}` | MEASURED: h264 |
| `GET/PUT /ndi-rtsp-srt/resolution` | `{"resolution":"1920X1080P30"…}` | >4K30 unifies record/NDI/RTSP/SRT media params (doc). MEASURED: 1080P30 |
| `GET/PUT /ndi-rtsp-srt/bitrate` | `{"bitrate":mbps}` — range per resolution (doc table: 0.7–160) | MEASURED: 20.0 |
| `GET /ndi-rtsp-srt/rtspurl` | `{wiredNetwork:{mainStreamUrl,subStreamUrl},wirelessNetwork:{…}}` | MEASURED: `rtsp://192.168.0.132/stream1`/`stream2` (URLs are served even while control=ndi) |
| `GET/PUT /record/{encoder,resolution,bitrate}` | same shapes as streaming | MEASURED: h264, 3840X2160P30, 60.0 Mbps |
| `GET/PUT /usb/mode` | `{"mode":uvc\|mtp}` | MEASURED: mtp (the camera's USB-C state while network-controlled) |
| `GET/PUT /audio/input/{agc,enc,aux}` | `{"enable":bool}` / `{"enable":bool,"level":weak…}` / `{"source":micIn\|LineIn}` | MEASURED: agc off, enc off/weak, aux LineIn. (The Tail Air's `audio/input/source` buildIn\|aux does NOT exist here — 404) |
| **`POST /ai/workmode/normaltrack/targetselect`** | `{"x":0.01-0.99,"y":0.01-0.99}` | **UNDOCUMENTED in the Tail 2 doc** (it is in the Tail Air's). LIVE on the Tail 2 (MEASURED 2026-09-30): POST-only (GET 404); `{}` → 400; a valid coordinate from mode `none` returned 200 and **engaged humanTrackingSingleMode on the subject there** — tap-to-track. `PUT ai/workmode {"mode":"objectTracking"}` bare → 400 `err_idx:32 "no xmin"`: object tracking demands a bounding box (grammar unknown — web bundle) |
| `GET/PUT /ai/gesturecontrol/{dynamiczoom,dynamiczoomdirection}` | `{"enable":bool}` / direction | **Undocumented in the Tail 2 doc** (Tail Air's); routes LIVE (GET 400s; shapes unverified) |
| `GET /album/filelist?seek=newest\|oldest&offset=N&count=N&filter=none` | paged file list | doc; not yet exercised |

**HDMI (state 2026-09-30):** the Tail 2 HAS an HDMI output port — the status push senses it
(`device_status.is_hdmi_attached`, `false` on this unit) — but the Tail Air's REST control
(`/hdmi/output/resolution` et al.) is **not served** by firmware 7.2.13.1: every path shape
probed 404s (`hdmi`, `hdmi/output`, `hdmi/output/resolution`, `hdmi/resolution`, `hdmi/control`,
`video/hdmi`, `output/hdmi`). The port works as an output; it is not network-controllable on
this firmware — EXCEPT orientation: Center exposes an HDMI landscape/portrait choice
(census 2026-09-30), so some non-REST path serves that one setting. The Tail 2 doc's own >4K30 media-unification note omits HDMI (the Tail Air's
includes it), consistent with the endpoints simply being absent here.
| `GET/PUT /image/exposure/mode` | `{"mode":"manual"\|"auto"}` | |
| `GET/PUT /image/exposure/auto/mode` | `{"mode":"global"\|"face"}` | face-priority AE |
| `GET/PUT /image/exposure/auto/compensation` | `{"evbias":float}` | **rejects JSON integers** (400 "Invalid value type"; `0`/`-1` rejected, `0.0`/`-1.0` applied — and some integer bodies ACK without applying). Client always emits a decimal-point float |
| `GET/PUT /image/exposure/manual/{iso,shuttertime}` | `{"iso":100-6400}` / `{"shutter":"1/N"}` | **mode-gated: HTTP 500 unless exposure manual**. Manual ISO read back 894 on first switch — a live-AE-inherited value; the doc's "increment of 100" claim is false |
| `GET/PUT /image/style/{brightness,contrast,hue,saturation,sharpness}` | `{"<c>":0-100}` | GET also returns `{mode}`; **PUT mode-gated: HTTP 500 "style mode is not manual" unless style/mode is manual** |
| `GET/PUT /image/style/mode` | `{mode + all five values}` | PUT takes the full bundle; the client sends current values so a mode switch never stomps adjustments |
| `GET/PUT /image/hdr/control` | `{"control":"on"\|"off"}` | Center UI interlocks (census 2026-09-30): HDR requires frame rate ≤30 AND night view mode off |
| `GET/PUT /image/whitebalance/config` | `{"mode":auto\|daylight\|fluorescent\|tungsten\|cloudy\|manual,"temperature":2000-10000}` | temperature writes observed not to stick outside manual mode (readback lags/ignores) |
| `GET/PUT /ndi-rtsp-srt/control` | `{"control":"ndi"\|"rtsp"\|"srt"\|"off"}` | exactly ONE active output; setting srt displaces ndi (the exclusivity §7a measured); the programmatic way to arm SRT for snapshots |
| `GET/PUT /ndi-rtsp-srt/{encoder,resolution,bitrate,rtspurl}` | per vendor doc | not yet exercised |
| `GET/PUT /ai/human/onlyme` | `{"enable":bool}` | |
| `GET/PUT /ai/human/zoomtype` | `normal\|shot\|halfBody\|fullBody\|P7\|P9\|P16\|P24` — Auto-Zoom framing patterns (portrait-only for some) | doc enum, richer than the status block's bare `zoom_type`. Center census 2026-09-30: the Console page exposes this as a slider under Single/Group tracking with detents off,3,5,7,9,19?,16,24 — 7/9/16/24 map to P7/P9/P16/P24, 3/5 presumably halfBody/fullBody (3 disabled in group mode), off=normal; and arming AI tracking sets it to `shot`, which is why the WS `zoom_type` reads `shot` while tracking is active |
| `GET/PUT /audio/input/{volume,mute,agc,enc,aux}` | `{"volume":0-100}` / `{"enable":bool}` / … | volume+mute exercised |
| `GET/PUT /usb/mode`, `/record/{encoder,resolution,bitrate}`, `/album/filelist` | per vendor doc | now MEASURED — see rows above |

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

## 7. Discovery model (INFERRED from bundle, consistent with probes; mDNS MEASURED 2026-09-30)

OBSBOT Center identifies a Tail 2 by **MAC** (the Tiny 2 path uses the USB serial). Each
device carries candidate addresses `[{type:"wired", ip}, {type:"wireless", ip}]`; discovery
probes candidates in parallel with the device_info + WS hello handshake and races them with a
short timeout. For obsbot-mcp, a Tail 2 registry can therefore be keyed by MAC, with the
camera selector accepting either MAC or `device_name`.

### 7a. mDNS: the camera announces; it does not answer (MEASURED 2026-09-30)

Captured OBSBOT Center discovering this camera (tshark, `host 192.168.0.132 or udp port
5353`): Center sent **zero** mDNS queries. Every query frame on the wire came from the camera
itself (both its IPv4 and its IPv6 link-local addresses), asking `_remo_mdns._tcp.local` PTR —
probing for its Remo remote. Discovery is a **listen**: the camera multicasts
response-framed announcements every few seconds, and everything on the LAN that wants to find
it just hears one. This is why direct queries (multicast `_services._dns-sd._udp.local`,
`_ndi._tcp.local`, hostname ANY — tried 2026-09-30; and September's legacy-unicast query) all
went unanswered: there is no query responder. The 2026-09-26 port-table note guessed "local
firewall artifact" — wrong; it was the absence of a responder.

What one announcement carries (names verbatim from the capture; hostname format is
`Tail2bc3cbc.local` — the MAC's last three octets run together, **no** separators):

| Record | Content |
|---|---|
| A `Tail2bc3cbc.local` | `192.168.0.132` (wired) |
| AAAA | `fe80::12a5:62ff:febc:3cbb` (MAC-derived link-local) |
| PTR `_remo_mdns._tcp.local` → `Remo_mDNS._remo_mdns._tcp.local` | SRV → `Tail2bc3cbc.local:12345` |
| TXT on that instance | the device digest, below |
| PTR `_ndi._tcp.local` → `TAIL 2_BC3CBC (OBSBOT)._ndi._tcp.local` | SRV port 5961; TXT `groups=Public`, `discovery=5960` (NDI discovery port) |

The digest is a set of JSON objects as separate TXT strings (merged here):

- `wifi_mac` (`…:3c:ba`), `wifi_mode`, `wireless_ip` (`192.168.55.222` — the camera's **own
  AP subnet**, typically unroutable from the LAN), `wired_ip`, `ssid`, connection counts
- `device_name` (**hex-encoded UTF-8**: `5461696c20325f626333636263` = `Tail 2_bc3cbc`),
  `ble_mac` (`…:3c:bc` — the MAC the registry keys on, and the one `/camera/sdk/device_info`
  reports), battery level/flags, sleep/charging state
- `device_type`/`product_type` (6), base64 `device_sn`, `permission_check`

So one packet = full registration: MAC, name, both IPs, liveness (it arrived seconds ago).
obsbot-mcp's `obsbot_tail2_scan` listens ~5 s for these (pure TypeScript, `dgram` +
`SO_REUSEADDR` on 5353, which all three OSes allow alongside their own responders) and falls
back to the HTTP sweep only when nothing was heard. Verified against the live camera
2026-09-30: listen → register → `device_info` over HTTP, no probe sent during discovery.

Ports seen here but not elsewhere in this document: **12345/tcp** (the SRV target of
`_remo_mdns` — the Remo mDNS channel, not the UDP 9999 file-transfer channel of §10) and
**5960/5961** (NDI discovery/instance).

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
   ratio}`) — the Tiny 2's tool-facing units exactly. Combined with `gimbalcontrol`, this
   yields both halves of absolute positioning: save-scratch-slot → GET (a pose SENSOR,
   ~2s/read, hardware-verified 2026-09-30 catching a 7.9° move exactly) and jog-speed →
   poll → stop (a closed-loop ACTUATOR, converged 4° in one iteration / 0.9s on first
   hardware try). There is still no single move-to-angle endpoint: the loop composes it.
4. **Preset `name` is base64 in the API** (`RGVmYXVsdA==` = "Default"), unlike the Tiny 2's
   selector-13 base64-in-ASCII quirk — plain base64 here.

## 9. Not yet decoded (next targets)

> **2026-09-30 (later):** the Export Log bundle solved the READ side of most
> items below — their persisted schema is now mapped in §13 (`ust.json`).
> **2026-10-01: the flip-sheet census (§10b) closed the WRITE side** — zone
> tracking, the custom-tracking fields, Auto/Manual zoom speed, Virtual
> Tracking, One Push' family, Gimbal Speed/Smoothness, remote pair, Image
> Style Streaming, As Initial State (a dedicated UDP command, not a file
> write) and Timed Power On all decoded. Remaining genuinely-unknown: the
> WB sub-itemization inside the 8238/c238 family, the c206 value encoding,
> HDMI orientation's write path (no traffic observed), and the
> Buzzer/lights/Plug-to-Power toggles (not in the sheet — presumably the
> 4454 key-value surface, keys TBD).

- **Zone tracking (Center's Console page switch, noted 2026-09-30 census).**
  No endpoint in the vendor REST doc; no UDP 9999 command decoded for it.
  Closest artifacts: `/ai/composition/{horizontaloffset,verticaloffset,*lock}`
  (listed in the vendor doc, never probed) and the write-only
  `POST /camera/sdk/face_framing`. Prime suspect for another UDP-only rider
  like hybrid zoom was — decode by capturing one labeled flip.
- **Custom tracking Pan/Tilt speeds + their Auto buttons (census 2026-09-30).**
  READABLE in every WS push (`tracking_settings`: `horizontalSpeed`,
  `verticalSpeed`, `horizontal_auto`, `vertical_auto`) but no write endpoint
  in the vendor REST doc — UDP-or-undocumented-REST suspect. Capture a
  labeled `customized` sweep (both sliders + both Auto toggles) to tag.
- **Preset "As Initial State" (census 2026-09-30).** Center's per-slot action
  menu: Update/Delete/Rename all map to existing REST ops, but As Initial
  State (set the boot pose) has no vendor-doc endpoint, no status flag, no
  decoded UDP command. Prime suspect: the §10 config-file write channel
  (`/app/private/` file ops) — decode by capturing one labeled invocation.
  The More page's "Device Initial State" dialog is the same mechanism with
  its own controls: an Initial Position Zero button, a joystick to compose
  the pose, and a Zoom Initial slider — none REST-visible.
- **Census REST gaps (2026-09-30, Center pages):** controls whose endpoints
  exist (vendor doc or bundle) but ship no MCP tool yet — Night View Mode
  (`image_night_mode`, POST shape unprobed, interlocked with HDR + ≤30fps),
  AF track mode (`image_af_trackmode`, enum likely `global|face|front`),
  preset switching speed (`ptz/presetspeed`, GET measured), the zoomtype
  framing patterns (`ai/human/zoomtype`, see its row above), and the auto
  ISO range double-slider (`image_exposure_auto_isorange`; stops
  100–6400 doubled, readable as iso_min/iso_max in GET /image), plus
  anti-flicker (`image_exposure_antiflick_mode`, off/50/60), USB mode
  switching (`usb/mode`, GET/PUT unprobed; status reads usb_mode) and the
  stream encoder family (`ndi_rtsp_srt_{encoder,resolution,bitrate,rtspurl}`),
  and the four gesture controls (`ai_gesturecontrol_{lockedtarget,recording,
  zoom,zoomfactor}` — GETs measured 2026-09-30: zoom enabled, factor 2.0),
  plus SD management (`setting_format_sd`, `setting_record_split` — the
  status push already carries split_size; sdcard space likewise).
  2026-10-01 UPDATE: all of the above EXCEPT `setting_format_sd` and
  `setting_record_split` now ship as tools (see the probe batch in
  CHANGELOG); shapes GET-measured and writes no-op-verified live, including
  two measured GATES (zoomtype needs human tracking armed; stream
  resolution needs the output off) and the evbias-style float-literal
  quirk on `zoomfactor`/`bitrate`. STILL REST-ABSENT despite the bundle's
  `image_mirror`/`image_night_mode` names: mirror, night mode and record
  split 404 on GET/PUT/POST across every path shape tried — file-channel
  (config write) suspects, decode via the flip-sheet capture.
  All probe-then-tool candidates; none suspected of riding UDP.
- **WB One Push calibration + R/B Gain mode (census 2026-09-30).** The six
  WB modes + Kelvin ship (`obsbot_tail2_wb`), but Center also exposes R/B
  gain adjustment (bundle's `image_balance` write, gain fields never probed),
  a color picker with B-A (blue–amber) and G-M (green–magenta) fine-tune
  spinners beside it, and a One Push white-card calibrate with NO vendor-doc
  endpoint anywhere — UDP-or-unprobed suspects; capture labeled uses to tag.
- **Power scheduling + boot behavior (census 2026-09-30):** Auto Power Off
  (idle timeout), Timed Power Off, Timed Power On — each with settings
  dialogs — plus Record on Power On and Plug/UnPlug to Power On/Off; none
  REST-visible (the vendor's power endpoints are one-shot actions; no
  schedule/auto-record fields in the status push). Same `/app/private/`
  config-file suspect as the initial-state mechanism.
- **Virtual Tracking switch (census 2026-09-30).** No resembling endpoint in
  the vendor REST census and no status field. Prime suspect: enabling the
  FreeD tracking-data output (the AR/VR production feature), which would
  ride its own UDP path — capture one labeled flip to tag. The section's
  fields — Target IP address, UDP port, virtual camera position X/Y/Z
  offsets (stage calibration for the virtual origin), and pan/tilt angle
  offsets with per-axis Reverse checkboxes — all read as FreeD sender
  configuration.
- **UE Animation Gesture Control (census 2026-09-30):** Gesture1/Gesture2
  switches, "please go to UE5 to bind and use" — a gateway flag for the
  OBSBOT Unreal plugin, semantics defined inside UE. No endpoint, no status
  field; low tool value, noted for completeness.
- **Minor unattributed toggles (census 2026-09-30):** Center switches with
  no matching endpoint or status field so far — Buzzer, Status Light and
  Tally Light (each with its own Brightness slider, 1–3 integer), Battery
  Light. (Grows as the census continues.)
- **Action buttons without endpoints (census 2026-09-30):** Remote
  Controller pair (BLE pairing — transient action, no REST endpoint;
  capture candidate), and Export Log (no endpoint in the vendor census —
  prime suspect for the §10 file-read channel, the one Center behavior we
  catalogued as never-seen; a labeled Export Log capture would be the first
  observed file READ). Manual upgrade = vendor `firmware_upload` (no tool,
  rightly); firmware version display is telemetry-only (same as serial/
  model — rides the aa44 pushes, not REST).
- **View-and-Gimbal coarse/fine button (census 2026-09-30).** Suspected
  Center-side joystick scaling (no resembling state anywhere in the status
  push or vendor doc). One toggle in the verification capture settles it:
  no traffic = UI-only.
- **Gimbal Speed stepped slider 1–5, slow→fast (census 2026-09-30).** No
  matching camera state (status push carries only `preset_speed` and the
  tracking custom speeds) and no vendor-doc endpoint — suspected Center-side
  virtual-joystick ceiling, same class as coarse/fine. A sibling Gimbal
  Smoothness slider 1–5 sits next to it, same suspicion. Verify both with
  one labeled slide each.

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

### 10a. Control writes decoded: hybrid zoom, and the value checksum (MEASURED 2026-09-30)

The control-plane role of this channel is now confirmed, not hypothetical:
**OBSBOT Center flips settings that do not exist in the REST tree via UDP
9999 writes.** First proven control: the hybrid-zoom unlock.

**The hybrid-zoom gate (MEASURED).** The camera's zoom is optically walled
at **5.0x**: `PUT /camera/sdk/ptz/zoom` with any ratio above 5.0 is
*acknowledged* (code 200) but silently pins at 5.0 — with the switch off,
repeated writes of 5.5/6.0/7.0/8.0 never move the readback. After the
Center-side switch is flipped on, the same REST write settles at 8.0/12.0.
Center's own zoom slider is gated the same way (maxes at 10 while locked,
12 when unlocked — observed 2026-09-30), so the wall is universal, not a
REST quirk.
No REST endpoint changes state during the flip (full endpoint diff: empty),
and the WS status block's `zoom_type` does NOT reflect it (it tracks
AI-shot mode instead — four transitions checked). The 12x "hybrid zoom" of
the product page is therefore real but only reachable through this channel.

**Write-frame anatomy (26-byte control write, offsets):**

```
aa                       magic
25                       frame type (write)
<seq lo> <seq hi>        uint16 LE sequence (rolls; arbitrary fresh values
                         accepted — hardware-verified with a random seq)
14 00                    header constant
<b6> <b7>                frame checksum — covers bytes [0..19] with itself
                         zeroed, CRACKED (see below)
0c 02 82 c1              command id (zoom-family control)
02 06 a7 71 df 1c        TLV: sender identity (constant per Center install)
03 57                    TLV terminator
02 00                    TLV: value length = 2
<ck hi> <ck lo>          TLV value checksum — CRACKED, below
<subcmd> <value>         subcmd 01 = hybrid-zoom enable (value 00/01)
                         subcmd 00 = PROBABLY Auto Zoom Speed 1–10 (range
                         matches; Center's Console-page census 2026-09-30
                         flagged it for a labeled-capture verification —
                         not yet confirmed against that specific slider)
```

**TLV value checksum (CRACKED, 21/21 samples):**

```
ck = byteswap16( crc16_0xA001_reflected(subcmd, value; init 0, xorout 0) ) ^ 0xfe06
```

Same poly as the MODBUS/USB CRC family (the Tiny 2's vendor protocol uses
CRC-16/USB — same core). Verified across TWO different command ids
(`0282c1` subcmds 00 and 01, and the `0303 05` slider command), so it is a
pure function of the value bytes — independent of command id, seq, and the
frame checksum. Full sample table lives in `test/tail2/udp.test.ts`.

**The [6..7] field: CRACKED (2026-09-30, second pass).** The breakthrough
was direction: sweeping the camera→Center frames (idle capture, both
directions) showed ONE formula across polls, writes, and ~900-byte
telemetry pushes, both senders:

```
[6..7] = be16( byteswap16( crc16_0xA001_reflected(F; init 0) ) ^ 0xdbe4 )
         where F = the frame's FIRST TWENTY BYTES with [6..7] themselves zeroed
```

The tail beyond byte 20 is NOT covered — which is why every full-frame CRC
sweep missed. The earlier negative results all predate this: zeroed field
(rejected — missing checksum), randomized seq with stale checksum (rejected
— seq is inside the 20 covered bytes), captured checksum with altered
payload (rejected — bytes 8-19 of the prefix include the command id).
Exceptions: `aa 29` replies carry a different session header (`1c 00` at
[4..5], `04 0c` at [8..9]) and did not match this model — the only shape
not yet covered.

**Synthesis VERIFIED on hardware (2026-09-30).** A frame built entirely
from the model — fresh random sequence, both checksums computed — was
accepted (zoom crossed the wall). `buildControlFrame()` in
`src/tail2/udp.ts` reproduces both captured Center frames byte-for-byte
from their sequence numbers (pinned in `test/tail2/udp.test.ts`).

**Replay also works (earlier fallback, now historical).** Verbatim captured
frames were accepted hours later, from a different source port, with no
handshake replay. The two hardware-proven frames:

```
ON : aa251414140040c40c0282c10206a771df1c035702003e560101
OFF: aa253a1314009bd40c0282c10206a771df1c03570200ff960100
```

Open risk, RESOLVED (MEASURED 2026-09-30): the `a771df1c` sender identity
is NOT session-validated — with OBSBOT Center fully closed, fully
synthesized frames (captured identity constant, fresh random sequences)
were honored in both directions (OFF re-armed the 5.0 wall, ON lifted it).
It is a client identifier, not a negotiated key. Residual caveat only: if
a future firmware or a Center re-pair changes the accepted identity, the
constants in `src/tail2/udp.ts` need a re-capture.

**Other controls seen riding this channel (2026-09-30 capture):** command
`0c 03 03 05` with a 0–100 value swept in tens (a slider — UNLABELED; note
`0282c1` subcmd 00 is only PROBABLY the Auto Zoom Speed slider, pending the
same verification). Both obey the same value checksum. Verification batch
when convenient: capture one labeled sweep of Auto Zoom Speed, one labeled
sweep of Manual Zoom Speed (the two must be distinguished — Manual could be
UI-side, the speed Center attaches to its own ptz/zoom writes, since no
zoom-speed state exists in the status push), one flip of zone tracking, and
the 0303 05 slider's identity.


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
interface sets). The macOS helper's `OBSBOT_MODEL_PIDS` lists it, so the helper
can enumerate and open the camera; neither sends it anything. It is deliberately
**not** in `OBSBOT_MODEL_PIDS` in `src/device/manager.ts`: that table admits a
camera to the Tiny 2 bind path, which identifies it by writing a V3 frame
(`UG_GET_SN`) to vendor selector 2. The `obsbot_*` Tiny 2 tools therefore never
open or write to a Tail 2, and `obsbot_devices` does not list one.

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

## 13. The settings tree on disk: `ust.json` (MEASURED 2026-09-30, Export Log)

Center's **Export Log** button downloads the camera's diagnostic bundle —
and with it the entire persisted-settings schema, no file-channel decoding
required. DECODED 2026-09-30 (second capture): it is a plain unauthenticated
**`GET /camera/test/log`** on the same lighttpd REST server (port 80) — an
endpoint in no vendor doc. `Content-Length` body (the tar.gz), no
Content-Type (why it first looked like raw TCP), ~7 s server-side
generation before the first byte, `User-Agent: Mozilla/5.0`. VERIFIED
standalone: a bare HTTP GET reproduces the full archive with no Center, no
UDP, no handshake. Center saves it to
`%APPDATA%\OBSBOT_Center\deviceLogs\tail2_<date>_<serial>.tar.gz`.
The `/camera/test/` path family is a lead for other hidden endpoints.

Archive layout (the `/app/private/` namespace, seen from outside):
`ust.json` (user settings — the prize), `status.json` (~220 KB runtime
dump), `factory/*.json` (test/aging records), `config/{indicator,pr_wifi,
ble_config,usb_eth,usb_rndis,usb_wifi}`, `remo_history/logNN.tar.gz`,
`upgrade.tar.gz`, `dmesg_log`, `umap/*`, `free.txt`.

`ust.json` maps the census gaps to their persisted homes — write path is
still the §10 file channel (op `08 09` WRITE observed for SRT JSON in
2026-09-26 captures), but the SCHEMA is now fully known:

- **Power scheduling + boot:** `sys.power_ctrl` (`auto_suspend_time` —
  negative minutes for Auto Power Off; `rtc_suspend_*` = Timed Power Off;
  `rtc_resume_*` = Timed Power On; once/repeat masks), `boot_action`,
  and per-stream `start_on_boot` flags (`record.start_on_boot` = Record on
  Power On).
- **Hybrid zoom:** `properties.ignore_digital_zoom` (false = digital
  region enabled — consistent with the camera's state at export). The UDP
  `0282c1` write presumably flips both runtime and this persisted flag.
- **`properties.manual_zoom_speed: 7`** — Manual Zoom Speed is
  camera-persisted, NOT Center-side; and 7 is a value from the
  2026-09-30 1-10 sweep, shifting the `0282c1`-subcmd-00 label from
  "probably Auto" toward "probably MANUAL" (labeled capture still pending).
- **`pdtUst.gimbal_smoothness: 50`** — likewise camera-side (0-100 scale
  under Center's 1-5 detents).
- **`pdtUst.virtualTrack`** — the whole Virtual Tracking section:
  `positionX/Y/Z`, `yaw/pitch/roll` offsets + per-axis `*Reverse`,
  base64-encoded `ipv4`, `port`, `cm103_enable`. FreeD sender confirmed
  structurally.
- **WB extras:** `isp_ust.awb` carries `manual_gain{UserManualRGain,
  UserManualBGain}` (R/B Gain mode), `wb_offset{XabOffset, YgmOffset}`
  (the B-A and G-M spinners), `onePushRBGain{...}` (One Push state).
- **AF track enum:** `af_track_mode` strings incl. `FACE`,
  `CENTER_WEIGHT` (Center's Global/Face/Front mapping TBD).
- **Streaming image style:** `isp_ust.live_style_en` — Center's
  "Streaming" style button.
- **Lights:** `device.tally` / `device.battery` `{light_opt, light_slider}`
  (switch + 0-100 brightness); the status light likely `config/indicator`.
- **`device.hdmi.rotation`** — the HDMI landscape/portrait control's
  persisted home (the one HDMI setting Center exposes).
- **`device.usb.mode`** (MTP/UVC) — the `usb/mode` REST endpoint's
  persisted backing.
- **`pdtUst.handposeControl{bHandpose1/2/3}`** — the UE gesture gates.
- **`sys.login`** — base64 WebUI credentials (user + factory password),
  relevant to the §2 auth picture.
- **`device.visca`** — RS-232 VISCA/Pelco config (address, baudrate).
- Full audio DSP tree (`audio_ust.chn[].{ns,agc,beamforming,hpf,notch}`),
  per-format bitrate tables for record/NDI/RTMP, gamma LUTs, and
  `pdtUst.groupMode` (group-tracking image overrides).

Read side is therefore SOLVED for every "unattributed" census toggle: the
authoritative answer lives in this file, fetchable with one HTTP GET.
Open work: (a) ~~decode the Export Log read protocol~~ SOLVED —
`GET /camera/test/log`, see above; probe the `/camera/test/` family for
siblings; (b) confirm which settings Center writes via REST vs the
file channel (SRT JSON went by file; hybrid zoom went by control frame —
the split is per-control); (c) `status.json` (~220 KB) — INSPECTED, see
§13a; (d) locate the preset bank / initial-state pose (not in this archive).

### 13a. `status.json` — the runtime telemetry tree (inspected 2026-09-30)

The ~220 KB runtime dump mirrors what the `aa 44` UDP telemetry pushes
carry, as one JSON snapshot:

- **Live gimbal pose** — `device.gimbal_status.status`: euler angles
  (x/y/z), joint angles, angular velocities, lock/invert/cali states,
  `attitude` (LANDSCAPE/PORTRAIT). The "no live pose" limitation is a REST
  limitation; a telemetry listener gets full pose at push rate.
- **Zoom system internals** — `lens_status.optical_zoom` (ratiox1000,
  ust_ratiox1000 = persisted zoom home, real_ratiox1000) and
  `lens_status.digital_zoom` (the CROP WINDOW: in/out/target rectangles on
  the 3840x2160 sensor — digital zoom is sensor-crop, confirmed
  structurally). `zoom_infos`: `zoom_setting_min/max = 100/1200` (ratio
  x100), `digital_zoom_max = 240` (2.4x digital on 5x optical = 12x),
  `has_mix_zoom`, `optics_enable`, and **`digital_enable`** — the hybrid
  zoom state, READABLE here even though no REST endpoint exposes it.
  `manual_zoom_speed` appears in runtime too (7).
- **Live AE/AF truth** — `iq_status`: runtime shutter/aperture/ISO/EV vs
  user settings, AF window (center_x/y), `afc_track_mode`, WB gains and
  offsets runtime copies, night mode state.
- **Accessory telemetry** — `basepan_status` (the 360° Rotation Base: two
  battery channels + joint angle), `remote_status` (BT remote battery),
  tally runtime, monitor thresholds (battery temp WARNING at 41°C).
- **Versions** — kernel 6.6.8-rc7-ish + second-stage version blocks.
- **NOT present**: the preset bank and the Device-Initial-State pose —
  neither is in this archive; their storage is still unlocated (candidates:
  a file the Export Log does not include, or gimbal-module NVM).

Implication for tooling: a small WS/UDP telemetry listener could surface
live pose, `digital_enable` (hybrid state READBACK — closes the one gap
the hybrid tool has), firmware identity, and accessory state with no new
protocol work.

### 13b. The `RM_TEST` HTTP endpoints (MEASURED 2026-09-30)

`GET /camera/test/log` has siblings on the same factory-test dispatcher
(module `RM_TEST`, handler `Remo_Test_HttpSvrFunc`). CONFIRMED working:

| Endpoint | Body | Notes |
|---|---|---|
| `/camera/test/log` | the full diagnostic tar.gz (~12 MB) | ~7 s server-side generation |
| `/camera/test/status` | the ~220 KB runtime status tree, FRESH per request | live-verified: gimbal micro-drift visible between back-to-back fetches |
| `/camera/test/ust` | the current `ust.json` settings tree | live settings readback over plain HTTP |

Two traps for anyone probing further:

1. **Unknown cmds return HTTP 200**, body = `... ERROR [RM_TEST]
   Remo_Test_HttpSvrFunc-4178:cmd <name> unsupport` (a decimal-hex dump
   format) — a naive prober reads every path as a hit. Distinguish by body.
2. **This is the FACTORY TEST server.** The path suffix is the cmd name;
   blind enumeration risks invoking a hardware-test or destructive action
   (reboot/format-class cmds plausibly exist). No further names were probed
   deliberately; string-mining Center's install and the web bundles found
   no `camera/test` references (URL runtime-composed). If more cmds are
   ever wanted, get the list from firmware, not from the live dispatcher.

Tooling implication: `/camera/test/status` + `/camera/test/ust` give
no-protocol-work readback for everything the REST tree hides — hybrid
zoom state (`zoom_infos.digital_enable`), live gimbal pose (euler/joint),
full settings — pollable as plain HTTP GETs.

### 10b. The flip-sheet census (MEASURED 2026-10-01, labeled capture)

Center with a fresh run (note: the sender identity RE-RANDOMIZED —
`38141dae30c3` this run vs `a771df1c` yesterday — confirming per-run
client ids, consistent with the camera not validating them). Every census
unknown mapped, in sheet order:

| Control | Mechanism (cmd → shape) |
|---|---|
| Zone tracking on/off | UDP `0c 04 44 54`, field `03`, LE32 bool |
| Auto Zoom Speed 1–10 | UDP `4454`, field `17`, LE32 int (drags emit every step) — a SECOND 1–10 speed distinct from `0282c1` subcmd 00 (Manual, per ust) |
| Tracking speed → Custom | `4454` field `04` bool |
| Custom Pan / Tilt sliders | `4454` fields `07` / `0a`, value = slider/10 as FLOAT32 (0.1–1.0) |
| Pan / Tilt Auto buttons | `4454` fields `06` / `09`, ONE-byte bool (len-9 TLV) — CORRECTED 2026-10-01 by live verification: they flip `horizontal_auto`/`vertical_auto` (first read as locks from the capture timeline alone) |
| Pan / Tilt axis locks | WRITE PATH UNKNOWN — emitted no traffic in the sheet, and REST guesses under `ai/composition/*lock` all 404. Readable in the WS push only |
| WB gains / B-A / G-M / One Push | UDP `0c 02 82 38` + `0c 02 c2 38` family, t≈104–162 (payloads carry gain-ish uint16s; not fully itemized) |
| Virtual Tracking switch | UDP `0c 02 82 ae`, subcmd `01`, bool (same tail shape as remote-pair) |
| Virtual Tracking fields | `0c 02 02 07` value frames + `c2c1`/`03 43 00` queries |
| Coarse/fine button | NO TRAFFIC — client-side, confirmed |
| Gimbal Speed 1–5 | UDP `0c 03 03 05` — THE MYSTERY SLIDER: values on the 0–100 scale (slider×10; 20/30/40/50 observed). Yesterday' s 10–100 tens sweep = this control |
| Gimbal Smoothness 1–5 | UDP `0c 02 c2 06` (t≈355–362, the second-dragged slider per operator confirmation; value encoding in the tail not yet decoded — `…10 09 70 01/00`) |
| HDMI orientation | NO TRAFFIC — client-side in Center or lazily persisted (ust `device.hdmi.rotation` exists but no write was captured for landscape→portrait→landscape) |
| Remote pair | UDP `0c 13 0e 0c`, subcmd `01`, one-shot `01` |
| Image Style Streaming | UDP `0c 02 42 38`, field `04`, bool (on then off observed) = ust `live_style_en` |
| **As Initial State** | UDP `0c 04 44 38` — a DEDICATED COMMAND, not a file write: 74-byte frame carrying the pose as FLOAT32s + zoom + the preset name (`RGVmYXVsdA=="Default"`), plus a `0c 04 44 3a` companion. The boot-pose storage hunt is CLOSED |
| Timed Power On | UDP `0c 02 42 a2`, 72-byte schedule structure (`15000000` = 21h; on/off pair observed) |

Also observed: Center re-asserts the SRT config FILE (`0c 02 09 30` write
of `/app/private/app_ust…_start_srt.json` with the full listener JSON)
roughly every ~107 s while idle — the file channel is periodic background
traffic, not user-action-driven.

The `0c 04 44 54` command is a generic key→value setter (16-bit key,
LE32 or FLOAT32 value, per-key checksum) — the widest write surface on
the channel. Synthesis needs only the key table above plus the already
cracked frame checksum (coverage is still bytes [0..19]; the 36-byte
frames carry the value beyond byte 20, and the per-TLV checksum inside
covers it).

### 10c. The 4454 synthesizer (SHIPPED 2026-10-01)

`buildKVFrame()` in `src/tail2/udp.ts` synthesizes the generic key-value
writer; golden-tested byte-for-byte against the flip-sheet capture and
hardware-verified live (zone toggle, auto zoom speed, custom enable,
pan/tilt float speeds, Auto buttons — all landed and read back via
`tracking_settings`). Grammar notes beyond §10b:

- The sender-identity TLV is `02 06 <6 bytes>` — type 2, length SIX. The
  hybrid frames' `a7 71 df 1c 03 57` is one 6-byte id (the `03 57` was
  never a terminator); Center randomizes its 6-byte id per run.
- Value width is PER-KEY: the Auto-button bools (keys 06/09) ride ONE byte
  (len-9 TLV); every other value — booleans included — rides four.
- The TLV checksum constant is LENGTH-dependent: `swap16(crc) ^ {9:
  0xe1dd, 12: 0x440a}` (no unified init exists; searched exhaustively).
- The frame checksum (bytes [0..19], field zeroed, `^ 0xdbe4`) covers the
  4454 frames unchanged — verified against captured prefixes.

Bonus REST shape discovered during the live e2e: `PUT ai/trackspeed` with
`{"speed":"customized"}` alone is a 400 (`[horizontalSpeed] Key not
found`) — customized mode requires the axis speeds in the same body.
