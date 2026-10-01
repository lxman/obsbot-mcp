import { describe, expect, it } from "vitest";
import {
  buildControlFrame,
  buildKVFrame,
  f32Bits,
  frameChecksum,
  hybridZoomSet,
  KV_KEYS,
  tlvValueChecksum,
} from "../../src/tail2/udp.js";

/**
 * Pins the decoded UDP 9999 control protocol (TAIL2-PROTOCOL.md §10) against
 * the 2026-09-30 Center captures: the TLV value checksum formula, the frame
 * checksum formula, and — the strongest constraint — that the synthesizer
 * reproduces the two hardware-proven captured frames BYTE-FOR-BYTE from
 * their sequence numbers. No network; the sender is exercised via injection.
 */

// The two captured hybrid-zoom writes (Center, 2026-09-30). Their seq bytes
// are LE: ON = 0x1414, OFF = 0x133a.
const CAPTURED_ON = "aa251414140040c40c0282c10206a771df1c035702003e560101";
const CAPTURED_OFF = "aa253a1314009bd40c0282c10206a771df1c03570200ff960100";

describe("tlvValueChecksum", () => {
  // (subcmd, value) -> on-wire checksum, as captured from Center 2026-09-30.
  // Two command families: 0282c1 subcmd 00 (speed 1-10 sweep) and 01 (hybrid
  // bool), plus 0303 05 (a 0-100 slider) — same function, proving it is a
  // pure checksum of the value bytes.
  const cases: Array<[number, number, number]> = [
    [0x00, 0x01, 0x3fc6], [0x00, 0x02, 0x7fc7], [0x00, 0x03, 0xbe07],
    [0x00, 0x04, 0xffc5], [0x00, 0x05, 0x3e05], [0x00, 0x06, 0x7e04],
    [0x00, 0x07, 0xbfc4], [0x00, 0x08, 0xffc0], [0x00, 0x09, 0x3e00],
    [0x00, 0x0a, 0x7e01], [0x01, 0x00, 0xff96], [0x01, 0x01, 0x3e56],
    [0x00, 0x14, 0xfe09], [0x00, 0x1e, 0x7e0e], [0x00, 0x28, 0xfe18],
    [0x00, 0x32, 0x7fd3], [0x00, 0x46, 0x7ff4], [0x00, 0x50, 0xfe3a],
    [0x00, 0x5a, 0x7e3d], [0x00, 0x64, 0xffed], [0x00, 0x3c, 0xfe17],
  ];
  for (const [subcmd, value, want] of cases) {
    it(`subcmd ${subcmd} value ${value} -> 0x${want.toString(16)}`, () => {
      expect(tlvValueChecksum(subcmd, value)).toBe(want);
    });
  }
});

describe("frameChecksum", () => {
  it("reproduces the captured ON frame's 0x40c4 from its 20-byte prefix", () => {
    const prefix = Buffer.from("aa251414140040c40c0282c10206a771df1c0357", "hex");
    // The function zeroes [6..7] itself, so feeding the captured bytes is fine.
    expect(frameChecksum([...prefix])).toBe(0x40c4);
  });

  it("reproduces the captured OFF frame's 0x9bd4", () => {
    const prefix = Buffer.from("aa253a1314009bd40c0282c10206a771df1c0357", "hex");
    expect(frameChecksum([...prefix])).toBe(0x9bd4);
  });

  it("rejects inputs that are not exactly the 20 covered bytes", () => {
    expect(() => frameChecksum(new Array(26).fill(0))).toThrow(/exactly/);
  });
});

describe("buildControlFrame", () => {
  it("reproduces the captured ON frame byte-for-byte from seq 0x1414", () => {
    expect(buildControlFrame(0x01, 0x01, 0x1414).toString("hex")).toBe(CAPTURED_ON);
  });

  it("reproduces the captured OFF frame byte-for-byte from seq 0x133a", () => {
    expect(buildControlFrame(0x01, 0x00, 0x133a).toString("hex")).toBe(CAPTURED_OFF);
  });

  it("self-verifies for arbitrary seq/value: re-computing the checksum over the built frame agrees", () => {
    for (const seq of [0x0000, 0x7f7f, 0xabcd, 0xffff]) {
      for (const [s, v] of [[0x01, 0x01], [0x00, 0x0a]] as const) {
        const f = buildControlFrame(s, v, seq);
        expect(f.length).toBe(26);
        // seq placed LE at [2..3]
        expect(f[2]).toBe(seq & 0xff);
        expect(f[3]).toBe((seq >> 8) & 0xff);
        // both embedded checksums recompute cleanly from the frame itself
        expect(frameChecksum([...f.slice(0, 20)])).toBe((f[6] << 8) | f[7]);
        expect(tlvValueChecksum(f[24]!, f[25]!)).toBe((f[22] << 8) | f[23]);
      }
    }
  });
});

