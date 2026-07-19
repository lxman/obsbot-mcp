import { expect, test } from "vitest";
import { bufToHex, hexToBuf } from "../../src/codec/encoding.js";
import {
  encodePresetAdd, encodePresetRecall, encodePresetDelete, encodePresetSetName,
  encodePresetListGet, encodePresetValueGet, encodePresetNameGet,
  decodePresetList, decodePresetEntry, assemblePresetSlots,
} from "../../src/codec/preset.js";

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

test("encodePresetListGet: cmd 0x3b44, empty payload", () => {
  const f = bufToHex(encodePresetListGet(1));
  expect(cmdOf(f)).toBe("443b");
  expect(len2Of(f)).toBe(0);
});

test("encodePresetValueGet: cmd 0x3a44, 4-byte slot-index payload", () => {
  const f = bufToHex(encodePresetValueGet(1, 2));
  expect(cmdOf(f)).toBe("443a");
  expect(len2Of(f)).toBe(4);
  expect(payloadOf(f, 4)).toBe("01000000");  // slot 2 -> index 1
});

test("encodePresetNameGet: cmd 0x3b04, 4-byte slot-index payload", () => {
  const f = bufToHex(encodePresetNameGet(1, 3));
  expect(cmdOf(f)).toBe("043b");
  expect(len2Of(f)).toBe(4);
  expect(payloadOf(f, 4)).toBe("02000000");  // slot 3 -> index 2
});

test("assemblePresetSlots returns 3 slots, empties marked", () => {
  const slots = assemblePresetSlots(1, [
    { slot: 1, name: "Preset1", pose: { pan: 5, tilt: 0, roll: 0, zoom: 1 } },
  ]);
  expect(slots).toHaveLength(3);
  expect(slots[0]).toMatchObject({ slot: 1, occupied: true, name: "Preset1" });
  expect(slots[1]).toMatchObject({ slot: 2, occupied: false, name: null, pose: null });
  expect(slots[2]).toMatchObject({ slot: 3, occupied: false });
});
