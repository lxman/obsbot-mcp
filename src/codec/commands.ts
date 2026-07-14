import { VendorFrame, RunState } from "./types.js";
import { buildFrame } from "./frame.js";
import { f32le, u32le, i32le, concat } from "./encoding.js";
import { OP_BY_NAME } from "./opcodes.js";

// Vendor frames are addressed by opcode NAME; the wire cmd and receiver come
// from the reverse-engineered opcode table (src/codec/opcodes.ts) rather than
// magic numbers, so the same definitions serve every platform transport and
// new commands are a table row + a payload encoder.
const vendorOp = (name: string, payload: Buffer): VendorFrame => {
  const op = OP_BY_NAME.get(name);
  if (!op || op.wireCmd === null || op.receiver === null) {
    throw new Error(`opcode "${name}" is not a sendable V3 command`);
  }
  const { wireCmd, receiver } = op;
  return { kind: "vendor", buildFrame: (seq: number) => buildFrame({ seq, cmd: wireCmd, receiver, payload }) };
};

/**
 * RE/diagnostics: build ANY opcode-table entry as a V3 frame with an arbitrary
 * payload. Used by the obsbot_probe tool to exercise unmapped GET/query opcodes
 * (e.g. AI_GET_QUICK_STATUS) while reverse-engineering the feedback surface.
 */
export const encodeVendorProbe = (name: string, payload: Buffer): VendorFrame =>
  vendorOp(name, payload);

// The gimbal move wire payload order is [roll, pitch, yaw] (data[0..3]=roll,
// [4..7]=pitch, [8..11]=yaw). Sending them in logical (yaw,pitch,roll) order put yaw
// into the roll slot (roll is unused on Tiny 2), which is why move-to-angle appeared
// inert.
const gimbal3 = (name: string, yaw: number, pitch: number, roll: number): VendorFrame =>
  vendorOp(name, concat(f32le(roll), f32le(pitch), f32le(yaw)));

export const encodeSetRunStatus = (state: RunState): VendorFrame =>
  vendorOp("CAM_SET_DEV_STATUS", Buffer.from([state === "run" ? 0 : 1, 0, 0, 0])); // wake=0, sleep=1

export const encodePtzMoveAngle = (yaw: number, pitch: number, roll: number): VendorFrame =>
  gimbal3("AI_SET_GIM_MOTOR_DEG", yaw, pitch, roll);

export const encodePtzMoveSpeed = (yaw: number, pitch: number, roll: number): VendorFrame =>
  gimbal3("AI_SET_GIM_SPEED", yaw, pitch, roll);

export const encodeRecenter = (): VendorFrame =>
  vendorOp("GIM_SET_MOTOR", Buffer.alloc(6));

export const zoomRatioToUnits = (ratio: number, min: number, max: number): number =>
  Math.round(min + (max - min) * (ratio - 1.0) + 0.001);

// ---------------------------------------------------------------------------
//  AI subject tracking
// ---------------------------------------------------------------------------
// AI tracking mode is an 8-byte payload: u32le(subject) ++ u32le(view), where
// subject 0 = human, 1 = animal, and the view code selects the framing. The
// (subject, view) pairs below are the device's own mode codes.
export type AiTrackMode =
  | "human-normal"
  | "human-full-body"
  | "human-half-body"
  | "human-close-up"
  | "human-auto-view"
  | "animal-normal"
  | "animal-close-up"
  | "animal-auto-view";

const AI_TRACK_VIEW: Record<AiTrackMode, [subject: number, view: number]> = {
  "human-normal": [0, 0],
  "human-full-body": [0, 4],
  "human-half-body": [0, 3],
  "human-close-up": [0, 2],
  "human-auto-view": [0, 1],
  "animal-normal": [1, 0],
  "animal-close-up": [1, 2],
  "animal-auto-view": [1, 1],
};

export const AI_TRACK_MODES = Object.keys(AI_TRACK_VIEW) as AiTrackMode[];

/** Enable AI tracking in a specific framing mode (AI_SET_AI_TRACK_MODE, cmd 0x6f). */
export const encodeAiTrackEnable = (mode: AiTrackMode): VendorFrame => {
  const [subject, view] = AI_TRACK_VIEW[mode];
  return vendorOp("AI_SET_AI_TRACK_MODE", concat(u32le(subject), u32le(view)));
};

