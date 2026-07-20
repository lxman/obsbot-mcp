import { crc16usb } from "./crc.js";
import { u16le } from "./encoding.js";

export interface FrameOpts { seq: number; cmd: number; receiver: number; payload: Buffer; sender?: number; flags?: number; }

export function buildFrame(o: FrameOpts): Buffer {
  const frame = Buffer.alloc(60);            // zero-padded fixed buffer
  frame[0] = 0xaa;
  frame[1] = o.flags ?? 0x25;                 // 0x25 = SET (nested payload); 0x01 = header-only GET
  u16le(o.seq).copy(frame, 2);
  u16le(12).copy(frame, 4);                   // len = 12 (header covered by token)
  // token field (6-7) stays 0 for the CRC, filled after
  frame[8] = o.sender ?? 0x0a;
  frame[9] = o.receiver;
  u16le(o.cmd).copy(frame, 10);
  // header token = CRC-16/USB over frame[0:12] with 6-7 already zero
  u16le(crc16usb(frame.subarray(0, 12))).copy(frame, 6);
  // nested payload segment at offset 12
  if (o.payload.length > 0) {
    const len2 = o.payload.length;
    u16le(len2).copy(frame, 12);              // len2
    // token2 field (14-15) zero for CRC
    o.payload.copy(frame, 16);
    const seg = frame.subarray(12, 12 + len2 + 4); // len2(2)+token2(2)+payload(len2)
    u16le(crc16usb(seg)).copy(frame, 14);
  }
  return frame;
}

export class FrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameParseError";
  }
}

export interface ParsedFrame {
  seq: number;
  cmd: number;
  receiver: number;
  sender: number;
  payload: Buffer;
}

/** Reverse of buildFrame: validate header + optional payload CRC and slice fields out. */
export function parseFrame(buf: Buffer): ParsedFrame {
  if (buf.length < 12) throw new FrameParseError(`frame too short: ${buf.length} bytes`);
  if (buf[0] !== 0xaa) throw new FrameParseError(`bad magic: 0x${buf[0].toString(16)}`);

  // Header CRC covers bytes [0,12) with the token field (6-7) treated as zero.
  const hdr = Buffer.from(buf.subarray(0, 12));
  hdr[6] = 0;
  hdr[7] = 0;
  const wantHdr = crc16usb(hdr);
  const gotHdr = buf.readUInt16LE(6);
  if (gotHdr !== wantHdr) {
    throw new FrameParseError(
      `header CRC mismatch: got 0x${gotHdr.toString(16)} want 0x${wantHdr.toString(16)}`,
    );
  }

  const seq = buf.readUInt16LE(2);
  const sender = buf[8];
  const receiver = buf[9];
  const cmd = buf.readUInt16LE(10);

  let payload = Buffer.alloc(0);
  if (buf.length >= 16) {
    const len2 = buf.readUInt16LE(12);
    if (len2 > 0) {
      const end = 16 + len2;
      if (buf.length < end) {
        throw new FrameParseError(`truncated payload: need ${end} bytes, have ${buf.length}`);
      }
      // Payload CRC covers [12,end) with the token2 field (14-15) treated as zero.
      const seg = Buffer.from(buf.subarray(12, end));
      seg[2] = 0; // frame offset 14
      seg[3] = 0; // frame offset 15
      const wantSeg = crc16usb(seg);
      const gotSeg = buf.readUInt16LE(14);
      if (gotSeg !== wantSeg) {
        throw new FrameParseError(
          `payload CRC mismatch: got 0x${gotSeg.toString(16)} want 0x${wantSeg.toString(16)}`,
        );
      }
      payload = Buffer.from(buf.subarray(16, end));
    }
  }

  return { seq, cmd, receiver, sender, payload };
}
