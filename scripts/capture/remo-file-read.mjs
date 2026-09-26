// Decisive file-op test inside a live taken-over session.
// Handshake first (proven), then four file-read variants against the
// capture-2 template; any reply containing JSON text = cracked.
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
const template = s2.find((d) => d.includes(Buffer.from("start_srt.json")));

// Variants
const CLIENT_MAC = Buffer.from("a4fe467f9de7", "hex");
const BLOB = Buffer.from("0f1991491359", "hex");
const v2 = Buffer.from(template); // fresh seq + fresh frame-bytes
v2[2] = 0x40; v2[3] = 0x00;
v2[6] = (Math.random() * 256) | 0; v2[7] = (Math.random() * 256) | 0;
const v3 = Buffer.from(template);
CLIENT_MAC.copy(v3, v3.indexOf(BLOB));
const v4 = Buffer.from(v2);
CLIENT_MAC.copy(v4, v4.indexOf(BLOB));
const variants = [
  ["V1 verbatim", template],
  ["V2 fresh seq+bytes", v2],
  ["V3 blob=clientMAC", v3],
  ["V4 both", v4],
];

const sock = createSocket("udp4");
sock.bind(61604);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let telemetry = 0, others = 0, phase = "";
sock.on("message", (msg) => {
  if (msg.length > 800 && msg.length < 900) { telemetry++; return; } // ~890B telemetry firehose
  others++;
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  const juicy = /[{]|json|srt|rtsp|ndi/i.test(text);
  console.log(`<== [${phase}] ${msg.length}B ${juicy ? "JUICY " : ""}${hex(msg.subarray(0, 80))}${msg.length > 80 ? "..." : ""}`);
  if (juicy) console.log(`    text: ${text.slice(0, 600)}`);
});

(async () => {
  phase = "handshake";
  for (const f of handshake) { sock.send(f, 9999, "192.168.0.132"); await sleep(450); }
  console.log(`handshake done (telemetry so far: ${telemetry})`);
  for (const [name, frame] of variants) {
    phase = name;
    console.log(`\n>> ${name} (${frame.length}B)`);
    sock.send(frame, 9999, "192.168.0.132");
    await sleep(6000);
    console.log(`   window: telemetry=${telemetry} other=${others}`);
    others = 0;
  }
  console.log(`\n=== done. total telemetry frames: ${telemetry} ===`);
  sock.close();
})();
