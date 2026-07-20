import { expect, test, vi } from "vitest";
import { MacosTransport } from "../../src/transport/macos.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

// The Tiny 2 exposes live absolute pan/tilt on UVC CT selector 0x0D as two
// int32 arc-seconds. The helper returns the raw per-axis arc-second value; the
// transport scales to degrees, mirroring how LinuxTransport scales V4L2
// millidegrees. 180000 asec = 50°, -32400 asec = -9°.
function makeFakeHelper(camCtrlGetValue = 180000) {
  return {
    xuSet: vi.fn(async (_selector: number, _data: Buffer) => {}),
    xuGet: vi.fn(async (_selector: number, _length: number) => Buffer.from([0xaa, 0x25])),
    zoomRange: vi.fn(async () => ({ min: 0, max: 100 })),
    zoomSet: vi.fn(async (_units: number) => {}),
    snapshot: vi.fn(async (_opts: unknown) => ({
      mime: "image/jpeg",
      width: 640,
      height: 360,
      base64: "QUJD",
    })),
    camCtrlSet: vi.fn(async (_p: number, _v: number, _f: number) => {}),
    camCtrlRange: vi.fn(async (_p: number) => ({ min: -468000, max: 468000 })),
    camCtrlGet: vi.fn(async (_p: number) => ({ value: camCtrlGetValue, flags: 2 })),
    procAmpSet: vi.fn(async (_p: number, _v: number, _f: number) => {}),
    procAmpRange: vi.fn(async (_p: number) => ({ min: 0, max: 100 })),
    close: vi.fn(async () => {}),
  } as unknown as HelperProcess;
}

test("camCtrlGet converts pan arc-seconds to degrees", async () => {
  const helper = makeFakeHelper(180000);
  const t = new MacosTransport(helper);
  expect(await t.camCtrlGet(0)).toEqual({ value: 50, flags: 2 });
});

test("camCtrlGet converts tilt arc-seconds to degrees, preserving sign", async () => {
  const helper = makeFakeHelper(-32400);
  const t = new MacosTransport(helper);
  expect(await t.camCtrlGet(1)).toEqual({ value: -9, flags: 2 });
});

test("camCtrlGet passes non-gimbal properties through unscaled", async () => {
  const helper = makeFakeHelper(1234);
  const t = new MacosTransport(helper);
  // Focus (property 6) is not an arc-second control.
  expect(await t.camCtrlGet(6)).toEqual({ value: 1234, flags: 2 });
});

test("camCtrlGet reads the hardware register every call, with no shadow-tracking", async () => {
  // Regression: the transport briefly shadow-tracked the last commanded pose
  // because selector 0x0E (PANTILT_RELATIVE) was mistaken for the position
  // register. A speed move must not stop camCtrlGet from reading the hardware.
  const helper = makeFakeHelper(342000);
  const t = new MacosTransport(helper);

  await t.gimbalSpeed(-30, 0, 0, 0);
  const after = await t.camCtrlGet(0);

  expect(after).toEqual({ value: 95, flags: 2 });
  expect(helper.camCtrlGet).toHaveBeenCalledWith(0);
});

test("camCtrlRange converts pan arc-second limits to degrees", async () => {
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);
  expect(await t.camCtrlRange(0)).toEqual({ min: -130, max: 130 });
});

test("camCtrlRange passes non-gimbal properties through unscaled", async () => {
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);
  expect(await t.camCtrlRange(6)).toEqual({ min: -468000, max: 468000 });
});

test("camCtrlSet rejects pan/tilt writes instead of issuing an untested SET_CUR", async () => {
  // SET_CUR on 0x0D has never been exercised on this device; absolute moves go
  // through vendor V3 frames (gimbalSet). Fail loudly rather than silently
  // writing a control we have not characterized.
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);

  await expect(t.camCtrlSet(0, 50, 2)).rejects.toThrow(/gimbalSet/);
  expect(helper.camCtrlSet).not.toHaveBeenCalled();
});

test("camCtrlSet passes non-gimbal properties through to the helper", async () => {
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);
  await t.camCtrlSet(6, 40, 1);
  expect(helper.camCtrlSet).toHaveBeenCalledWith(6, 40, 1);
});

test("gimbalSet sends a vendor move frame", async () => {
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);
  await t.gimbalSet(50, 10);
  expect(helper.xuSet).toHaveBeenCalledOnce();
  expect((helper.xuSet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(2);
});

test("nextSeq increments monotonically", async () => {
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);
  expect(t.nextSeq() + 1).toBe(t.nextSeq());
});

test("close delegates to helper", async () => {
  const helper = makeFakeHelper();
  const t = new MacosTransport(helper);
  await t.close();
  expect(helper.close).toHaveBeenCalledOnce();
});
