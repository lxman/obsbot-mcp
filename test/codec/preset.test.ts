import { expect, test } from "vitest";
import { bufToHex, hexToBuf } from "../../src/codec/encoding.js";
import {
  encodePresetAdd, encodePresetRecall, encodePresetDelete, encodePresetSetName,
  encodePresetListGet, encodePresetValueGet, encodePresetNameGet,
  decodePresetName, decodePresetCount,
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

// Captured 0x3B04 name reply payload (after parseFrame): u16 len=7, "Default", pose block.
test("decodePresetName parses length-prefixed ASCII", () => {
  const payload = hexToBuf("0700" + Buffer.from("Default").toString("hex") + "14000000000000000000000000803f");
  expect(decodePresetName(payload)).toBe("Default");
});

// Captured 0x3B44 list reply payload: u16 count.
test("decodePresetCount reads the leading u16 count", () => {
  expect(decodePresetCount(hexToBuf("0100e63f000d0006000000"))).toBe(1);
  expect(decodePresetCount(hexToBuf("0300"))).toBe(3);
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
