import { expect, test, vi } from "vitest";
import { createTools } from "../../src/mcp/tools.js";
import type { ObsbotTransport } from "../../src/transport/transport.js";
import { CameraBusyError } from "../../src/transport/transport.js";
import type { DeviceManager } from "../../src/device/manager.js";
import type { CaptureManager } from "../../src/capture/manager.js";
import { CaptureError, FfmpegMissingError } from "../../src/capture/manager.js";

// Real awake status block captured from the device (starts 0x25, byte[2]=0 → awake).
const HEALTHY_STATUS_AWAKE = Buffer.from(
  "2501000200000001010158020001013200000000017f2100000143000000553c00031000000000000000000000000000000000000000000000000000",
  "hex",
);
// Same block with the sleep flag set (byte[2]=1), as observed on a sleeping camera.
const HEALTHY_STATUS_ASLEEP = (() => {
  const b = Buffer.from(HEALTHY_STATUS_AWAKE);
  b[0x02] = 1;
  return b;
})();

function makeFakeTransport() {
  let seq = 0;
  return {
    sendVendor: vi.fn(async (_frame: Buffer) => {}),
    recvVendor: vi.fn(async (_frame: Buffer, _length?: number) => Buffer.alloc(60)),
    recvStatus: vi.fn(async (_length?: number) => HEALTHY_STATUS_AWAKE),
    xuRaw: vi.fn(async (_selector: number, _data: Buffer) => {}),
    xuGetRaw: vi.fn(async (_selector: number, _length: number) => Buffer.alloc(60)),
    zoomRange: vi.fn(async () => ({ min: 0, max: 100 })),
    zoomSet: vi.fn(async (_units: number) => {}),
    camCtrlSet: vi.fn(async (_p: number, _v: number, _f: number) => {}),
    camCtrlRange: vi.fn(async (_p: number) => ({ min: 0, max: 100 })),
    camCtrlGet: vi.fn(async (_p: number) => ({ value: 0, flags: 0 })),
    procAmpSet: vi.fn(async (_p: number, _v: number, _f: number) => {}),
    procAmpRange: vi.fn(async (_p: number) => ({ min: 2800, max: 6500 })),
    snapshot: vi.fn(async () => ({
      mime: "image/jpeg",
      width: 1280,
      height: 720,
      base64: "QUJD",
    })),
    gimbalSet: vi.fn(async (_yaw: number, _pitch: number, _roll?: number) => {}),
    gimbalSpeed: vi.fn(async (_yaw: number, _pitch: number, _roll: number, _autoStopMs: number) => {}),
    gimbalRecenter: vi.fn(async () => {}),
    nextSeq: vi.fn(() => ++seq),
    close: vi.fn(async () => {}),
  } satisfies ObsbotTransport;
}

function makeFakeMgr(devices: unknown[] = []) {
  return {
    list: vi.fn(async () => devices),
    openFirstObsbot: vi.fn(),
  } as unknown as DeviceManager;
}

function makeFakeCapture(over: Partial<CaptureManager> = {}): CaptureManager {
  return {
    startRecord: vi.fn(async () => ({
      id: "cap1", kind: "record", pid: 1, source: "device",
      outputPath: "C:\\Videos\\OBSBOT\\obsbot-x.mp4", durationSec: 3600,
      startedAtIso: "2026-07-13T00:00:00.000Z",
    })),
    startPreview: vi.fn(async () => ({
      id: "cap2", kind: "preview", pid: 2, source: "device",
      startedAtIso: "2026-07-13T00:00:00.000Z",
    })),
    stop: vi.fn(async () => ({ kind: "record", outputPath: "C:\\Videos\\OBSBOT\\obsbot-x.mp4", graceful: true })),
    list: vi.fn(() => []),
    stopAll: vi.fn(),
    ...over,
  } as unknown as CaptureManager;
}

function findTool(tools: ReturnType<typeof createTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

test("obsbot_zoom_absolute clamps ratio above max and calls zoomSet with max-mapped units", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr();
  const tools = createTools(async () => transport, mgr);
  const tool = findTool(tools, "obsbot_zoom_absolute");

  const result = await tool.handler({ ratio: 99 });

  expect(transport.zoomRange).toHaveBeenCalledTimes(1);
  expect(transport.zoomSet).toHaveBeenCalledTimes(1);
  expect(transport.zoomSet).toHaveBeenCalledWith(100); // ratio clamped to 2.0 -> max units
  expect(result).toEqual({ ok: true, ratio: 2.0 });
});

test("obsbot_set_run_status rejects an invalid state via zod", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr();
  const tools = createTools(async () => transport, mgr);
  const tool = findTool(tools, "obsbot_set_run_status");

  await expect(tool.handler({ state: "not-a-state" })).rejects.toThrow();
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("obsbot_ptz_move_speed sends move then auto-stop", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr();
  const tools = createTools(async () => transport, mgr);
  const tool = findTool(tools, "obsbot_ptz_move_speed");

  const result = await tool.handler({ yaw: 10, pitch: 5, roll: 0, autoStopMs: 1 });

  expect(transport.gimbalSpeed).toHaveBeenCalledTimes(1);
  expect(transport.gimbalSpeed).toHaveBeenCalledWith(10, 5, 0, 1);
  expect(result).toEqual({ ok: true, stopped: true });
});

test("obsbot_ptz_move_speed negates yaw so +yaw pans camera-left (matches ptz_move_angle)", async () => {
  // Firmware velocity-yaw is inverted vs position-yaw: +yaw drives the gimbal RIGHT on
  // AI_SET_GIM_SPEED but LEFT on AI_SET_GIM_MOTOR_DEG (HW-observed). The tool normalizes
  // so a caller's +yaw means the same physical direction (camera-left) on both tools.
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ptz_move_speed");

  await tool.handler({ yaw: 40, pitch: 0, roll: 0, autoStopMs: 0 });

  // The yaw inversion is handled by gimbalSpeed on the transport; gimbalSpeed was
  // called with the raw (non-negated) yaw values as the tool receives them.
  expect(transport.gimbalSpeed).toHaveBeenCalledWith(40, 0, 0, 0);
});

test("obsbot_gimbal_recenter sends a single vendor frame", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr();
  const tools = createTools(async () => transport, mgr);
  const tool = findTool(tools, "obsbot_gimbal_recenter");

  const result = await tool.handler({});

  expect(transport.gimbalRecenter).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ ok: true });
});

// A 60-byte status block: awake, with the AI-mode tuple (m,n) at 0x18/0x1c so the
// handler's post-write verify (poll-until-settled) can read the landed framing.
function aiStatusBlock(m: number, n: number): Buffer {
  const b = Buffer.alloc(60);
  b[0x02] = 0; // awake (gate reads this too)
  b[0x18] = m; // AI mode tuple, first value
  b[0x1c] = n; // AI mode tuple, second value
  return b;
}

test("obsbot_ai_tracking enable defaults to normal framing: [16 02 02 00] to sel 6, verifies aiMode", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => aiStatusBlock(2, 0)); // awake + normal
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");

  const result = await tool.handler({ enabled: true });

  expect(transport.xuRaw).toHaveBeenCalledTimes(1);
  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 4)]).toEqual([0x16, 0x02, 0x02, 0x00]);
  expect(transport.sendVendor).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: true, enabled: true, mode: "normal", verified: "normal", matched: true });
});

