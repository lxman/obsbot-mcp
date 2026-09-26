// Find the reboot window: where s2c frames stop (camera died) and resume
// (camera back). Everything c2s in between = Center's re-handshake.
import { readFileSync } from "node:fs";
const buf = readFileSync("C:/Users/Jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng");
let off = 0, linkType = 1;
const events = [];
while (off + 8 <= buf.length) {
  const type = buf.readUInt32LE(off), len = buf.readUInt32LE(off + 4);
  if (len < 12 || off + len > buf.length) break;
  const body = buf.subarray(off, off + len);
  if (type === 1) linkType = buf.readUInt16LE(off + 8);
  else if (type === 6) {
    const p = body.subarray(28, 28 + buf.readUInt32LE(off + 20));
    const ts = buf.readUInt32LE(off + 8) * 4294967296 + buf.readUInt32LE(off + 12);
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
    events.push({ ts, dir: dport === 9999 ? "c2s" : "s2c", d: udp.subarray(8, udp.readUInt16BE(4)) });
  }
  off += len;
}
const s2cIdx = events.map((e, i) => e.dir === "s2c" ? i : -1).filter((i) => i >= 0);
let gapLo = 0, gapHi = s2cIdx.length - 1;
for (let k = 1; k < s2cIdx.length; k++) {
  if (events[s2cIdx[k]].ts - events[s2cIdx[k - 1]].ts > 40e6) { gapLo = s2cIdx[k - 1]; gapHi = s2cIdx[k]; break; }
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
console.log(`camera-outage window: after event #${gapLo} (last s2c) until #${gapHi} (first s2c back), ${((events[gapHi].ts - events[gapLo].ts) / 1e6).toFixed(1)}s`);
console.log("=== Center re-handshake + camera first replies ===");
for (let i = gapLo + 1; i <= Math.min(gapHi + 8, events.length - 1); i++) {
  const e = events[i];
  console.log(`[${i}] ${e.dir} ${e.d.length}B ${hex(e.d.subarray(0, 64))}${e.d.length > 64 ? " ..." : ""}`);
}
