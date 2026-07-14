import { expect, test } from "vitest";
import {
  encodeSetRunStatus, encodePtzMoveAngle, encodePtzMoveSpeed, encodeRecenter, zoomRatioToUnits,
  encodeAiTrackEnable, encodeAiTrackDisable, encodeAiGroupEnable, encodeAiTrackSpeed,
  encodeZoomWithSpeed, encodeFaceFocus, encodeGetFaceFocus, decodeFaceFocus, encodeFov, encodeHdr, encodeAiTracking, AI_FRAMING_MODES, percentToRange,
} from "../../src/codec/commands.js";
import { decodeStatus } from "../../src/codec/commands.js";
import { bufToHex } from "../../src/codec/encoding.js";

const pad60 = (h: string) => (h + "0".repeat(120)).slice(0, 120);

test("wake reproduces golden frame", () => {
  expect(bufToHex(encodeSetRunStatus("run").buildFrame(0x000c))).toBe(pad60("aa250c000c0089420a02c2a00400be07"));
});
test("sleep reproduces golden frame", () => {
  expect(bufToHex(encodeSetRunStatus("sleep").buildFrame(0x0012))).toBe(pad60("aa2512000c00e9220a02c2a00400bffb01000000"));
});
test("move-to-angle uses cmd 0x6444 and packs roll,pitch,yaw f32 (wire order)", () => {
  // The gimbal move wire payload is [roll, pitch, yaw]
  // (data[0..3]=roll, [4..7]=pitch, [8..11]=yaw).
  // Our encoder takes logical (yaw, pitch, roll); distinct values pin the order.
  const f = encodePtzMoveAngle(30, 20, 10).buildFrame(1); // yaw=30, pitch=20, roll=10
  expect(f[10]).toBe(0x44); expect(f[11]).toBe(0x64);
  expect(f.readFloatLE(16)).toBeCloseTo(10); // roll
  expect(f.readFloatLE(20)).toBeCloseTo(20); // pitch
  expect(f.readFloatLE(24)).toBeCloseTo(30); // yaw
});
test("speed uses cmd 0x6484 and packs roll,pitch,yaw f32 (wire order)", () => {
  const f = encodePtzMoveSpeed(30, 20, 10).buildFrame(1); // yaw=30, pitch=20, roll=10
  expect(f[10]).toBe(0x84); expect(f[11]).toBe(0x64);
  expect(f.readFloatLE(16)).toBeCloseTo(10); // roll
  expect(f.readFloatLE(20)).toBeCloseTo(20); // pitch
  expect(f.readFloatLE(24)).toBeCloseTo(30); // yaw
});
test("recenter uses cmd 0x00c3", () => {
  const f = encodeRecenter().buildFrame(1);
  expect(f[10]).toBe(0xc3); expect(f[11]).toBe(0x00);
});
test("zoomRatioToUnits: min+(max-min)*(ratio-1)+0.001, rounded", () => {
  expect(zoomRatioToUnits(1.0, 0, 100)).toBe(0);
  expect(zoomRatioToUnits(2.0, 0, 100)).toBe(100);
  expect(zoomRatioToUnits(1.5, 0, 100)).toBe(50);
});

