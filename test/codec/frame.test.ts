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
  expect(p.flags).toBe(0x25);
  expect(p.seq).toBe(0x0102);
  expect(p.cmd).toBe(0x35c2);
  expect(p.receiver).toBe(0x02);
  expect(bufToHex(p.payload)).toBe("01000000");
  expect(p.errorCode).toBeUndefined();
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

// --- Issue #3: V3 reply framing (0x29 data, 0x09 empty/ACK, 0x89 16-byte error) ---

test("parseFrame decodes a 0x29 data reply (captured CAM_GET_EXPOSURE 0x2942)", () => {
  const reply = buildFrame({
    seq: 102,
    cmd: 0x2942,
    sender: 0x02,
    receiver: 0x0a,
    flags: 0x29,
    payload: hexToBuf("0264000000"),
  });
  const p = parseFrame(reply);
  expect(p.flags).toBe(0x29);
  expect(p.seq).toBe(102);
  expect(p.cmd).toBe(0x2942);
  expect(p.sender).toBe(0x02);
  expect(p.receiver).toBe(0x0a);
  expect(bufToHex(p.payload)).toBe("0264000000");
  expect(p.errorCode).toBeUndefined();
});

test("parseFrame decodes a 0x09 empty/ACK reply and ignores stale nested-segment bytes in the buffer tail", () => {
  // Captured on Tiny 2: AI_GET_GIMBAL_PRESET_LIST (0x3B44) with 0 presets replies
  // with flags=0x09, hdrLen=12, overwriting only bytes [0..12) of the selector-2
  // buffer while leaving the previous frame's valid nested segment (e.g. WAKE's
  // 0400be07 00000000) intact at offset 12.
  const buf = hexToBuf(pad60("aa0968000c00ff58040a443b0400be0700000000"));
  const p = parseFrame(buf);
  expect(p.flags).toBe(0x09);
  expect(p.seq).toBe(104);
  expect(p.cmd).toBe(0x3b44);
  expect(p.sender).toBe(0x04);
  expect(p.receiver).toBe(0x0a);
  expect(p.payload.length).toBe(0);
  expect(p.errorCode).toBeUndefined();
});

test("parseFrame decodes a 16-byte 0x89 error reply (captured 0x3B04 -> 0x000a and 0x1234 -> 0xfffd)", () => {
  // Captured on Tiny 2: AI_GET_GIMBAL_PRESET_ID_NAME (0x3B04, seq=105) returns
  // flags=0x89, hdrLen=16, hdrCrc=0xf2b6, bytes 12..15 = 0002 0a00 (errCode=0x000a),
  // followed by unwritten stale tail bytes 0000803f.
  const errName = hexToBuf(pad60("aa8969001000b6f2040a043b00020a000000803f"));
  const p1 = parseFrame(errName);
  expect(p1.flags).toBe(0x89);
  expect(p1.seq).toBe(105);
  expect(p1.cmd).toBe(0x3b04);
  expect(p1.sender).toBe(0x04);
  expect(p1.receiver).toBe(0x0a);
  expect(p1.payload.length).toBe(0);
  expect(p1.errorCode).toBe(0x000a);

  // Captured on Tiny 2: unsupported cmd 0x1234 (seq=110) -> errCode 0xfffd
  const errUnsupported = hexToBuf(pad60("aa896e0010006e59020a34120002fdff02000001"));
  const p2 = parseFrame(errUnsupported);
  expect(p2.flags).toBe(0x89);
  expect(p2.seq).toBe(110);
  expect(p2.cmd).toBe(0x1234);
  expect(p2.errorCode).toBe(0xfffd);
  expect(p2.payload.length).toBe(0);
});

test("parseFrame rejects a 16-byte 0x89 error reply with a corrupted error code (covered by 16-byte header CRC)", () => {
  const err = hexToBuf(pad60("aa8969001000b6f2040a043b00020a000000803f"));
  err[14] = 0x0b; // mutate error code inside the 16-byte header
  expect(() => parseFrame(err)).toThrow(/header CRC/);
});

test("parseFrame rejects an invalid header length field", () => {
  const f = buildFrame({ seq: 1, cmd: 0x35c2, receiver: 0x02, payload: Buffer.alloc(0) });
  f.writeUInt16LE(20, 4);
  expect(() => parseFrame(f)).toThrow(/invalid header length/);
});
