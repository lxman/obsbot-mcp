// Checksum crack v2: reuse the PROVEN frame extraction (same as file-read
// scripts), require >=3 samples before trusting any match.
import { readFileSync } from "node:fs";
const buf = readFileSync("C:/Users/jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng");
let off = 0, linkType = 1;
const frames = [];
while (off + 8 <= buf.length) {
  const type = buf.readUInt32LE(off), len = buf.readUInt32LE(off + 4);
  if (len < 12 || off + len > buf.length) break;
  const body = buf.subarray(off, off + len);
  if (type === 1) linkType = buf.readUInt16LE(off + 8);
  else if (type === 6) {
    const p = body.subarray(28, 28 + buf.readUInt32LE(off + 20));
    if (linkType !== 1 || p.length < 34) { off += len; continue; }
    let o = 14, et = p.readUInt16BE(12);
    while ((et === 0x8100 || et === 0x88a8) && p.length > o + 4) { o += 4; et = p.readUInt16BE(o - 2); }
    if (et !== 0x0800) { off += len; continue; }
    const ip = p.subarray(o);
    if ((ip[0] >> 4) !== 4 || ip[9] !== 17) { off += len; continue; }
    const ihl = (ip[0] & 0x0f) * 4, total = ip.readUInt16BE(2);
    const udp = ip.subarray(ihl, total);
    if (udp.length < 8) { off += len; continue; }
    const sport = udp.readUInt16BE(0), dport = udp.readUInt16BE(2);
    if (sport !== 9999 && dport !== 9999) { off += len; continue; }
    const d = udp.subarray(8, udp.readUInt16BE(4));
    if (dport === 9999 && d[1] === 0x45 && d[8] === 0x0c) frames.push(d); // type-0x45 client frames
  }
  off += len;
}
console.log(`type-0x45 c2s frames: ${frames.length}`);
const samples = frames.map((d) => ({
  nonce: Buffer.from(d.subarray(6, 8)),
  body: Buffer.from(d.subarray(24)),
  want: d.readUInt16LE(22),
  frame: Buffer.from(d),
})).filter((s) => 24 + s.body.length === s.frame.length);
console.log(`samples with len-consistency: ${samples.length}`);
for (const s of samples) console.log(`  body=${s.body.length}B nonce=${s.nonce.toString("hex")} want=0x${s.want.toString(16)} firstBody=${s.body.subarray(0, 4).toString("hex")}`);
if (samples.length < 3) { console.log("insufficient samples"); process.exit(1); }

const crc16 = (poly, init, refin, refout, xorout) => (data) => {
  let crc = init;
  for (const b of data) {
    if (refin) {
      let x = b;
      for (let i = 0; i < 8; i++) x = x & 1 ? (x >>> 1) ^ 0xa001 : x >>> 1;
      crc ^= x << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    } else {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  if (refout) { let r = 0; for (let i = 0; i < 16; i++) { r = (r << 1) | (crc & 1); crc >>>= 1; } crc = r; }
  return (crc ^ xorout) & 0xffff;
};
const crc32 = (data) => { let c = ~0; for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const fletcher16 = (d) => { let a = 0, b = 0; for (const x of d) { a = (a + x) % 255; b = (b + a) % 255; } return (b << 8) | a; };
const sum16 = (d) => d.reduce((s, x) => (s + x) & 0xffff, 0);
const checks = {
  "CCITT-FALSE": crc16(0x1021, 0xffff, false, false, 0),
  "XMODEM": crc16(0x1021, 0x0000, false, false, 0),
  "KERMIT": crc16(0x1021, 0x0000, true, true, 0),
  "X25": crc16(0x1021, 0xffff, true, true, 0xffff),
  "ARC": crc16(0xa001, 0x0000, true, false, 0),
  "MODBUS": crc16(0xa001, 0xffff, true, false, 0),
  "MAXIM": crc16(0xa001, 0x0000, true, false, 0xffff),
  "crc32-low": (d) => crc32(d) & 0xffff,
  "crc32-hi": (d) => (crc32(d) >>> 16) & 0xffff,
  "crc32-fold": (d) => { const c = crc32(d); return ((c & 0xffff) ^ (c >>> 16)) & 0xffff; },
  fletcher16, sum16,
  "xor8x2": (d) => d.reduce((s, x) => s ^ x, 0) * 0x0101 & 0xffff,
};
const spans = {
  "nonce||body": (f) => Buffer.concat([f.nonce, f.body]),
  "body": (f) => f.body,
  "hdr[0..5]||nonce||body": (f) => Buffer.concat([f.frame.subarray(0, 6), f.nonce, f.body]),
  "hdr[8..13]||nonce||body": (f) => Buffer.concat([f.frame.subarray(8, 14), f.nonce, f.body]),
  "hdr[0..5]||hdr[8..21]||body": (f) => Buffer.concat([f.frame.subarray(0, 6), f.frame.subarray(8, 22), f.body]),
};
const found = [];
for (const [sn, span] of Object.entries(spans)) {
  for (const [cn, fn] of Object.entries(checks)) {
    if (samples.every((f) => fn(span(f)) === f.want)) found.push(`${sn} | ${cn} | want-LE`);
    if (samples.every((f) => fn(span(f)) === (((f.want & 0xff) << 8) | (f.want >> 8)))) found.push(`${sn} | ${cn} | want-BE`);
  }
}
console.log(found.length ? "\n*** REAL MATCHES ***" : "\nno match");
for (const f of found) console.log("  " + f);
