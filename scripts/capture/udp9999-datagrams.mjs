// Hex-dump individual UDP 9999 datagrams that carry file paths, and list
// s2c strings (file-read responses + telemetry identifiers).
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
let off = 0, linkType = 1;
const c2s = [], s2c = [];
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
    if (dport !== 9999 && sport !== 9999) { off += len; continue; }
    const payload = udp.subarray(8, udp.readUInt16BE(4));
    (dport === 9999 ? c2s : s2c).push(payload);
  }
  off += len;
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
console.error(`c2s=${c2s.length} datagrams, s2c=${s2c.length} datagrams`);

console.log("== c2s datagrams containing 'app_ust' (file ops) ==");
c2s.forEach((d, i) => {
  if (d.includes(Buffer.from("app_ust"))) {
    console.log(`-- c2s[${i}] len=${d.length}`);
    for (let k = 0; k < d.length; k += 32) console.log(hex(d.subarray(k, k + 32)));
  }
});

console.log("\n== s2c datagrams containing '{' or 'rtsp' or '.json' (file responses) ==");
s2c.forEach((d, i) => {
  const s = d.toString("latin1");
  if (s.includes(".json") || /rtsp/i.test(s) || (s.includes("{") && s.includes(":"))) {
    // print printable rendering, capped
    let out = "";
    for (const ch of d) out += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
    console.log(`-- s2c[${i}] len=${d.length}: ${out.slice(0, 600)}`);
  }
});
