import { z } from "zod";
import {
  encodeSetRunStatus,
  encodePtzMoveAngle,
  encodePtzMoveSpeed,
  encodeRecenter,
  zoomRatioToUnits,
  encodeAiTrackSpeed,
  encodeAiTracking,
  encodeAiMode,
  encodeFaceAe,
  encodeVendorProbe,
  encodeZoomWithSpeed,
  encodeFaceFocus,
  encodeSetExposureMode,
  encodeSetExposureValue,
  encodeGetExposureRange,
  decodeExposureRange,
  decodeStatus,
  encodeFov,
  encodeHdr,
  percentToRange,
  AI_FRAMING_MODES,
  AI_SCENE_MODES,
  AI_TRACK_SPEEDS,
  FOV_TYPES,
  UVC_XU_SELECTOR,
  CAMERA_CONTROL_PAN,
  CAMERA_CONTROL_TILT,
  CAMERA_CONTROL_FOCUS,
  VIDEO_PROCAMP_WHITE_BALANCE,
  IMAGE_CONTROL_PROP,
  IMAGE_CONTROLS,
  UVC_FLAG_AUTO,
  UVC_FLAG_MANUAL,
} from "../codec/commands.js";
import type { AiTrackSpeed, AiFramingMode, AiSceneMode, AiModeStatus, FovType, ImageControl } from "../codec/commands.js";
import { verifyFraming } from "./framing.js";
import { parseFrame } from "../codec/frame.js";
import {
  decodePresetList,
  decodePresetEntry,
  assemblePresetSlots,
  implausiblePresetListReason,
  encodePresetAdd,
  encodePresetUpdate,
  encodePresetRecall,
  encodePresetDelete,
  encodePresetSetName,
  encodeGimBootPosSet,
  encodeGimBootPosReset,
  encodeGimBootPosTrigger,
} from "../codec/preset.js";
import type { PresetSlot, PresetPose } from "../codec/preset.js";
import { ObsbotTransport, CameraBusyError } from "../transport/transport.js";
import { DeviceManager } from "../device/manager.js";
import { DeviceSession } from "../device/session.js";
import { ensureReady, msg } from "./ready.js";
import type { ReadyResult } from "./ready.js";
import type { CaptureManager } from "../capture/manager.js";
import { CaptureError } from "../capture/manager.js";

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<object>;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// Some MCP clients serialize numbers and booleans as strings when the advertised
// inputSchema lacks type info. We now advertise a proper JSON Schema (see
// mcp/server.ts), but also accept string-encoded values defensively so the tools
// work with any client. Booleans are coerced EXPLICITLY — z.coerce.boolean()
// maps any non-empty string (including "false") to true, which would be a bug.
const num = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v),
    z.number(),
  );
const bool = () =>
  z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    z.boolean(),
  );

const listDevicesSchema = z.object({});
const setRunStatusSchema = z.object({ state: z.enum(["run", "sleep"]) });
const ptzMoveAngleSchema = z.object({
  yaw: num(),
  pitch: num(),
  roll: num().default(0),
});
const ptzMoveSpeedSchema = z.object({
  yaw: num(),
  pitch: num(),
  roll: num().default(0),
  autoStopMs: num().default(800),
});
const gimbalRecenterSchema = z.object({});
const zoomAbsoluteSchema = z.object({ ratio: num() });

// mode covers the human framings AND the standalone scene modes (group/whiteboard/
// desk/hand). For a framing, enable = human tracking with that framing; for a scene
// mode, `enabled` is implied true (disable via enabled:false, which cancels tracking).
const AI_TRACKING_MODES = [...AI_FRAMING_MODES, ...AI_SCENE_MODES];
const aiTrackingSchema = z.object({
  enabled: bool(),
  mode: z.enum(AI_TRACKING_MODES as [string, ...string[]]).default("normal"),
});
const isSceneMode = (m: string): m is AiSceneMode => (AI_SCENE_MODES as string[]).includes(m);
const aiTrackSpeedSchema = z.object({
  speed: z.enum(AI_TRACK_SPEEDS as [AiTrackSpeed, ...AiTrackSpeed[]]),
});
const zoomSpeedSchema = z.object({
  ratio: num(),
  speed: num().default(0),
});
const faceFocusSchema = z.object({ enabled: bool() });
const getStatusSchema = z.object({});
// Generic RE/spelunking primitive: raw send-bytes / get-bytes on any XU selector,
// plus a `query` convenience that frames a table opcode and reads the reply.
const probeSchema = z.object({
  mode: z.enum(["get", "set", "query"]),
  selector: num().pipe(z.number().int().min(0).max(255)).optional(),
  length: num().pipe(z.number().int().min(1).max(1024)).optional(),
  hex: z.string().optional(),        // raw bytes for mode "set"
  opcode: z.string().optional(),     // table opcode name for mode "query"
  payloadHex: z.string().optional(), // nested payload for mode "query"
});
const fovSchema = z.object({ fov: z.enum(FOV_TYPES as [FovType, ...FovType[]]) });
const hdrSchema = z.object({ enabled: bool() });
const focusSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  position: num().pipe(z.number().min(0).max(100)).default(50),
});
const whiteBalanceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  temperature: num().default(5000),
});
const imageControlSchema = z.object({
  control: z.enum(IMAGE_CONTROLS as [ImageControl, ...ImageControl[]]),
  level: num().pipe(z.number().min(0).max(100)),
});
const exposureSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  level: num().pipe(z.number().min(0).max(100)).default(50),
  // Auto-exposure metering priority: global (whole frame) or face. Only meaningful
  // with mode 'auto'; ignored for manual. Optional so existing calls are unchanged.
  priority: z.enum(["global", "face"]).optional(),
});
const gimbalPositionSchema = z.object({});
const presetListSchema = z.object({});
const presetSaveSchema = z.object({
  slot: num().pipe(z.union([z.literal(1), z.literal(2), z.literal(3)])),
});
const presetSlotSchema = z.object({
  slot: num().pipe(z.union([z.literal(1), z.literal(2), z.literal(3)])),
});
const presetRecallSchema = presetSlotSchema;
const presetUpdateSchema = z.object({
  slot: num().pipe(z.union([z.literal(1), z.literal(2), z.literal(3)])),
});
const presetRenameSchema = z.object({
  slot: num().pipe(z.union([z.literal(1), z.literal(2), z.literal(3)])),
  name: z.string(),
});
const presetDeleteSchema = presetSlotSchema;
const bootPoseSchema = z.object({ action: z.enum(["set", "clear", "goto"]) });
// Rename frame payload is u32le(slot-1) [4 bytes] + ASCII name, inside a fixed 60-byte
// frame whose payload region starts at offset 16 (see buildFrame). Max payload is
// 60-16=44 bytes, so the name must fit in 44-4=40 bytes.
const PRESET_NAME_MAX = 40;
const snapshotSchema = z.object({
  maxDim: num().pipe(z.number().min(256).max(1920)).default(1024),
  quality: num().pipe(z.number().min(1).max(100)).default(80),
  settleMs: num().pipe(z.number().min(0).max(5000)).default(600),
  source: z.enum(["device", "virtual", "ndi"]).default("device"),
});

