import { expect, test } from "vitest";
import { buildFrame, parseFrame, FrameParseError } from "../../src/codec/frame.js";
import { bufToHex, hexToBuf } from "../../src/codec/encoding.js";
import { crc16usb } from "../../src/codec/crc.js";

const pad60 = (h: string) => (h + "0".repeat(120)).slice(0, 120);

test("buildFrame reproduces the captured WAKE frame exactly", () => {
  const f = buildFrame({ seq: 0x000c, cmd: 0xa0c2, receiver: 0x02, payload: hexToBuf("00000000") });
  expect(bufToHex(f)).toBe(pad60("aa250c000c0089420a02c2a00400be07"));
});

test("buildFrame reproduces the captured SLEEP frame exactly", () => {
  const f = buildFrame({ seq: 0x0012, cmd: 0xa0c2, receiver: 0x02, payload: hexToBuf("01000000") });
  expect(bufToHex(f)).toBe(pad60("aa2512000c00e9220a02c2a00400bffb01000000"));
});

test("move-to-angle frame has cmd bytes 44 64 and valid header token", () => {
  const f = buildFrame({ seq: 1, cmd: 0x6444, receiver: 0x04,
    payload: Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]) }); // 0,0,0
  expect(f[10]).toBe(0x44); expect(f[11]).toBe(0x64);
  expect(f.length).toBe(60);
});

test("parseFrame round-trips a buildFrame frame with a payload", () => {
  const f = buildFrame({ seq: 0x0102, cmd: 0x35c2, receiver: 0x02, payload: hexToBuf("01000000") });
  const p = parseFrame(f);
  expect(p.seq).toBe(0x0102);
  expect(p.cmd).toBe(0x35c2);
  expect(p.receiver).toBe(0x02);
  expect(bufToHex(p.payload)).toBe("01000000");
});

test("parseFrame round-trips a payload-less frame", () => {
  const f = buildFrame({ seq: 7, cmd: 0x35c2, receiver: 0x02, payload: Buffer.alloc(0) });
  const p = parseFrame(f);
  expect(p.cmd).toBe(0x35c2);
  expect(p.payload.length).toBe(0);
});

test("parseFrame rejects a bad magic byte", () => {
  const f = buildFrame({ seq: 1, cmd: 0x35c2, receiver: 0x02, payload: hexToBuf("00000000") });
  f[0] = 0x00;
  expect(() => parseFrame(f)).toThrow(FrameParseError);
});

test("parseFrame rejects a corrupted header CRC", () => {
  const f = buildFrame({ seq: 1, cmd: 0x35c2, receiver: 0x02, payload: hexToBuf("00000000") });
  f[9] = (f[9] + 1) & 0xff; // flip the receiver byte -> header CRC no longer matches
  expect(() => parseFrame(f)).toThrow(/header CRC/);
});

test("parseFrame rejects a corrupted payload CRC", () => {
  const f = buildFrame({ seq: 1, cmd: 0x35c2, receiver: 0x02, payload: hexToBuf("01000000") });
  f[16] = (f[16] + 1) & 0xff; // mutate payload byte -> payload CRC no longer matches
  expect(() => parseFrame(f)).toThrow(/payload CRC/);
});

test("parseFrame rejects a truncated buffer", () => {
  expect(() => parseFrame(Buffer.from([0xaa, 0x25, 0x00]))).toThrow(FrameParseError);
});

test("buildFrame flags defaults to 0x25", () => {
  expect(buildFrame({ seq: 1, cmd: 0x18c8, receiver: 0x0d, payload: Buffer.alloc(0) })[1]).toBe(0x25);
});
test("buildFrame honours an explicit flags byte and recomputes the header CRC", () => {
  const f = buildFrame({ seq: 1, cmd: 0x18c8, receiver: 0x0d, payload: Buffer.alloc(0), flags: 0x01 });
  expect(f[1]).toBe(0x01);
  // header CRC over [0,12) with bytes 6-7 zeroed must be self-consistent
  const hdr = Buffer.from(f.subarray(0, 12)); hdr[6] = 0; hdr[7] = 0;
  expect(f.readUInt16LE(6)).toBe(crc16usb(hdr));
});
