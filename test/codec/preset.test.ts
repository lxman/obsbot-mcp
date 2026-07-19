import { expect, test } from "vitest";
import { bufToHex, hexToBuf } from "../../src/codec/encoding.js";
import {
  encodePresetAdd, encodePresetRecall, encodePresetDelete, encodePresetSetName,
  encodeBootPose, encodeBootFlags,
  encodeGimBootPosSet, encodeGimBootPosReset, encodeGimBootPosTrigger,
  decodePresetList, decodePresetEntry, assemblePresetSlots,
  implausiblePresetListReason,
} from "../../src/codec/preset.js";
import { OP_BY_NAME } from "../../src/codec/opcodes.js";

const cmdOf = (h: string) => h.slice(20, 24);        // bytes 10-11
const len2Of = (h: string) => parseInt(h.slice(26, 28) + h.slice(24, 26), 16); // bytes 12-13 LE
const payloadOf = (h: string, n: number) => h.slice(32, 32 + n * 2); // from offset 16

test("encodePresetAdd: cmd 0x3944, slot index + pose + -1000 sentinel", () => {
  const f = bufToHex(encodePresetAdd(1, 3, { pan: 21, tilt: 0, roll: 0, zoom: 1 }));
  expect(cmdOf(f)).toBe("4439");            // 0x3944 LE
  expect(len2Of(f)).toBe(24);
  expect(payloadOf(f, 4)).toBe("02000000"); // slot 3 -> index 2
  // pan=21 -> f32le(21) = 0000a841
  expect(payloadOf(f, 24).slice(8, 16)).toBe("0000a841");
  // last float = -1000 sentinel = 00007ac4
  expect(payloadOf(f, 24).slice(40, 48)).toBe("00007ac4");
});

test("encodePresetRecall: cmd 0x39c4, slot index + four 1.0 floats", () => {
  const f = bufToHex(encodePresetRecall(1, 1));
  expect(cmdOf(f)).toBe("c439");
  expect(len2Of(f)).toBe(20);
  expect(payloadOf(f, 4)).toBe("00000000");            // slot 1 -> index 0
  expect(payloadOf(f, 20).slice(8)).toBe("0000803f".repeat(4));
});

test("encodePresetDelete: cmd 0x3984, 4-byte slot-index payload", () => {
  const f = bufToHex(encodePresetDelete(1, 2));
  expect(cmdOf(f)).toBe("8439");
  expect(len2Of(f)).toBe(4);
  expect(payloadOf(f, 4)).toBe("01000000");            // slot 2 -> index 1
});

test("encodePresetSetName: cmd 0x3a84, slot index + ASCII", () => {
  const f = bufToHex(encodePresetSetName(1, 1, "Preset1"));
  expect(cmdOf(f)).toBe("843a");
  expect(len2Of(f)).toBe(4 + 7);
  expect(payloadOf(f, 11)).toBe("00000000" + Buffer.from("Preset1").toString("hex"));
});

// Captured verbatim from an OBSBOT Center "As Initial State" wire sequence:
// aa250f000c001b440a04c43e18002bb2010000003333f33f67668a41000000000000803f00000000
test("encodeBootPose: cmd 0x3ec4, slot index + pose + trailing 0.0 (NOT the -1000 ADD sentinel)", () => {
  const f = bufToHex(encodeBootPose(1, 2, { pan: 1.9, tilt: 17.3, roll: 0, zoom: 1 }));
  expect(cmdOf(f)).toBe("c43e");            // 0x3ec4 LE
  expect(len2Of(f)).toBe(24);
  expect(payloadOf(f, 4)).toBe("01000000"); // slot 2 -> index 1
  // final float must be 0.0 (00000000), not the -1000 sentinel (00007ac4) ADD/UPDATE use
  expect(payloadOf(f, 24).slice(40, 48)).toBe("00000000");
});

// Captured verbatim from the same sequence:
// aa2511000c001ae40a04443e28004dd4feffffffffffffff80ffffffffffffff00000000ffffffff00000000000000000000000000000000
test("encodeBootFlags: cmd 0x3e44, 40-byte captured flag block (no slot index)", () => {
  const f = bufToHex(encodeBootFlags(1));
  expect(cmdOf(f)).toBe("443e");            // 0x3e44 LE
  expect(len2Of(f)).toBe(40);
  expect(payloadOf(f, 40)).toBe(
    "feffffffffffffff80ffffffffffffff00000000ffffffff00000000000000000000000000000000",
  );
});

