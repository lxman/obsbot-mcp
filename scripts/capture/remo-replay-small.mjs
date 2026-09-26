// Replay the SMALL captured frames verbatim (heartbeat, status poll, auth
// read) — all previously answered by the camera. Discriminates between
// "channel/session is closed to us" and "the file-op frame is protected".
import { readFileSync } from "node:fs";
import { createSocket } from "node:dgram";

const buf = readFileSync("C:/Users/jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng");
let off = 0, linkType = 1;
const c2s = [];
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
    if (udp.length < 8 || udp.readUInt16BE(2) !== 9999) { off += len; continue; }
    c2s.push(udp.subarray(8, udp.readUInt16BE(4)));
  }
  off += len;
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

// Distinct small frames by their seq id: heartbeat (e9), status (ea), query (f0), auth (f1).
const pick = (seqHex) => c2s.find((d) => d.subarray(2, 4).toString("hex") === seqHex && d.length <= 40);

const sock = createSocket("udp4");
sock.bind(59911);
let got = 0;
sock.on("message", (msg, rinfo) => {
  got++;
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  console.log(`<== ${rinfo.address}:${rinfo.port} ${msg.length}B ${hex(msg.subarray(0, 80))}`);
  console.log(`    text: ${text.slice(0, 300)}`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (const seq of ["e905", "ea05", "f005", "f105"]) {
    const f = pick(seq);
    if (!f) { console.log(`(no template for ${seq})`); continue; }
    console.log(`>> [${seq}] ${f.length}B ${hex(f)}`);
    sock.send(f, 9999, "192.168.0.132");
    await sleep(1500);
  }
  // and once more from a fresh ephemeral port, in case 59911 is poisoned
  const s2 = createSocket("udp4");
  s2.on("message", (msg, rinfo) => console.log(`<== (ephemeral) ${msg.length}B ${hex(msg.subarray(0, 60))}`));
  const hb = pick("e905");
  if (hb) { console.log(`>> [e905] from ephemeral port`); s2.send(hb, 9999, "192.168.0.132"); }
  await sleep(2000);
  console.log(`=== done: ${got} replies ===`);
  sock.close(); s2.close();
})();