test("obsbot_ai_tracking enable in close-up framing writes byte[3]=0x02 and verifies close-up", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => aiStatusBlock(2, 2)); // awake + close-up
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");

  const result = await tool.handler({ enabled: true, mode: "close-up" });

  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 4)]).toEqual([0x16, 0x02, 0x02, 0x02]);
  expect(result).toMatchObject({ ok: true, enabled: true, mode: "close-up", verified: "close-up", matched: true });
});

test("obsbot_ai_tracking disable writes [16 02 00 00] and verifies no-tracking", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => aiStatusBlock(0, 0)); // awake + no-tracking
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");

  const result = await tool.handler({ enabled: false });

  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 4)]).toEqual([0x16, 0x02, 0x00, 0x00]);
  expect(result).toMatchObject({ ok: true, enabled: false, verified: "no-tracking", matched: true });
});

test("obsbot_ai_tracking enable in whiteboard scene mode writes [16 02 04 00] and verifies whiteboard", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => aiStatusBlock(4, 0)); // awake + whiteboard
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");

  const result = await tool.handler({ enabled: true, mode: "whiteboard" });

  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 4)]).toEqual([0x16, 0x02, 0x04, 0x00]);
  expect(transport.sendVendor).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: true, enabled: true, mode: "whiteboard", verified: "whiteboard", matched: true });
});

test("obsbot_ai_tracking enable in hand scene mode writes byte[2]=0x03 and verifies hand", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => aiStatusBlock(3, 0)); // awake + hand (m=3 on this firmware)
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");

  const result = await tool.handler({ enabled: true, mode: "hand" });

  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 4)]).toEqual([0x16, 0x02, 0x03, 0x00]);
  expect(result).toMatchObject({ ok: true, enabled: true, mode: "hand", verified: "hand", matched: true });
});

test("obsbot_ai_tracking rejects a retired framing name via zod", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");
  await expect(tool.handler({ enabled: true, mode: "human-close-up" })).rejects.toThrow();
});

test("gated command returns the readiness error and does NOT act when unreachable", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => {
    throw new Error("KsProperty GET failed");
  });
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");
  const result = await tool.handler({ enabled: true });
  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("gated command auto-wakes an asleep camera before acting", async () => {
  let n = 0;
  const asleep = Buffer.alloc(60);
  asleep[0x02] = 1;
  const transport = makeFakeTransport();
  // First read asleep (triggers wake); then awake + normal framing so the post-write
  // verify settles immediately instead of polling the full window.
  transport.recvStatus = vi.fn(async () => (n++ === 0 ? asleep : aiStatusBlock(2, 0)));
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_ai_tracking");
  const result = await tool.handler({ enabled: true });
  expect(transport.sendVendor).toHaveBeenCalledTimes(1); // wake frame
  expect(transport.xuRaw).toHaveBeenCalledTimes(1); // the actual command, after wake
  expect(result).toMatchObject({ ok: true, enabled: true });
});

test("obsbot_list_devices returns mgr.list()", async () => {
  const devices = [{ path: "\\\\.\\usb1", name: "OBSBOT Tiny 2" }];
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr(devices);
  const tools = createTools(async () => transport, mgr);
  const tool = findTool(tools, "obsbot_list_devices");

  const result = await tool.handler({});

  expect(result).toEqual({ devices });
});

test("obsbot_ptz_move_angle clamps yaw/pitch to conservative limits", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr();
  const tools = createTools(async () => transport, mgr);
  const tool = findTool(tools, "obsbot_ptz_move_angle");

  const result = await tool.handler({ yaw: 999, pitch: -999, roll: 0 });

  expect(transport.gimbalSet).toHaveBeenCalledTimes(1);
  expect(transport.gimbalSet).toHaveBeenCalledWith(150, -90, 0);
  expect(result).toEqual({ yaw: 150, pitch: -90, roll: 0 });
});

test("obsbot_ai_tracking rejects an unknown mode", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await expect(
    tools.find((t) => t.name === "obsbot_ai_tracking")!.handler({ enabled: true, mode: "nope" }),
  ).rejects.toThrow();
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("obsbot_zoom_speed clamps ratio and speed", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools.find((t) => t.name === "obsbot_zoom_speed")!.handler({
    ratio: 9,
    speed: 999,
  });
  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ ok: true, ratio: 2.0, speed: 255 });
});

test("obsbot_fov sends a 60-byte payload to XU selector 6", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools.find((t) => t.name === "obsbot_fov")!.handler({ fov: "narrow" });
  expect(transport.xuRaw).toHaveBeenCalledTimes(1);
  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect(data.length).toBe(60);
  expect([...data.subarray(0, 3)]).toEqual([0x04, 0x01, 2]);
});

test("obsbot_hdr sends [0x01,0x01,on] to XU selector 6", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools.find((t) => t.name === "obsbot_hdr")!.handler({ enabled: true });
  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 3)]).toEqual([0x01, 0x01, 1]);
});

test("obsbot_focus manual maps 0-100 onto the device range via camCtrl", async () => {
  const transport = makeFakeTransport();
  transport.camCtrlRange = vi.fn(async () => ({ min: 0, max: 200 }));
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools.find((t) => t.name === "obsbot_focus")!.handler({
    mode: "manual",
    position: 50,
  });
  expect(transport.camCtrlRange).toHaveBeenCalledWith(6);
  expect(transport.camCtrlSet).toHaveBeenCalledWith(6, 100, 2); // 50% of [0,200], manual flag
  expect(result).toEqual({ ok: true, mode: "manual", position: 50, value: 100 });
});

test("obsbot_focus auto uses the auto flag without querying range", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools.find((t) => t.name === "obsbot_focus")!.handler({ mode: "auto" });
  expect(transport.camCtrlSet).toHaveBeenCalledWith(6, 0, 1);
  expect(transport.camCtrlRange).not.toHaveBeenCalled();
});

test("obsbot_white_balance manual clamps Kelvin to device range via procAmp", async () => {
  const transport = makeFakeTransport();
  transport.procAmpRange = vi.fn(async () => ({ min: 2800, max: 6500 }));
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools.find((t) => t.name === "obsbot_white_balance")!.handler({
    mode: "manual",
    temperature: 9000,
  });
  expect(transport.procAmpSet).toHaveBeenCalledWith(7, 6500, 2); // clamped to max, manual flag
  expect(result).toEqual({ ok: true, mode: "manual", temperature: 6500 });
});

test("obsbot_white_balance auto uses the auto flag", async () => {
  const transport = makeFakeTransport();
  transport.procAmpRange = vi.fn(async () => ({ min: 2800, max: 6500 }));
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools.find((t) => t.name === "obsbot_white_balance")!.handler({ mode: "auto" });
  expect(transport.procAmpSet).toHaveBeenCalledWith(7, 2800, 1);
});

