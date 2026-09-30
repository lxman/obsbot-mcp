import { describe, expect, it } from "vitest";
import { createAnnouncementCollector, parseTail2Announcement } from "../../src/tail2/mdns.js";

/**
 * Parser tests build DNS response packets by hand in the exact shape the
 * camera multicasts (captured 2026-09-30, TAIL2-PROTOCOL.md §2a): a TXT
 * record on `Remo_mDNS._remo_mdns._tcp.local` whose strings are JSON objects,
 * split across two strings — one with the network identity (wifi_mac, both
 * IPs), one with the device identity (hex device_name, ble_mac).
 */

const NET_JSON =
  `{"wifi_mac":"10:a5:62:bc:3c:ba","wifi_mode":"ap","wireless_ip":"192.168.55.222",` +
  `"wired_ip":"192.168.0.132","ssid":"","conn_app":0,"conn_monitor":0,"conn_pc":0}`;
const DEV_JSON =
  `{"device_name":"5461696c20325f626333636263","ble_mac":"10:a5:62:bc:3c:bc",` +
  `"battery_level":100,"swivel":false,"pop_up":false,"charging":false,` +
  `"overtemp":true,"power_adapter":true,"remote":false,"is_sleep":false,"power_low":false}`;
const SN_JSON = `{"device_type":1,"device_flags":0,"product_type":6,"device_sn":"Ng=="}`;

function labels(name: string): Buffer[] {
  return name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
}

function record(nameParts: Buffer[], type: number, rdata: Buffer): Buffer {
  const head = Buffer.concat([...nameParts, Buffer.from([0])]);
  return Buffer.concat([
    head,
    Buffer.from([0, type, 0, 1]), // TYPE, CLASS=IN
    Buffer.from([0, 0, 0, 30]), // TTL
    Buffer.from([rdata.length >> 8, rdata.length & 0xff]),
    rdata,
  ]);
}

function txt(strings: string[]): Buffer {
  return Buffer.concat(strings.map((s) => {
    const b = Buffer.from(s, "utf8");
    if (b.length > 255) throw new Error("test TXT string too long");
    return Buffer.concat([Buffer.from([b.length]), b]);
  }));
}

function packet(records: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0]), // id, flags(response), qdcount=0
    Buffer.from([0, records.length, 0, 0, 0, 0]), // ancount, nscount, arcount
    ...records,
  ]);
}

const REMO_NAME = labels("Remo_mDNS._remo_mdns._tcp.local");
const tail2Packet = (): Buffer =>
  packet([
    record(REMO_NAME, 16, txt([NET_JSON, DEV_JSON, SN_JSON])),
    record(labels("Tail2bc3cbc.local"), 1, Buffer.from([192, 168, 0, 132])),
  ]);

describe("parseTail2Announcement", () => {
  it("extracts MAC, decoded name, and both IPs from a real-shaped announcement", () => {
    const a = parseTail2Announcement(tail2Packet(), "192.168.0.132");
    expect(a).toEqual({
      mac: "10:a5:62:bc:3c:bc",
      name: "Tail 2_bc3cbc",
      hosts: ["192.168.0.132", "192.168.55.222"], // wired before wireless; src already known
    });
  });

  it("falls back to the packet's source address when the digest IPs are useless", () => {
    const net = NET_JSON.replace('"wired_ip":"192.168.0.132"', '"wired_ip":"0.0.0.0"')
      .replace('"wireless_ip":"192.168.55.222"', '"wireless_ip":"0.0.0.0"');
    const p = packet([record(REMO_NAME, 16, txt([net, DEV_JSON]))]);
    const a = parseTail2Announcement(p, "10.1.2.3");
    expect(a).toEqual({ mac: "10:a5:62:bc:3c:bc", name: "Tail 2_bc3cbc", hosts: ["10.1.2.3"] });
  });

  it("skips questions before the answers", () => {
    const q = Buffer.concat([
      ...labels("_remo_mdns._tcp.local").map((b) => b),
      Buffer.from([0]),
      Buffer.from([0, 12, 0, 1]), // QTYPE=PTR, QCLASS
    ]);
    const withQuestion = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1]), // id, flags, qdcount=1
      Buffer.from([0, 1, 0, 0, 0, 0]), // ancount=1, nscount, arcount
      q,
      record(REMO_NAME, 16, txt([NET_JSON, DEV_JSON])),
    ]);
    expect(parseTail2Announcement(withQuestion)?.mac).toBe("10:a5:62:bc:3c:bc");
  });

  it("follows compression pointers in answer names and keeps the record boundaries", () => {
    // Second record's name is a pointer at offset 12 (the first record's name).
    const pointer = Buffer.from([0xc0, 12]);
    const p = packet([
      record(REMO_NAME, 16, txt([NET_JSON, DEV_JSON])),
      record([pointer], 33, Buffer.from([0, 0, 0, 0, 0x30, 0x39, 0xc0, 12])), // SRV port 12345
    ]);
    expect(parseTail2Announcement(p)?.mac).toBe("10:a5:62:bc:3c:bc");
  });

  it("returns null for other devices' mDNS and for garbage", () => {
    const chromecast = packet([
      record(labels("Chromecast._googlecast._tcp.local"), 16, txt([`{"id":"abc","cd":"x"}`])),
    ]);
    expect(parseTail2Announcement(chromecast, "10.0.0.1")).toBeNull();
    expect(parseTail2Announcement(Buffer.from([1, 2, 3]))).toBeNull();
    expect(parseTail2Announcement(Buffer.alloc(0))).toBeNull();
    // A digest whose ble_mac is not a MAC is not a Tail 2 digest.
    const bad = packet([record(REMO_NAME, 16, txt([`{"ble_mac":"nope","wired_ip":"1.2.3.4"}`]))]);
    expect(parseTail2Announcement(bad, "10.0.0.1")).toBeNull();
  });
});

describe("createAnnouncementCollector", () => {
  it("dedupes by MAC and merges hosts across repeat announcements", () => {
    const c = createAnnouncementCollector();
    c.push(tail2Packet(), "192.168.0.132");
    // Later announcement heard on a different interface/address.
    const onWifi = tail2Packet();
    c.push(onWifi, "192.168.0.99");
    const results = c.results();
    expect(results).toHaveLength(1);
    expect(results[0]!.hosts).toEqual(["192.168.0.132", "192.168.55.222", "192.168.0.99"]);
  });

  it("keeps two different cameras apart", () => {
    const c = createAnnouncementCollector();
    c.push(tail2Packet(), "192.168.0.132");
    const other = packet([
      record(labels("Remo_mDNS._remo_mdns._tcp.local"), 16, txt([
        NET_JSON.replaceAll("192.168.0.132", "192.168.0.140").replaceAll("10:a5:62:bc:3c:ba", "10:a5:62:bc:3c:da"),
        DEV_JSON.replaceAll("10:a5:62:bc:3c:bc", "10:a5:62:bc:3c:dc").replace("5461696c20325f626333636263", "5461696c20325f626333636463"),
      ])),
    ]);
    c.push(other, "192.168.0.140");
    expect(c.results().map((a) => a.mac).sort()).toEqual(["10:a5:62:bc:3c:bc", "10:a5:62:bc:3c:dc"]);
  });
});
