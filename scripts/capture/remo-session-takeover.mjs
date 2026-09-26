// THE TEST: replay the session-3 handshake verbatim, then transplant the
// capture-2 file-read onto the new session (swap client MAC, keep the rest)
// and see if the camera answers US.
import { readFileSync } from "node:fs";
import { createSocket } from "node:dgram";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

// Handshake c2s frames (events 0,2,4,6,8,10 from session-3 chronology).
const HS = [
  "aa 25 00 00 14 00 6a 78 0c 01 01 08 02 06 a4 fe 46 7f 9d e7 09 00 32 aa 0c 01 00 93 00 a8 c0 a4 f0",
  "aa 01 01 00 14 00 52 6b 0c 01 81 0b 02 06 a4 fe 46 7f 9d e7",
  "aa 01 02 00 14 00 81 23 0c 01 41 0c 02 06 a4 fe 46 7f 9d e7",
  // event 6: auth write, 195B — rebuilt below from the pcap (too long to inline)
  null,
  "aa 21 04 00 14 00 e8 b9 0c 01 01 0c 02 06 a4 fe 46 7f 9d e7 01 00 27 ff 01",
  "aa 01 05 00 14 00 22 fd 0c 0d 08 18 02 06 a4 fe 46 7f 9d e7",
];

// Extract event 6 (the 195B auth write) and the file-op template from pcaps.
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
HS[3] = hex(s3.find((d) => d.length === 195));
const authWrite = s3.find((d) => d.length === 195);
const fileRead = s2.find((d) => d.includes(Buffer.from("start_srt.json")));

// The file-op header carries its own 6-byte blob (0f 19 91 49 13 59), NOT the
// small-frame client MAC — so no transplant; send it verbatim after the
// handshake and let the camera arbitrate.
const transplanted = Buffer.from(fileRead);

const sock = createSocket("udp4");
sock.bind(61604); // session-3 port: the camera sends replies to the REGISTERED port, not the datagram source
let replies = 0;
sock.on("message", (msg, rinfo) => {
  replies++;
  let text = "";
  for (const ch of msg) text += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
  console.log(`<== [${replies}] ${msg.length}B ${hex(msg.subarray(0, 64))}${msg.length > 64 ? " ..." : ""}`);
  if (text.match(/[{"]|srt|rtsp|ndi/)) console.log(`    text: ${text.slice(0, 500)}`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  console.log("== replaying handshake ==");
  for (const [i, h] of HS.entries()) {
    if (!h) continue;
    const f = Buffer.from(h.replace(/\s+/g, ""), "hex");
    console.log(`>> hs[${i}] ${f.length}B`);
    sock.send(f, 9999, "192.168.0.132");
    await sleep(600);
  }
  console.log("== transplanted file-read (srt) ==");
  console.log(`>> ${transplanted.length}B ${hex(transplanted.subarray(0, 64))}...`);
  sock.send(transplanted, 9999, "192.168.0.132");
  await sleep(2500);
  console.log(`=== done: ${replies} replies ===`);
  sock.close();
  process.exit(replies > 0 ? 0 : 1);
})();
