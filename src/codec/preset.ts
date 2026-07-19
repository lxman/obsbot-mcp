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