const captureSourceEnum = z.enum(["device", "virtual", "ndi"]);
const recordStartSchema = z.object({
  durationSec: num().pipe(z.number().positive()).optional(),
  audio: bool().default(true),
  outputPath: z.string().optional(),
  source: captureSourceEnum.default("device"),
});
const previewStartSchema = z.object({ source: captureSourceEnum.default("device") });
const captureStopSchema = z.object({ sessionId: z.string() });
const captureListSchema = z.object({});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Preset read path: flat XU selectors 12 (list) + 13 (entry cursor). Hardware-verified
// 2026-07-19 — NOT the framed-reply model (recvVendor + parseFrame); reads on the
// vendor reply path just return the flat status block for this device. Three steps:
//   1. GET selector 12 -> <count:u8> <slotIdx:u8> x count
//   2. echo-write the just-read bytes back to selector 12 -> resets the entry cursor
//      (echo is provably non-destructive; do NOT write zeros/synthesized bytes)
//   3. GET selector 13, `count` times -> each read returns the next preset entry and
//      advances the cursor, until the exhausted marker (status 0x02)
//
// Occupancy gates a create-once resource (save requires EMPTY, everything else
// requires OCCUPIED), so a falsely-"empty" read here drives an irreversible write.
// C1/I1/I3 below are all facets of the same unifying fix: never trust device bytes
// enough to act on them (or echo them back) without a plausibility/consistency check.
const isAllZero = (b: Buffer): boolean => b.equals(Buffer.alloc(b.length));

// A genuinely EMPTY device and a not-serving read BOTH return an all-zero selector-12
// block (hardware-established 2026-07-19 under controlled conditions: OBSBOT Center
// closed so nothing could re-assert presets, camera measured awake at the moment of
// the read, stable across repeated reads). So the block alone cannot tell them apart.
//
// Corroborate on the SAME XU surface and handle: the status block. When selector 12
// read zeros on a genuinely empty device, the status block still returned real
// non-zero data — a dead link or stale handle would zero BOTH.
//
// The check is deliberately TWO-part. decodeStatus reports awake for an ALL-ZERO block
// (awake === block[0x02] === 0), so testing `awake` alone would let a dead link
// masquerade as an empty device — manufacturing the exact false-EMPTY that gates the
// irreversible create-once ADD. Requiring the status block to be non-zero AND awake
// makes emptiness something we accept only on positive evidence.
//
// NOTE: UVC liveness is NOT valid corroboration here — obsbot_gimbal_position returns
// a correct live pose even while the preset selectors aren't serving.
async function presetSubsystemServing(t: ObsbotTransport): Promise<boolean> {
  try {
    const status = await t.recvStatus(60);
    if (isAllZero(status)) return false;
    return decodeStatus(status).awake;
  } catch {
    return false;
  }
}

async function getPresetSlots(t: ObsbotTransport): Promise<PresetSlot[]> {
  const block = await t.xuGetRaw(12, 60);
  // Zero presets is a legitimate device state, and every preset tool routes through
  // here — so refusing it outright left our toolset with no path OUT of it (save was
  // gated behind the read that fails, making the first preset uncreatable where
  // OBSBOT Center doesn't exist). Accept it only with positive corroboration, and
  // skip the echo-write: with no entries there is no cursor to reset, which removes
  // the C1 hazard at its root on this path rather than bypassing the check.
  if (isAllZero(block) && (await presetSubsystemServing(t))) {
    return assemblePresetSlots([]);
  }
  // C1: validate BEFORE the echo-write — see implausiblePresetListReason. A
  // failed/short/garbage read must never be echoed back to a selector whose
  // write semantics for anything but a genuine echo are undecoded.
  const reason = implausiblePresetListReason(block);
  if (reason) {
    throw new Error(`preset list read implausible, refusing to reset the cursor: ${reason}`);
  }
  const list = decodePresetList(block);
  await t.xuRaw(12, block); // echo-write resets the cursor — load-bearing, see above

  // I3: never walk more entries than the device physically has, no matter what
  // `count` claimed. C1 already rejects count>3 above, but this clamp is a
  // second, independent guard against turning a garbage count into up to 255
  // USB control transfers.
  const walkCount = Math.min(list.count, 3);
  const per: { slot: 1 | 2 | 3; name: string; pose: PresetPose }[] = [];
  for (let i = 0; i < walkCount; i++) {
    const e = decodePresetEntry(await t.xuGetRaw(13, 60));
    if (e.end) break;
    per.push({ slot: e.slot!, name: e.name!, pose: e.pose! });
  }

  // I1: list.slots (from selector 12) is the device's own statement of WHICH
  // slots are occupied. If the entry-cursor walk (selector 13) disagrees — it
  // exhausted early, hit an implausible/all-zero entry, or decoded a different
  // slot set — don't silently trust whichever answer under-reports. A false
  // EMPTY is the dangerous direction for a create-once resource, so fail loudly
  // instead of returning a confident wrong answer.
  const walked = [...new Set(per.map((e) => e.slot - 1))].sort((a, b) => a - b);
  const claimed = [...list.slots].sort((a, b) => a - b);
  const agree = walked.length === claimed.length && walked.every((s, i) => s === claimed[i]);
  if (!agree) {
    throw new Error(
      `preset list mismatch: selector 12 claims occupied slots [${claimed.join(",")}] but the ` +
        `entry-cursor walk (selector 13) found [${walked.join(",")}]`,
    );
  }

  return assemblePresetSlots(per);
}

