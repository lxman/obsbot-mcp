import { z } from "zod";
import { writeFile } from "node:fs/promises";
import type { ToolDef } from "../mcp/tools.js";
import type { Tail2Registry } from "./registry.js";
import { srtSnapshot, ndiToolsInstalled, type SrtSnapshot } from "./snapshot.js";
import { moveAbsolute } from "./move.js";
import { hybridZoomSet, sendUdpFrame, kvSet, f32Bits, KV_KEYS, type UdpFrameSender } from "./udp.js";

/**
 * MCP tools for the OBSBOT Tail 2 (network camera — HTTP/WS control; its USB
 * UVC mode is not used here, see TAIL2-PROTOCOL.md §11). A separate tool family from the Tiny 2's:
 * the two cameras share semantics but not transports, and pretending otherwise
 * would make every schema a lie somewhere. Where a tool mirrors a Tiny 2 tool
 * (zoom, recenter, ai tracking) the semantics match on purpose; where the
 * Tail 2 has no Tiny 2 counterpart (portrait rotation, roll bias) the tool is
 * new.
 *
 * The `camera` selector here is a MAC address, device_name, or host — unlike
 * the Tiny 2's serial-number selector. Omitted with exactly one Tail 2
 * registered resolves to it; omitted with none tells the caller how to add
 * one; omitted with several names them all.
 */

// Same defensive coercions as the Tiny 2 tools (see src/mcp/tools.ts): some
// MCP clients serialize numbers/booleans as strings, and z.coerce.boolean()
// would map "false" to true.
const num = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v),
    z.number(),
  );
const bool = () =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
const withCamera = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, camera: z.string().optional() });

/**
 * Bundle-verified enums from the camera's own web app (TAIL2-PROTOCOL.md §3).
 * `none` is excluded from the tool's mode list — it is what `enabled:false`
 * sends, and advertising it alongside `enabled` would make two ways to say
 * the same thing, one of which is always wrong.
 */
const TAIL2_AI_MODES = [
  "humanTrackingSingleMode",
  "humanTrackingGroupMode",
  "animalTrackingNormal",
  "animalTrackingCloseUp",
  "objectTracking",
  "objectTrackingNormal",
  "objectTrackingCloseUp",
] as const;

const TAIL2_TRACK_SPEEDS = ["superLazy", "lazy", "slow", "fast", "crazy", "customized"] as const;

const devicesSchema = z.object({});
const scanSchema = z.object({});
const statusSchema = withCamera({});
const infoSchema = withCamera({});
const zoomSchema = withCamera({
  ratio: num().pipe(z.number().min(1.0).max(12.0)),
  speed: num().pipe(z.number().int().min(1).max(10)).default(5),
});
const recenterSchema = withCamera({});
const gimbalSpeedSchema = withCamera({
  yaw: num().pipe(z.number().min(-150).max(150)).optional(),
  pitch: num().pipe(z.number().min(-150).max(150)).optional(),
  roll: num().pipe(z.number().min(-150).max(150)).optional(),
  durationMs: num().pipe(z.number().int().min(100).max(5000)).optional(),
});
const gimbalMoveSchema = withCamera({
  yaw: num().pipe(z.number().min(-178).max(178)).optional(),
  pitch: num().pipe(z.number().min(-178).max(178)).optional(),
});
const gimbalInvertSchema = withCamera({ enable: bool().optional() });
const portraitSchema = withCamera({ enable: bool() });
const rollBiasSchema = withCamera({ angle: num().pipe(z.number().min(-90).max(90)) });
const aiTrackSchema = withCamera({
  enabled: bool(),
  mode: z.enum(TAIL2_AI_MODES).default("humanTrackingSingleMode"),
});
const trackSpeedSchema = withCamera({ speed: z.enum(TAIL2_TRACK_SPEEDS) });

// Preset slots: the Tail 2's API is 0-based (ids 0–2) but the tools expose
// 1-based slots (1|2|3) to match the Tiny 2's preset tools, so a caller's
// mental model carries across both cameras.
const slotSchema = num().pipe(z.number().int().min(1).max(3));
const presetListSchema = withCamera({});
const presetSaveSchema = withCamera({ slot: slotSchema, name: z.string().max(40).optional() });
const presetSlotSchema = withCamera({ slot: slotSchema });
const presetRenameSchema = withCamera({ slot: slotSchema, name: z.string().max(40) });

const snapshotSchema = withCamera({
  resolution: num().pipe(z.number().int().min(256).max(1920)).default(640),
  quality: num().pipe(z.number().int().min(1).max(100)).default(80),
});

// ---- 2026-10-01 probe-batch schemas -------------------------------------------------

const ZOOM_TYPES = [
  "normal", "shot", "halfBody", "fullBody", "P7", "P9", "P16", "P24",
] as const;
const zoomTypeSchema = withCamera({ type: z.enum(ZOOM_TYPES).optional() });
const presetSpeedSchema = withCamera({
  speed: num().pipe(z.number().int().min(1).max(5)).optional(),
});
const usbModeSchema = withCamera({ mode: z.enum(["mtp", "uvc"]).optional() });
const antiFlickerSchema = withCamera({
  mode: z.enum(["off", "50hz", "60hz"]).optional(),
});
const afTrackSchema = withCamera({ mode: z.enum(["global", "face", "front"]).optional() });
const isoRangeSchema = withCamera({
  min: num().pipe(z.number().int().min(100).max(6400)).optional(),
  max: num().pipe(z.number().int().min(100).max(6400)).optional(),
});
const gestureSchema = withCamera({
  lockedTarget: bool().optional(),
  recording: bool().optional(),
  zoom: bool().optional(),
  zoomFactor: num().pipe(z.number().min(1).max(10)).optional(),
});
const streamConfigSchema = withCamera({
  encoder: z.enum(["h264", "h265"]).optional(),
  resolution: z.string().regex(/^\d{3,4}X\d{3,4}P\d{2}$/).optional(),
  bitrate: num().pipe(z.number().min(0.7).max(160)).optional(),
});
const exportLogSchema = withCamera({ path: z.string().min(1) });
const liveStatusSchema = withCamera({});
const zoneTrackingSchema = withCamera({ enabled: bool() });
const autoZoomSpeedSchema = withCamera({
  speed: num().pipe(z.number().int().min(1).max(10)),
});
const trackCustomSchema = withCamera({
  enabled: bool().optional(),
  pan: num().pipe(z.number().int().min(1).max(10)).optional(),
  tilt: num().pipe(z.number().int().min(1).max(10)).optional(),
  panAuto: bool().optional(),
  tiltAuto: bool().optional(),
});

const PRESET_SHAPE_NOTE =
  `unlike the Tiny 2, save OVERWRITES an occupied slot (no create-once), and ` +
  `there is no explicit-pose write in this API at all — a slot always captures ` +
  `the camera's CURRENT pose (measured 2026-09-26; TAIL2-PROTOCOL.md §3)`;