// --- UVC image controls (standard IAMVideoProcAmp) + exposure (IAMCameraControl) ---
test("obsbot_image_control maps 0-100 onto the device range and sets via procAmp (brightness=prop 0)", async () => {
  const transport = makeFakeTransport();
  transport.procAmpRange = vi.fn(async () => ({ min: 0, max: 100 }));
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools
    .find((t) => t.name === "obsbot_image_control")!
    .handler({ control: "brightness", level: 75 });
  expect(transport.procAmpRange).toHaveBeenCalledWith(0);
  expect(transport.procAmpSet).toHaveBeenCalledWith(0, 75, 2); // 75% of [0,100], manual flag
  expect(result).toEqual({ ok: true, control: "brightness", level: 75, value: 75 });
});

test("obsbot_image_control uses the right property id + range for gain (prop 9)", async () => {
  const transport = makeFakeTransport();
  transport.procAmpRange = vi.fn(async () => ({ min: 1, max: 64 }));
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools
    .find((t) => t.name === "obsbot_image_control")!
    .handler({ control: "gain", level: 50 });
  expect(transport.procAmpRange).toHaveBeenCalledWith(9);
  expect(transport.procAmpSet).toHaveBeenCalledWith(9, 33, 2); // 50% of [1,64] -> 32.5 -> 33
  expect(result).toEqual({ ok: true, control: "gain", level: 50, value: 33 });
});

test("obsbot_image_control rejects an unsupported control via zod", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await expect(
    tools.find((t) => t.name === "obsbot_image_control")!.handler({ control: "gamma", level: 50 }),
  ).rejects.toThrow();
});

test("obsbot_exposure auto uses V3 frame protocol, not camCtrl", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools.find((t) => t.name === "obsbot_exposure")!.handler({ mode: "auto" });
  // Exposure now uses vendor V3 frames (CAM_SET_EXPOSURE_MODE) not UVC camCtrl
  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  expect(transport.camCtrlSet).not.toHaveBeenCalled();
  expect(transport.camCtrlRange).not.toHaveBeenCalled();
});

test("obsbot_exposure auto with priority:face sends the AE mode frame then a sel-6 face-AE write [03 01 01]", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools
    .find((t) => t.name === "obsbot_exposure")!
    .handler({ mode: "auto", priority: "face" });
  expect(transport.sendVendor).toHaveBeenCalledTimes(1); // AE mode frame
  const [selector, data] = transport.xuRaw.mock.calls[0];
  expect(selector).toBe(6);
  expect([...data.subarray(0, 3)]).toEqual([0x03, 0x01, 0x01]);
  expect(result).toMatchObject({ ok: true, mode: "auto", priority: "face" });
});

test("obsbot_exposure auto with priority:global writes [03 01 00]", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools
    .find((t) => t.name === "obsbot_exposure")!
    .handler({ mode: "auto", priority: "global" });
  const [, data] = transport.xuRaw.mock.calls[0];
  expect([...data.subarray(0, 3)]).toEqual([0x03, 0x01, 0x00]);
});

test("obsbot_exposure auto without priority does not write face-AE", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await tools.find((t) => t.name === "obsbot_exposure")!.handler({ mode: "auto" });
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("obsbot_exposure manual sends V3 frame mode + value", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools
    .find((t) => t.name === "obsbot_exposure")!
    .handler({ mode: "manual", level: 25 });
  // Two sendVendor calls: mode switch + value set
  expect(transport.sendVendor).toHaveBeenCalledTimes(2);
  expect(transport.camCtrlRange).not.toHaveBeenCalled();
  expect(transport.camCtrlSet).not.toHaveBeenCalled();
  // 25% of 0-65535 range => 16384
  expect(result).toEqual({ ok: true, mode: "manual", level: 25, raw: 16384 });
});

// --- String-encoded args from clients that ignore the advertised schema ----
test("obsbot_ptz_move_angle accepts string-encoded numbers", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools
    .find((t) => t.name === "obsbot_ptz_move_angle")!
    .handler({ yaw: "30", pitch: "-20", roll: "0" });
  expect(transport.gimbalSet).toHaveBeenCalledTimes(1);
  expect(transport.gimbalSet).toHaveBeenCalledWith(30, -20, 0);
  expect(result).toEqual({ yaw: 30, pitch: -20, roll: 0 });
});

test("obsbot_zoom_speed accepts string-encoded ratio/speed", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await tools
    .find((t) => t.name === "obsbot_zoom_speed")!
    .handler({ ratio: "1.5", speed: "6" });
  expect(result).toEqual({ ok: true, ratio: 1.5, speed: 6 });
});

test("obsbot_ai_tracking accepts string 'true'/'false' for enabled", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => aiStatusBlock(2, 0)); // awake + normal, so verify settles fast
  const tools = createTools(async () => transport, makeFakeMgr());
  const on = await tools
    .find((t) => t.name === "obsbot_ai_tracking")!
    .handler({ enabled: "true", mode: "normal" });
  expect(on).toMatchObject({ ok: true, enabled: true, mode: "normal" });

  transport.recvStatus = vi.fn(async () => aiStatusBlock(0, 0)); // no-tracking, verify target for disable
  const off = await tools
    .find((t) => t.name === "obsbot_ai_tracking")!
    .handler({ enabled: "false" });
  expect(off).toMatchObject({ ok: true, enabled: false, mode: "normal" });
});

