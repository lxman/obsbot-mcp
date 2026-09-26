// CRC16 brute force: every poly x init{0,FFFF} x refin x refout x xorout{0,FFFF}
// over candidate spans, filtered by the 8B sample, verified against all 6.
import { readFileSync } from "node:fs";
const buf = readFileSync("C:/Users/jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng");
let off = 0, linkType = 1;
const all = [];
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
    if (dport !== 9999) { off += len; continue; }
    const d = udp.subarray(8, udp.readUInt16BE(4));
    if (d[1] === 0x45 && d[8] === 0x0c && 24 + d.readUInt16LE(20) === d.length) all.push(d);
  }
  off += len;
}
const samples = all.map((d) => ({ frame: d, body: Buffer.from(d.subarray(24)), want: d.readUInt16LE(22) }));
console.log(`samples: ${samples.length}`);
if (samples.length < 3) process.exit(1);

const spans = {
  body: (s) => s.body,
  cmdSeg8_13_then_body: (s) => Buffer.concat([s.frame.subarray(8, 14), s.body]),
  hdrAll_minus_aaTypeSeqNonceCksum: (s) => Buffer.concat([s.frame.subarray(4, 6), s.frame.subarray(8, 22), s.body]),
};

const crc16 = (data, poly, init, refin, refout, xorout) => {
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

const swap16 = (v) => ((v & 0xff) << 8) | (v >> 8);
for (const [sname, span] of Object.entries(spans)) {
  const probe = samples[0];
  const targetLE = probe.want, targetBE = swap16(probe.want);
  const survivors = [];
  for (let poly = 0; poly < 0x10000; poly++) {
    for (const init of [0x0000, 0xffff]) {
      for (const refin of [false, true]) {
        for (const refout of [false, true]) {
          for (const xorout of [0x0000, 0xffff]) {
            if (crc16(span(probe), poly, init, refin, refout, xorout) === targetLE) survivors.push([poly, init, refin, refout, xorout, "LE"]);
            if (crc16(span(probe), poly, init, refin, refout, xorout) === targetBE) survivors.push([poly, init, refin, refout, xorout, "BE"]);
          }
        }
      }
    }
  }
  console.log(`${sname}: ${survivors.length} survivors on sample[0]`);
  const full = survivors.filter(([poly, init, refin, refout, xorout, e]) =>
    samples.every((s) => crc16(span(s), poly, init, refin, refout, xorout) === (e === "LE" ? s.want : swap16(s.want))));
  if (full.length) {
    console.log(`\n*** CRACKED (${sname}) ***`);
    for (const f of full) console.log(`  poly=0x${f[0].toString(16)} init=0x${f[1].toString(16)} refin=${f[2]} refout=${f[3]} xorout=0x${f[4].toString(16)} endian=${f[5]}`);
  }
}
console.log("done");
