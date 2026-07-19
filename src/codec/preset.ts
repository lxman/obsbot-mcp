import { buildFrame } from "./frame.js";
import { f32le, u32le, concat } from "./encoding.js";
import { OP_BY_NAME } from "./opcodes.js";

export interface PresetPose { pan: number; tilt: number; roll: number; zoom: number }

// Opcodes come from the generated table (tools/opcodes/opcodes.json, extracted from
// libdev.dll with PDB symbols) under the firmware's OWN names. This file previously
// kept a hand-written copy with invented names — notably `BOOT_POSE: 0x3ec4` and
// `BOOT_FLAGS: 0x3e44`, neither of which is what those commands do:
//   0x3ec4 = AI_SET_BOOT_PRESET_UPDATE_ONLY — BINDS AN EXISTING PRESET as the boot
//            preset (hence OBSBOT Center's preset-identifying step before it)
//   0x3e44 = AI_SET_BOOT_PRESETS_ACTIONS   — a "boot presets actions" record
// Those invented names actively misled the reading of this protocol, so resolve by
// real name and let the table be the single source of truth.
const op = (name: string): number => {
  const wire = OP_BY_NAME.get(name)?.wireCmd;
  if (wire == null) throw new Error(`unknown or non-sendable opcode: ${name}`);
  return wire;
};

const CMD = {
  ADD: op("AI_SET_GIMBAL_PRESET_ADD"),
  UPDATE: op("AI_SET_PRESET_UPDATE_ONLY"),
  RECALL: op("AI_SET_GIMBAL_PRESET_TRIG"),
  DELETE: op("AI_SET_GIMBAL_PRESET_DELETE"),
  SET_NAME: op("AI_SET_GIMBAL_PRESET_ID_NAME"),
  // Legacy names retained for the existing As-Initial-State replay path; see the
  // real semantics above. Prefer the GIM_BOOT_POS family below.
  BOOT_POSE: op("AI_SET_BOOT_PRESET_UPDATE_ONLY"),
  BOOT_FLAGS: op("AI_SET_BOOT_PRESETS_ACTIONS"),
  // The purpose-built boot-pose family: set / reset / trigger, all decoded.
  GIM_BOOT_POS_SET: op("AI_SET_GIM_BOOT_POS"),
  GIM_BOOT_POS_RESET: op("AI_RST_GIM_BOOT_POS"),
  GIM_BOOT_POS_TRIGGER: op("AI_TRG_GIM_BOOT_POS"),
} as const;
const RECEIVER = 0x04;
const idx = (slot: number) => u32le(slot - 1);
const poseBytes = (p: PresetPose) =>
  concat(f32le(p.pan), f32le(p.tilt), f32le(p.roll), f32le(p.zoom), f32le(-1000));

export const encodePresetAdd = (seq: number, slot: number, pose: PresetPose): Buffer =>
  buildFrame({ seq, cmd: CMD.ADD, receiver: RECEIVER, payload: concat(idx(slot), poseBytes(pose)) });

export const encodePresetUpdate = (seq: number, slot: number, pose: PresetPose): Buffer =>
  buildFrame({ seq, cmd: CMD.UPDATE, receiver: RECEIVER, payload: concat(idx(slot), poseBytes(pose)) });

export const encodePresetRecall = (seq: number, slot: number): Buffer =>
  buildFrame({ seq, cmd: CMD.RECALL, receiver: RECEIVER,
    payload: concat(idx(slot), f32le(1), f32le(1), f32le(1), f32le(1)) });

export const encodePresetDelete = (seq: number, slot: number): Buffer =>
  buildFrame({ seq, cmd: CMD.DELETE, receiver: RECEIVER, payload: idx(slot) });

export const encodePresetSetName = (seq: number, slot: number, name: string): Buffer =>
  buildFrame({ seq, cmd: CMD.SET_NAME, receiver: RECEIVER,
    payload: concat(idx(slot), Buffer.from(name, "ascii")) });

// RETAINED AS DECODED PROTOCOL KNOWLEDGE — NOT REACHABLE FROM ANY TOOL.
// This is the OBSBOT Center "As Initial State" replay. It was removed from the tool
// surface once the command names were recovered: 0x3ec4 is AI_SET_BOOT_PRESET_UPDATE_ONLY
// (binds an existing preset as the boot preset) and 0x3e44 is AI_SET_BOOT_PRESETS_ACTIONS
// (an undecoded 40-byte "actions" record captured from one device state, carrying no slot
// binding of its own). Neither has a decoded way to be undone. The GIM_BOOT_POS family
// below does the same job with a real reset, so prefer it. Kept here, with its golden
// tests, so the captured sequence is not lost.
//
// Boot-pose sequence: slot index + pose, but — unlike ADD/UPDATE — the trailing
// float is a plain 0.0, not the -1000 sentinel. Confirmed against a captured
// OBSBOT Center "As Initial State" wire frame (cmd 0x3ec4); do not fold this
// back into poseBytes(), which ADD/UPDATE's golden tests pin to -1000.
export const encodeBootPose = (seq: number, slot: number, pose: PresetPose): Buffer =>
  buildFrame({
    seq,
    cmd: CMD.BOOT_POSE,
    receiver: RECEIVER,
    payload: concat(idx(slot), f32le(pose.pan), f32le(pose.tilt), f32le(pose.roll), f32le(pose.zoom), f32le(0)),
  });