/** Disable AI tracking of the current target (AI_SET_CANCEL_TARGET, cmd 0x6e — no payload). */
export const encodeAiTrackDisable = (): VendorFrame =>
  vendorOp("AI_SET_CANCEL_TARGET", Buffer.alloc(0));

/** Enable auto group-framing (AI_SET_AUTO_GROUP, cmd 0x70 — 8 zero bytes). */
export const encodeAiGroupEnable = (): VendorFrame =>
  vendorOp("AI_SET_AUTO_GROUP", Buffer.alloc(8));

/** Disable auto group-framing (AI_CANCEL_AUTO_GROUP, cmd 0x71 — no payload). */
export const encodeAiGroupDisable = (): VendorFrame =>
  vendorOp("AI_CANCEL_AUTO_GROUP", Buffer.alloc(0));

// Tracking-speed preset — a single value byte sent via wireCmd 0x0CC4
// (AI_SET_TRACK_MODE), the command OBSBOT Center uses for its Standard/Sport
// toggle. Confirmed by USB capture 2026-07-13: SET_CUR to XU entity 2 /
// selector 0x02, value 0=Standard, 2=Sport, moving status byte 0x24. (Our old
// wireCmd 0x0944 / AI_SET_TRACK_SPEED was ACK'd but IGNORED by the Tiny 2
// firmware — byte 0x24 never moved; that was the original no-op bug.)
//
// TINY 2 EXPOSES EXACTLY TWO SPEEDS. A full hardware sweep of values 0–5
// (2026-07-13, live gimbal-follow observation) proved the Tiny 2 honors ONLY
// value 2 (Sport); 0/1/3/4/5 all behave as the Standard default — the device
// stores whatever byte you send but changes no tracking behavior. So this enum
// is deliberately collapsed to the two real Tiny 2 states, and the labels are
// aligned to the device (matching the trackSpeed readback below).
//
// OTHER OBSBOT MODELS: a richer 6-level speed enum exists
//   lazy=0, slow=1, standard=2, fast=3, crazy=4, auto=5
// If/when we support a model that actually implements those levels, restore the
// 6-value map here (the encoder/frame path is model-agnostic — only this
// value→label table changes).
export type AiTrackSpeed = "standard" | "sport";

const AI_TRACK_SPEED: Record<AiTrackSpeed, number> = {
  standard: 0, // device Standard (slower follow)
  sport: 2,    // device Sport (snappier follow)
};

export const AI_TRACK_SPEEDS = Object.keys(AI_TRACK_SPEED) as AiTrackSpeed[];

export const encodeAiTrackSpeed = (speed: AiTrackSpeed): VendorFrame =>
  vendorOp("AI_SET_TRACK_MODE", Buffer.from([AI_TRACK_SPEED[speed]]));

// ---------------------------------------------------------------------------
//  Zoom with speed  (CAM_SET_ZOOM_ABSOLUTE, cmd 0x32)
// ---------------------------------------------------------------------------
// The zoom-with-speed payload packs speed FIRST then ratio: data[0:4] =
// u32le(zoom_speed), data[4:8] = u32le(zoom_ratio), where zoom_ratio is the
// ratio × 100 (1.5× -> 150).
export const encodeZoomWithSpeed = (ratioX100: number, speed: number): VendorFrame =>
  vendorOp("CAM_SET_ZOOM_ABSOLUTE", concat(u32le(speed), u32le(ratioX100)));

// ---------------------------------------------------------------------------
//  Face focus  (CAM_SET_FACE_FOCUS, cmd 0x03) — int32le(enable) on V3.
// ---------------------------------------------------------------------------
export const encodeFaceFocus = (enable: boolean): VendorFrame =>
  vendorOp("CAM_SET_FACE_FOCUS", i32le(enable ? 1 : 0));

// ---------------------------------------------------------------------------
//  Reads (Get commands) — the return channel. A GET request carries no nested
//  payload (it asks, it does not set); the camera replies with a frame whose
//  payload holds the state. Decoders take that reply payload.
// ---------------------------------------------------------------------------

/** Request the current face-priority autofocus state (CAM_GET_FACE_FOCUS, cmd 0x35c2). */
export const encodeGetFaceFocus = (): VendorFrame =>
  vendorOp("CAM_GET_FACE_FOCUS", Buffer.alloc(0));

export interface FaceFocusState {
  enabled: boolean;
}