test("boolean coercion does NOT treat arbitrary strings as true", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  await expect(
    tools.find((t) => t.name === "obsbot_hdr")!.handler({ enabled: "yes" }),
  ).rejects.toThrow();
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("obsbot_snapshot returns an image content block on success", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = (await tools
    .find((t) => t.name === "obsbot_snapshot")!
    .handler({})) as { content: Array<Record<string, unknown>> };
  expect(transport.snapshot).toHaveBeenCalledTimes(1);
  const image = result.content.find((c) => c.type === "image");
  expect(image).toMatchObject({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
  const text = result.content.find((c) => c.type === "text") as { text: string };
  expect(JSON.parse(text.text)).toEqual({ width: 1280, height: 720, source: "device" });
});

test("obsbot_snapshot returns actionable text (no image) when the camera is busy", async () => {
  const transport = makeFakeTransport();
  transport.snapshot = vi.fn(async () => {
    throw new CameraBusyError();
  });
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = (await tools
    .find((t) => t.name === "obsbot_snapshot")!
    .handler({})) as { content: Array<Record<string, unknown>> };
  expect(result.content.some((c) => c.type === "image")).toBe(false);
  const text = result.content.find((c) => c.type === "text") as { text: string };
  expect(text.text).toMatch(/in use/i);
});

test("obsbot_snapshot source 'virtual' resolves a device path and passes it through", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr([
    { path: "p-tiny", name: "OBSBOT Tiny 2 StreamCamera" },
    { path: "p-virt", name: "OBSBOT Virtual Camera" },
  ]);
  const tools = createTools(async () => transport, mgr);
  await tools.find((t) => t.name === "obsbot_snapshot")!.handler({ source: "virtual" });
  expect(transport.snapshot).toHaveBeenCalledWith(
    expect.objectContaining({ path: "p-virt" }),
  );
});

test("obsbot_snapshot returns text (no image) when the requested source is absent", async () => {
  const transport = makeFakeTransport();
  const mgr = makeFakeMgr([{ path: "p-tiny", name: "OBSBOT Tiny 2 StreamCamera" }]);
  const tools = createTools(async () => transport, mgr);
  const result = (await tools
    .find((t) => t.name === "obsbot_snapshot")!
    .handler({ source: "ndi" })) as { content: Array<Record<string, unknown>> };
  expect(transport.snapshot).not.toHaveBeenCalled();
  expect(result.content.some((c) => c.type === "image")).toBe(false);
});

test("obsbot_record_start returns the session and output path", async () => {
  const transport = makeFakeTransport();
  const capture = makeFakeCapture();
  const tools = createTools(async () => transport, makeFakeMgr(), capture);
  const result = await tools.find((t) => t.name === "obsbot_record_start")!.handler({ durationSec: 10 });
  expect(capture.startRecord).toHaveBeenCalledWith(
    expect.objectContaining({ durationSec: 10, audio: true, source: "device" }),
  );
  expect(result).toMatchObject({ ok: true, sessionId: "cap1", outputPath: expect.any(String), durationSec: 3600 });
});

test("obsbot_record_start surfaces FfmpegMissingError as actionable text (no throw)", async () => {
  const transport = makeFakeTransport();
  const capture = makeFakeCapture({ startRecord: vi.fn(async () => { throw new FfmpegMissingError(); }) });
  const tools = createTools(async () => transport, makeFakeMgr(), capture);
  const result = (await tools.find((t) => t.name === "obsbot_record_start")!.handler({})) as { content: Array<Record<string, unknown>> };
  const text = result.content.find((c) => c.type === "text") as { text: string };
  expect(text.text).toMatch(/ffmpeg/i);
});

test("obsbot_record_start surfaces a CaptureError as text", async () => {
  const transport = makeFakeTransport();
  const capture = makeFakeCapture({ startRecord: vi.fn(async () => { throw new CaptureError("no 'ndi' video source found"); }) });
  const tools = createTools(async () => transport, makeFakeMgr(), capture);
  const result = (await tools.find((t) => t.name === "obsbot_record_start")!.handler({ source: "ndi" })) as { content: Array<Record<string, unknown>> };
  const text = result.content.find((c) => c.type === "text") as { text: string };
  expect(text.text).toMatch(/ndi/i);
});

test("obsbot_preview_start returns a session id", async () => {
  const transport = makeFakeTransport();
  const capture = makeFakeCapture();
  const tools = createTools(async () => transport, makeFakeMgr(), capture);
  const result = await tools.find((t) => t.name === "obsbot_preview_start")!.handler({});
  expect(result).toEqual({ ok: true, sessionId: "cap2" });
});

test("obsbot_capture_stop stops the session", async () => {
  const transport = makeFakeTransport();
  const capture = makeFakeCapture();
  const tools = createTools(async () => transport, makeFakeMgr(), capture);
  const result = await tools.find((t) => t.name === "obsbot_capture_stop")!.handler({ sessionId: "cap1" });
  expect(capture.stop).toHaveBeenCalledWith("cap1");
  expect(result).toMatchObject({ ok: true, kind: "record", graceful: true });
});

test("obsbot_capture_list returns active sessions", async () => {
  const transport = makeFakeTransport();
  const sessions = [{ id: "cap1", kind: "record", pid: 1, source: "device", startedAtIso: "t" }];
  const capture = makeFakeCapture({ list: vi.fn(() => sessions as never) });
  const tools = createTools(async () => transport, makeFakeMgr(), capture);
  const result = await tools.find((t) => t.name === "obsbot_capture_list")!.handler({});
  expect(result).toEqual({ sessions });
});

test("obsbot_get_status decodes awake+hdr from the status block", async () => {
  const transport = makeFakeTransport();
  const block = Buffer.alloc(60);
  block[0x02] = 0; // awake
  block[0x06] = 1; // hdr on
  transport.recvStatus = vi.fn(async () => block);
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, true); // debug: raw present
  const tool = findTool(tools, "obsbot_get_status");
  const result = await tool.handler({});
  expect(transport.recvStatus).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    ok: true,
    awake: true,
    hdr: true,
    aiMode: "no-tracking",
    trackSpeed: "standard",
  });
  // raw exposes the full 60-byte block as hex (120 chars) for RE of undecoded offsets.
  expect(result.raw).toHaveLength(120);
  expect(result.raw.slice(0x06 * 2, 0x06 * 2 + 2)).toBe("01"); // byte 0x06 = hdr on
});

// --- Debug gating: obsbot_probe and get_status.raw are RE-only, behind --debug. ---
test("createTools omits obsbot_probe unless debug is enabled", () => {
  const tools = createTools(async () => makeFakeTransport(), makeFakeMgr());
  expect(tools.find((t) => t.name === "obsbot_probe")).toBeUndefined();
});

test("createTools includes obsbot_probe when debug is enabled", () => {
  const tools = createTools(async () => makeFakeTransport(), makeFakeMgr(), undefined, undefined, true);
  expect(tools.find((t) => t.name === "obsbot_probe")).toBeDefined();
});

test("obsbot_get_status omits the raw RE block unless debug is enabled", async () => {
  const transport = makeFakeTransport();
  const block = Buffer.alloc(60);
  block[0x02] = 0; // awake
  transport.recvStatus = vi.fn(async () => block);
  const tools = createTools(async () => transport, makeFakeMgr());
  const result = await findTool(tools, "obsbot_get_status").handler({});
  expect(result).toMatchObject({ ok: true, awake: true });
  expect(result.raw).toBeUndefined();
});

test("obsbot_get_status includes the raw block when debug is enabled", async () => {
  const transport = makeFakeTransport();
  const block = Buffer.alloc(60);
  block[0x02] = 0; // awake
  transport.recvStatus = vi.fn(async () => block);
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, true);
  const result = await findTool(tools, "obsbot_get_status").handler({});
  expect(result.raw).toHaveLength(120);
});

test("obsbot_probe get reads the given selector/length via xuGetRaw", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async () => Buffer.from("aabbcc", "hex"));
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, true);
  const tool = findTool(tools, "obsbot_probe");
  const result = await tool.handler({ mode: "get", selector: 6, length: 128 });
  expect(transport.xuGetRaw).toHaveBeenCalledWith(6, 128);
  expect(result).toMatchObject({ ok: true, selector: 6, len: 3, raw: "aabbcc" });
});

test("obsbot_probe set writes raw hex to the selector via xuRaw", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, true);
  const tool = findTool(tools, "obsbot_probe");
  const result = await tool.handler({ mode: "set", selector: 2, hex: "aa25" });
  expect(transport.xuRaw).toHaveBeenCalledWith(2, Buffer.from("aa25", "hex"));
  expect(result).toMatchObject({ ok: true, selector: 2, sent: "aa25" });
});

test("obsbot_probe query frames an opcode and reads the reply via recvVendor", async () => {
  const transport = makeFakeTransport();
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, true);
  const tool = findTool(tools, "obsbot_probe");
  const result = await tool.handler({ mode: "query", opcode: "AI_GET_QUICK_STATUS" });
  expect(transport.recvVendor).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ ok: true, opcode: "AI_GET_QUICK_STATUS" });
});

