import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Passive mDNS discovery for the OBSBOT Tail 2.
 *
 * The Tail 2 has no mDNS query responder — it ANNOUNCES. Every few seconds it
 * multicasts a response-framed packet to 224.0.0.251:5353 (IPv4, and the same
 * digest over IPv6 link-local) carrying, in the TXT record of its
 * `_remo_mdns._tcp.local` service, a full device digest: both MACs, both IPs,
 * the hex-encoded device name, battery and sleep flags. Measured 2026-09-30 by
 * capturing OBSBOT Center's discovery: Center sent no queries either — the
 * announcements alone are how everything on the LAN finds the camera.
 * TAIL2-PROTOCOL.md §2a.
 *
 * So discovery here is a listen, not a sweep: bind 5353 with SO_REUSEADDR
 * (the OS's own responder holds the port on every platform; multicast
 * delivery to multiple REUSEADDR sockets is uniform across Windows, Linux
 * and macOS — it is how NDI tools coexist), join the group on every
 * non-internal IPv4 interface, and collect Tail 2-shaped announcements.
 * TAIL2-PROTOCOL.md §7a.
 */

/** What one camera's announcement tells us — identity straight from the camera. */
export interface Tail2Announcement {
  mac: string;
  name: string;
  /** Wired first, then wireless, then the address the packet arrived from. */
  hosts: string[];
}

const GROUP = "224.0.0.251";
const MDNS_PORT = 5353;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

const isUsefulHost = (h: string): boolean => h !== "" && h !== "0.0.0.0" && h !== "255.255.255.255";

// ---------------------------------------------------------------------------
// DNS packet parsing — just enough for mDNS response packets: questions are
// skipped, answer names are decoded (compression pointers included), and TXT
// records are unpacked into their length-prefixed strings. SRV/A/AAAA are
// tolerated structurally but only TXT carries the Tail 2 digest.
// ---------------------------------------------------------------------------

/** Decode a (possibly compressed) DNS name. Returns the name and the offset
 *  just past it in the ORIGINAL section — after a compression pointer the
 *  record's fixed fields continue right after the pointer itself. */
function readName(buf: Buffer, off: number): { name: string; end: number } {
  const labels: string[] = [];
  let jumped = false;
  let end = off;
  let pos = off;
  let jumps = 0;
  while (true) {
    if (pos >= buf.length) return { name: "", end: buf.length };
    const len = buf[pos]!;
    if (len === 0) {
      if (!jumped) end = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return { name: "", end: buf.length };
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (!jumped) end = pos + 2;
      if (++jumps > 32) return { name: "", end: buf.length }; // pointer loop
      pos = ptr;
      jumped = true;
      continue;
    }
    if (pos + 1 + len > buf.length) return { name: "", end: buf.length };
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("latin1"));
    pos += 1 + len;
  }
  return { name: labels.join("."), end };
}

/** Unpack one packet's TXT strings; other record types are skipped by RDLENGTH. */
function txtStringsOf(buf: Buffer): string[] {
  const strings: string[] = [];
  if (buf.length < 12) return strings;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const { end } = readName(buf, pos);
    pos = end + 4; // QTYPE + QCLASS
    if (pos > buf.length) return strings;
  }
  for (let i = 0; i < an; i++) {
    const { end } = readName(buf, pos);
    pos = end;
    if (pos + 10 > buf.length) return strings;
    const type = buf.readUInt16BE(pos);
    const rdLength = buf.readUInt16BE(pos + 8);
    const rdata = buf.subarray(pos + 10, pos + 10 + rdLength);
    pos += 10 + rdLength;
    if (type === 16) {
      // TXT RDATA: a sequence of <1-byte length><bytes> strings.
      let p = 0;
      while (p < rdata.length) {
        const l = rdata[p]!;
        if (p + 1 + l > rdata.length) break;
        strings.push(rdata.subarray(p + 1, p + 1 + l).toString("utf8"));
        p += 1 + l;
      }
    }
  }
  return strings;
}

