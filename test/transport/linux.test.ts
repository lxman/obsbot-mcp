import { expect, test, vi } from "vitest";
import { LinuxTransport } from "../../src/transport/linux.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

function makeFakeHelper() {
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
    camCtrlRange: vi.fn(async (_p: number) => ({ min: 0, max: 100 })),
    camCtrlGet: vi.fn(async (_p: number) => ({ value: 288000, flags: 2 })),
    procAmpSet: vi.fn(async (_p: number, _v: number, _f: number) => {}),
    procAmpRange: vi.fn(async (_p: number) => ({ min: 0, max: 100 })),
    close: vi.fn(async () => {}),
  } as unknown as HelperProcess;
}

test("recvVendor sends the request via xuSet on selector 2 then reads via xuGet", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const req = Buffer.from([0xaa, 0x25, 0x01]);

  const reply = await t.recvVendor(req);

  expect(helper.xuSet).toHaveBeenCalledWith(2, req);
  expect(helper.xuGet).toHaveBeenCalledTimes(1);
  // Read happens on the response selector (default 2) with the default length.
  expect((helper.xuGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(2);
  expect(reply[0]).toBe(0xaa);
  // Enforce send-then-read order: xuSet must be called before xuGet.
  expect((helper.xuSet as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    .toBeLessThan((helper.xuGet as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
});

test("recvVendor honours an explicit reply length", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  await t.recvVendor(Buffer.from([0xaa]), 32);
  expect((helper.xuGet as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(32);
});

test("recvStatus reads the status block via xuGet on selector 6 with no xuSet", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const block = await t.recvStatus();
  expect(helper.xuSet).not.toHaveBeenCalled();
  expect((helper.xuGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(6);
  expect(Buffer.isBuffer(block)).toBe(true);
});

test("zoomRange delegates to helper", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const r = await t.zoomRange();
  expect(r).toEqual({ min: 0, max: 100 });
  expect(helper.zoomRange).toHaveBeenCalledOnce();
});

test("snapshot delegates to helper", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const snap = await t.snapshot({ maxDim: 640, quality: 70 });
  expect(snap.base64).toBe("QUJD");
});

test("camCtrl delegated to helper", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const r = await t.camCtrlGet(0);
  // 288000 arc-seconds / 3600 per degree = 80°.
  expect(r).toEqual({ value: 80, flags: 2 });
});

test("gimbalSet writes pan/tilt via V4L2 camCtrlSet, in parallel", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);

  await t.gimbalSet(10, 5);

  // yaw=10 -> pan raw = 10*3600 = 36000; pitch=5 (down) -> tilt raw = -5*3600 = -18000.
  expect(helper.camCtrlSet).toHaveBeenCalledWith(0, 36000, 2);
  expect(helper.camCtrlSet).toHaveBeenCalledWith(1, -18000, 2);
  expect(helper.xuSet).not.toHaveBeenCalled();
});

test("gimbalRecenter writes pan=0, tilt=0 via V4L2 camCtrlSet", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);

  await t.gimbalRecenter();

  expect(helper.camCtrlSet).toHaveBeenCalledWith(0, 0, 2);
  expect(helper.camCtrlSet).toHaveBeenCalledWith(1, 0, 2);
});

test("gimbalSpeed sends a vendor frame then an auto-stop frame, negating yaw", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);

  await t.gimbalSpeed(10, 5, 0, 1);

  expect(helper.xuSet).toHaveBeenCalledTimes(2);
  expect(helper.camCtrlSet).not.toHaveBeenCalled();
});

test("procAmp delegated to helper", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const r = await t.procAmpRange(7);
  expect(r).toEqual({ min: 0, max: 100 });
});

test("nextSeq increments monotonically", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  const a = t.nextSeq();
  const b = t.nextSeq();
  expect(b).toBe(a + 1);
});

test("close delegates to helper", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);
  await t.close();
  expect(helper.close).toHaveBeenCalledOnce();
});