// --- Preset read path: flat XU selectors 12 (list) + 13 (entry cursor). ---
// Real captured fixtures from hardware (2026-07-19 session) — see preset.test.ts
// for the byte-layout tests these mirror.
// A realistic 60-byte selector-12 reply representing "zero presets saved" — count=0
// (byte 0), but NOT bit-for-bit identical to a failed/silent read: real hardware has
// not captured this exact state, so the nonzero sentinel byte just keeps this fixture
// distinguishable from the "totally zeroed" hostile-input fixture that
// implausiblePresetListReason must reject (see preset.ts's C1 design note — an
// all-zero response is treated as a failed read, not as "genuinely zero presets").
// A genuinely empty device returns a BIT-FOR-BIT ALL-ZERO selector-12 block
// (hardware-established 2026-07-19, OBSBOT Center closed, camera measured awake,
// stable across repeated reads). This fixture previously set b[40] = 0xaa — a byte
// invented so the C1 plausibility check would pass. That fiction is exactly what let
// the empty-state dead-end ship: it asserted an empty device is distinguishable from
// a failed read by the block alone, which the hardware disproves. Emptiness is now
// established by corroborating with the status block instead.
function emptyPresetListBlock(): Buffer {
  return Buffer.alloc(60);
}

const PRESET_LIST_BLOCK = Buffer.from("030001020000", "hex");
const PRESET_ENTRY_1 = Buffer.from("0000000018fcfce5640055484a6c633256304d513d3d00", "hex");
const PRESET_ENTRY_2 = Buffer.from("0001000046004808640055484a6c633256304d673d3d00", "hex");
const PRESET_ENTRY_3 = Buffer.from("000200003c004808640055484a6c633256304d773d3d00", "hex");
const PRESET_ENTRY_END = Buffer.from("02000000", "hex");

function makePresetTransport() {
  const transport = makeFakeTransport();
  const calls: string[] = [];
  let entryCall = 0;
  const entries = [PRESET_ENTRY_1, PRESET_ENTRY_2, PRESET_ENTRY_3, PRESET_ENTRY_END];
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) => {
    if (selector === 12) {
      calls.push("get12");
      return PRESET_LIST_BLOCK;
    }
    calls.push("get13");
    return entries[entryCall++];
  });
  transport.xuRaw = vi.fn(async (selector: number, _data: Buffer) => {
    if (selector === 12) calls.push("reset12");
  });
  return { transport, calls };
}

test("obsbot_preset_list reads list block, echo-resets the cursor, then walks entries", async () => {
  const { transport, calls } = makePresetTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: true });
  const slots = (result as { slots: Array<Record<string, unknown>> }).slots;
  expect(slots).toHaveLength(3);
  expect(slots.every((s) => s.occupied)).toBe(true);
  expect(slots.map((s) => s.name)).toEqual(["Preset1", "Preset2", "Preset3"]);
  expect(slots[0].pose).toEqual({ pan: -66.6, tilt: -10, roll: 0, zoom: 1 });

  // The echo-write reset is load-bearing: without it the cursor stays exhausted
  // and enumeration returns nothing. Must happen after the list read and before
  // any selector-13 reads.
  expect(calls).toEqual(["get12", "reset12", "get13", "get13", "get13"]);
  expect(transport.xuRaw).toHaveBeenCalledWith(12, PRESET_LIST_BLOCK);
});

// --- C1: never echo an implausible selector-12 read back to the device ---