export interface PresetReadOpts {
  attempts?: number;
  backoffMs?: number[];
}

// This is a mechanical system: the gimbal does not switch between awake and asleep,
// it travels through them (rising, settling, stowing), and subsystems come back
// online in some order. A single sample of a system in motion describes one instant,
// not the state the next call lands in — so a lone implausible read is expected
// occasionally and is not, by itself, news.
//
// Backoff spans ~1.7s, chosen against the observed ~1-2s post-wake self-centering
// window. Latency is the cheapest thing we can spend here.
const PRESET_READ_DEFAULTS: Required<PresetReadOpts> = { attempts: 3, backoffMs: [200, 500, 1000] };

const napMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const allEmpty = (slots: PresetSlot[]): boolean => slots.every((s) => !s.occupied);

/**
 * Read the preset slots with bounded retry, and confirm the one verdict whose error
 * destroys data.
 *
 * Reads can neither damage the camera nor delete anything, so retrying and
 * re-reading is free in the only currencies that matter. Writes are never retried
 * here — the caller's write sits outside this function by construction.
 *
 * EMPTY is confirmed by a second read because it is the sole verdict that authorizes
 * an irreversible create-once ADD: a slot wrongly believed empty gets a customer's
 * preset written over (firmware behaviour there is undecoded). The inverse error is
 * benign — a slot wrongly believed occupied only makes delete a no-op and update
 * fail. Disagreement between the two reads means the device is mid-transition, so we
 * refuse rather than pick a side.
 */