// --- AI tracking (payloads) -------------------------------------------------
test("AI track enable uses cmd 0x0584 and packs u32le(subject),u32le(view)", () => {
  const f = encodeAiTrackEnable("human-full-body").buildFrame(1);
  expect(f[10]).toBe(0x84); expect(f[11]).toBe(0x05); // wireCmd 0x0584
  expect(f[9]).toBe(0x04);                              // receiver
  expect(f.readUInt16LE(12)).toBe(8);                   // len2 = 8-byte payload
  expect(f.readUInt32LE(16)).toBe(0);                   // subject = human
  expect(f.readUInt32LE(20)).toBe(4);                   // view = full-body
});
test("AI track enable animal-close-up -> subject 1, view 2", () => {
  const f = encodeAiTrackEnable("animal-close-up").buildFrame(1);
  expect(f.readUInt32LE(16)).toBe(1);
  expect(f.readUInt32LE(20)).toBe(2);
});
test("AI track disable uses cmd 0x0504 with empty payload", () => {
  const f = encodeAiTrackDisable().buildFrame(1);
  expect(f[10]).toBe(0x04); expect(f[11]).toBe(0x05);
  expect(f.readUInt16LE(12)).toBe(0); // no nested payload
});
test("AI group enable uses cmd 0x0604 with 8 zero bytes", () => {
  const f = encodeAiGroupEnable().buildFrame(1);
  expect(f[10]).toBe(0x04); expect(f[11]).toBe(0x06);
  expect(f.readUInt16LE(12)).toBe(8);
  expect(f.readUInt32LE(16)).toBe(0);
  expect(f.readUInt32LE(20)).toBe(0);
});
// Track speed rides the command OBSBOT Center actually uses for Standard/Sport:
// wireCmd 0x0CC4 (AI_SET_TRACK_MODE), NOT 0x0944 — the latter is ACK'd but ignored
// by the Tiny 2 firmware. Confirmed by USB capture 2026-07-13 (byte 0x24 moved
// only for 0x0CC4). A full 0–5 hardware sweep proved the Tiny 2 honors only
// value 2 (Sport); the enum is collapsed to standard(0)/sport(2) for this device.
test("AI track speed uses cmd 0x0cc4 (AI_SET_TRACK_MODE), not 0x0944", () => {
  const f = encodeAiTrackSpeed("sport").buildFrame(1);
  expect(f[10]).toBe(0xc4); expect(f[11]).toBe(0x0c);
  expect(f.readUInt16LE(12)).toBe(1);
  expect(f[16]).toBe(2); // sport = 2
});
// The golden Standard/Sport frames captured from OBSBOT Center (seq stripped):
// value 0 -> payload CRC e63f, value 2 -> payload CRC 67fe. Our builder must match.
test("AI track speed 'standard' reproduces OBSBOT Center's Standard frame (value 0)", () => {
  const f = encodeAiTrackSpeed("standard").buildFrame(0x14); // standard = 0
  // bytes [0..13]: magic, seq, len, header-CRC, sender/receiver, cmd, len2
  expect(bufToHex(f).slice(0, 28)).toBe("aa251400" + "0c00" + "eae1" + "0a04" + "c40c" + "0100");
  expect(f.readUInt16LE(14)).toBe(0x3fe6); // payload CRC e6 3f (LE)
  expect(f[16]).toBe(0);
});
test("AI track speed 'sport' reproduces OBSBOT Center's Sport frame (value 2)", () => {
  const f = encodeAiTrackSpeed("sport").buildFrame(0x16); // sport = 2
  expect(f[10]).toBe(0xc4); expect(f[11]).toBe(0x0c);
  expect(f.readUInt16LE(14)).toBe(0xfe67); // payload CRC 67 fe (LE)
  expect(f[16]).toBe(2);
});

// --- Zoom with speed: payload is speed-FIRST then ratio*100 ----------------
test("zoom-with-speed uses cmd 0x1942 and packs u32le(speed),u32le(ratio*100)", () => {
  const f = encodeZoomWithSpeed(150, 6).buildFrame(1);
  expect(f[10]).toBe(0x42); expect(f[11]).toBe(0x19);
  expect(f.readUInt16LE(12)).toBe(8);
  expect(f.readUInt32LE(16)).toBe(6);   // speed first
  expect(f.readUInt32LE(20)).toBe(150); // ratio*100 second
});

// --- Face focus (vendor, int32le enable) -----------------------------------
test("face focus uses cmd 0x3602 and int32le(enable)", () => {
  const f = encodeFaceFocus(true).buildFrame(1);
  expect(f[10]).toBe(0x02); expect(f[11]).toBe(0x36);
  expect(f.readUInt16LE(12)).toBe(4);
  expect(f.readInt32LE(16)).toBe(1);
});

// --- UVC XU selector-6 raw payloads (FOV, HDR) -----------------------------
test("FOV encodes a 60-byte [0x04,0x01,value] buffer", () => {
  expect(encodeFov("wide").length).toBe(60);
  expect([...encodeFov("wide").subarray(0, 3)]).toEqual([0x04, 0x01, 0]);
  expect([...encodeFov("narrow").subarray(0, 3)]).toEqual([0x04, 0x01, 2]);
});
test("HDR encodes a 60-byte [0x01,0x01,on] buffer", () => {
  expect(encodeHdr(true).length).toBe(60);
  expect([...encodeHdr(true).subarray(0, 3)]).toEqual([0x01, 0x01, 1]);
  expect([...encodeHdr(false).subarray(0, 3)]).toEqual([0x01, 0x01, 0]);
});
// AI tracking enable/disable is a RAW uvcExt write to selector 6 (NOT a framed V3
// command — that path is ACK'd but inert). Payload is [tag=0x16, len=0x02, enable,
// framing]: byte[2] = 0x02 on / 0x00 off; byte[3] = framing sub-mode. The framing
// byte was captured from OBSBOT Center 2026-07-13 (Upper Body/Close-up/Headless/
// Lower Body clicks wrote 16 02 02 01/02/03/04) and hardware-verified by replay:
// the aiMode readback settled to (m=2, n=byte[3]) and OC's own button highlight
// tracked each of our writes.
test("AI tracking enable defaults to normal framing [16 02 02 00], 60 bytes", () => {
  expect(encodeAiTracking(true).length).toBe(60);
  expect([...encodeAiTracking(true).subarray(0, 4)]).toEqual([0x16, 0x02, 0x02, 0x00]);
});