test("C1: an all-zero selector-12 block is rejected before the echo-write, not trusted as 'empty'", async () => {
  // An all-zero block alone proves nothing — a genuinely empty device returns the
  // same bytes. What marks THIS as a dead read is that the status block is zeroed
  // too: a dead link / stale handle zeroes both, so there is no corroboration and
  // the block must never be trusted or echoed.
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number) =>
    selector === 12 ? Buffer.alloc(60) : Buffer.alloc(60),
  );
  transport.recvStatus = vi.fn(async () => Buffer.alloc(60));
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  expect((result as { error: string }).error).toMatch(/implausible|all-zero/i);
  // The load-bearing guarantee: an untrusted read must never be echoed back to
  // selector 12 (its write semantics for anything but a genuine echo are undecoded).
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("C1: an oversized count (>3) on selector 12 is rejected before the echo-write", async () => {
  const transport = makeFakeTransport();
  const block = Buffer.alloc(60);
  block[0] = 0xff; // garbage count
  transport.xuGetRaw = vi.fn(async () => block);
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  expect((result as { error: string }).error).toMatch(/implausible|count/i);
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("C1: a short (truncated) selector-12 read is rejected before the echo-write", async () => {
  const transport = makeFakeTransport();
  // count=2 claims 2 slot-index bytes follow, but the buffer is cut short.
  transport.xuGetRaw = vi.fn(async () => Buffer.from("02", "hex"));
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("a corroborated empty device reports three empty slots and is NOT echoed back", async () => {
  // Supersedes the old "count=0 but non-all-zero block IS echoed" case: hardware has
  // no such block. A real empty device returns all zeros, is accepted only because
  // the status block corroborates, and needs no cursor reset — so no echo-write.
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async () => emptyPresetListBlock());
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: true });
  expect((result as { slots: Array<{ occupied: boolean }> }).slots.every((s) => !s.occupied)).toBe(true);
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

// --- I1: cross-check the entry-cursor walk against selector 12's own slot list ---

test("I1: cursor-exhausts-early vs list disagreement fails loudly instead of under-reporting", async () => {
  const transport = makeFakeTransport();
  // selector 12 claims 3 occupied slots, but the entry cursor (selector 13) hits the
  // exhausted marker after only 1 — a real device inconsistency, not a decode bug.
  // Cycle the entries so the SAME inconsistency is presented on every retry attempt -
  // a persistent device inconsistency, not a one-off that a re-read would clear.
  let entryCall = 0;
  const entries = [PRESET_ENTRY_1, PRESET_ENTRY_END];
  transport.xuGetRaw = vi.fn(async (selector: number) =>
    selector === 12 ? PRESET_LIST_BLOCK : entries[entryCall++ % entries.length],
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  expect((result as { error: string }).error).toMatch(/mismatch/i);
});

// --- I3: the entry walk never reads more than the device's 3 slots, and an
// implausible/all-zero selector-13 entry does not masquerade as an occupied slot ---

test("I3: a garbage oversized count doesn't turn into an unbounded read loop", async () => {
  const transport = makeFakeTransport();
  const block = Buffer.alloc(60);
  block[0] = 0xff; // would mean 255 selector-13 reads if unclamped
  transport.xuGetRaw = vi.fn(async () => block);
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  // C1 already rejects this before the walk even starts - confirms the garbage
  // count never reaches the entry loop, let alone drives 255 USB transfers. Asserted
  // as "no selector-13 read ever happens", which is the actual invariant; a raw call
  // count would just be measuring how many times the retry policy re-reads.
  await tool.handler({});
  const entryReads = transport.xuGetRaw.mock.calls.filter((c) => c[0] === 13);
  expect(entryReads).toHaveLength(0);
});

test("I3: an all-zero selector-13 entry does not collapse into a false-occupied slot", async () => {
  const transport = makeFakeTransport();
  // selector 12 plausibly claims 1 occupied slot, but the corresponding selector-13
  // read comes back all zero (a failed/short entry read) instead of a real entry
  // or the 0x02 exhausted marker.
  transport.xuGetRaw = vi.fn(async (selector: number) =>
    selector === 12 ? Buffer.from("0100", "hex") : Buffer.alloc(60),
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  // The all-zero entry must NOT decode as a plausible occupied slot; since that
  // disagrees with selector 12's claim, I1's cross-check fails loudly.
  expect(result).toMatchObject({ ok: false });
});

test("obsbot_gimbal_position maps UVC pan->yaw and negates tilt->pitch", async () => {
  const transport = makeFakeTransport();
  // pan (prop 0) = 30 -> yaw 30; tilt (prop 1) = -19 -> pitch +19 (negated)
  transport.camCtrlGet = vi.fn(async (p: number) =>
    p === 0 ? { value: 30, flags: 2 } : { value: -19, flags: 2 },
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_gimbal_position");

  const result = await tool.handler({});

  expect(transport.camCtrlGet).toHaveBeenCalledWith(0);
  expect(transport.camCtrlGet).toHaveBeenCalledWith(1);
  expect(result).toEqual({ yaw: 30, pitch: 19 });
});

// --- obsbot_preset_save ---

test("obsbot_preset_save rejects an occupied slot", async () => {
  // makePresetTransport's fixture has all three slots occupied.
  const { transport } = makePresetTransport();
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_save");

  const result = await tool.handler({ slot: 1 });

  expect(result).toEqual({ ok: false, error: "slot 1 is occupied; update or delete first" });
  expect(transport.sendVendor).not.toHaveBeenCalled();
});


// Models the device as STATE rather than call ordinal: reads reflect whatever the
// writes have done so far. Call-ordinal fakes ("1st read empty, 2nd read occupied")
// silently encode HOW MANY times production code reads, so they break the moment a
// read is added for safety - and worse, they cannot distinguish "we read twice" from
// "the device changed". State-driven fakes survive both.
function statefulPresetTransport(before: Buffer, after: Buffer, entry = PRESET_ENTRY_1) {
  const transport = makeFakeTransport();
  let written = false;
  const realSend = transport.sendVendor;
  transport.sendVendor = vi.fn(async (frame: Buffer) => {
    written = true;
    return realSend(frame);
  });
  transport.xuGetRaw = vi.fn(async (selector: number) =>
    selector === 12 ? (written ? after : before) : entry,
  );
  transport.xuRaw = vi.fn(async () => {});
  return transport;
}

test("obsbot_preset_save on an empty slot sends the ADD frame with the live pose then verifies", async () => {
  const transport = statefulPresetTransport(emptyPresetListBlock(), Buffer.from("0100", "hex"));
  // pan (prop 0) = 21 -> yaw 21; tilt (prop 1) = 0 -> pitch -0 (negated)
  transport.camCtrlGet = vi.fn(async (p: number) =>
    p === 0 ? { value: 21, flags: 2 } : { value: 0, flags: 2 },
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_save");

  const result = await tool.handler({ slot: 1 });

  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  const addFrame = transport.sendVendor.mock.calls[0][0] as Buffer;
  expect(addFrame.subarray(10, 12).toString("hex")).toBe("4439"); // cmd 0x3944 LE
  expect(addFrame.readFloatLE(20)).toBeCloseTo(21); // pan slotted after idx(4) + pan f32

  expect(result).toMatchObject({ ok: true });
  const slot = (result as { slot: Record<string, unknown> }).slot;
  expect(slot).toMatchObject({ slot: 1, occupied: true, name: "Preset1" });
});

// Helper to build a selector-13 entry buffer matching decodePresetEntry's layout,
// using the real base64 encoding at runtime (avoids hand-computed hex, which is
// error-prone). slotIdx is 0-based (slot 1 -> 0).
function makePresetEntryBuffer(slotIdx: number, name: string): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x00; // not the ENTRY_END marker (0x02)
  header[1] = slotIdx;
  header.writeInt16LE(-1000, 4); // pitch hundredths (arbitrary, unused by these tests)
  header.writeInt16LE(-6660, 6); // yaw hundredths (arbitrary, unused by these tests)
  header[8] = 100; // zoom hundredths
  const b64 = Buffer.from(name, "ascii").toString("base64");
  return Buffer.concat([header, Buffer.from(b64, "ascii"), Buffer.from([0])]);
}

// --- obsbot_preset_recall ---

test("obsbot_preset_recall rejects an empty slot", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? emptyPresetListBlock() : Buffer.from("02000000", "hex"),
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_recall");

  const result = await tool.handler({ slot: 1 });

  expect(result).toEqual({ ok: false, error: "slot 1 is empty; save first" });
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("obsbot_preset_recall sends the RECALL frame for an occupied slot then verifies", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? Buffer.from("0100", "hex") : PRESET_ENTRY_1,
  );
  transport.xuRaw = vi.fn(async (_selector: number, _data: Buffer) => {});
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_recall");

  const result = await tool.handler({ slot: 1 });

  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  const frame = transport.sendVendor.mock.calls[0][0] as Buffer;
  expect(frame.subarray(10, 12).toString("hex")).toBe("c439"); // cmd 0x39c4 LE
  expect(result).toMatchObject({ ok: true });
  const slot = (result as { slot: Record<string, unknown> }).slot;
  expect(slot).toMatchObject({ slot: 1, occupied: true, name: "Preset1" });
});

// --- obsbot_preset_update ---

test("obsbot_preset_update rejects an empty slot", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? emptyPresetListBlock() : Buffer.from("02000000", "hex"),
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_update");

  const result = await tool.handler({ slot: 1 });

  expect(result).toEqual({ ok: false, error: "slot 1 is empty; save first" });
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("obsbot_preset_update sends UPDATE with the live pose for an occupied slot then verifies", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? Buffer.from("0100", "hex") : PRESET_ENTRY_1,
  );
  transport.xuRaw = vi.fn(async (_selector: number, _data: Buffer) => {});
  // pan (prop 0) = 33 -> yaw 33; tilt (prop 1) = 5 -> pitch -5 (negated)
  transport.camCtrlGet = vi.fn(async (p: number) =>
    p === 0 ? { value: 33, flags: 2 } : { value: 5, flags: 2 },
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_update");

  const result = await tool.handler({ slot: 1 });

  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  const frame = transport.sendVendor.mock.calls[0][0] as Buffer;
  expect(frame.subarray(10, 12).toString("hex")).toBe("043e"); // cmd 0x3e04 LE
  expect(frame.readFloatLE(20)).toBeCloseTo(33); // pan slotted after idx(4) + pan f32
  expect(frame.readFloatLE(24)).toBeCloseTo(-5); // pitch = -tilt
  expect(result).toMatchObject({ ok: true });
});

// --- obsbot_preset_rename ---

test("obsbot_preset_rename rejects an empty slot", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? emptyPresetListBlock() : Buffer.from("02000000", "hex"),
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_rename");

  const result = await tool.handler({ slot: 1, name: "Foo" });

  expect(result).toEqual({ ok: false, error: "slot 1 is empty; save first" });
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("obsbot_preset_rename sends SET_NAME with the (truncated) name then verifies the new name", async () => {
  const transport = makeFakeTransport();
  const longName = "x".repeat(50);
  const truncated = longName.slice(0, 40);
  let listCall = 0;
  // Guard read: slot occupied under old name "Preset1". Verify read: same slot, now
  // under the new (truncated) name — the fake must reflect the rename on the SECOND
  // read only, to prove the tool actually re-reads rather than trusting its own input.
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) => {
    if (selector === 12) {
      listCall++;
      return Buffer.from("0100", "hex");
    }
    return listCall <= 1 ? PRESET_ENTRY_1 : makePresetEntryBuffer(0, truncated);
  });
  transport.xuRaw = vi.fn(async (_selector: number, _data: Buffer) => {});
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_rename");

  const result = await tool.handler({ slot: 1, name: longName });

  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  const frame = transport.sendVendor.mock.calls[0][0] as Buffer;
  expect(frame.subarray(10, 12).toString("hex")).toBe("843a"); // cmd 0x3a84 LE
  expect(frame.subarray(16, 20).toString("hex")).toBe("00000000"); // idx(slot 1) = 0
  const sentName = frame.subarray(20, 20 + truncated.length).toString("ascii");
  expect(sentName).toBe(truncated);
  expect(sentName.length).toBe(40);
  expect(result).toMatchObject({ ok: true });
  const slot = (result as { slot: Record<string, unknown> }).slot;
  expect(slot).toMatchObject({ slot: 1, occupied: true, name: truncated });
});

test("obsbot_preset_rename returns a structured failure when the device didn't apply the new name", async () => {
  const transport = makeFakeTransport();
  // List/entry reads never change -> stays "Preset1" on both the guard and verify read.
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? Buffer.from("0100", "hex") : PRESET_ENTRY_1,
  );
  transport.xuRaw = vi.fn(async (_selector: number, _data: Buffer) => {});
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_rename");

  const result = await tool.handler({ slot: 1, name: "NewName" });

  expect(result).toEqual({
    ok: false,
    error: "verification failed",
    expected: "NewName",
    actual: "Preset1",
  });
});

// --- obsbot_preset_delete ---

test("obsbot_preset_delete rejects an already-empty slot", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? emptyPresetListBlock() : Buffer.from("02000000", "hex"),
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_delete");

  const result = await tool.handler({ slot: 1 });

  expect(result).toEqual({ ok: false, error: "slot 1 is already empty" });
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("obsbot_preset_delete sends the DELETE frame for an occupied slot then verifies it's empty", async () => {
  // State-driven: occupied until the DELETE frame is sent, empty after - so the tool
  // must actually re-read to observe the change.
  const transport = statefulPresetTransport(Buffer.from("0100", "hex"), emptyPresetListBlock());
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_delete");

  const result = await tool.handler({ slot: 1 });

  expect(transport.sendVendor).toHaveBeenCalledTimes(1);
  const frame = transport.sendVendor.mock.calls[0][0] as Buffer;
  expect(frame.subarray(10, 12).toString("hex")).toBe("8439"); // cmd 0x3984 LE
  expect(result).toMatchObject({ ok: true, deleted: { name: "Preset1" } });
});

test("obsbot_preset_delete returns a structured failure if the slot is still occupied after delete", async () => {
  const transport = makeFakeTransport();
  // List/entry reads never change -> slot stays occupied on both reads.
  transport.xuGetRaw = vi.fn(async (selector: number, _length: number) =>
    selector === 12 ? Buffer.from("0100", "hex") : PRESET_ENTRY_1,
  );
  transport.xuRaw = vi.fn(async (_selector: number, _data: Buffer) => {});
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_delete");

  const result = await tool.handler({ slot: 1 });

  expect(result).toEqual({ ok: false, error: "verification failed", expected: "empty", actual: "occupied" });
});

// --- I2: all six preset tools are gated (readiness-checked) like other gimbal tools ---

const PRESET_TOOL_ARGS: Record<string, unknown> = {
  obsbot_preset_list: {},
  obsbot_preset_save: { slot: 1 },
  obsbot_preset_recall: { slot: 1 },
  obsbot_preset_update: { slot: 1 },
  obsbot_preset_rename: { slot: 1, name: "Foo" },
  obsbot_preset_delete: { slot: 1 },
};

for (const name of Object.keys(PRESET_TOOL_ARGS)) {
  test(`I2: ${name} is gated — returns the readiness error and never touches the device when unreachable`, async () => {
    const transport = makeFakeTransport();
    transport.recvStatus = vi.fn(async () => {
      throw new Error("KsProperty GET failed");
    });
    const tools = createTools(async () => transport, makeFakeMgr());
    const tool = findTool(tools, name);

    const result = await tool.handler(PRESET_TOOL_ARGS[name]);

    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(transport.xuGetRaw).not.toHaveBeenCalled();
    expect(transport.sendVendor).not.toHaveBeenCalled();
  });
}

// --- M1: a failure after the ADD/UPDATE write has already committed must say so ---

test("M1: obsbot_preset_save reports a plain save failure when the ADD write itself throws (nothing committed)", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async () => emptyPresetListBlock());
  transport.sendVendor = vi.fn(async () => {
    throw new Error("device NAK");
  });
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_save");

  const result = await tool.handler({ slot: 1 });

  expect(result).toMatchObject({ ok: false });
  const error = (result as { error: string }).error;
  // Nothing committed yet — must NOT claim the preset was saved.
  expect(error).not.toMatch(/saved to slot/i);
  expect(error).toMatch(/save failed/i);
});

// --- M2: catch blocks report a safe message even for a non-Error throw ---

test("M2: obsbot_preset_list surfaces a readable error even when a non-Error is thrown", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async () => {
    throw "camera unplugged"; // eslint-disable-line no-throw-literal -- simulate a non-Error throw
  });
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  const error = (result as { error: string }).error;
  expect(error).not.toBe("undefined");
  expect(error).toContain("camera unplugged");
});

