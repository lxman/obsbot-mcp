// Minimal pcapng reader: extracts TCP conversations and printable payloads.
// Enough protocol for pktmon's etl2pcap output (Ethernet link type):
// SHB/IDB/EPB/SPB blocks -> Eth (VLAN-aware) -> IPv4 -> TCP -> seq-sorted streams.
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2]);
const conns = new Map(); // key "ip:port<->ip:port" (normalized) -> { segments: [{seq,dir,payload}] }

let off = 0;
let linkType = 1;
let packets = 0;
while (off + 8 <= buf.length) {
  const type = buf.readUInt32LE(off);
  const len = buf.readUInt32LE(off + 4);
  if (len < 12 || off + len > buf.length) break;
  const body = buf.subarray(off, off + len);
  if (type === 0x00000001) {
    linkType = buf.readUInt16LE(off + 8);
  } else if (type === 0x00000006) {
    // EPB: type(4) len(4) iface(4) ts_hi(4) ts_lo(4) caplen(4) origlen(4) -> packet at +28
    const caplen = buf.readUInt32LE(off + 20);
    parsePacket(body.subarray(28, 28 + caplen), buf.readUInt32LE(off + 16));
    packets++;
  } else if (type === 0x00000003) {
    const caplen = buf.readUInt32LE(off + 8) % 2 ** 16; // SPB: orig len, caplen inferred
    parsePacket(body.subarray(12, 12 + caplen), 0);
    packets++;
  }
  off += len;
}

function parsePacket(p, iface) {
  if (linkType !== 1 || p.length < 34) return;
  let o = 14; // Ethernet header
  let et = p.readUInt16BE(12);
  while ((et === 0x8100 || et === 0x88a8) && p.length > o + 4) { o += 4; et = p.readUInt16BE(o - 2); }
  if (et !== 0x0800) return;
  const ip = p.subarray(o);
  if ((ip[0] >> 4) !== 4) return;
  const ihl = (ip[0] & 0x0f) * 4;
  const src = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
  const dst = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
  const totalLen = ip.readUInt16BE(2);
  const fromCamera = src === "192.168.0.132";
  if (ip[9] === 17) {
    // UDP
    const udp = ip.subarray(ihl, totalLen);
    if (udp.length < 8) return;
    const sport = udp.readUInt16BE(0);
    const dport = udp.readUInt16BE(2);
    const len = udp.readUInt16BE(4);
    const payload = udp.subarray(8, len);
    if (payload.length === 0) return;
    const a = fromCamera ? `${src}:${sport}` : `${dst}:${dport}`;
    const b = fromCamera ? `${dst}:${dport}` : `${src}:${sport}`;
    const key = `udp ${a}<->${b}`;
    let c = conns.get(key);
    if (!c) conns.set(key, (c = { segments: [] }));
    c.segments.push({ seq: c.segments.length, fromCamera, payload });
    return;
  }
  if (ip[9] !== 6) return; // TCP only below
  const tcp = ip.subarray(ihl, totalLen);
  if (tcp.length < 20) return;
  const sport = tcp.readUInt16BE(0);
  const dport = tcp.readUInt16BE(2);
  const seq = tcp.readUInt32BE(4);
  const doff = (tcp[12] >> 4) * 4;
  const payload = tcp.subarray(doff);
  if (payload.length === 0) return;
  const a = fromCamera ? `${src}:${sport}` : `${dst}:${dport}`;
  const b = fromCamera ? `${dst}:${dport}` : `${src}:${sport}`;
  const key = `${a}<->${b}`;
  let c = conns.get(key);
  if (!c) conns.set(key, (c = { segments: [] }));
  c.segments.push({ seq, fromCamera, payload });
}

const printable = (b) => {
  let out = "";
  for (const ch of b) {
    out += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ch === 0x0a ? "\n" : ch === 0x0d ? "" : ".";
  }
  return out;
};

console.error(`parsed ${packets} packets, ${conns.size} connections`);
for (const [key, c] of conns) {
  const c2s = c.segments.filter((s) => !s.fromCamera);
  const s2c = c.segments.filter((s) => s.fromCamera);
  console.log(`\n===== ${key}  c2s=${c2s.reduce((n, s) => n + s.payload.length, 0)}B s2c=${s2c.reduce((n, s) => n + s.payload.length, 0)}B =====`);
  for (const [label, segs] of [["C->CAM", c2s], ["CAM->C", s2c]]) {
    if (segs.length === 0) continue;
    segs.sort((x, y) => (x.seq - y.seq) | 0);
    const merged = Buffer.concat(segs.map((s) => s.payload));
    // Print printable prefix (up to 4KB) — enough for request/response text.
    const text = printable(merged.subarray(0, 4096));
    console.log(`--- ${label} (${merged.length}B) ---`);
    console.log(text);
    if (merged.length > 4096) console.log(`[+${merged.length - 4096} more bytes]`);
  }
}