const SETTLED_NOTE =
  `settled:false means the command was sent and acknowledged but the readback ` +
  `had not caught up within the polling budget — the camera moves slower than ` +
  `it acknowledges. Retry the read (or the command) rather than assuming failure.`;

export function createTail2Tools(
  registry: Tail2Registry,
  grab: (host: string, o: { maxDim: number; quality: number }) => Promise<SrtSnapshot> =
    (host, o) => srtSnapshot(host, o),
  udpSend: UdpFrameSender = sendUdpFrame,
): ToolDef[] {
  return [
    {
      name: "obsbot_tail2_devices",
      description:
        "List registered OBSBOT Tail 2 cameras (network cameras; MAC-keyed). Each entry: " +
        "mac (the identity — pass it as `camera` to any obsbot_tail2_* tool), name, and the " +
        "host(s) it has answered on. Registration is not liveness: an offline camera still " +
        "appears here; use obsbot_tail2_status to check one is reachable.",
      schema: devicesSchema,
      handler: async () => ({
        cameras: registry.list().map((e) => ({ mac: e.mac, name: e.name, hosts: e.hosts })),
      }),
    },
    {
      name: "obsbot_tail2_scan",
      description:
        "Discover OBSBOT Tail 2 cameras on the network and register them. Listens for the " +
        "camera's own mDNS announcements (~5s — it multicasts its MAC, name and IPs every " +
        "few seconds, the same channel OBSBOT Center discovers by) and falls back to an HTTP " +
        "subnet sweep only when nothing was heard (multicast-filtered networks; ~20s on a " +
        "full /24). Returns the cameras found; they stay registered afterwards. Run this " +
        "once to onboard a Tail 2 whose IP you don't know.",
      schema: scanSchema,
      handler: async () => {
        const found = await registry.scan();
        return {
          found: found.map((e) => ({ mac: e.mac, name: e.name, hosts: e.hosts })),
          registered: registry.list().length,
        };
      },
    },
    {
      name: "obsbot_tail2_status",
      description:
        "Read a Tail 2's full live status block (one WebSocket push): power, recording, " +
        "portrait rotation, AI mode + tracking settings, zoom ratio, roll bias, focus modes, " +
        "NDI/RTSP/SRT/RTMP enablement, SD card, preset list with poses (degrees + zoom " +
        "ratio), and per-subsystem health (gimbal/AI/battery/lens/ToF). NOTE: no live " +
        "yaw/pitch — the Tail 2 reports pose only via saved presets, so gimbal moves are " +
        "open-loop (same limitation as the Tiny 2 on Linux).",
      schema: statusSchema,
      handler: async (args: unknown) => {
        const { camera } = statusSchema.parse(args);
        const { api } = await registry.resolve(camera);
        return { camera: (await api.info()).mac, ...(await api.status()) };
      },
    },
    {
      name: "obsbot_tail2_info",
      description:
        "Read a Tail 2's identity and static configuration in one call: device_info (name, " +
        "MAC, wired/wireless IPs), range (zoom 1.0–12.0, focus 1–100, exposure, white " +
        "balance 2000–10000K, image adjust ranges), and networkconfig (NDI/stream encoder " +
        "settings). Read-only.",
      schema: infoSchema,
      handler: async (args: unknown) => {
        const { camera } = infoSchema.parse(args);
        const { api } = await registry.resolve(camera);
        return {
          device: await api.info(),
          ranges: await api.ranges(),
          network: await api.networkConfig(),
        };
      },
    },
    {
      name: "obsbot_tail2_zoom",
      description:
        "Set absolute zoom ratio on a Tail 2 (1.0–12.0 — twelve x, six times the Tiny 2's " +
        "range; scale is the camera's own ratio, not a magnification multiple). speed 1–10 " +
        "is REQUIRED by the firmware and defaults to 5. Zoom ramps mechanically; the tool " +
        "polls the readback and returns settled:false if it hadn't arrived within ~5s — the " +
        "command was still sent. Hardware-verified 2026-09-26.",
      schema: zoomSchema,
      handler: async (args: unknown) => {
        const { ratio, speed, camera } = zoomSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.zoomSet(ratio, speed);
        return { ok: true, ratio: r.ratio, settled: r.settled, note: SETTLED_NOTE };
      },
    },
    {
      name: "obsbot_tail2_hybrid_zoom",
      description:
        "Unlock (or re-lock) the Tail 2's hybrid digital zoom — the control OBSBOT Center owns. " +
        "Out of the box the camera's advertised 12x range is walled at its 5x OPTICAL ceiling " +
        "across the entire REST API: PUT ptz/zoom above 5.0 is acknowledged but silently pins at " +
        "5.0. Center unlocks the 5-12x digital region through its private UDP 9999 protocol; this " +
        "tool speaks that protocol directly (both checksums decoded — the synthesizer reproduces " +
        "Center's captured frames byte-for-byte; TAIL2-PROTOCOL.md §10). Verified by readback " +
        "from the live status snapshot (zoom_infos.digital_enable); returns settled:false if the " +
        "readback hadn't caught up — behavioral double-check: obsbot_tail2_zoom ratio 6.0 settles " +
        "above 5.0 only when enabled. Works with OBSBOT Center closed. Hardware-verified both " +
        "directions 2026-09-30, including full synthesis with a fresh sequence number.",
      schema: withCamera({ enabled: bool() }),
      handler: async (args: unknown) => {
        const { camera, enabled } = withCamera({ enabled: bool() }).parse(args);
        const entry = await registry.resolve(camera);
        const host = entry.hosts[0]!;
        await hybridZoomSet(host, enabled, udpSend);
        // The write has no ack frame; the live snapshot regenerates per
        // request, so poll digital_enable until it matches (bounded).
        let settled = false;
        for (let i = 0; i < 4 && !settled; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 400));
          try {
            if ((await entry.api.hybridZoomEnabled()) === enabled) settled = true;
          } catch {
            // Readback is best-effort: the write itself is fire-and-forget.
          }
        }
        return {
          ok: true,
          enabled,
          settled,
          note: settled
            ? "readback-verified via /camera/test/status (zoom_infos.digital_enable)"
            : "sent, but the readback had not caught up — retry this call or verify " +
              "behaviorally with obsbot_tail2_zoom (ratio >5.0 settles only when enabled)",
        };
      },
    },
    {
      name: "obsbot_tail2_zoom_type",
      description:
        "Read or set the auto-zoom framing pattern (Center's Console slider under Single/Group " +
        "tracking: off/3/5/7/9/…/24). Off=normal, 7/9/16/24=P7/P9/P16/P24 (subject-size framing " +
        "percentages), 3/5≈halfBody/fullBody (3 disabled in group mode). Arming AI tracking sets " +
        "this to `shot` — which is why the status block's zoom_type reads shot while tracking. " +
        "Writes are GATED (MEASURED 2026-10-01): the camera 500s unless human tracking is armed " +
        "— obsbot_tail2_ai_track enabled:true first. Readback-verified write.",
      schema: zoomTypeSchema,
      handler: async (args: unknown) => {
        const { camera, type } = zoomTypeSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (type === undefined) return await api.zoomTypeGet();
        const r = await api.zoomTypeSet(type);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_preset_speed",
      description:
        "Read or set the preset switching speed (1-5, Center's Console page). How fast recalls " +
        "drive the gimbal. Readback-verified write.",
      schema: presetSpeedSchema,
      handler: async (args: unknown) => {
        const { camera, speed } = presetSpeedSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (speed === undefined) return await api.presetSpeedGet();
        const r = await api.presetSpeedSet(speed);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_usb_mode",
      description:
        "Read or set the USB-C function mode: mtp or uvc. Control rides the network either way, " +
        "so switching is safe remotely. `mtp` is the measured wire value; `uvc` is the presumed " +
        "counterpart (GET-measured 2026-10-01). Readback-verified write.",
      schema: usbModeSchema,
      handler: async (args: unknown) => {
        const { camera, mode } = usbModeSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (mode === undefined) return await api.usbModeGet();
        const r = await api.usbModeSet(mode);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_antiflicker",
      description:
        "Read or set the anti-flicker mode: off, 50hz or 60hz (60hz measured on this unit). " +
        "Readback-verified write.",
      schema: antiFlickerSchema,
      handler: async (args: unknown) => {
        const { camera, mode } = antiFlickerSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (mode === undefined) return await api.antiFlickerGet();
        const r = await api.antiFlickerSet(mode);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_af_track",
      description:
        "Read or set the autofocus track mode: global, face or front (Center's radios; `face` " +
        "measured on the wire, the other two are the presumed strings). Readback-verified write.",
      schema: afTrackSchema,
      handler: async (args: unknown) => {
        const { camera, mode } = afTrackSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (mode === undefined) return await api.afTrackGet();
        const r = await api.afTrackSet(mode);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_iso_range",
      description:
        "Read or set the auto-ISO range (the double-ended slider: both bounds, 100-6400 in " +
        "doubling stops). Pass min and/or max; both default to the current value when omitted. " +
        "Readback-verified write.",
      schema: isoRangeSchema,
      handler: async (args: unknown) => {
        const { camera, min, max } = isoRangeSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (min === undefined && max === undefined) return await api.isoRangeGet();
        const current = await api.isoRangeGet();
        const r = await api.isoRangeSet(min ?? current.isomin, max ?? current.isomax);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_gesture",
      description:
        "Read (bare) or set the gesture-control switches and the gesture zoom factor: " +
        "lockedTarget, recording, zoom (booleans) and zoomFactor (the multiplier one zoom " +
        "gesture applies, e.g. 2.0). All measured on the wire 2026-10-01. Writes are " +
        "readback-verified; each field is optional.",
      schema: gestureSchema,
      handler: async (args: unknown) => {
        const { camera, lockedTarget, recording, zoom, zoomFactor } = gestureSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (
          lockedTarget === undefined && recording === undefined && zoom === undefined &&
          zoomFactor === undefined
        ) {
          const [lt, rec, zm, zf] = await Promise.all([
            api.gestureLockedTargetGet(),
            api.gestureRecordingGet(),
            api.gestureZoomGet(),
            api.gestureZoomFactorGet(),
          ]);
          return { lockedTarget: lt.enable, recording: rec.enable, zoom: zm.enable, zoomFactor: zf.factor };
        }
        const out: Record<string, unknown> = { ok: true };
        if (lockedTarget !== undefined) out.lockedTarget = await api.gestureLockedTargetSet(lockedTarget);
        if (recording !== undefined) out.recording = await api.gestureRecordingSet(recording);
        if (zoom !== undefined) out.zoom = await api.gestureZoomSet(zoom);
        if (zoomFactor !== undefined) out.zoomFactor = await api.gestureZoomFactorSet(zoomFactor);
        return out;
      },
    },
    {
      name: "obsbot_tail2_stream_config",
      description:
        "Read (bare) or set the stream encoder configuration shared by the network outputs: " +
        "encoder (h264/h265), resolution (camera format like 1920X1080P30), bitrate (Mbps). " +
        "The bare read also includes the RTSP URLs for both network interfaces. GATED (MEASURED " +
        "2026-10-01): resolution writes 500 while an output is live — set obsbot_tail2_stream " +
        "output:\"off\" first (encoder and bitrate writes are ungated). Readback-verified writes.",
      schema: streamConfigSchema,
      handler: async (args: unknown) => {
        const { camera, encoder, resolution, bitrate } = streamConfigSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (encoder === undefined && resolution === undefined && bitrate === undefined) {
          const [enc, res, br, urls] = await Promise.all([
            api.streamEncoderGet(),
            api.streamResolutionGet(),
            api.streamBitrateGet(),
            api.rtspUrlsGet(),
          ]);
          return { encoder: enc.encoder, resolution: res.resolution, bitrate: br.bitrate, rtspUrls: urls };
        }
        const out: Record<string, unknown> = { ok: true };
        if (encoder !== undefined) out.encoder = await api.streamEncoderSet(encoder);
        if (resolution !== undefined) out.resolution = await api.streamResolutionSet(resolution);
        if (bitrate !== undefined) out.bitrate = await api.streamBitrateSet(bitrate);
        return out;
      },
    },
    {
      name: "obsbot_tail2_export_log",
      description:
        "Download the camera's full diagnostic bundle (GET /camera/test/log — the same archive " +
        "OBSBOT Center's Export Log button produces) and save it to `path`. ~12 MB tar.gz " +
        "containing the settings tree (ust.json), the runtime status snapshot, factory records, " +
        "kernel logs. Takes ~10-20 s (server-side archive generation).",
      schema: exportLogSchema,
      handler: async (args: unknown) => {
        const { camera, path } = exportLogSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const buf = await api.exportLog();
        await writeFile(path, buf);
        return { ok: true, path, bytes: buf.length, note: "tar.gz diagnostic bundle saved" };
      },
    },
    {
      name: "obsbot_tail2_live_status",
      description:
        "Read a FRESH runtime snapshot (GET /camera/test/status) distilled to what the REST " +
        "tree hides: live gimbal pose (euler + joint angles — the WS push has no pose), zoom " +
        "internals including digital_enable (the hybrid-zoom state, the readback " +
        "obsbot_tail2_hybrid_zoom verifies against), runtime exposure truth (shutter/ISO/aperture " +
        "as actually running), battery/lens temperatures, boot stage and uptime, and accessory " +
        "state (360° base, BT remote, tally). Regenerated server-side per request.",
      schema: liveStatusSchema,
      handler: async (args: unknown) => {
        const { camera } = liveStatusSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const s = (await api.liveStatus()) as {
          status?: {
            init?: { stage?: string; poweron_pts?: number };
            system?: unknown;
            device?: {
              gimbal_status?: {
                status?: Record<string, number>;
                attitude?: string;
              };
              lens_status?: { temperature?: number };
              battery_status?: { capacity?: number; voltage?: number; temperature?: number; charging?: number };
            };
            sync_push?: {
              media_status?: { zoom_infos?: Record<string, unknown> };
              iq_status?: Record<string, unknown>;
              dev_status?: {
                basepan_status?: { basepan_joint_angle?: number };
                remote_status?: { charging?: boolean; capacity?: number };
              };
            };
          };
        };
        const gimbal = s.status?.device?.gimbal_status;
        const zi = s.status?.sync_push?.media_status?.zoom_infos ?? {};
        const iq = s.status?.sync_push?.iq_status ?? {};
        // The runtime exposure fields live under `exposure_params`.
        const ae = ((iq.exposure_params instanceof Object ? iq.exposure_params : {}) as Record<string, unknown>);
        const n = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
        const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
        return {
          gimbal: {
            euler: {
              x: n(gimbal?.status?.x_euler_angle),
              y: n(gimbal?.status?.y_euler_angle),
              z: n(gimbal?.status?.z_euler_angle),
            },
            joint: {
              x: n(gimbal?.status?.x_joint_angle),
              y: n(gimbal?.status?.y_joint_angle),
              z: n(gimbal?.status?.z_joint_angle),
            },
            attitude: gimbal?.attitude,
          },
          zoom: {
            hybridDigitalEnable: zi.digital_enable,
            settingMin: n(zi.zoom_setting_min),
            settingMax: n(zi.zoom_setting_max),
            settingCurrent: n(zi.zoom_setting_current),
            manualZoomSpeed: n(zi.manual_zoom_speed),
            digitalZoomMax: n(zi.digital_zoom_max),
          },
          exposureRuntime: {
            shutter: str(ae.runtime_shutter),
            iso: n(ae.runtime_iso),
            aperture: str(ae.runtime_aperture),
            ev: str(ae.runtime_ev),
          },
          power: {
            batteryCapacity: n(s.status?.device?.battery_status?.capacity),
            batteryVoltageMv: n(s.status?.device?.battery_status?.voltage),
            batteryTempC: n(s.status?.device?.battery_status?.temperature),
            charging: n(s.status?.device?.battery_status?.charging) === 1,
            lensTempC: n(s.status?.device?.lens_status?.temperature),
            bootStage: s.status?.init?.stage,
          },
          accessories: {
            basePanJointAngle: n(s.status?.sync_push?.dev_status?.basepan_status?.basepan_joint_angle),
            remoteCharging: s.status?.sync_push?.dev_status?.remote_status?.charging,
            remoteCapacity: n(s.status?.sync_push?.dev_status?.remote_status?.capacity),
          },
        };
      },
    },
    {
      name: "obsbot_tail2_zone_tracking",
      description:
        "Toggle zone tracking (Center's Console page switch) on or off. Rides the camera's " +
        "private UDP 9999 channel (generic key-value command, key 03 — decoded from a labeled " +
        "capture 2026-10-01, TAIL2-PROTOCOL.md §10b). No ack and no REST-readable state — the " +
        "effect shows in the tracking behavior. Synthesized frame, works with Center closed.",
      schema: zoneTrackingSchema,
      handler: async (args: unknown) => {
        const { camera, enabled } = zoneTrackingSchema.parse(args);
        const entry = await registry.resolve(camera);
        await kvSet(entry.hosts[0]!, KV_KEYS.zoneTracking, enabled, udpSend);
        return { ok: true, enabled, note: "sent — no readback exists for this switch" };
      },
    },
    {
      name: "obsbot_tail2_auto_zoom_speed",
      description:
        "Set the AUTO zoom speed 1-10 — how fast AI-tracking auto-zoom framing moves (Center's " +
        "Console slider; distinct from the MANUAL zoom speed on obsbot_tail2_zoom's speed param). " +
        "Rides UDP 9999 key 0x17. No REST-readable state; no ack — the frame is synthesized and " +
        "works with Center closed.",
      schema: autoZoomSpeedSchema,
      handler: async (args: unknown) => {
        const { camera, speed } = autoZoomSpeedSchema.parse(args);
        const entry = await registry.resolve(camera);
        await kvSet(entry.hosts[0]!, KV_KEYS.autoZoomSpeed, speed, udpSend);
        return { ok: true, speed, note: "sent — no readback exists for this control" };
      },
    },
    {
      name: "obsbot_tail2_track_custom",
      description:
        "Configure CUSTOM tracking speed (Center's `customized` track speed): enable it, set the " +
        "per-axis Pan/Tilt speeds 1-10, and toggle the per-axis Auto buttons. Bare call reads " +
        "current state from the status push (tracking_settings, locks included read-only). " +
        "Writes ride UDP 9999 keys 04/07/0a/06/09 (pan/tilt travel as float32 slider/10 on the " +
        "wire; keys 06/09 are the Auto buttons — hardware-verified against horizontal_auto/" +
        "vertical_auto). The AXIS LOCKS have no known write path (not UDP, REST guesses 404) — " +
        "shown read-only. Verified by tracking_settings readback.",
      schema: trackCustomSchema,
      handler: async (args: unknown) => {
        const { camera, enabled, pan, tilt, panAuto, tiltAuto } = trackCustomSchema.parse(args);
        const entry = await registry.resolve(camera);
        const readBare =
          enabled === undefined && pan === undefined && tilt === undefined &&
          panAuto === undefined && tiltAuto === undefined;
        if (readBare) {
          const st = (await entry.api.status()) as {
            tracking_settings?: Record<string, unknown>;
          };
          const t = st.tracking_settings ?? {};
          const n = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
          const b = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
          return {
            mode: (await entry.api.trackSpeedGet()).speed,
            pan: n(t.horizontalSpeed),
            tilt: n(t.verticalSpeed),
            panLock: b(t.PanAxisLock),
            tiltLock: b(t.TiltAxisLock),
            panAuto: b(t.horizontal_auto),
            tiltAuto: b(t.vertical_auto),
          };
        }
        const host = entry.hosts[0]!;
        const out: Record<string, unknown> = { ok: true };
        if (enabled !== undefined) await kvSet(host, KV_KEYS.customTrackingEnable, enabled, udpSend);
        if (pan !== undefined) await kvSet(host, KV_KEYS.panSpeed, f32Bits(pan / 10), udpSend);
        if (tilt !== undefined) await kvSet(host, KV_KEYS.tiltSpeed, f32Bits(tilt / 10), udpSend);
        // The Auto-button bools ride ONE byte on the wire (len-9 TLV) — the
        // only keys that do; everything else is 4-byte.
        if (panAuto !== undefined) await kvSet(host, KV_KEYS.panAuto, panAuto, udpSend, undefined, { bool8: true });
        if (tiltAuto !== undefined) await kvSet(host, KV_KEYS.tiltAuto, tiltAuto, udpSend, undefined, { bool8: true });
        // Readback: tracking_settings reflects pan/tilt/autos; the mode shows
        // `customized` once enabled.
        const st = (await entry.api.status()) as { tracking_settings?: Record<string, unknown> };
        const t = st.tracking_settings ?? {};
        out.readback = {
          mode: (await entry.api.trackSpeedGet()).speed,
          pan: t.horizontalSpeed,
          tilt: t.verticalSpeed,
          panAuto: t.horizontal_auto,
          tiltAuto: t.vertical_auto,
        };
        return out;
      },
    },
    {
      name: "obsbot_tail2_recenter",
      description:
        "Recenter a Tail 2's gimbal (yaw 0 / pitch 0 / roll 0). Returns as soon as the " +
        "command is acknowledged — the Tail 2 exposes no live pose to verify arrival " +
        "against (open-loop, like the Tiny 2 on Linux), and note that commanding a reset " +
        "can drop AI tracking to none (observed once 2026-09-26; re-enable with " +
        "obsbot_tail2_ai_track if that matters). Hardware-verified 2026-09-26.",
      schema: recenterSchema,
      handler: async (args: unknown) => {
        const { camera } = recenterSchema.parse(args);
        const { api } = await registry.resolve(camera);
        await api.recenter();
        return { ok: true };
      },
    },
    {
      name: "obsbot_tail2_gimbal_position",
      description:
        "Read the Tail 2's live gimbal pose in degrees (yaw/pitch/roll) plus the zoom ratio. " +
        "The API has no direct pose read — this works by saving the current pose into an empty " +
        "preset slot, reading it back, and deleting the slot (takes ~2s). Requires at least one " +
        "empty preset slot: overwriting a preset is irreversible (no pose-by-value write exists " +
        "to restore it). Leftover 'pose-probe' slots from crashed reads are deleted, not trusted.",
      schema: withCamera({}),
      handler: async (args: unknown) => {
        const { camera } = withCamera({}).parse(args);
        const { api } = await registry.resolve(camera);
        return await api.readPose();
      },
    },
    {
      name: "obsbot_tail2_gimbal_speed",
      description:
        "Jog the Tail 2's gimbal: per-axis SPEED (sign = direction, magnitude = speed, ±150 of " +
        "the firmware's ±178 range) with an automatic stop after durationMs (default 500, max " +
        "5000). This is the joystick primitive (POST ptz/gimbalcontrol) — there is no absolute " +
        "move endpoint, so the camera moves continuously until stopped; this tool always stops " +
        "it. Measured: command 20 ≈ 7.9°/s, and a POSITIVE yaw command DECREASES the recorded " +
        "yaw (obsbot_tail2_gimbal_position's convention). Disable AI tracking first or it will " +
        "fight the move.",
      schema: gimbalSpeedSchema,
      handler: async (args: unknown) => {
        const { camera, yaw, pitch, roll, durationMs } = gimbalSpeedSchema.parse(args);
        if (yaw === undefined && pitch === undefined && roll === undefined) {
          throw new Error("give at least one of yaw, pitch, roll (a speed to drive)");
        }
        const { api } = await registry.resolve(camera);
        const t0 = Date.now();
        try {
          await api.gimbalSpeed(yaw ?? 0, pitch ?? 0, roll ?? 0);
          await new Promise((r) => setTimeout(r, durationMs ?? 500));
        } finally {
          await api.gimbalStop();
        }
        return { ok: true, droveMs: Date.now() - t0, stopped: true };
      },
    },
    {
      name: "obsbot_tail2_gimbal_move",
      description:
        "Move the Tail 2's gimbal to an absolute yaw/pitch in degrees — the Tail 2's pose-record " +
        "convention (obsbot_tail2_gimbal_position reports the same axes). There is no move-to-" +
        "angle endpoint in the API, so this is a closed loop over the speed primitive: jog, read " +
        "the pose (each read ~2s), correct, up to 5 rounds, tolerance ±1.5°. Slow by design — " +
        "expect ~5-15s. REFUSES while AI tracking is active (tracking drives the gimbal itself " +
        "and would fight the loop); obsbot_tail2_ai_track enabled:false first.",
      schema: gimbalMoveSchema,
      handler: async (args: unknown) => {
        const { camera, yaw, pitch } = gimbalMoveSchema.parse(args);
        if (yaw === undefined && pitch === undefined) {
          throw new Error("give at least one of yaw, pitch to move to");
        }
        const { api } = await registry.resolve(camera);
        const { mode } = await api.aiModeGet();
        if (mode !== "none") {
          throw new Error(
            `AI tracking is active (${mode}) and drives the gimbal itself — it would fight the move. ` +
              `Call obsbot_tail2_ai_track with enabled:false first.`,
          );
        }
        const result = await moveAbsolute(
          {
            readPose: () => api.readPose(),
            speedCmd: (y, p) => api.gimbalSpeed(y, p, 0),
            stop: () => api.gimbalStop(),
            sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
          },
          { yaw, pitch },
        );
        return {
          ok: true,
          ...result,
          note: result.converged
            ? undefined
            : "did not converge within the iteration budget — the pose is as close as it got; retry or jog with obsbot_tail2_gimbal_speed",
        };
      },
    },
    {
      name: "obsbot_tail2_gimbal_invert",
      description:
        "Read or set the Tail 2's control-direction inversion (gimbalinvert). Call with no " +
        "arguments to read; pass enable to write (verified by readback).",
      schema: gimbalInvertSchema,
      handler: async (args: unknown) => {
        const { camera, enable } = gimbalInvertSchema.parse(args);
        const { api } = await registry.resolve(camera);
        if (enable === undefined) return await api.gimbalInvertGet();
        const r = await api.gimbalInvertSet(enable);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_record",
      description:
        "Read (bare call) or control (enable) the Tail 2's recording switch over REST. Recording " +
        "needs storage — with no SD card the state still reads (\"off\") but starting will not " +
        "succeed; check obsbot_tail2_status's sdcard field first.",
      schema: withCamera({ enable: bool().optional() }),
      handler: async (args: unknown) => {
        const { camera, enable } = withCamera({ enable: bool().optional() }).parse(args);
        const { api } = await registry.resolve(camera);
        if (enable === undefined) return await api.recordGet();
        const r = await api.recordSet(enable);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_capture_photo",
      description:
        "Trigger a still-photo capture on the Tail 2 (POST capture/trigger). Needs storage (SD " +
        "card — check obsbot_tail2_status's sdcard field). The ack means the camera accepted the " +
        "trigger; the photo lands on the card (see obsbot_tail2_status / album).",
      schema: withCamera({}),
      handler: async (args: unknown) => {
        const { camera } = withCamera({}).parse(args);
        const { api } = await registry.resolve(camera);
        await api.captureTrigger();
        return { ok: true };
      },
    },
    {
      name: "obsbot_tail2_track_target",
      description:
        "Tap-to-track: give a normalized frame coordinate (x/y 0.01-0.99, top-left ~0,0) and the " +
        "camera engages AI tracking on the subject there — measured to arm humanTrackingSingleMode " +
        "on its own from mode none. Divide a snapshot pixel by frameWidth/frameHeight and pass it " +
        "straight in. The mode that engages depends on what is at the point, so read it back " +
        "(obsbot_tail2_status ai_mode) when it matters; objectTracking cannot be entered this way " +
        "(it demands a bounding box the API grammar for which is not yet decoded).",
      schema: withCamera({
        x: num().pipe(z.number().min(0.01).max(0.99)),
        y: num().pipe(z.number().min(0.01).max(0.99)),
      }),
      handler: async (args: unknown) => {
        const schema = withCamera({
          x: num().pipe(z.number().min(0.01).max(0.99)),
          y: num().pipe(z.number().min(0.01).max(0.99)),
        });
        const { camera, x, y } = schema.parse(args);
        const { api } = await registry.resolve(camera);
        await api.targetSelect(x, y);
        const { mode } = await api.aiModeGet();
        return { ok: true, x, y, aiMode: mode };
      },
    },
    {
      name: "obsbot_tail2_focus_point",
      description:
        "Tap-to-focus: move the focus window to a normalized frame coordinate (x/y 0.01-0.99, " +
        "top-left ~0,0) AND start a point focus there. Effective in afc/afs focus modes only — " +
        "in mf the motor position is the tool (obsbot_tail2_focus). Bare call reads the current " +
        "window. Divide a snapshot pixel by frameWidth/frameHeight and pass it straight in.",
      schema: withCamera({
        x: num().pipe(z.number().min(0.01).max(0.99)).optional(),
        y: num().pipe(z.number().min(0.01).max(0.99)).optional(),
      }),
      handler: async (args: unknown) => {
        const schema = withCamera({
          x: num().pipe(z.number().min(0.01).max(0.99)).optional(),
          y: num().pipe(z.number().min(0.01).max(0.99)).optional(),
        });
        const { camera, x, y } = schema.parse(args);
        const { api } = await registry.resolve(camera);
        if (x === undefined && y === undefined) return await api.focusWindowGet();
        if (x === undefined || y === undefined) {
          throw new Error("x and y go together — give both or neither");
        }
        const { mode } = await api.focusModeGet();
        if (mode === "mf") {
          throw new Error(
            `focus window applies in afc/afs only (current: ${mode}). ` +
              `In mf, drive the motor with obsbot_tail2_focus position instead.`,
          );
        }
        const r = await api.focusWindowSet(x, y);
        return { ok: true, ...r, pointFocusStarted: true };
      },
    },
    {
      name: "obsbot_tail2_focus",
      description:
        "Read (bare call) or set the Tail 2's focus: mode afc|afs|mf, and position (0-100, the " +
        "focus motor) which is only valid in mf — the camera errors on it in afc/afs and this " +
        "tool refuses rather than trigger that. Bare call reports the mode, and the position " +
        "when in mf.",
      schema: withCamera({
        mode: z.enum(["afc", "afs", "mf"]).optional(),
        position: num().pipe(z.number().min(0).max(100)).optional(),
      }),
      handler: async (args: unknown) => {
        const { camera, mode, position } = withCamera({
          mode: z.enum(["afc", "afs", "mf"]).optional(),
          position: num().pipe(z.number().min(0).max(100)).optional(),
        }).parse(args);
        const { api } = await registry.resolve(camera);
        const out: Record<string, unknown> = {};
        if (mode !== undefined) Object.assign(out, await api.focusModeSet(mode));
        const current = await api.focusModeGet();
        if (position !== undefined) {
          if (current.mode !== "mf") {
            throw new Error(
              `focus position is only valid in mf (current: ${current.mode}). Set mode:"mf" first.`,
            );
          }
          Object.assign(out, await api.focusPositionSet(position));
        } else if (current.mode === "mf") {
          // Readable only in mf (HTTP 500 otherwise — measured).
          out.position = (await api.focusPositionGet()).position;
        }
        return { mode: current.mode, ...out };
      },
    },
    {
      name: "obsbot_tail2_exposure",
      description:
        "Read (bare call) or set the Tail 2's exposure. mode manual|auto; in AUTO: face " +
        "(face-priority AE, global|face) and evbias (-3.0..3.0, ~0.3 steps); in MANUAL: iso " +
        "(100-6400) and shutter (\"1/N\", 1/6400..1/30). Manual values only exist in manual mode " +
        "and face/evbias only in auto — a bare call reports whichever set the current mode " +
        "exposes. Note: the camera's manual ISO granularity is finer than the doc claims " +
        "(a live-AE value like 894 reads back).",
      schema: withCamera({
        mode: z.enum(["manual", "auto"]).optional(),
        face: bool().optional(),
        evbias: num().pipe(z.number().min(-3).max(3)).optional(),
        iso: num().pipe(z.number().min(100).max(6400)).optional(),
        shutter: z.string().regex(/^1\/\d+$/).optional(),
      }),
      handler: async (args: unknown) => {
        const schema = withCamera({
          mode: z.enum(["manual", "auto"]).optional(),
          face: bool().optional(),
          evbias: num().pipe(z.number().min(-3).max(3)).optional(),
          iso: num().pipe(z.number().min(100).max(6400)).optional(),
          shutter: z.string().regex(/^1\/\d+$/).optional(),
        });
        const { camera, mode, face, evbias, iso, shutter } = schema.parse(args);
        const { api } = await registry.resolve(camera);
        const out: Record<string, unknown> = {};
        if (mode !== undefined) Object.assign(out, await api.exposureModeSet(mode));
        if (face !== undefined) Object.assign(out, await api.exposureAutoModeSet(face ? "face" : "global"));
        if (evbias !== undefined) Object.assign(out, await api.exposureEvbiasSet(evbias));
        if (iso !== undefined) Object.assign(out, await api.exposureIsoSet(iso));
        if (shutter !== undefined) Object.assign(out, await api.exposureShutterSet(shutter));
        // Mode-appropriate reads (the other mode's values are gated off —
        // HTTP 500 — so only what exists now is reported). The AE sub-mode's
        // key is also "mode" — renamed so it cannot clobber the exposure mode.
        const { mode: current } = await api.exposureModeGet();
        const read: Record<string, unknown> = { mode: current };
        if (current === "auto") {
          read.autoMode = (await api.exposureAutoModeGet()).mode;
          Object.assign(read, await api.exposureEvbiasGet());
        } else {
          Object.assign(read, await api.exposureIsoGet());
          Object.assign(read, await api.exposureShutterGet());
        }
        return { ...read, ...(Object.keys(out).length ? { applied: out } : {}) };
      },
    },
    {
      name: "obsbot_tail2_image_adjust",
      description:
        "Read (bare call) or set the Tail 2's image style: brightness/contrast/hue/saturation/" +
        "sharpness, each an absolute 0-100, plus styleMode standard|outdoor|pastel|manual. " +
        "Individual control writes are MODE-GATED (measured): they apply only in styleMode " +
        "manual — HTTP 500 \"style mode is not manual\" otherwise — so this tool applies a " +
        "given styleMode FIRST and refuses a control write in a preset mode. A styleMode switch " +
        "preserves the current values. Bare call returns the full style bundle.",
      schema: withCamera({
        control: z.enum(["brightness", "contrast", "hue", "saturation", "sharpness"]).optional(),
        value: num().pipe(z.number().min(0).max(100)).optional(),
        styleMode: z.enum(["standard", "outdoor", "pastel", "manual"]).optional(),
      }),
      handler: async (args: unknown) => {
        const schema = withCamera({
          control: z.enum(["brightness", "contrast", "hue", "saturation", "sharpness"]).optional(),
          value: num().pipe(z.number().min(0).max(100)).optional(),
          styleMode: z.enum(["standard", "outdoor", "pastel", "manual"]).optional(),
        });
        const { camera, control, value, styleMode } = schema.parse(args);
        if ((control === undefined) !== (value === undefined)) {
          throw new Error("control and value go together — give both or neither");
        }
        const { api } = await registry.resolve(camera);
        const out: Record<string, unknown> = {};
        if (styleMode !== undefined) Object.assign(out, await api.styleModeSet(styleMode));
        if (control !== undefined && value !== undefined) {
          const { mode } = await api.styleGet();
          if (mode !== "manual") {
            throw new Error(
              `style writes apply only in styleMode manual (current: ${mode}). ` +
                `Pass styleMode:"manual" alongside, or switch first.`,
            );
          }
          Object.assign(out, await api.styleSet(control, value));
        }
        return { ...await api.styleGet(), ...(Object.keys(out).length ? { applied: out } : {}) };
      },
    },
    {
      name: "obsbot_tail2_hdr",
      description: "Read (bare call) or set (enabled) the Tail 2's HDR.",
      schema: withCamera({ enabled: bool().optional() }),
      handler: async (args: unknown) => {
        const { camera, enabled } = withCamera({ enabled: bool().optional() }).parse(args);
        const { api } = await registry.resolve(camera);
        if (enabled === undefined) return await api.hdrGet();
        const r = await api.hdrSet(enabled);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_wb",
      description:
        "Read (bare call) or set the Tail 2's white balance: mode auto|daylight|fluorescent|" +
        "tungsten|cloudy|manual, plus temperature in Kelvin (2000-10000) which applies in " +
        "manual mode.",
      schema: withCamera({
        mode: z.enum(["auto", "daylight", "fluorescent", "tungsten", "cloudy", "manual"]).optional(),
        temperature: num().pipe(z.number().min(2000).max(10000)).optional(),
      }),
      handler: async (args: unknown) => {
        const schema = withCamera({
          mode: z.enum(["auto", "daylight", "fluorescent", "tungsten", "cloudy", "manual"]).optional(),
          temperature: num().pipe(z.number().min(2000).max(10000)).optional(),
        });
        const { camera, mode, temperature } = schema.parse(args);
        const { api } = await registry.resolve(camera);
        if (mode === undefined && temperature === undefined) return await api.wbConfigGet();
        const r = await api.wbConfigSet(mode ?? "manual", temperature);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_stream",
      description:
        "Read (bare call) or set the Tail 2's active network output: ndi|rtsp|srt|off — exactly " +
        "ONE is active at a time (setting srt displaces ndi, and a camera reboot resets to off). " +
        "This is the programmatic way to arm SRT for obsbot_tail2_snapshot without touching " +
        "OBSBOT Center.",
      schema: withCamera({ output: z.enum(["ndi", "rtsp", "srt", "off"]).optional() }),
      handler: async (args: unknown) => {
        const { camera, output } = withCamera({
          output: z.enum(["ndi", "rtsp", "srt", "off"]).optional(),
        }).parse(args);
        const { api } = await registry.resolve(camera);
        if (output === undefined) return await api.streamControlGet();
        const r = await api.streamControlSet(output);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_only_me",
      description:
        "Read (bare call) or set (enabled) the Tail 2's OnlyMe human-tracking switch — track " +
        "only the nearest/locked person rather than reframing for everyone.",
      schema: withCamera({ enabled: bool().optional() }),
      handler: async (args: unknown) => {
        const { camera, enabled } = withCamera({ enabled: bool().optional() }).parse(args);
        const { api } = await registry.resolve(camera);
        if (enabled === undefined) return await api.onlyMeGet();
        const r = await api.onlyMeSet(enabled);
        return { ok: true, ...r };
      },
    },
    {
      name: "obsbot_tail2_audio",
      description:
        "Read (bare call) or set the Tail 2's audio input: volume 0-100 and mute. Changes apply " +
        "to the encoded/recorded audio stream.",
      schema: withCamera({
        volume: num().pipe(z.number().min(0).max(100)).optional(),
        mute: bool().optional(),
      }),
      handler: async (args: unknown) => {
        const schema = withCamera({
          volume: num().pipe(z.number().min(0).max(100)).optional(),
          mute: bool().optional(),
        });
        const { camera, volume, mute } = schema.parse(args);
        const { api } = await registry.resolve(camera);
        const out: Record<string, unknown> = {};
        if (volume !== undefined) Object.assign(out, await api.audioVolumeSet(volume));
        if (mute !== undefined) Object.assign(out, await api.audioMuteSet(mute));
        return {
          ...(await api.audioVolumeGet()),
          ...(await api.audioMuteGet()),
          ...(Object.keys(out).length ? { applied: out } : {}),
        };
      },
    },
    {
      name: "obsbot_tail2_portrait",
      description:
        "Rotate a Tail 2's barrel 90° for portrait framing (enable) or back to landscape " +
        "(disable) — a motorized physical rotation no Tiny 2 has. Takes ~1.5s; the tool " +
        "polls the status push for the new orientation and returns settled:false if the " +
        "motor hadn't finished within ~5s. MEASURED 2026-09-26: while the motor is in " +
        "motion the camera can acknowledge a write and silently drop it — if settled stays " +
        "false, retry the command. Hardware-verified both directions.",
      schema: portraitSchema,
      handler: async (args: unknown) => {
        const { enable, camera } = portraitSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.portraitSet(enable);
        return { ok: true, portrait: r.switch_portrait, settled: r.settled, note: SETTLED_NOTE };
      },
    },
    {
      name: "obsbot_tail2_roll_bias",
      description:
        "Set a Tail 2's roll trim angle in degrees (horizon correction / deliberate tilt), " +
        "clamped to ±90. Unlike the Tiny 2 (whose roll slot is inert), this moves the " +
        "image. Verified write+readback on hardware 2026-09-26.",
      schema: rollBiasSchema,
      handler: async (args: unknown) => {
        const { angle, camera } = rollBiasSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.rollBiasSet(angle);
        return { ok: true, angle: r.angle, settled: r.settled };
      },
    },
    {
      name: "obsbot_tail2_ai_track",
      description:
        "Enable or disable a Tail 2's AI tracking. enabled:false stops tracking (mode `none`). " +
        "enabled:true starts the chosen mode — default humanTrackingSingleMode (single-person " +
        "framing, the camera's power-on default); also group human framing, animal tracking, " +
        "and object tracking (the mode strings are the camera's own enum). NOTE: while " +
        "tracking is active it owns the gimbal — manual moves fight it, and a recenter can " +
        "drop tracking to none. Mode strings verified against firmware 7.2.13.1.",
      schema: aiTrackSchema,
      handler: async (args: unknown) => {
        const { enabled, mode, camera } = aiTrackSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.aiModeSet(enabled ? mode : "none");
        return {
          ok: true,
          mode: r.mode,
          settled: r.settled,
          ...(r.settled ? {} : { note: SETTLED_NOTE }),
        };
      },
    },
    {
      name: "obsbot_tail2_track_speed",
      description:
        "Set a Tail 2's tracking follow speed: superLazy | lazy | slow | fast | crazy | " +
        "customized — the camera's own six-speed enum (NOT the Tiny 2's standard/sport " +
        "pair). Verified by readback on hardware 2026-09-26.",
      schema: trackSpeedSchema,
      handler: async (args: unknown) => {
        const { speed, camera } = trackSpeedSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.trackSpeedSet(speed);
        return { ok: true, speed: r.speed, settled: r.settled };
      },
    },
    {
      name: "obsbot_tail2_preset_list",
      description:
        "List a Tail 2's three preset slots: occupied/empty, decoded name, and pose in " +
        "degrees + zoom ratio (pitch/yaw/roll/ratio). Slot numbers are 1–3 (the camera's " +
        "own ids are 0-based; mapped for consistency with the Tiny 2 preset tools).",
      schema: presetListSchema,
      handler: async (args: unknown) => {
        const { camera } = presetListSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const presets = await api.presetsGet();
        return {
          slots: [0, 1, 2].map((id) => {
            const p = presets.find((x) => x.id === id);
            return p
              ? { slot: id + 1, occupied: true, name: p.name, pose: { yaw: p.yaw, pitch: p.pitch, roll: p.roll, ratio: p.ratio } }
              : { slot: id + 1, occupied: false, name: null, pose: null };
          }),
        };
      },
    },
    {
      name: "obsbot_tail2_preset_save",
      description:
        "Save a Tail 2's CURRENT live pose into a slot (1–3): aim the camera first (via " +
        "tracking, a recall, or physically), then save. name defaults to P1/P2/P3. NOTE: " +
        PRESET_SHAPE_NOTE +
        " — deleting first is unnecessary. Hardware-verified 2026-09-26.",
      schema: presetSaveSchema,
      handler: async (args: unknown) => {
        const { slot, name, camera } = presetSaveSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.presetSave(slot - 1, name ?? `P${slot}`);
        return { ok: true, slot, settled: r.settled, presets: r.presets };
      },
    },
    {
      name: "obsbot_tail2_preset_recall",
      description:
        "Recall a Tail 2 preset slot (1–3): drives the gimbal and zoom to the saved pose. " +
        "Refuses an empty slot. Arrival is verified through the only live observable — the " +
        "zoom ratio from the status push — so gimbal axes are open-loop (the Tail 2 reports " +
        "no live pose). Disable AI tracking first or it will fight the move. " +
        "Hardware-verified 2026-09-26 (zoom 1.5 → saved 3.0 observed).",
      schema: presetSlotSchema,
      handler: async (args: unknown) => {
        const { slot, camera } = presetSlotSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.presetRecall(slot - 1);
        return { ok: true, slot, settled: r.settled, zoom: r.zoom };
      },
    },
    {
      name: "obsbot_tail2_preset_delete",
      description:
        "Delete a Tail 2 preset slot (1–3), freeing it. Verified by the slot disappearing " +
        "from the list.",
      schema: presetSlotSchema,
      handler: async (args: unknown) => {
        const { slot, camera } = presetSlotSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.presetDelete(slot - 1);
        return { ok: true, slot, settled: r.settled };
      },
    },
    {
      name: "obsbot_tail2_preset_rename",
      description:
        "Rename a Tail 2 preset slot (1–3). Names travel base64 on the wire; the tool " +
        "encodes/decodes transparently (up to 40 chars).",
      schema: presetRenameSchema,
      handler: async (args: unknown) => {
        const { slot, name, camera } = presetRenameSchema.parse(args);
        const { api } = await registry.resolve(camera);
        const r = await api.presetRename(slot - 1, name);
        return { ok: true, slot, settled: r.settled };
      },
    },
    {
      name: "obsbot_tail2_snapshot",
      description:
        "Grab one still frame from a Tail 2 and return it as an image (for framing/lighting " +
        "checks — and for measuring pixels). Source: the camera's SRT output via ffmpeg SRT " +
        "caller (port 5000) — requires SRT listener mode in OBSBOT Center; exclusive with NDI, " +
        "cleared by reboots, and Center only allows changing streaming settings while the output " +
        "is off. Serves immediately once on. If SRT is off, returns a report of what it found " +
        "with the available options and their costs (SRT toggle, NDI Webcam bridge caveats, " +
        "NDI Tools install) so you can pick the cheapest path instead of dead-ending. " +
        "resolution is the longest edge (256–1920, default 640); quality 1–100 (default 80). " +
        "Needs ffmpeg. Frames are 16:9 1080p-sourced.",
      schema: snapshotSchema,
      handler: async (args: unknown) => {
        const { resolution, quality, camera } = snapshotSchema.parse(args);
        const entry = await registry.resolve(camera);
        const status = await entry.api.status();
        if (status.srt?.enable === true) {
          const host = entry.hosts[0]!;
          const snap = await grab(host, { maxDim: resolution, quality });
          return {
            content: [
              { type: "image", data: snap.base64, mimeType: snap.mime },
              {
                type: "text",
                text: JSON.stringify({ width: snap.width, height: snap.height, source: "srt" }),
              },
            ],
          };
        }
        // SRT off. The NDI Webcam bridge is deliberately NOT attempted
        // automatically: on the reference machine (2026-09-26) its configured
        // output slots delivered uniformly black frames to ffmpeg while other
        // slots hung — an auto-grab would either stall or return a confident
        // black image. Probing the slots also disrupts the bridge app. Report
        // options instead; SRT remains the autonomous path.
        const ndiOn = status.ndi?.enable === true;
        const tools = ndiToolsInstalled();
        const lines = [
          `No video source is currently grabbable from this Tail 2 (SRT off${ndiOn ? ", NDI on" : ", NDI off"}).`,
          "",
          "Options:",
          `1. Enable SRT listener mode in OBSBOT Center for this camera (streaming settings; the toggle ` +
            `disables NDI while active and is cleared by a camera reboot). Serves immediately once on — ` +
            `this tool then grabs autonomously. Recommended for agent-driven use.`,
          ...(tools
            ? [
                `2. NDI Webcam bridge (NDI Tools is installed): with NDI on and the bridge running, ` +
                  `its 'NDI Webcam' DirectShow output can be read with ffmpeg. NOT attempted automatically: ` +
                  `on the reference machine the configured slots delivered black frames and probing the ` +
                  `app's devices disrupts it. If you verify a slot carries live video (e.g. OBS can preview ` +
                  `it), this becomes a no-camera-changes source — but treat it as unverified until then.`,
                `   WARNING: never force-kill the Webcam app (taskkill /f) — that corrupts its output-slot ` +
                  `configuration; close it through its own UI.`,
              ]
            : []),
          `3. Install NDI Tools (https://ndi.video/tools/) for option 2, or an NDI-capable ffmpeg build.`,
        ];
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      },
    },
  ];
}
