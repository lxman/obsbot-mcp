// File-read with the CLIENT ID corrected to our live session's
// (a4 fe 46 7f 9d e7): the one variable proven wrong.
import { readFileSync } from "node:fs";
import { createSocket } from "node:dgram";
const hex = (b) => [...b].map((x) => x.toString(hex ? 16 : 16)).join(" ");
const H = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

function c2sFrames(path) {
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
      if (udp.length < 8 || udp.readUInt16BE(2) !== 9999) { off += len; continue; }
      out.push(udp.subarray(8, udp.readUInt16BE(4)));
    }
    off += len;
  }
  return out;
}
const s3 = c2sFrames("C:/Users/jorda/Obsbot/artifacts/tail2/center-session3-handshake.pcapng");
const s2 = c2sFrames("C:/Users/jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng");
const handshake = [33, 20, 20, 195, 25, 20].map((len) => s3.find((d) => d.length === len));
const fileRead = s2.find((d) => d.includes(Buffer.from("start_srt.json")));
const p1 = s2.find((d) => d.length === 20 && d.subarray(9, 11).toString("hex") === "0404");

const OUR_ID = Buffer.from("a4fe467f9de7", "hex");
const OLD_ID = Buffer.from("0f1991491359", "hex");
const fixed = Buffer.from(fileRead);
const at = fixed.indexOf(OLD_ID);
if (at < 0) throw new Error("old client id not found");
OUR_ID.copy(fixed, at);
console.log(`client id swapped @${at}: ${H(fixed.subarray(at - 2, at + 8))}`);

const sock = createSocket("udp4");
sock.bind(61604);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let telemetry = 0, phase = "";
sock.on("message", (msg) => {
  if (msg.length > 800 && msg.length < 900) { telemetry++; return; }
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  const juicy = /[{]|json|srt|rtsp|ndi/i.test(text);
  console.log(`<== [${phase}] ${msg.length}B ${juicy ? "*** JUICY ***" : ""} ${H(msg.subarray(0, 110))}${msg.length > 110 ? "..." : ""}`);
  if (juicy) console.log(`    text: ${text.slice(0, 900)}`);
});
let seq = 0x60;
const keepalive = () => {
  const f = Buffer.from(p1);
  f[2] = seq & 0xff; f[3] = 0; seq++;
  f[6] = (Math.random() * 256) | 0; f[7] = (Math.random() * 256) | 0;
  const mi = f.indexOf(Buffer.from("cfbf593ac5d2", "hex"));
  if (mi >= 0) OUR_ID.copy(f, mi);
  sock.send(f, 9999, "192.168.0.132");
};
const send = (f) => sock.send(f, 9999, "192.168.0.132");

(async () => {
  phase = "handshake";
  for (const h of handshake) { send(h); await sleep(400); }
  phase = "keepalive";
  for (let i = 0; i < 3; i++) { keepalive(); await sleep(1200); }
  console.log("session warm; sending FIXED file-read");
  phase = "FILE-READ-FIXED";
  send(fixed);
  for (let i = 0; i < 6; i++) { await sleep(1400); keepalive(); }
  console.log(`\n=== done. telemetry=${telemetry} ===`);
  sock.close();
})();