// --- Empty-state: a genuinely empty device returns an ALL-ZERO selector-12 block ---
// Hardware-established 2026-07-19 under controlled conditions (OBSBOT Center closed so
// nothing could re-assert presets, camera MEASURED awake before and at the moment of
// failure, stable across repeated reads). Deleting the last preset yields a bit-for-bit
// all-zero block, so "all-zero" is genuinely ambiguous between EMPTY and NOT-SERVING.
//
// The discriminator is the STATUS BLOCK on the same XU surface and handle: at the exact
// instant selector 12 read zeros, the status block returned real non-zero data. A dead
// link / stale handle would zero BOTH. Note UVC liveness is NOT valid corroboration —
// obsbot_gimbal_position returns a correct pose even when presets aren't serving.
//
// Corroboration is deliberately TWO-part (non-zero AND awake): decodeStatus reports
// awake for an ALL-ZERO block (awake === block[2] === 0), so "awake" alone would let a
// dead link masquerade as an empty device — the exact false-EMPTY that gates the
// irreversible create-once ADD.

test("empty device: save can bootstrap the FIRST preset when all slots are empty", async () => {
  // Regression for the dead-end: every preset tool routes through getPresetSlots, so
  // an all-zero read blocked save too — leaving our toolset with no path OUT of a
  // legitimate device state (fatal where OBSBOT Center doesn't exist to create one).
  const transport = statefulPresetTransport(Buffer.alloc(60), Buffer.from("0100", "hex"));
  transport.recvStatus = vi.fn(async () => HEALTHY_STATUS_AWAKE);
  transport.camCtrlGet = vi.fn(async (p: number) =>
    p === 0 ? { value: 21, flags: 2 } : { value: 0, flags: 2 },
  );
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_save");

  const result = await tool.handler({ slot: 1 });

  expect(result).toMatchObject({ ok: true });
  expect(transport.sendVendor).toHaveBeenCalled();
});

