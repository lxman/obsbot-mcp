import { expect, test } from "vitest";
import { crc16usb } from "../../src/codec/crc.js";
import { hexToBuf } from "../../src/codec/encoding.js";

// From the wake golden frame: CRC over frame[0:12] with bytes 6-7 zeroed -> stored token 0x4289 (LE 89 42)
test("crc16usb matches wake header token", () => {
  const hdr = hexToBuf("aa250c000c0000000a02c2a0"); // 12 bytes, token field zeroed
  const c = crc16usb(hdr);
  expect(c & 0xff).toBe(0x89);
  expect(c >> 8).toBe(0x42);
});