/** Decode a CAM_GET_FACE_FOCUS reply payload: int32le enable flag at offset 0. */
export const decodeFaceFocus = (payload: Buffer): FaceFocusState => {
  if (payload.length < 4) {
    throw new Error(`face-focus reply payload too short: ${payload.length} bytes`);
  }
  return { enabled: payload.readInt32LE(0) !== 0 };
};

// ---------------------------------------------------------------------------
//  UVC extension-unit controls  (XU selector 6, NOT a V3 frame)
// ---------------------------------------------------------------------------
// FOV and (UVC-mode) WDR/HDR use a fixed 60-byte buffer written via
// uvc_xu_set(selector = 6, buf, 0x3c). The first three bytes are [tag, 0x01,
// value]; the rest are zero. tag 0x04 = FOV, 0x01 = WDR/HDR.
export const UVC_XU_SELECTOR = 6;

const uvcExt = (tag: number, value: number): Buffer => {
  const b = Buffer.alloc(60);
  b[0] = tag;
  b[1] = 0x01;
  b[2] = value & 0xff;
  return b;
};

// FOV: 86°(wide)=0, 78°(medium)=1, 65°(narrow)=2.
export type FovType = "wide" | "medium" | "narrow";
const FOV_VALUE: Record<FovType, number> = { wide: 0, medium: 1, narrow: 2 };
export const FOV_TYPES = Object.keys(FOV_VALUE) as FovType[];
export const encodeFov = (fov: FovType): Buffer => uvcExt(0x04, FOV_VALUE[fov]);

// HDR/WDR on/off.
export const encodeHdr = (on: boolean): Buffer => uvcExt(0x01, on ? 1 : 0);

// AI subject tracking enable/disable + framing sub-mode. OBSBOT Center does NOT
// use the framed V3 command channel for this (AI_SET_AI_TRACK_MODE 0x0584 on
// selector 2 is ACK'd but IGNORED by the Tiny 2 — the original inert bug). It
// writes a RAW uvcExt payload to XU selector 6 (the status selector), captured
// 2026-07-13. Same shape as FOV/HDR uvcExt controls but a 2-byte value:
//   [tag=0x16, valueLen=0x02, enable, framing] + zero pad to 60 bytes.
//   byte[2] = ENABLE flag: 0x02 on / 0x00 off.
//   byte[3] = FRAMING sub-mode: 0 normal · 1 upper-body · 2 close-up ·
//             3 headless · 4 lower-body.
// The framing byte was captured by clicking each button in OBSBOT Center (writes
// were 16 02 02 01/02/03/04) and hardware-verified by replaying our own
// xuRaw(6, …): the get_status aiMode readback settled to (m=2, n=byte[3]) — the
// SET mode byte equals the status tuple's `n` — and OC's own button highlight
// tracked each write. Disable always sends byte[3]=0, matching OC.
//
// These five are the device-real framings the Tiny 2 exposes; the labels match a
// subset of AiModeStatus (below) so a set can be verified directly against the
// aiMode readback. (The AI_TRACK_VIEW set above targets the inert framed
// channel and is kept only for other OBSBOT models.)
export type AiFramingMode =
  | "normal"
  | "upper-body"
  | "close-up"
  | "headless"
  | "lower-body";

const AI_FRAMING: Record<AiFramingMode, number> = {
  normal: 0,
  "upper-body": 1,
  "close-up": 2,
  headless: 3,
  "lower-body": 4,
};

export const AI_FRAMING_MODES = Object.keys(AI_FRAMING) as AiFramingMode[];

export const encodeAiTracking = (on: boolean, mode: AiFramingMode = "normal"): Buffer => {
  const b = Buffer.alloc(60);
  b[0] = 0x16;
  b[1] = 0x02;
  b[2] = on ? 0x02 : 0x00;
  b[3] = on ? AI_FRAMING[mode] : 0x00;
  return b;
};

// ---------------------------------------------------------------------------
//  UVC standard controls (IAMCameraControl / IAMVideoProcAmp) — property ids
//  and the auto/manual flag values for focus and white balance.
// ---------------------------------------------------------------------------
export const CAMERA_CONTROL_PAN = 0; // CameraControl_Pan
export const CAMERA_CONTROL_TILT = 1; // CameraControl_Tilt
export const CAMERA_CONTROL_FOCUS = 6; // CameraControl_Focus
export const CAMERA_CONTROL_EXPOSURE = 4; // CameraControl_Exposure
export const VIDEO_PROCAMP_WHITE_BALANCE = 7; // VideoProcAmp_WhiteBalance
export const UVC_FLAG_AUTO = 1; // *_Flags_Auto
export const UVC_FLAG_MANUAL = 2; // *_Flags_Manual