// Captured verbatim from the single observed As-Initial-State wire sequence (cmd
// 0x3e44). Carries no slot index of its own — the target slot is conveyed by the
// preceding encodeBootPose frame. Internal structure of these 40 bytes is NOT
// decoded (no per-field meaning known) and this constant has NOT been
// hardware-replayed independently — only observed as part of the captured sequence.
const BOOT_FLAGS_BLOCK = Buffer.from(
  "feffffffffffffff80ffffffffffffff00000000ffffffff00000000000000000000000000000000",
  "hex",
);

export const encodeBootFlags = (seq: number): Buffer =>
  buildFrame({ seq, cmd: CMD.BOOT_FLAGS, receiver: RECEIVER, payload: BOOT_FLAGS_BLOCK });

// NOTE: the vendor GET encoders (LIST 0x3b44 / VALUE 0x3a44 / NAME 0x3b04) were
// deleted 2026-07-19. They built valid frames, but the device answers them on a
// reply path we cannot read: after sending one, the reply selector returns the
// flat status block, never a V3 frame. Preset reads use the flat selectors below
// instead. Do not reintroduce them expecting readable replies.

// Flat XU selector 12 (list): <count:u8> <slotIdx:u8> x count. Hardware-verified
// 2026-07-19 — the framed-reply model (recvVendor + parseFrame) does NOT carry
// preset data; reads on the vendor reply path just return the flat status block.
export interface PresetListBlock { count: number; slots: number[] }

export const decodePresetList = (block: Buffer): PresetListBlock => {
  const count = block[0];
  const slots: number[] = [];
  for (let i = 0; i < count; i++) slots.push(block[1 + i]);
  return { count, slots };
};

// C1: sanity-check a raw selector-12 read BEFORE a caller echoes it back to reset
// the entry cursor. Selector 12's write semantics for anything OTHER than exactly
// what the device just returned are undecoded, so a failed/short/garbage read
// (asleep camera, stale handle, transient USB error) must never be echoed —
// echoing is only proven non-destructive for a genuine device response. Returns
// a human-readable reason if the block looks implausible, or null if it's safe
// to trust and echo.
//
// Design note: this checks the WHOLE returned block for all-zero, not just the
// leading `1 + count` bytes. `block[0]` IS `count`, so for any count > 0 the
// leading bytes can never be all-zero by construction — a "leading bytes"
// check is only ever triggered by count === 0, which would make it equivalent
// to unconditionally rejecting "zero presets saved" (a legitimate device
// state, not distinguishable from failure by count alone). Checking the full
// block instead targets the actual failure signature — a dead/asleep read
// returning nothing — while still accepting a genuine empty-list reply as
// long as ANY other byte in the 60-byte block is non-zero.
export const implausiblePresetListReason = (block: Buffer): string | null => {
  if (block.length < 1) return "empty response (0 bytes)";
  const count = block[0];
  if (count > 3) return `implausible slot count ${count} (device has 3 slots)`;
  if (block.length < 1 + count) return `short response: ${block.length} bytes for count=${count}`;
  if (block.equals(Buffer.alloc(block.length))) return "all-zero response — looks like a failed/short read";
  return null;
};

// Flat XU selector 13 (entry cursor): each GET returns the next preset and
// advances the cursor; the cursor is reset by echo-writing the selector-12
// block back (see getPresetSlots in mcp/tools.ts).
export interface PresetEntry {
  end: boolean;
  slot?: 1 | 2 | 3;
  name?: string;
  pose?: PresetPose;
}

const ENTRY_END = 0x02;
// Minimum bytes needed to read the fixed header (status, slotIdx, 2 reserved,
// pitch i16, yaw i16, zoom u8) before the variable-length base64 name starts
// at offset 10.
const ENTRY_HEADER_LEN = 10;