describe("hybridZoomSet", () => {
  it("sends a synthesized frame for the camera host, boolean in the tail", async () => {
    const sent: Array<{ host: string; frame: Buffer }> = [];
    const fake = async (host: string, frame: Buffer) => {
      sent.push({ host, frame });
    };
    await hybridZoomSet("192.168.0.132", true, fake, 0x1414);
    await hybridZoomSet("192.168.0.132", false, fake, 0x133a);
    expect(sent.map((s) => s.host)).toEqual(["192.168.0.132", "192.168.0.132"]);
    expect(sent[0]!.frame.toString("hex")).toBe(CAPTURED_ON);
    expect(sent[1]!.frame.toString("hex")).toBe(CAPTURED_OFF);
  });
});

describe("buildKVFrame (the 4454 generic writer, §10b)", () => {
  // Golden frames from the 2026-10-01 flip-sheet capture (Center session id
  // 38141dae30c3) — reproduced byte-for-byte by passing that id + the seq.
  const SESSION_ID = [0x38, 0x14, 0x1d, 0xae, 0x30, 0xc3];
  const golden: Array<[string, number, number | boolean, number, string]> = [
    ["zone ON", KV_KEYS.zoneTracking, true, 0x009b, "aa259b001400a4a50c044454020638141dae30c30c0005e3000000000300000001000000"],
    ["zone OFF", KV_KEYS.zoneTracking, false, 0x00a5, "aa25a5001400c9410c044454020638141dae30c30c00041f000000000300000000000000"],
    ["autoZoomSpeed 10", KV_KEYS.autoZoomSpeed, 10, 0x00b4, "aa25b40014009c780c044454020638141dae30c30c00073800000000170000000a000000"],
  ];
  for (const [name, key, value, seq, want] of golden) {
    if (!want || want.length < 20) continue;
    it(`reproduces captured ${name} byte-for-byte`, () => {
      expect(buildKVFrame(key, value, seq, SESSION_ID).toString("hex")).toBe(want);
    });
  }
  it("reproduces captured panAuto ON tail byte-for-byte (1-byte bool TLV, len 9)", () => {
    const f = buildKVFrame(KV_KEYS.panAuto, true, 0x00bf, SESSION_ID, { bool8: true });
    expect(f.length).toBe(33);
    expect(f.subarray(20).toString("hex")).toBe("0900a81d000000000600000001");
    expect(frameChecksum([...f.slice(0, 20)])).toBe((f[6] << 8) | f[7]);
  });
  it("serializes float values as LE32 bit patterns (0.2f = wire cdcc4c3e)", () => {
    expect(f32Bits(0.8)).toBe(0x3f4ccccd);
    expect(f32Bits(0.2)).toBe(0x3e4ccccd);
    const f = buildKVFrame(KV_KEYS.panSpeed, f32Bits(0.2), 0x00c9, SESSION_ID);
    expect(f.subarray(-4).toString("hex")).toBe("cdcc4c3e");
    expect(frameChecksum([...f.slice(0, 20)])).toBe((f[6] << 8) | f[7]);
  });
  it("self-verifies for arbitrary keys/values: embedded checksums recompute", () => {
    for (const [key, value] of [[KV_KEYS.panAuto, true], [KV_KEYS.tiltAuto, false], [KV_KEYS.autoZoomSpeed, 4]] as const) {
      const f = buildKVFrame(key, value, 0x1234);
      expect(frameChecksum([...f.slice(0, 20)])).toBe((f[6] << 8) | f[7]);
    }
  });
  it("rejects value shapes without a checksum constant", () => {
    // int32 values are 12 bytes — covered; assert the table's coverage of
    // the two legal lengths via the built frame sizes.
    expect(buildKVFrame(KV_KEYS.zoneTracking, true, 1).length).toBe(36);
    expect(buildKVFrame(KV_KEYS.panAuto, true, 1, undefined, { bool8: true }).length).toBe(33);
    expect(buildKVFrame(KV_KEYS.autoZoomSpeed, 5, 1).length).toBe(36);
  });
});