// Flat XU selector 12: <count:u8> <slotIdx:u8> x count. Hardware-observed 2026-07-19.
test("decodePresetList reads count then slot indices", () => {
  expect(decodePresetList(hexToBuf("030001020000"))).toEqual({ count: 3, slots: [0, 1, 2] });
});

// Flat XU selector 13, 60-byte entry. Real captured fixtures from hardware.
test("decodePresetEntry decodes slot, pose (x0.01 deg) and base64 name", () => {
  const e = decodePresetEntry(hexToBuf("0000000018fcfce5640055484a6c633256304d513d3d00"));
  expect(e.end).toBe(false);
  expect(e.slot).toBe(1);
  expect(e.name).toBe("Preset1");
  expect(e.pose).toEqual({ pan: -66.6, tilt: -10, roll: 0, zoom: 1 });
});

test("decodePresetEntry decodes a second entry", () => {
  const e = decodePresetEntry(hexToBuf("0001000046004808640055484a6c633256304d673d3d00"));
  expect(e.slot).toBe(2);
  expect(e.name).toBe("Preset2");
  expect(e.pose).toEqual({ pan: 21.2, tilt: 0.7, roll: 0, zoom: 1 });
});

test("decodePresetEntry flags the exhausted marker", () => {
  expect(decodePresetEntry(hexToBuf("02000000")).end).toBe(true);
});

// --- I4: decodePresetEntry must not choke on, or misdecode, hostile input ---

test("I4: decodePresetEntry treats a buffer too short for the fixed header as end/invalid, not a RangeError", () => {
  // 8 bytes: block.readInt16LE(6) would need bytes 6-7 to exist, but this is only
  // long enough to trigger readInt16LE(4)/(6) if unguarded — either way, too short
  // for the full 10-byte header (name starts at offset 10).
  expect(() => decodePresetEntry(hexToBuf("0000000018fcfce5"))).not.toThrow();
  expect(decodePresetEntry(hexToBuf("0000000018fcfce5")).end).toBe(true);
});

test("I4: decodePresetEntry treats a 1-byte buffer as end/invalid, not a RangeError", () => {
  expect(() => decodePresetEntry(hexToBuf("00"))).not.toThrow();
  expect(decodePresetEntry(hexToBuf("00")).end).toBe(true);
});

test("I4: decodePresetEntry treats an all-zero 60-byte block as end/invalid, not a plausible occupied slot", () => {
  const e = decodePresetEntry(Buffer.alloc(60));
  expect(e.end).toBe(true);
  expect(e.slot).toBeUndefined();
});

test("I4: decodePresetEntry rejects an out-of-range slot index instead of silently producing slot:8", () => {
  // block[1] = 7 -> slotIdx 7, which (unguarded) would compute slot: 8 and then
  // vanish from assemblePresetSlots's 1|2|3 lookup instead of surfacing as corrupt.
  const header = Buffer.alloc(10);
  header[0] = 0x00; // not the end marker
  header[1] = 7; // implausible slot index
  header.writeInt16LE(0, 4);
  header.writeInt16LE(0, 6);
  header[8] = 100;
  const block = Buffer.concat([header, Buffer.from([0x41, 0x00])]); // "A" + NUL name
  const e = decodePresetEntry(block);
  expect(e.end).toBe(true);
  expect(e.slot).toBeUndefined();
});

// --- C1: the raw selector-12 plausibility check, in isolation ---

test("implausiblePresetListReason accepts a genuine 3-occupied-slots block", () => {
  expect(implausiblePresetListReason(hexToBuf("030001020000"))).toBeNull();
});

test("implausiblePresetListReason rejects a count > the device's 3 slots", () => {
  expect(implausiblePresetListReason(hexToBuf("ff"))).toMatch(/count/i);
});

test("implausiblePresetListReason rejects a block too short for its own claimed count", () => {
  expect(implausiblePresetListReason(hexToBuf("02"))).toMatch(/short/i);
});

test("implausiblePresetListReason rejects a fully all-zero block (failed/silent read)", () => {
  expect(implausiblePresetListReason(Buffer.alloc(60))).toMatch(/all-zero/i);
});

test("implausiblePresetListReason accepts a plausible count=0 block that isn't bit-for-bit zero", () => {
  const b = Buffer.alloc(60);
  b[40] = 0xaa;
  expect(implausiblePresetListReason(b)).toBeNull();
});

