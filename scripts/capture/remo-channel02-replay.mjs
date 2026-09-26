// Full channel-02 replay: session takeover, then the ENTIRE capture-2
// c2s sequence from the post-reboot re-handshake through the channel-02
// prelude to the file read — client id swapped to ours, seqs renumbered.
import { readFileSync } from "node:fs";
import { createSocket } from "node:dgram";

function c2sEvents(path) {
  const buf = readFileSync(path);
  let off = 0, linkType = 1;
  const out = [];
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
      out.push(udp.subarray(8, udp.readUInt16BE(4)));
    }
    off += len;
  }
  return out;
}
const s3 = c2sEvents("C:/Users/jorda/Obsbot/artifacts/tail2/center-session3-handshake.pcapng");
const s2 = c2sEvents("C:/Users/jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng");
const handshake3 = [33, 20, 20, 195, 25, 20].map((len) => s3.find((d) => d.length === len));

// capture-2 c2s sequence from re-handshake opener to just before the read:
// the re-handshake frames are identifiable by seq 0x0000-0x0008 after frame 1266;
// simpler: take every c2s frame from index of the seq==0 opener (the one with
// client id 0f1991...) through the 09 30 prelude — i.e. the frames we enumerated.
// Rebuild by filtering: all c2s frames carrying OUR-TO-BE id 0f1991... in order.
const OLD = Buffer.from("0f1991491359", "hex");
const chain = s2.filter((d) => d.includes(OLD));
console.log(`channel-02 chain frames (id 0f1991...): ${chain.length}`);
const OURS = Buffer.from("a4fe467f9de7", "hex");
let seq = 0x100;
const adapt = (tpl) => {
  const f = Buffer.from(tpl);
  const at = f.indexOf(OLD);
  if (at >= 0) OURS.copy(f, at);
  f[2] = seq & 0xff; f[3] = (seq >> 8) & 0xff; seq += 1;
  return f;
};

const sock = createSocket("udp4");
sock.bind(61604);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let telemetry = 0, interesting = 0, phase = "";
sock.on("message", (msg) => {
  if (msg.length > 800 && msg.length < 900) { telemetry++; return; }
  if (msg.length === 20 || msg.length === 28 || msg.length === 33 || msg.length === 36 || msg.length === 44) return; // cadence noise
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  interesting++;
  const juicy = /[{]|json|srt|rtsp|ndi/i.test(text);
  console.log(`<== [${phase}] ${msg.length}B ${juicy ? "*** JUICY ***" : ""} ${[...msg.subarray(0, 100)].map((x) => x.toString(16).padStart(2, "0")).join(" ")}${msg.length > 100 ? "..." : ""}`);
  if (juicy) console.log(`    text: ${text.slice(0, 900)}`);
});

(async () => {
  phase = "hs3";
  for (const h of handshake3) { sock.send(h, 9999, "192.168.0.132"); await sleep(350); }
  phase = "chain";
  let i = 0;
  for (const tpl of chain) {
    const f = adapt(tpl);
    sock.send(f, 9999, "192.168.0.132");
    if (f.length > 40) console.log(`>> chain[${i}] ${f.length}B seq=0x${((f[3] << 8) | f[2]).toString(16)} cmd=${f.subarray(8, 12).toString("hex")}`);
    i++;
    await sleep(220);
  }
  phase = "post";
  await sleep(6000);
  console.log(`\n=== done: telemetry=${telemetry} interesting=${interesting} ===`);
  sock.close();
})();
