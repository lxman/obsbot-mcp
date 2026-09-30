import { z } from "zod";
import type { ToolDef } from "../mcp/tools.js";
import type { Tail2Registry } from "./registry.js";
import { srtSnapshot, ndiToolsInstalled, type SrtSnapshot } from "./snapshot.js";

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
