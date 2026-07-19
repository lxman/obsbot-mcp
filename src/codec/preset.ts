import { buildFrame } from "./frame.js";
import { f32le, u32le, concat } from "./encoding.js";

export interface PresetPose { pan: number; tilt: number; roll: number; zoom: number }

const CMD = { ADD: 0x3944, UPDATE: 0x3e04, RECALL: 0x39c4, DELETE: 0x3984,
  SET_NAME: 0x3a84, BOOT_POSE: 0x3ec4, BOOT_FLAGS: 0x3e44 } as const;
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

export const decodePresetEntry = (block: Buffer): PresetEntry => {
  if (block[0] === ENTRY_END) return { end: true };
  const slot = (block[1] + 1) as 1 | 2 | 3;
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
export const assemblePresetSlots = (
  _count: number,
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