/**
 * Extract a Tail 2 announcement from one mDNS packet, or null for anything
 * else on the wire. Detection is by the digest's own shape — TXT strings that
 * JSON-parse into an object carrying a `ble_mac` (the registry's identity
 * MAC) plus a reachable IP — so other devices' mDNS traffic parses to nothing
 * and registers nothing. `srcIp` is where the packet came from; it becomes a
 * host of last resort and a live-reachability hint.
 */
export function parseTail2Announcement(buf: Buffer, srcIp?: string): Tail2Announcement | null {
  const merged: Record<string, unknown> = {};
  for (const s of txtStringsOf(buf)) {
    if (!s.startsWith("{")) continue;
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        Object.assign(merged, v as Record<string, unknown>);
      }
    } catch {
      // Someone else's TXT string that merely looks like JSON — ignore.
    }
  }
  const mac = typeof merged.ble_mac === "string" ? merged.ble_mac.toLowerCase() : "";
  if (!MAC_RE.test(mac)) return null;

  const hosts: string[] = [];
  for (const h of [merged.wired_ip, merged.wireless_ip]) {
    if (typeof h === "string" && isUsefulHost(h) && !hosts.includes(h)) hosts.push(h);
  }
  if (srcIp && isUsefulHost(srcIp) && !hosts.includes(srcIp)) hosts.push(srcIp);
  if (hosts.length === 0) return null;

  let name = mac;
  if (typeof merged.device_name === "string" && /^[0-9a-f]+$/i.test(merged.device_name)) {
    const decoded = Buffer.from(merged.device_name, "hex").toString("utf8");
    if (decoded !== "") name = decoded;
  }
  return { mac, name, hosts };
}

/** Accumulates announcements across packets, keyed by MAC. Testable without
 *  sockets: push() buffers, results() the deduplicated list. */
export function createAnnouncementCollector() {
  const byMac = new Map<string, Tail2Announcement>();
  return {
    push(buf: Buffer, srcIp?: string): void {
      const a = parseTail2Announcement(buf, srcIp);
      if (!a) return;
      const existing = byMac.get(a.mac);
      if (existing) {
        for (const h of a.hosts) if (!existing.hosts.includes(h)) existing.hosts.push(h);
      } else {
        byMac.set(a.mac, a);
      }
    },
    results(): Tail2Announcement[] {
      return [...byMac.values()];
    },
  };
}

/**
 * Listen for Tail 2 announcements for `ms` milliseconds (the camera repeats
 * every few seconds, so 5s is ample) and return what was heard. Never throws:
 * a bind failure or a network without multicast yields an empty list, and the
 * caller falls back to the HTTP sweep.
 */
export function listenForTail2Announcements(ms = 5000): Promise<Tail2Announcement[]> {
  return new Promise((resolve) => {
    const collector = createAnnouncementCollector();
    let socket: dgram.Socket | null = null;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        try {
          socket.dropMembership(GROUP);
        } catch {
          // Already gone.
        }
        socket.close();
      }
      resolve(collector.results());
    };
    const timer = setTimeout(finish, ms);
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socket.on("message", (buf: Buffer, rinfo: dgram.RemoteInfo) => {
        collector.push(buf, rinfo.address);
      });
      socket.on("error", finish);
      socket.bind(MDNS_PORT, () => {
        const s = socket!;
        try {
          s.addMembership(GROUP);
        } catch {
          // Default-interface join failed; explicit per-interface joins below.
        }
        for (const addrs of Object.values(networkInterfaces())) {
          for (const a of addrs ?? []) {
            if (a.family !== "IPv4" || a.internal) continue;
            try {
              s.addMembership(GROUP, a.address);
            } catch {
              // One unusable interface must not cost the others.
            }
          }
        }
      });
    } catch {
      finish();
    }
  });
}