test("assemblePresetSlots returns 3 slots, empties marked", () => {
  const slots = assemblePresetSlots([
    { slot: 1, name: "Preset1", pose: { pan: 5, tilt: 0, roll: 0, zoom: 1 } },
  ]);
  expect(slots).toHaveLength(3);
  expect(slots[0]).toMatchObject({ slot: 1, occupied: true, name: "Preset1" });
  expect(slots[1]).toMatchObject({ slot: 2, occupied: false, name: null, pose: null });
  expect(slots[2]).toMatchObject({ slot: 3, occupied: false });
});

// --- Boot pose: the purpose-built AI_SET/RST/TRG_GIM_BOOT_POS family ----------
// Recovered from the in-repo Ghidra extraction (tools/opcodes/opcodes.json) and
// cross-validated against libdev.dll's own marshalling:
//   aiSetGimbalBootPosR internal cmdId 0x07 == AI_SET_GIM_BOOT_POS  (0x3844)
//   aiRstGimbalBootPosR internal cmdId 0x09 == AI_RST_GIM_BOOT_POS  (0x38C4)
//   presets_flag=true alt id 0x43           == AI_SET_BOOT_PRESET_UPDATE_ONLY (0x3EC4)
// The last of those is what our old "encodeBootPose" actually sent: it BINDS AN
// EXISTING PRESET as the boot preset, which is why OBSBOT Center's sequence needs
// a preset-identifying step. This family is the direct, reversible alternative.
test("encodeGimBootPosSet: cmd 0x3844 (AI_SET_GIM_BOOT_POS), yaw/pitch/roll/zoom", () => {
  const f = bufToHex(encodeGimBootPosSet(1, { pan: 30, tilt: -12, roll: 0, zoom: 1 }));
  expect(cmdOf(f)).toBe("4438"); // 0x3844 LE
  // Field ORDER is yaw, pitch, roll, zoom — read directly out of libdev's movss
  // stores (buf+0x05=yaw from [rbx+0xC], +0x09=pitch from [rbx+8], +0x0D=roll
  // from [rbx+4]). PresetPosInfo DECLARES roll,pitch,yaw — the vendor reorders on
  // the way out, so the struct order is host-side only.
  const p = payloadOf(f, 20);
  expect(p.slice(0, 8)).toBe("00000000");   // id — boot pose is global, not slotted
  expect(p.slice(8, 16)).toBe("0000f041");  // yaw   = 30.0
  expect(p.slice(16, 24)).toBe("000040c1"); // pitch = -12.0
  expect(p.slice(24, 32)).toBe("00000000"); // roll  = 0.0
  expect(p.slice(32, 40)).toBe("0000803f"); // zoom  = 1.0
});

test("encodeGimBootPosReset: cmd 0x38c4 (AI_RST_GIM_BOOT_POS), no payload", () => {
  const f = bufToHex(encodeGimBootPosReset(1));
  expect(cmdOf(f)).toBe("c438"); // 0x38C4 LE
  expect(len2Of(f)).toBe(0);     // aiRstGimbalBootPosR takes no arguments
});

test("encodeGimBootPosTrigger: cmd 0x3904 (AI_TRG_GIM_BOOT_POS)", () => {
  const f = bufToHex(encodeGimBootPosTrigger(1));
  expect(cmdOf(f)).toBe("0439"); // 0x3904 LE
});

// The opcode numbers must come from the generated table, not a hand-kept copy.
// preset.ts previously hardcoded `BOOT_POSE: 0x3ec4` / `BOOT_FLAGS: 0x3e44` under
// invented names; those names hid the real semantics (a preset binding and an
// "actions" record) and shaped a whole session's worth of wrong reasoning.
test("preset opcodes are sourced from the generated table under their real names", () => {
  const expected: Record<string, number> = {
    AI_SET_GIMBAL_PRESET_ADD: 0x3944,
    AI_SET_GIMBAL_PRESET_DELETE: 0x3984,
    AI_SET_GIMBAL_PRESET_TRIG: 0x39c4,
    AI_SET_GIMBAL_PRESET_ID_NAME: 0x3a84,
    AI_SET_PRESET_UPDATE_ONLY: 0x3e04,
    AI_SET_GIM_BOOT_POS: 0x3844,
    AI_RST_GIM_BOOT_POS: 0x38c4,
    AI_TRG_GIM_BOOT_POS: 0x3904,
  };
  for (const [name, wire] of Object.entries(expected)) {
    expect(OP_BY_NAME.get(name)?.wireCmd, name).toBe(wire);
  }
});