export const decodePresetEntry = (block: Buffer): PresetEntry => {
  if (block.length > 0 && block[0] === ENTRY_END) return { end: true };
  // I4: a buffer too short to hold the fixed header can't be decoded — without
  // this guard, block.readInt16LE(4)/(6) below throws a raw RangeError that
  // surfaces to the caller as an opaque ERR_OUT_OF_RANGE. Treat it the same as
  // end-of-list/invalid instead.
  if (block.length < ENTRY_HEADER_LEN) return { end: true };
  // I3/I4: an all-zero header is exactly what a failed/short USB read decodes
  // as (status 0x00 "not end", slotIdx 0, pitch/yaw/zoom all 0) — it is NOT a
  // real occupied slot. A committed preset's zoom is always >=1.0 (block[8]
  // >=100), so an all-zero header never corresponds to a genuine entry. Treat
  // it as end-of-list/invalid: the dangerous failure mode for a create-once
  // resource is a false OCCUPIED read, never a false EMPTY.
  if (block.subarray(0, ENTRY_HEADER_LEN).equals(Buffer.alloc(ENTRY_HEADER_LEN))) {
    return { end: true };
  }
  const slotIdx = block[1];
  // I4: only slot indices 0..2 are valid on this 3-slot device. Without this
  // check a garbage block[1] (e.g. 7) silently becomes slot:8, which then
  // misses assemblePresetSlots's 1|2|3 lookup and collapses to an all-empty
  // result instead of surfacing the corruption.
  if (slotIdx > 2) return { end: true };
  const slot = (slotIdx + 1) as 1 | 2 | 3;
  const pitch = block.readInt16LE(4) / 100;
  const yaw = block.readInt16LE(6) / 100;
  const zoom = block[8] / 100;
  const nul = block.indexOf(0, 10);
  const b64 = block.subarray(10, nul === -1 ? block.length : nul).toString("ascii");
  const name = Buffer.from(b64, "base64").toString("ascii");
  return { end: false, slot, name, pose: { pan: yaw, tilt: pitch, roll: 0, zoom } };
};

export interface PresetSlot {
  slot: 1 | 2 | 3; occupied: boolean; name: string | null; pose: PresetPose | null;
}
// I1: this used to take an unused `_count` parameter. Decision: drop it rather
// than consume it here — the authoritative-count reconciliation belongs one
// level up, in mcp/tools.ts's getPresetSlots, which has BOTH the selector-12
// list (the device's own claim of which slots are occupied) and the walked
// selector-13 entries available to cross-check against each other. By the time
// perSlot reaches this function it is already trusted; this function's only
// job is reshaping it into the fixed 3-slot view.
export const assemblePresetSlots = (
  perSlot: { slot: 1 | 2 | 3; name: string; pose: PresetPose }[],
): PresetSlot[] => {
  const byslot = new Map(perSlot.map((e) => [e.slot, e]));
  return ([1, 2, 3] as const).map((slot) => {
    const e = byslot.get(slot);
    return e
      ? { slot, occupied: true, name: e.name, pose: e.pose }
      : { slot, occupied: false, name: null, pose: null };
  });
};

// --- Boot pose: the direct, reversible family --------------------------------
// AI_SET_GIM_BOOT_POS / AI_RST_GIM_BOOT_POS / AI_TRG_GIM_BOOT_POS. Unlike the
// As-Initial-State replay (which binds a preset and writes an undecoded 40-byte
// "actions" record), every command here is decoded, and RST restores the factory
// default — so setting a boot pose is undoable.
//
// PAYLOAD LAYOUT IS A HYPOTHESIS, pending hardware. Field ORDER is solid: read
// from libdev's own movss stores in aiSetGimbalBootPosR (buf+0x05 = yaw from
// [rbx+0xC], +0x09 = pitch from [rbx+8], +0x0D = roll from [rbx+4], +0x11 = zoom).
// What is NOT confirmed is whether the UVC path uses the same framing as that
// (network) path, which had an extra zero byte at +0x04 and unaligned floats. We
// mirror our own frame convention instead: u32 id, then four aligned floats.
//
// The discriminator is PHYSICAL, not a readback (our transport cannot read vendor
// GET replies): set a boot pose, fire encodeGimBootPosTrigger, and watch where the
// gimbal actually goes. Wrong layout => it moves somewhere other than commanded,
// and encodeGimBootPosReset puts the device back either way.
export const encodeGimBootPosSet = (seq: number, pose: PresetPose): Buffer =>
  buildFrame({
    seq,
    cmd: CMD.GIM_BOOT_POS_SET,
    receiver: RECEIVER,
    // id is 0: the boot pose is a single global setting, not one of the 3 slots.
    payload: concat(u32le(0), f32le(pose.pan), f32le(pose.tilt), f32le(pose.roll), f32le(pose.zoom)),
  });

export const encodeGimBootPosReset = (seq: number): Buffer =>
  buildFrame({ seq, cmd: CMD.GIM_BOOT_POS_RESET, receiver: RECEIVER, payload: Buffer.alloc(0) });

export const encodeGimBootPosTrigger = (seq: number): Buffer =>
  buildFrame({ seq, cmd: CMD.GIM_BOOT_POS_TRIGGER, receiver: RECEIVER, payload: Buffer.alloc(0) });
