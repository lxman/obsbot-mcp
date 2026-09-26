// Extract the FULL session chronology from the fresh handshake capture:
// capture started before Center launched, so capture order == time order and
// the first c2s frames ARE the handshake. Dump everything in order, capped.
import { readFileSync } from "node:fs";
const buf = readFileSync("C:/Users/jorda/Obsbot/artifacts/tail2/center-session3-handshake.pcapng");
let off = 0, linkType = 1;
const events = [];
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
    events.push({ dir: dport === 9999 ? "c2s" : "s2c", d: udp.subarray(8, udp.readUInt16BE(4)) });
  }
  off += len;
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
console.error(`events: ${events.length} (${events.filter((e) => e.dir === "c2s").length} c2s)`);
for (const [i, e] of events.entries()) {
  if (e.d.length > 120) {
    console.log(`[${i}] ${e.dir} ${e.d.length}B ${hex(e.d.subarray(0, 48))}...`);
  } else {
    console.log(`[${i}] ${e.dir} ${e.d.length}B ${hex(e.d)}`);
  }
}