async function readPresetSlots(
  t: ObsbotTransport,
  gate: () => Promise<ReadyResult>,
  opts: PresetReadOpts = {},
): Promise<PresetSlot[]> {
  const { attempts, backoffMs } = { ...PRESET_READ_DEFAULTS, ...opts };
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await napMs(backoffMs[Math.min(i - 1, backoffMs.length - 1)]);
      // Re-probe readiness between attempts: the failure mode we chase is the device
      // being partway through a transition, and the wake it may send is a decoded,
      // documented command — not an undecoded write.
      await gate();
    }
    try {
      const slots = await getPresetSlots(t);
      if (allEmpty(slots) && !allEmpty(await getPresetSlots(t))) {
        throw new Error(
          "preset list unstable: one read reported every slot empty, an immediate " +
            "re-read disagreed — refusing to treat this as empty",
        );
      }
      return slots;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export function createTools(
  getTransport: () => Promise<ObsbotTransport>,
  mgr: DeviceManager,
  capture?: CaptureManager,
  session?: DeviceSession,
  debug = false,
  presetRead: PresetReadOpts = {},
): ToolDef[] {
  // Readiness gate for gimbal/AI commands: probe presence + auto-wake if asleep,
  // self-heal (invalidate + re-open) on a mid-session disconnect. Returns the
  // ready transport or an { ok:false } error the handler passes straight through.
  const gate = () => ensureReady(getTransport, session);
  const needCapture = (): CaptureManager => {
    if (!capture) throw new Error("capture manager not configured");
    return capture;
  };
  const captureErrorText = (e: unknown): { content: Array<{ type: "text"; text: string }> } | never => {
    if (e instanceof CaptureError) return { content: [{ type: "text", text: e.message }] };
    throw e;
  };

  const toolDefs: ToolDef[] = [
    {
      name: "obsbot_list_devices",
      description: "List connected OBSBOT-compatible video capture devices.",
      schema: listDevicesSchema,
      handler: async (args: unknown) => {
        listDevicesSchema.parse(args);
        return { devices: await mgr.list() };
      },
    },
    {
      name: "obsbot_set_run_status",
      description: "Wake (\"run\") or sleep the camera/gimbal.",
      schema: setRunStatusSchema,
      handler: async (args: unknown) => {
        const { state } = setRunStatusSchema.parse(args);
        const t = await getTransport();
        await t.sendVendor(encodeSetRunStatus(state).buildFrame(t.nextSeq()));
        return { ok: true, state };
      },
    },
    {
      name: "obsbot_ptz_move_angle",
      description:
        "Move the gimbal to an absolute yaw/pitch angle (degrees); positive yaw pans to the " +
        "camera's left, positive pitch tilts down. Yaw is clamped to [-150,150], pitch to " +
        "[-90,90]. Absolute positioning (1:1 degrees), verified on hardware.",
      schema: ptzMoveAngleSchema,
      handler: async (args: unknown) => {
        const parsed = ptzMoveAngleSchema.parse(args);
        const yaw = clamp(parsed.yaw, -150, 150);
        const pitch = clamp(parsed.pitch, -90, 90);
        const roll = parsed.roll;
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        // Vendor gimbal frame AI_SET_GIM_MOTOR_DEG. The wire payload order is [roll, pitch,
        // yaw] — see encodePtzMoveAngle / gimbal3. Absolute, 1:1 degrees, HW-confirmed. (The
        // earlier UVC pan/tilt/roll experiment was abandoned: it's flaky on the OBSBOT
        // DirectShow driver, so PTZ rides the vendor frame instead.)
        await t.sendVendor(encodePtzMoveAngle(yaw, pitch, roll).buildFrame(t.nextSeq()));
        return ready.reconnected ? { yaw, pitch, roll, reconnected: true } : { yaw, pitch, roll };
      },
    },
    {
      name: "obsbot_ptz_move_speed",
      description:
        "Drive the gimbal at a yaw/pitch speed (positive yaw pans to the camera's left, matching " +
        "obsbot_ptz_move_angle), then automatically stop after autoStopMs (default 800ms) so it can't run away.",
      schema: ptzMoveSpeedSchema,
      handler: async (args: unknown) => {
        const { yaw, pitch, roll, autoStopMs } = ptzMoveSpeedSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        // Firmware velocity-yaw is inverted relative to position-yaw (AI_SET_GIM_SPEED +yaw
        // drives right, AI_SET_GIM_MOTOR_DEG +yaw drives left — HW-observed). Negate so the
        // tool contract is consistent: +yaw pans to the camera's left on both PTZ tools.
        await t.sendVendor(encodePtzMoveSpeed(-yaw, pitch, roll).buildFrame(t.nextSeq()));
        if (autoStopMs > 0) {
          await sleep(autoStopMs);
          await t.sendVendor(encodePtzMoveSpeed(0, 0, 0).buildFrame(t.nextSeq()));
        }
        return { ok: true, stopped: autoStopMs > 0, ...(ready.reconnected && { reconnected: true }) };
      },
    },
    {
      name: "obsbot_gimbal_recenter",
      description: "Recenter the gimbal.",
      schema: gimbalRecenterSchema,
      handler: async (args: unknown) => {
        gimbalRecenterSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        // Vendor recenter GIM_SET_MOTOR (0x00C3 + 6 zero bytes). HW-confirmed to recenter
        // the gimbal.
        await t.sendVendor(encodeRecenter().buildFrame(t.nextSeq()));
        return { ok: true, ...(ready.reconnected && { reconnected: true }) };
      },
    },
    {
      name: "obsbot_zoom_absolute",
      description: "Set absolute zoom ratio, clamped to [1.0, 2.0].",
      schema: zoomAbsoluteSchema,
      handler: async (args: unknown) => {
        const parsed = zoomAbsoluteSchema.parse(args);
        const ratio = clamp(parsed.ratio, 1.0, 2.0);
        const t = await getTransport();
        const { min, max } = await t.zoomRange();
        await t.zoomSet(zoomRatioToUnits(ratio, min, max));
        return { ok: true, ratio };
      },
    },
    {
      name: "obsbot_ai_tracking",
      description:
        "Enable or disable AI tracking and choose the mode. When enabled the camera " +
        "follows the subject; disabling stops tracking. `mode` is either a human framing " +
        "(normal | upper-body | close-up | headless | lower-body) or a standalone scene " +
        "mode (group | whiteboard | desk | hand); scene modes imply enabled:true. After " +
        "writing, the tool polls the status block until the mode settles and returns " +
        "{ verified, matched } — the aiMode the device actually landed on (matched:false " +
        "means no subject was being tracked, so the mode could not take effect yet).",
      schema: aiTrackingSchema,
      handler: async (args: unknown) => {
        const { enabled, mode } = aiTrackingSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        const readAiMode = async (): Promise<AiModeStatus> => {
          try {
            return decodeStatus(await t.recvStatus()).aiMode;
          } catch {
            return "unknown"; // transient read mid-switch — keep polling
          }
        };
        // Snapshot the framing before the write so verify can tell a real change
        // from the pre-write value (and skip the m=6 transient). See verifyFraming.
        const before = await readAiMode();
        // OBSBOT Center toggles tracking/mode with a raw uvcExt write to selector 6,
        // NOT a framed V3 command (which the Tiny 2 ACKs but ignores). byte[2] is the
        // work mode, byte[3] the human framing sub-mode. A scene mode (group/whiteboard/
        // desk/hand) is its own work mode; a framing is the human work mode. See
        // encodeAiMode / encodeAiTracking.
        const payload =
          !enabled ? encodeAiMode("none")
          : isSceneMode(mode) ? encodeAiMode(mode)
          : encodeAiTracking(true, mode as AiFramingMode);
        await t.xuRaw(UVC_XU_SELECTOR, payload);
        // Verify by readback: aiMode settles to the requested mode after a brief m=6
        // transient. The mode name doubles as its aiMode readback value.
        const want: AiModeStatus = enabled ? (mode as AiModeStatus) : "no-tracking";
        const { verified, matched } = await verifyFraming(readAiMode, want, before);
        return { ok: true, enabled, mode, verified, matched, ...(ready.reconnected && { reconnected: true }) };
      },
    },
    {
      name: "obsbot_ai_track_speed",
      description:
        "Set the AI tracking-speed preset (OBSBOT Center's Standard/Sport). " +
        "speed: standard (slower follow) | sport (snappier follow).",
      schema: aiTrackSpeedSchema,
      handler: async (args: unknown) => {
        const { speed } = aiTrackSpeedSchema.parse(args);
        const t = await getTransport();
        await t.sendVendor(encodeAiTrackSpeed(speed).buildFrame(t.nextSeq()));
        return { ok: true, speed };
      },
    },
    {
      name: "obsbot_zoom_speed",
      description:
        "Zoom to an absolute ratio at a chosen speed. ratio is clamped to [1.0,2.0]; " +
        "speed 0=device default, 1-10 slow→fast, 255=maximum.",
      schema: zoomSpeedSchema,
      handler: async (args: unknown) => {
        const parsed = zoomSpeedSchema.parse(args);
        const ratio = clamp(parsed.ratio, 1.0, 2.0);
        const speed = clamp(Math.round(parsed.speed), 0, 255);
        const t = await getTransport();
        await t.sendVendor(
          encodeZoomWithSpeed(Math.round(ratio * 100), speed).buildFrame(t.nextSeq()),
        );
        return { ok: true, ratio, speed };
      },
    },
    {
      name: "obsbot_face_focus",
      description: "Enable or disable face-priority autofocus.",
      schema: faceFocusSchema,
      handler: async (args: unknown) => {
        const { enabled } = faceFocusSchema.parse(args);
        const t = await getTransport();
        await t.sendVendor(encodeFaceFocus(enabled).buildFrame(t.nextSeq()));
        return { ok: true, enabled };
      },
    },
    {
      name: "obsbot_get_status",
      description:
        "Read the camera's live status block. Returns { awake, hdr, aiMode, trackSpeed }: " +
        "aiMode is the current AI framing (no-tracking|normal|upper-body|close-up|headless|" +
        "lower-body|desk|whiteboard|hand|group|unknown); trackSpeed is standard|sport|unknown. " +
        "Under --debug the result also carries `raw`: the full 60-byte status block as hex " +
        "(for reverse-engineering undecoded offsets).",
      schema: getStatusSchema,
      handler: async (args: unknown) => {
        getStatusSchema.parse(args);
        const t = await getTransport();
        try {
          const block = await t.recvStatus();
          return { ok: true, ...decodeStatus(block), ...(debug ? { raw: block.toString("hex") } : {}) };
        } catch (e) {
          return { ok: false, error: `could not read camera status: ${(e as Error).message}` };
        }
      },
    },
    {
      name: "obsbot_probe",
      description:
        "RE/diagnostics only — generic XU byte access for reverse-engineering the feedback surface. " +
        "mode 'get': GET_CUR read `length` bytes from XU `selector` (default selector 6; use a large " +
        "length to probe the status block's true size, or sweep other selectors). " +
        "mode 'set': SET_CUR write raw `hex` bytes to XU `selector` (e.g. replay a captured frame). " +
        "mode 'query': frame table `opcode` (default AI_GET_QUICK_STATUS) with optional `payloadHex`, " +
        "send on the vendor selector, then read the reply frame. Returns raw hex. Not for normal use.",
      schema: probeSchema,
      handler: async (args: unknown) => {
        const { mode, selector, length, hex, opcode, payloadHex } = probeSchema.parse(args);
        const t = await getTransport();
        try {
          if (mode === "get") {
            const sel = selector ?? 0x06;
            const block = await t.xuGetRaw(sel, length ?? 128);
            return { ok: true, selector: sel, len: block.length, raw: block.toString("hex") };
          }
          if (mode === "set") {
            if (selector === undefined || !hex) {
              return { ok: false, error: "mode 'set' requires selector and hex" };
            }
            await t.xuRaw(selector, Buffer.from(hex, "hex"));
            return { ok: true, selector, sent: hex };
          }
          // mode "query": build a framed V3 command, send it, read the reply frame.
          const payload = payloadHex ? Buffer.from(payloadHex, "hex") : Buffer.alloc(0);
          const name = opcode ?? "AI_GET_QUICK_STATUS";
          const frame = encodeVendorProbe(name, payload).buildFrame(t.nextSeq());
          const reply = await t.recvVendor(frame, length ?? 60);
          let parsed: object;
          try {
            const p = parseFrame(reply);
            parsed = {
              cmd: "0x" + p.cmd.toString(16).padStart(4, "0"),
              receiver: p.receiver,
              payloadHex: p.payload.toString("hex"),
            };
          } catch (e) {
            parsed = { parseError: (e as Error).message };
          }
          return {
            ok: true,
            opcode: name,
            sentFrame: frame.toString("hex"),
            replyHex: reply.toString("hex"),
            parsed,
          };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    {
      name: "obsbot_fov",
      description: "Set the field of view. fov: wide (86°) | medium (78°) | narrow (65°).",
      schema: fovSchema,
      handler: async (args: unknown) => {
        const { fov } = fovSchema.parse(args);
        const t = await getTransport();
        await t.xuRaw(UVC_XU_SELECTOR, encodeFov(fov as FovType));
        return { ok: true, fov };
      },
    },
    {
      name: "obsbot_hdr",
      description: "Toggle HDR/WDR imaging on or off.",
      schema: hdrSchema,
      handler: async (args: unknown) => {
        const { enabled } = hdrSchema.parse(args);
        const t = await getTransport();
        await t.xuRaw(UVC_XU_SELECTOR, encodeHdr(enabled));
        return { ok: true, enabled };
      },
    },
    {
      name: "obsbot_focus",
      description:
        "Set focus. mode 'auto' enables continuous autofocus; mode 'manual' sets the " +
        "focus motor to position (0-100, near→far), mapped onto the device range.",
      schema: focusSchema,
      handler: async (args: unknown) => {
        const { mode, position } = focusSchema.parse(args);
        const t = await getTransport();
        if (mode === "auto") {
          await t.camCtrlSet(CAMERA_CONTROL_FOCUS, 0, UVC_FLAG_AUTO);
          return { ok: true, mode };
        }
        const { min, max } = await t.camCtrlRange(CAMERA_CONTROL_FOCUS);
        const value = percentToRange(position, min, max);
        await t.camCtrlSet(CAMERA_CONTROL_FOCUS, value, UVC_FLAG_MANUAL);
        return { ok: true, mode, position, value };
      },
    },
    {
      name: "obsbot_gimbal_position",
      description:
        "Read the gimbal's current absolute yaw/pitch in degrees (positive yaw = camera's " +
        "left, positive pitch = down) via the standard UVC Pan/Tilt controls. Reports the " +
        "actual position, which may lag a move that is still in progress.",
      schema: gimbalPositionSchema,
      handler: async (args: unknown) => {
        gimbalPositionSchema.parse(args);
        const t = await getTransport();
        const pan = await t.camCtrlGet(CAMERA_CONTROL_PAN);
        const tilt = await t.camCtrlGet(CAMERA_CONTROL_TILT);
        // UVC pan value is degrees, same sign as our yaw (+ = camera-left). UVC tilt
        // is degrees but positive = up, so negate to match our +pitch = down convention.
        return { yaw: pan.value, pitch: -tilt.value };
      },
    },
    {
      name: "obsbot_preset_list",
      description:
        "Read the three gimbal preset slots (occupied/empty, name, pose in degrees). " +
        "Reads flat XU selectors 12 (list) and 13 (entry cursor), NOT the vendor V3 " +
        "framed-reply path (which is non-functional for preset data on this device).",
      schema: presetListSchema,
      handler: async (args: unknown) => {
        presetListSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        try {
          const slots = await readPresetSlots(t, gate, presetRead);
          return { ok: true, slots, ...(ready.reconnected && { reconnected: true }) };
        } catch (e) {
          return { ok: false, error: msg(e) };
        }
      },
    },
    {
      name: "obsbot_preset_save",
      description:
        "Save the gimbal's current live pose (yaw/pitch, via the standard UVC Pan/Tilt " +
        "controls) into preset slot 1|2|3. Slots are create-once on this device — there is " +
        "no overwrite, so an occupied slot is rejected (delete it first). Verifies by " +
        "re-reading the slot list after writing. For the power-up pose see obsbot_boot_pose.",
      schema: presetSaveSchema,
      handler: async (args: unknown) => {
        const { slot } = presetSaveSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        let pose: PresetPose;
        try {
          const before = await readPresetSlots(t, gate, presetRead);
          if (before[slot - 1].occupied) {
            return { ok: false, error: `slot ${slot} is occupied; update or delete first` };
          }
          // Mirror obsbot_gimbal_position's read path exactly: UVC pan is degrees, same
          // sign as our yaw; UVC tilt is degrees but positive = up, so negate to match
          // our +pitch = down convention.
          const yaw = (await t.camCtrlGet(CAMERA_CONTROL_PAN)).value;
          const pitch = -(await t.camCtrlGet(CAMERA_CONTROL_TILT)).value;
          // T6: ObsbotTransport exposes no zoom getter, so the live zoom ratio can't be
          // read back here — zoom is hardcoded to 1 rather than guessed. Not an oversight.
          pose = { pan: yaw, tilt: pitch, roll: 0, zoom: 1 };
          await t.sendVendor(encodePresetAdd(t.nextSeq(), slot, pose));
        } catch (e) {
          return { ok: false, error: `preset save failed: ${msg(e)}` };
        }
        // M1: the ADD above has committed. From here on, a thrown error must say so —
        // otherwise a retry hits "slot occupied" with no clue the save actually landed.
        try {
          const after = await readPresetSlots(t, gate, presetRead);
          if (!after[slot - 1].occupied) {
            return { ok: false, error: "verification failed", expected: "occupied", actual: "empty" };
          }
          return { ok: true, slot: after[slot - 1], ...(ready.reconnected && { reconnected: true }) };
        } catch (e) {
          return {
            ok: false,
            error: `preset saved to slot ${slot} but verification failed: ${msg(e)}`,
          };
        }
      },
    },
    {
      name: "obsbot_preset_recall",
      description:
        "Recall preset slot 1|2|3, driving the gimbal to that slot's saved pose. The slot " +
        "must be occupied. The gimbal may still be moving when this returns — verification " +
        "only confirms the slot is still occupied, not that the pose has arrived.",
      schema: presetRecallSchema,
      handler: async (args: unknown) => {
        const { slot } = presetRecallSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        try {
          const before = await readPresetSlots(t, gate, presetRead);
          if (!before[slot - 1].occupied) {
            return { ok: false, error: `slot ${slot} is empty; save first` };
          }
          await t.sendVendor(encodePresetRecall(t.nextSeq(), slot));
          const after = await readPresetSlots(t, gate, presetRead);
          if (!after[slot - 1].occupied) {
            return { ok: false, error: "verification failed", expected: "occupied", actual: "empty" };
          }
          return { ok: true, slot: after[slot - 1], ...(ready.reconnected && { reconnected: true }) };
        } catch (e) {
          return { ok: false, error: msg(e) };
        }
      },
    },
    {
      name: "obsbot_preset_update",
      description:
        "Overwrite preset slot 1|2|3 with the gimbal's current live pose (yaw/pitch via the " +
        "standard UVC Pan/Tilt controls). The slot must already be occupied (save first to " +
        "create it). Verifies by re-reading the slot list after writing. For the power-up " +
        "pose see obsbot_boot_pose.",
      schema: presetUpdateSchema,
      handler: async (args: unknown) => {
        const { slot } = presetUpdateSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        let pose: PresetPose;
        let previous: PresetPose | null = null;
        try {
          const before = await readPresetSlots(t, gate, presetRead);
          if (!before[slot - 1].occupied) {
            return { ok: false, error: `slot ${slot} is empty; save first` };
          }
          // The pose we are about to destroy. Already in hand from the guard read, so
          // handing it back costs nothing and is the only restore path the caller has:
          // the device keeps no history and UPDATE is not reversible.
          previous = before[slot - 1].pose;
          // Mirror obsbot_preset_save's read path exactly: UVC pan is degrees, same sign as
          // our yaw; UVC tilt is degrees but positive = up, so negate to match our +pitch =
          // down convention.
          const yaw = (await t.camCtrlGet(CAMERA_CONTROL_PAN)).value;
          const pitch = -(await t.camCtrlGet(CAMERA_CONTROL_TILT)).value;
          // T6: ObsbotTransport exposes no zoom getter, so the live zoom ratio can't be
          // read back here — zoom is hardcoded to 1 rather than guessed. Not an oversight.
          pose = { pan: yaw, tilt: pitch, roll: 0, zoom: 1 };
          await t.sendVendor(encodePresetUpdate(t.nextSeq(), slot, pose));
        } catch (e) {
          return { ok: false, error: `preset update failed: ${msg(e)}` };
        }
        // M1: the UPDATE above has committed. From here on, a thrown error must say so.
        try {
          const after = await readPresetSlots(t, gate, presetRead);
          if (!after[slot - 1].occupied) {
            return { ok: false, error: "verification failed", expected: "occupied", actual: "empty" };
          }
          return {
            ok: true,
            slot: after[slot - 1],
            ...(previous && { previous }),
            ...(ready.reconnected && { reconnected: true }),
          };
        } catch (e) {
          return {
            ok: false,
            error: `preset updated in slot ${slot} but verification failed: ${msg(e)}`,
          };
        }
      },
    },
    {
      name: "obsbot_preset_rename",
      description:
        `Rename preset slot 1|2|3. The slot must already be occupied. Names longer than ` +
        `${PRESET_NAME_MAX} bytes are truncated to fit the wire frame. Verifies by re-reading ` +
        "the slot list after writing.",
      schema: presetRenameSchema,
      handler: async (args: unknown) => {
        const { slot, name } = presetRenameSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        try {
          const before = await readPresetSlots(t, gate, presetRead);
          if (!before[slot - 1].occupied) {
            return { ok: false, error: `slot ${slot} is empty; save first` };
          }
          const clean = name.slice(0, PRESET_NAME_MAX);
          // The read path (decodePresetEntry) base64-decodes the stored name, but the
          // captured OBSBOT Center rename frame carried raw ASCII ("Preset1", "3reset2A"),
          // so the write side sends raw ASCII here too — per the capture. Whether the
          // device actually expects ASCII or base64 on the WRITE side is NOT yet
          // hardware-confirmed; flagged for the hardware verification task.
          await t.sendVendor(encodePresetSetName(t.nextSeq(), slot, clean));
          const after = await readPresetSlots(t, gate, presetRead);
          if (after[slot - 1].name !== clean) {
            return { ok: false, error: "verification failed", expected: clean, actual: after[slot - 1].name };
          }
          return { ok: true, slot: after[slot - 1], ...(ready.reconnected && { reconnected: true }) };
        } catch (e) {
          return { ok: false, error: msg(e) };
        }
      },
    },
    {
      name: "obsbot_boot_pose",
      description:
        "Boot pose — the position the gimbal strikes on power-up. action 'set' stores the " +
        "gimbal's current live pose; 'clear' restores the factory default; 'goto' drives the " +
        "gimbal to the stored boot pose right now. NOT VERIFIED: this device answers reads on " +
        "a reply path this transport cannot read, so 'set' cannot be confirmed by readback — " +
        "use 'goto' and watch where the gimbal actually lands. 'clear' undoes 'set'.",
      schema: bootPoseSchema,
      handler: async (args: unknown) => {
        const { action } = bootPoseSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        try {
          if (action === "clear") {
            await t.sendVendor(encodeGimBootPosReset(t.nextSeq()));
            return { ok: true, action, ...(ready.reconnected && { reconnected: true }) };
          }
          if (action === "goto") {
            await t.sendVendor(encodeGimBootPosTrigger(t.nextSeq()));
            return { ok: true, action, ...(ready.reconnected && { reconnected: true }) };
          }
          // Same live-pose read as obsbot_preset_save: UVC pan is degrees with our
          // yaw's sign; UVC tilt is positive = up, so negate for our +pitch = down.
          const yaw = (await t.camCtrlGet(CAMERA_CONTROL_PAN)).value;
          const pitch = -(await t.camCtrlGet(CAMERA_CONTROL_TILT)).value;
          // Zoom is hardcoded to 1: ObsbotTransport exposes no zoom getter, so the
          // live ratio cannot be read back here rather than guessed.
          const bootPose: PresetPose = { pan: yaw, tilt: pitch, roll: 0, zoom: 1 };
          await t.sendVendor(encodeGimBootPosSet(t.nextSeq(), bootPose));
          return {
            ok: true,
            action,
            bootPose,
            // Stated explicitly so the caller never reads success as confirmation:
            // the write left the host, nothing read it back. Verify with 'goto'.
            verified: false,
            ...(ready.reconnected && { reconnected: true }),
          };
        } catch (e) {
          return { ok: false, error: `boot pose ${action} failed: ${msg(e)}` };
        }
      },
    },
    {
      name: "obsbot_preset_delete",
      description:
        "Delete preset slot 1|2|3. The slot must be occupied. Verifies by re-reading the " +
        "slot list after writing.",
      schema: presetDeleteSchema,
      handler: async (args: unknown) => {
        const { slot } = presetDeleteSchema.parse(args);
        const ready = await gate();
        if (!ready.ok) return ready;
        const t = ready.transport;
        // Tracks whether the destructive write already left the host. If the
        // post-write verify read throws, a bare error reads as "nothing happened"
        // and invites a blind retry of an operation that already committed.
        let sent = false;
        try {
          const before = await readPresetSlots(t, gate, presetRead);
          if (!before[slot - 1].occupied) {
            return { ok: false, error: `slot ${slot} is already empty` };
          }
          // Everything the delete is about to destroy, captured from the guard read.
          // Slots are create-once with no device-side history, so this response is the
          // caller's ONLY route back if the wrong slot was named.
          const destroyed = { name: before[slot - 1].name, pose: before[slot - 1].pose };
          await t.sendVendor(encodePresetDelete(t.nextSeq(), slot));
          sent = true;
          const after = await readPresetSlots(t, gate, presetRead);
          if (after[slot - 1].occupied) {
            return { ok: false, error: "verification failed", expected: "empty", actual: "occupied" };
          }
          return { ok: true, deleted: destroyed, ...(ready.reconnected && { reconnected: true }) };
        } catch (e) {
          if (sent) {
            return {
              ok: false,
              error: `delete was sent and may have been applied, but verification failed: ${msg(e)}`,
              committed: "unknown",
            };
          }
          return { ok: false, error: msg(e) };
        }
      },
    },
    {
      name: "obsbot_white_balance",
      description:
        "Set white balance. mode 'auto' enables auto white balance; mode 'manual' sets a " +
        "colour temperature in Kelvin (clamped to the device's supported range).",
      schema: whiteBalanceSchema,
      handler: async (args: unknown) => {
        const { mode, temperature } = whiteBalanceSchema.parse(args);
        const t = await getTransport();
        const { min, max } = await t.procAmpRange(VIDEO_PROCAMP_WHITE_BALANCE);
        if (mode === "auto") {
          await t.procAmpSet(VIDEO_PROCAMP_WHITE_BALANCE, min, UVC_FLAG_AUTO);
          return { ok: true, mode };
        }
        const value = clamp(Math.round(temperature), min, max);
        await t.procAmpSet(VIDEO_PROCAMP_WHITE_BALANCE, value, UVC_FLAG_MANUAL);
        return { ok: true, mode, temperature: value };
      },
    },
    {
      name: "obsbot_image_control",
      description:
        "Adjust a standard image control: control is brightness | contrast | hue | " +
        "saturation | sharpness | gain | backlight-compensation; level 0-100 is mapped onto " +
        "the device's supported range for that control. Standard UVC (IAMVideoProcAmp), no auto.",
      schema: imageControlSchema,
      handler: async (args: unknown) => {
        const { control, level } = imageControlSchema.parse(args);
        const property = IMAGE_CONTROL_PROP[control];
        const t = await getTransport();
        const { min, max } = await t.procAmpRange(property);
        const value = percentToRange(level, min, max);
        await t.procAmpSet(property, value, UVC_FLAG_MANUAL);
        return { ok: true, control, level, value };
      },
    },
    {
      name: "obsbot_exposure",
      description:
        "Set exposure. mode 'auto' enables auto-exposure; mode 'manual' sets level 0-100 " +
        "(0 darkest → 100 brightest), mapped onto the device's exposure range. With auto, " +
        "an optional priority 'global' | 'face' selects the metering region (face-priority " +
        "meters for a detected face). " +
        "Uses proprietary V3 frame protocol (CAM_SET_EXPOSURE_MODE + CAM_SET_EXPOSURE_TINY2) " +
        "because the standard UVC/IAMCameraControl V4L2 path is a stub on the Tiny 2.",
      schema: exposureSchema,
      handler: async (args: unknown) => {
        const { mode, level, priority } = exposureSchema.parse(args);
        const t = await getTransport();
        if (mode === "auto") {
          await t.sendVendor(encodeSetExposureMode(false).buildFrame(t.nextSeq()));
          // Face vs global metering is a sel-6 uvcExt write applied after auto-exposure
          // is on (readback surfaces at status offset 0x07). See encodeFaceAe.
          if (priority) {
            await t.xuRaw(UVC_XU_SELECTOR, encodeFaceAe(priority === "face"));
            return { ok: true, mode, priority };
          }
          return { ok: true, mode };
        }
        // Switch to manual mode via V3 frame protocol (CAM_SET_EXPOSURE_MODE)
        await t.sendVendor(encodeSetExposureMode(true).buildFrame(t.nextSeq()));
        // Translate 0-100 percentage to raw 16-bit exposure value.
        // Tiny 2 exposure range is 0-65535 (confirmed by Tiny4Linux reference).
        const raw = percentToRange(level, 0, 65535);
        await t.sendVendor(encodeSetExposureValue(raw).buildFrame(t.nextSeq()));
        return { ok: true, mode, level, raw };
      },
    },
    {
      name: "obsbot_snapshot",
      description:
        "Grab one still frame from the camera and return it as an image (for you to see " +
        "and for framing/lighting/exposure checks). NOTE: before calling, ensure the camera " +
        "is focused (call obsbot_focus with mode:'auto' for autofocus) unless otherwise " +
        "directed. source: device (default) | virtual | ndi. " +
        "If the camera is in use by another app, returns a message instead of an image.",
      schema: snapshotSchema,
      handler: async (args: unknown) => {
        const { maxDim, quality, settleMs, source } = snapshotSchema.parse(args);
        const t = await getTransport();
        let path: string | undefined;
        if (source !== "device") {
          const devices = await mgr.list();
          const re = source === "virtual" ? /OBSBOT Virtual Camera/i : /NDI Webcam/i;
          const match = devices.find((d) => re.test(d.name));
          if (!match) {
            return {
              content: [
                {
                  type: "text",
                  text: `No '${source}' video source found (is OBSBOT Center / NDI running?).`,
                },
              ],
            };
          }
          path = match.path;
        }
        try {
          const snap = await t.snapshot({ path, maxDim, quality, settleMs });
          return {
            content: [
              { type: "image", data: snap.base64, mimeType: snap.mime },
              {
                type: "text",
                text: JSON.stringify({ width: snap.width, height: snap.height, source }),
              },
            ],
          };
        } catch (e) {
          if (e instanceof CameraBusyError) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Camera is in use by another application. Close it (or try source:'virtual' " +
                    "or 'ndi' if OBSBOT Center is running), then retry.",
                },
              ],
            };
          }
          throw e;
        }
      },
    },
    {
      name: "obsbot_record_start",
      description:
        "Start recording the camera to an MP4 (for the user). durationSec optional (open-ended " +
        "recordings auto-stop after 60 min); audio defaults to on (the OBSBOT mic); outputPath " +
        "optional (defaults under Videos\\\\OBSBOT). NOTE: before calling, ensure the camera " +
        "is focused (call obsbot_focus with mode:'auto' for autofocus) unless otherwise " +
        "directed. source: device|virtual|ndi. Returns a sessionId " +
        "for obsbot_capture_stop.",
      schema: recordStartSchema,
      handler: async (args: unknown) => {
        const parsed = recordStartSchema.parse(args);
        try {
          const s = await needCapture().startRecord({
            source: parsed.source, durationSec: parsed.durationSec,
            audio: parsed.audio, outputPath: parsed.outputPath,
          });
          return { ok: true, sessionId: s.id, outputPath: s.outputPath, durationSec: s.durationSec };
        } catch (e) {
          return captureErrorText(e);
        }
      },
    },
    {
      name: "obsbot_preview_start",
      description:
        "Open a live preview window of the camera (for the user to watch). NOTE: before calling, " +
        "ensure the camera is focused (call obsbot_focus with mode:'auto' for autofocus) unless " +
        "otherwise directed. source: device|virtual|ndi. " +
        "Returns a sessionId for obsbot_capture_stop.",
      schema: previewStartSchema,
      handler: async (args: unknown) => {
        const { source } = previewStartSchema.parse(args);
        try {
          const s = await needCapture().startPreview({ source });
          return { ok: true, sessionId: s.id };
        } catch (e) {
          return captureErrorText(e);
        }
      },
    },
    {
      name: "obsbot_capture_stop",
      description:
        "Stop a recording or preview session by its sessionId. Recordings are stopped gracefully so " +
        "the MP4 finalizes correctly.",
      schema: captureStopSchema,
      handler: async (args: unknown) => {
        const { sessionId } = captureStopSchema.parse(args);
        try {
          const r = await needCapture().stop(sessionId);
          return { ok: true, ...r };
        } catch (e) {
          return captureErrorText(e);
        }
      },
    },
    {
      name: "obsbot_capture_list",
      description: "List active recording/preview sessions (id, kind, source, output path, start time).",
      schema: captureListSchema,
      handler: async (args: unknown) => {
        captureListSchema.parse(args);
        return { sessions: needCapture().list() };
      },
    },
  ];

  // obsbot_probe is an RE/diagnostics-only tool (raw XU byte access); expose it only
  // under --debug so normal deployments don't advertise it. get_status's raw block is
  // gated the same way, inside its handler.
  return debug ? toolDefs : toolDefs.filter((t) => t.name !== "obsbot_probe");
}
