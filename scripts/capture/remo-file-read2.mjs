// File-read inside a PROPERLY MAINTAINED session: heartbeat keepalives
// (like Center's ~5s cadence) + subscription frames, then the verbatim read.
import { readFileSync } from "node:fs";
import { createSocket } from "node:dgram";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
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
// Center's subscription + status poll frames from session 2 (small, repeated):
const subscribe = s2.filter((d) => d.length === 32 && d[8] === 0x0c && d[9] === 0x01 && d[10] === 0x81 && d[11] === 0x08);
const poll1 = s2.filter((d) => d.length === 20 && d.subarray(9, 11).toString("hex") === "0404");
const poll2 = s2.filter((d) => d.length === 28 && d.subarray(9, 11).toString("hex") === "0484");
console.log(`templates: subscribe=${subscribe.length} poll1=${poll1.length} poll2=${poll2.length}`);
const sub = subscribe[0], p1 = poll1[0], p2 = poll2[0];

const CLIENT_MAC = Buffer.from("a4fe467f9de7", "hex");
let seq = 0x50;
const frame = (template) => {
  const f = Buffer.from(template);
  f[2] = seq & 0xff; f[3] = (seq >> 8) & 0xff; seq++;
  f[6] = (Math.random() * 256) | 0; f[7] = (Math.random() * 256) | 0;
  // stamp OUR client MAC over whatever identity the template carried
  const mi = f.indexOf(Buffer.from("cfbf593ac5d2", "hex"));
  if (mi >= 0) CLIENT_MAC.copy(f, mi);
  return f;
};

const sock = createSocket("udp4");
sock.bind(61604);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let telemetry = 0, phase = "";
const log = [];
sock.on("message", (msg) => {
  if (msg.length > 800 && msg.length < 900) { telemetry++; return; }
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  const juicy = /[{]|json|srt|rtsp|ndi/i.test(text);
  console.log(`<== [${phase}] ${msg.length}B ${juicy ? "*** JUICY ***" : ""} ${hex(msg.subarray(0, 96))}${msg.length > 96 ? "..." : ""}`);
  if (juicy) console.log(`    text: ${text.slice(0, 800)}`);
  log.push({ phase, len: msg.length, text: text.slice(0, 1000) });
});
const send = (f) => sock.send(f, 9999, "192.168.0.132");

(async () => {
  phase = "handshake";
  for (const h of handshake) { send(h); await sleep(400); }
  // mirror Center's cadence for ~15s: heartbeat + polls + subscription
  phase = "keepalive";
  for (let i = 0; i < 5; i++) {
    send(frame(p1)); await sleep(900);
    send(frame(sub)); await sleep(900);
    send(frame(p2)); await sleep(900);
  }
  console.log(`keepalive done (telemetry: ${telemetry})`);
  // NOW the file read — verbatim except fresh seq/nonce bytes
  phase = "FILE-READ";
  console.log(">> sending srt file-read (fresh seq/bytes, session token verbatim)");
  send(frame(fileRead));
  await sleep(8000);
  console.log(`\n=== done. telemetry=${telemetry}, logged=${log.length} ===`);
  sock.close();
})();
