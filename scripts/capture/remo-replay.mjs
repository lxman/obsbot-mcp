// Remo-protocol replay client for the Tail 2 (UDP 9999).
// 1) extract a real Center frame (the start_srt.json file op) from capture 2
// 2) replay verbatim; if the camera answers our socket, there is no session binding
// 3) replay patched variants (equal-length sibling configs first, then
//    length-adjusted rtsp) to map the file-read surface.
import { readFileSync } from "node:fs";
import { createSocket } from "node:dgram";

const PCAP = "C:/Users/jorda/Obsbot/artifacts/tail2/center-session2-rtsp-enable.pcapng";
const CAM = "192.168.0.132";
const CAMPORT = 9999;

// --- extract c2s datagrams from the pcapng (same parsing as scripts/capture) ---
const buf = readFileSync(PCAP);
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
    if (udp.length < 8 || udp.readUInt16BE(2) !== CAMPORT) { off += len; continue; }
    c2s.push(udp.subarray(8, udp.readUInt16BE(4)));
  }
  off += len;
}
// The srt file-op frame: contains the literal path.
const srtFrame = c2s.find((d) => d.includes(Buffer.from("start_srt.json")));
if (!srtFrame) throw new Error("template frame not found in capture");
console.log(`template frame: ${srtFrame.length}B`);

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const show = (tag, msg) => {
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  console.log(`\n<- ${tag} (${msg.length}B)\n${hex(msg.subarray(0, 96))}${msg.length > 96 ? " ..." : ""}\n   text: ${text.slice(0, 400)}`);
};

const sock = createSocket("udp4");
sock.bind(59911); // Center's old source port, now free — removes port-keying doubt
const replies = [];
sock.on("message", (msg, rinfo) => {
  replies.push(msg);
  show(`${rinfo.address}:${rinfo.port}`, msg);
});

const send = (label, frame) => {
  console.log(`\n>> ${label}: ${frame.length}B`);
  console.log(`   ${hex(frame.subarray(0, 96))}${frame.length > 96 ? " ..." : ""}`);
  sock.send(frame, CAMPORT, CAM);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// equal-length sibling swaps: patch the three bytes "srt" inside the frame
const variant = (from, to) => {
  const f = Buffer.from(srtFrame);
  const i = f.indexOf(Buffer.from(from));
  if (i < 0) throw new Error(`pattern ${from} not found`);
  f.write(to, i, "ascii");
  return f;
};
// length-adjusted rtsp: patch text AND fix the protobuf length byte (0x23 -> 0x24)
const rtspVariant = () => {
  const f = Buffer.from(srtFrame);
  const i = f.indexOf(Buffer.from("srt"));
  // protobuf field 3 length sits 2 bytes before the string (tag at i-2)
  f.write("rtsp", i, "ascii");
  f[i - 2] = f[i - 2] + 1; // len prefix 0x23 -> 0x24
  // move the trailing bytes (everything after old string end) by +1
  const oldEnd = i + 3; // end of "srt"
  const tail = f.subarray(oldEnd);
  f.copy(f, oldEnd + 1, oldEnd, f.length - 1);
  f.set(tail.subarray(0, tail.length - 1), oldEnd + 1);
  return f.subarray(0, srtFrame.length + 1);
};

(async () => {
  send("verbatim srt read", srtFrame);
  await sleep(2000);
  send("patched start_ndi.json", variant("srt", "ndi"));
  await sleep(2000);
  send("patched start_uvc.json", variant("srt", "uvc"));
  await sleep(2000);
  send("patched start_rtsp.json (len+1)", rtspVariant());
  await sleep(2500);
  console.log(`\n=== done: ${replies.length} replies ===`);
  sock.close();
})();