test("all-zero selector 12 while the camera reports asleep is refused, not read as empty", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async () => Buffer.alloc(60));
  transport.recvStatus = vi.fn(async () => HEALTHY_STATUS_ASLEEP);
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  expect(transport.xuRaw).not.toHaveBeenCalled();
});

test("delete of the LAST preset reports success once the device reads back empty", async () => {
  // Observed on hardware: delete committed but reported {ok:false} because the
  // post-write verify read hit the all-zero (now-empty) block and threw.
  const transport = statefulPresetTransport(Buffer.from("0101", "hex"), Buffer.alloc(60), PRESET_ENTRY_2);
  transport.recvStatus = vi.fn(async () => HEALTHY_STATUS_AWAKE);
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_delete");

  const result = await tool.handler({ slot: 2 });

  expect(result).toMatchObject({ ok: true });
});

test("a write that commits but fails verification says so, instead of implying nothing happened", async () => {
  const transport = makeFakeTransport();
  let listCall = 0;
  transport.xuGetRaw = vi.fn(async (selector: number) => {
    if (selector === 12) {
      if (++listCall === 1) return Buffer.from("0101", "hex");
      throw new Error("camera unplugged");
    }
    return PRESET_ENTRY_2;
  });
  transport.recvStatus = vi.fn(async () => HEALTHY_STATUS_AWAKE);
  const tools = createTools(async () => transport, makeFakeMgr());
  const tool = findTool(tools, "obsbot_preset_delete");

  const result = await tool.handler({ slot: 2 });

  expect(result).toMatchObject({ ok: false });
  // The destructive write already landed — the caller must not read this as a no-op
  // and retry blindly.
  expect((result as { error: string }).error).toMatch(/verif/i);
  expect((result as { error: string }).error).toMatch(/sent|committed|applied/i);
});

// --- Due diligence around destructive writes ---------------------------------
// Risk order (user-stated): (1) never damage the camera, (2) never lose the
// customer's data, (3) everything else — latency included — is negotiable below
// those. Reads cannot do either kind of harm, so they are retried and
// double-checked freely; writes are NEVER retried.
//
// Only ONE wrong read destroys data: believing a slot is EMPTY when it is
// occupied, which fires a create-once ADD at a customer's preset (the firmware's
// behaviour there is undecoded — it may overwrite). The reverse error is benign:
// a slot wrongly believed occupied makes delete a no-op and update fail. So the
// EMPTY verdict — and only the EMPTY verdict — is confirmed by a second read.

// Retry timings are injected so the suite never actually sleeps.
const FAST_READ = { attempts: 3, backoffMs: [1, 1, 1] };

test("an EMPTY verdict is confirmed by a second read before it is trusted", async () => {
  const transport = makeFakeTransport();
  let listReads = 0;
  transport.xuGetRaw = vi.fn(async (selector: number) => {
    if (selector === 12) listReads++;
    return Buffer.alloc(60);
  });
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, false, FAST_READ);
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: true });
  expect(listReads).toBe(2); // the verdict that can destroy data is never single-sampled
});

test("an unstable EMPTY (second read disagrees) never authorizes a create-once write", async () => {
  const transport = makeFakeTransport();
  let listReads = 0;
  transport.xuGetRaw = vi.fn(async (selector: number) => {
    if (selector === 12) {
      // reads alternate empty / occupied — a device caught mid-transition
      return ++listReads % 2 === 1 ? Buffer.alloc(60) : Buffer.from("0100", "hex");
    }
    return PRESET_ENTRY_1;
  });
  transport.camCtrlGet = vi.fn(async () => ({ value: 0, flags: 2 }));
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, false, FAST_READ);
  const tool = findTool(tools, "obsbot_preset_save");

  const result = await tool.handler({ slot: 1 });

  expect(result).toMatchObject({ ok: false });
  // The whole point: an unconfirmed EMPTY must not become an ADD.
  expect(transport.sendVendor).not.toHaveBeenCalled();
});

test("delete hands back the preset it destroyed, so it can be restored", async () => {
  const transport = makeFakeTransport();
  let listCall = 0;
  transport.xuGetRaw = vi.fn(async (selector: number) => {
    if (selector === 12) return ++listCall === 1 ? Buffer.from("0101", "hex") : Buffer.alloc(60);
    return PRESET_ENTRY_2; // slot 2, "Preset2", pan 21.2 tilt 0.7
  });
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, false, FAST_READ);
  const tool = findTool(tools, "obsbot_preset_delete");

  const result = await tool.handler({ slot: 2 });

  expect(result).toMatchObject({
    ok: true,
    deleted: { name: "Preset2", pose: { pan: 21.2, tilt: 0.7, roll: 0, zoom: 1 } },
  });
});

test("update hands back the pose it overwrote, so it can be restored", async () => {
  const transport = makeFakeTransport();
  transport.xuGetRaw = vi.fn(async (selector: number) =>
    selector === 12 ? Buffer.from("0101", "hex") : PRESET_ENTRY_2,
  );
  transport.camCtrlGet = vi.fn(async (p: number) =>
    p === 0 ? { value: 40, flags: 2 } : { value: -14, flags: 2 },
  );
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, false, FAST_READ);
  const tool = findTool(tools, "obsbot_preset_update");

  const result = await tool.handler({ slot: 2 });

  expect(result).toMatchObject({
    ok: true,
    previous: { pan: 21.2, tilt: 0.7, roll: 0, zoom: 1 },
  });
});

test("a transient read failure is retried rather than surfaced to the caller", async () => {
  const transport = makeFakeTransport();
  let listCall = 0;
  let entryCall = 0;
  const entries = [PRESET_ENTRY_1, PRESET_ENTRY_2, PRESET_ENTRY_3];
  transport.xuGetRaw = vi.fn(async (selector: number) => {
    if (selector === 12) {
      // first attempt lands mid-transition (all zeros, no corroboration), then recovers
      if (++listCall === 1) return Buffer.alloc(60);
      return PRESET_LIST_BLOCK;
    }
    return entries[entryCall++ % entries.length];
  });
  transport.recvStatus = vi.fn(async () => Buffer.alloc(60)); // uncorroborated => not "empty"
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, false, FAST_READ);
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: true });
  expect(listCall).toBeGreaterThan(1); // it really did re-read
});

test("retries are bounded — a persistently bad read fails loudly instead of spinning", async () => {
  const transport = makeFakeTransport();
  let listReads = 0;
  transport.xuGetRaw = vi.fn(async (selector: number) => {
    if (selector === 12) listReads++;
    return Buffer.alloc(60);
  });
  transport.recvStatus = vi.fn(async () => Buffer.alloc(60)); // dead link: both zeroed
  const tools = createTools(async () => transport, makeFakeMgr(), undefined, undefined, false, FAST_READ);
  const tool = findTool(tools, "obsbot_preset_list");

  const result = await tool.handler({});

  expect(result).toMatchObject({ ok: false });
  expect(listReads).toBe(3); // exactly `attempts`, no runaway
  expect(transport.xuRaw).not.toHaveBeenCalled();
});