test("AI tracking disable is [16 02 00 00] regardless of the framing arg", () => {
  expect([...encodeAiTracking(false).subarray(0, 4)]).toEqual([0x16, 0x02, 0x00, 0x00]);
  expect([...encodeAiTracking(false, "close-up").subarray(0, 4)]).toEqual([0x16, 0x02, 0x00, 0x00]);
});

test.each([
  ["normal", 0x00],
  ["upper-body", 0x01],
  ["close-up", 0x02],
  ["headless", 0x03],
  ["lower-body", 0x04],
] as const)("AI tracking enable in %s framing sets byte[3]=%i", (mode, byte3) => {
  const buf = encodeAiTracking(true, mode);
  expect(buf.length).toBe(60);
  expect([...buf.subarray(0, 4)]).toEqual([0x16, 0x02, 0x02, byte3]);
});

test("AI_FRAMING_MODES lists the five device-real framings", () => {
  expect(AI_FRAMING_MODES).toEqual(["normal", "upper-body", "close-up", "headless", "lower-body"]);
});

test("percentToRange maps 0..100 onto [min,max]", () => {
  expect(percentToRange(0, 10, 20)).toBe(10);
  expect(percentToRange(100, 10, 20)).toBe(20);
  expect(percentToRange(50, 0, 100)).toBe(50);
});

test("encodeGetFaceFocus builds a CAM_GET_FACE_FOCUS request frame (cmd 0x35c2, receiver 0x02, no payload)", () => {
  const f = encodeGetFaceFocus().buildFrame(1);
  expect(f[10]).toBe(0xc2); // cmd low byte
  expect(f[11]).toBe(0x35); // cmd high byte
  expect(f[9]).toBe(0x02);  // receiver
  expect(f.readUInt16LE(12)).toBe(0); // no nested payload
});

test("decodeFaceFocus maps an int32le 1 payload to enabled:true", () => {
  expect(decodeFaceFocus(Buffer.from([0x01, 0x00, 0x00, 0x00]))).toEqual({ enabled: true });
});

test("decodeFaceFocus maps an int32le 0 payload to enabled:false", () => {
  expect(decodeFaceFocus(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toEqual({ enabled: false });
});

test("decodeFaceFocus throws on a short payload", () => {
  expect(() => decodeFaceFocus(Buffer.from([0x01]))).toThrow(/too short/);
});

function statusBlock(over: Record<number, number> = {}): Buffer {
  const b = Buffer.alloc(60);
  for (const [k, v] of Object.entries(over)) b[Number(k)] = v;
  return b;
}

test("decodeStatus reads awake (0x02===0) and hdr (0x06!==0)", () => {
  expect(decodeStatus(statusBlock({ 0x02: 0, 0x06: 1 }))).toEqual({
    awake: true,
    hdr: true,
    aiMode: "no-tracking",
    trackSpeed: "standard",
  });
});

test("decodeStatus reports sleep and hdr-off", () => {
  expect(decodeStatus(statusBlock({ 0x02: 1, 0x06: 0 }))).toEqual({
    awake: false,
    hdr: false,
    aiMode: "no-tracking",
    trackSpeed: "standard",
  });
});

test("decodeStatus throws on a block too short to hold the track-speed offset 0x24", () => {
  expect(() => decodeStatus(Buffer.alloc(4))).toThrow(/too short/);
});

// Track speed at byte 0x24 (Tiny 2 offset; NOT the reference's 0x21). Hardware-confirmed.
test.each([
  [0, "standard"],
  [2, "sport"],
  [9, "unknown"],
])("decodeStatus maps track-speed byte 0x24=%i -> %s", (v, label) => {
  expect(decodeStatus(statusBlock({ 0x24: v })).trackSpeed).toBe(label);
});

// AI mode is the (0x18, 0x1c) = (m, n) tuple, mapped per OpenFoxes/Tiny4Linux status.rs.
test.each([
  [0, 0, "no-tracking"],
  [2, 0, "normal"],
  [2, 1, "upper-body"],
  [2, 2, "close-up"],
  [2, 3, "headless"],
  [2, 4, "lower-body"],
  [5, 0, "desk"],
  [4, 0, "whiteboard"],
  [6, 0, "hand"],
  [1, 0, "group"],
  [7, 9, "unknown"],
])("decodeStatus maps AI-mode tuple (%i,%i) -> %s", (m, n, mode) => {
  expect(decodeStatus(statusBlock({ 0x18: m, 0x1c: n })).aiMode).toBe(mode);
});