// Standard IAMVideoProcAmp image adjustments the Tiny 2 supports, keyed to their
// DirectShow VideoProcAmpProperty id. All manual (no auto flag). Confirmed on
// hardware 2026-07-14 by a range probe (Gamma/ColorEnable came back unsupported,
// so they're omitted here). Drivable with zero RE via procAmpSet/procAmpRange.
export type ImageControl =
  | "brightness"
  | "contrast"
  | "hue"
  | "saturation"
  | "sharpness"
  | "backlight-compensation"
  | "gain";

export const IMAGE_CONTROL_PROP: Record<ImageControl, number> = {
  brightness: 0,
  contrast: 1,
  hue: 2,
  saturation: 3,
  sharpness: 4,
  "backlight-compensation": 8,
  gain: 9,
};

export const IMAGE_CONTROLS = Object.keys(IMAGE_CONTROL_PROP) as ImageControl[];

/** Map a 0..100 percentage onto an inclusive [min,max] device-unit range. */
export const percentToRange = (pct: number, min: number, max: number): number =>
  Math.round(min + (max - min) * (pct / 100));

// ---------------------------------------------------------------------------
//  Status block (UVC XU selector 6, GET_CUR) — a flat fixed-offset snapshot,
//  NOT a V3 frame reply: no magic, no CRC. Offsets confirmed against the
//  OpenFoxes/Tiny4Linux reference (status.rs). Extend by adding offsets here.
// ---------------------------------------------------------------------------
const STATUS_OFF_SLEEP = 0x02; // 0 = awake, 1 = sleep
const STATUS_OFF_HDR = 0x06;   // 0 = off, non-zero = on
const STATUS_OFF_AI_MODE_M = 0x18; // AI mode tuple, first value
const STATUS_OFF_AI_MODE_N = 0x1c; // AI mode tuple, second value
// Track speed lives at 0x24 on the Tiny 2 — NOT the reference's 0x21 (which reads
// a constant here). Offset found + value map (0=standard, 2=sport) confirmed on
// hardware 2026-07-13 against the OBSBOT Center Standard/Sport control.
const STATUS_OFF_TRACK_SPEED = 0x24;

// The device-reported AI framing mode, decoded from the (m, n) tuple at offsets
// 0x18/0x1c. These are the CAMERA'S status semantics (from Tiny4Linux status.rs),
// a different space from our AI_TRACK_VIEW *set* payload.
export type AiModeStatus =
  | "no-tracking"
  | "normal"
  | "upper-body"
  | "close-up"
  | "headless"
  | "lower-body"
  | "desk"
  | "whiteboard"
  | "hand"
  | "group"
  | "unknown";

const AI_MODE_TABLE: Record<string, AiModeStatus> = {
  "0,0": "no-tracking",
  "2,0": "normal",
  "2,1": "upper-body",
  "2,2": "close-up",
  "2,3": "headless",
  "2,4": "lower-body",
  "5,0": "desk",
  "4,0": "whiteboard",
  "6,0": "hand",
  "1,0": "group",
};

// The device exposes two tracking speeds via OBSBOT Center (Standard/Sport).
export type TrackSpeedStatus = "standard" | "sport" | "unknown";

const TRACK_SPEED_TABLE: Record<number, TrackSpeedStatus> = {
  0: "standard",
  2: "sport",
};

export interface CameraStatus {
  awake: boolean;
  hdr: boolean;
  aiMode: AiModeStatus;
  trackSpeed: TrackSpeedStatus;
}

export const decodeStatus = (block: Buffer): CameraStatus => {
  if (block.length <= STATUS_OFF_TRACK_SPEED) {
    throw new Error(`status block too short: ${block.length} bytes`);
  }
  const m = block[STATUS_OFF_AI_MODE_M];
  const n = block[STATUS_OFF_AI_MODE_N];
  return {
    awake: block[STATUS_OFF_SLEEP] === 0,
    hdr: block[STATUS_OFF_HDR] !== 0,
    aiMode: AI_MODE_TABLE[`${m},${n}`] ?? "unknown",
    trackSpeed: TRACK_SPEED_TABLE[block[STATUS_OFF_TRACK_SPEED]] ?? "unknown",
  };
};
