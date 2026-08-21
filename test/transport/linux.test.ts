import { expect, test, vi } from "vitest";
import { LinuxTransport } from "../../src/transport/linux.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

function makeFakeHelper(camCtrlGetValue = 288000) {
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
    panTiltSet: vi.fn(async (_pan: number, _tilt: number) => {}),
    camCtrlRange: vi.fn(async (_p: number) => ({ min: 0, max: 100 })),
    camCtrlGet: vi.fn(async (_p: number) => ({ value: camCtrlGetValue, flags: 2 })),
    readLatency: vi.fn(async () => ({ meanUs: 2, minUs: 2, maxUs: 2 })),
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

test("pan/tilt keep their sub-degree precision", async () => {
  // The device reports arcseconds. 3600 arcsec = 1 deg, so 21510 arcsec is
  // 5.975 deg. Rounding that to 6 discards real precision the hardware gave
  // us, and aimAtPixel adds its offset to whatever this returns.
  const helper = makeFakeHelper(21510);
  const t = new LinuxTransport(helper);
  const r = await t.camCtrlGet(0);
  expect(r).toEqual({ value: 5.975, flags: 2 });
});

test("gimbalSet commits both axes in a single panTiltSet, never as two writes", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);

  await t.gimbalSet(10, 5);

  // yaw=10 -> pan raw = 10*3600 = 36000; pitch=5 (down) -> tilt raw = -5*3600 = -18000.
  expect(helper.panTiltSet).toHaveBeenCalledWith(36000, -18000);
  // The point of the change: two single-axis writes let uvcvideo's
  // read-modify-write cancel half the move, so splitting them is the bug.
  expect(helper.camCtrlSet).not.toHaveBeenCalled();
  expect(helper.xuSet).not.toHaveBeenCalled();
});

test("gimbalRecenter commits pan=0, tilt=0 in a single panTiltSet", async () => {
  const helper = makeFakeHelper();
  const t = new LinuxTransport(helper);

  await t.gimbalRecenter();

  expect(helper.panTiltSet).toHaveBeenCalledWith(0, 0);
  expect(helper.camCtrlSet).not.toHaveBeenCalled();
});

test("gimbalSet falls back to two writes when the helper predates pantilt_set", async () => {
  // A user whose npm package updated without the native helper being rebuilt
  // must still be able to move the gimbal — degraded, not broken.
  const helper = makeFakeHelper();
  (helper.panTiltSet as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("unknown op: pantilt_set"),
  );
  const t = new LinuxTransport(helper);

  await t.gimbalSet(10, 5);

  expect(helper.camCtrlSet).toHaveBeenCalledWith(0, 36000, 2);
  expect(helper.camCtrlSet).toHaveBeenCalledWith(1, -18000, 2);
});

test("gimbalSet propagates real helper failures instead of falling back", async () => {
  // Only "unknown op" means an old binary. Anything else is a genuine failure
  // and must not be retried down a path that hides it.
  const helper = makeFakeHelper();
  (helper.panTiltSet as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("pantilt_set: set failed"),
  );
  const t = new LinuxTransport(helper);

  await expect(t.gimbalSet(10, 5)).rejects.toThrow("set failed");
  expect(helper.camCtrlSet).not.toHaveBeenCalled();
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

// --- closed-loop move retry (OBSBOT_LIVE_POSE, Linux only) ---
//
// The camera intermittently lands one axis on a previously commanded pose. With
// live reads that is detectable, so panTiltAbsolute settles, compares, and
// re-sends ONCE. Gated off by default: on a stock kernel the read is a cached
// echo, a retry could never trigger, and the settle would just cost time.

function withGate<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OBSBOT_LIVE_POSE;
  if (value === undefined) delete process.env.OBSBOT_LIVE_POSE;
  else process.env.OBSBOT_LIVE_POSE = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.OBSBOT_LIVE_POSE;
    else process.env.OBSBOT_LIVE_POSE = prev;
  });
}

// A helper whose pan/tilt readback is a function of how many commits it has seen:
// `poseAfter[n]` is the pose it reports after n panTiltSet calls.
function makeStatefulHelper(poseAfter: Array<[number, number]>) {
  const helper = makeFakeHelper();
  let commits = 0;
  (helper.panTiltSet as ReturnType<typeof vi.fn>).mockImplementation(async () => { commits++; });
  (helper.camCtrlGet as ReturnType<typeof vi.fn>).mockImplementation(async (p: number) => {
    const pose = poseAfter[Math.min(commits, poseAfter.length - 1)];
    return { value: p === 0 ? pose[0] : pose[1], flags: 2 };
  });
  return helper;
}

test("gate off: one commit, no settle reads, no retry", () =>
  withGate(undefined, async () => {
    const helper = makeStatefulHelper([[0, 0], [999, 999]]); // would look badly off-target if read
    const t = new LinuxTransport(helper);
    await t.gimbalSet(10, -5);
    expect(helper.panTiltSet).toHaveBeenCalledTimes(1);
    expect(helper.camCtrlGet).not.toHaveBeenCalled();
    expect(t.moveRetries).toBe(0);
  }));

test("gate on: a move that lands within one step is not retried", () =>
  withGate("1", async () => {
    // Lands one 3600-step short of the commanded pan, as the hardware does.
    const helper = makeStatefulHelper([[0, 0], [36000 - 3600, -18000]]);
    const t = new LinuxTransport(helper);
    await t.gimbalSet(10, 5);
    expect(helper.panTiltSet).toHaveBeenCalledTimes(1);
    expect(helper.camCtrlGet).toHaveBeenCalled();
    expect(t.moveRetries).toBe(0);
  }));

test("gate on: an axis that lands on a stale pose is re-sent once and corrects", () =>
  withGate("1", async () => {
    // After the 1st commit pan sits at a previously commanded 216000 instead of
    // 36000; after the 2nd commit it is where it was told to go.
    const helper = makeStatefulHelper([[0, 0], [216000, -18000], [36000, -18000]]);
    const t = new LinuxTransport(helper);
    await t.gimbalSet(10, 5);
    expect(helper.panTiltSet).toHaveBeenCalledTimes(2);
    expect(helper.panTiltSet).toHaveBeenNthCalledWith(2, 36000, -18000);
    expect(t.moveRetries).toBe(1);
  }));

test("gate on: a move that is still off after the retry is not retried again", () =>
  withGate("1", async () => {
    const helper = makeStatefulHelper([[0, 0], [216000, -18000], [216000, -18000]]);
    const t = new LinuxTransport(helper);
    await expect(t.gimbalSet(10, 5)).resolves.toBeUndefined(); // no throw: the caller's settle reports it
    expect(helper.panTiltSet).toHaveBeenCalledTimes(2);
    expect(t.moveRetries).toBe(1);
  }));

test("gate on: recenter goes through the same closed loop", () =>
  withGate("1", async () => {
    const helper = makeStatefulHelper([[36000, 0], [36000, 0], [0, 0]]); // pan ignores the first (0,0)
    const t = new LinuxTransport(helper);
    await t.gimbalRecenter();
    expect(helper.panTiltSet).toHaveBeenCalledTimes(2);
    expect(helper.panTiltSet).toHaveBeenLastCalledWith(0, 0);
    expect(t.moveRetries).toBe(1);
  }));

// --- livePoseReads: read-latency probe (auto-detect a live-reading kernel) ---

test("livePoseReads probes read latency and reports live above the threshold", () =>
  withGate(undefined, async () => {
    const helper = makeFakeHelper();
    (helper.readLatency as ReturnType<typeof vi.fn>).mockResolvedValue({ meanUs: 150, minUs: 115, maxUs: 700 });
    const t = new LinuxTransport(helper);
    expect(await t.livePoseReads()).toBe(true);
  }));

test("livePoseReads reports cached below the threshold", () =>
  withGate(undefined, async () => {
    const helper = makeFakeHelper();
    (helper.readLatency as ReturnType<typeof vi.fn>).mockResolvedValue({ meanUs: 2, minUs: 1.9, maxUs: 2.1 });
    const t = new LinuxTransport(helper);
    expect(await t.livePoseReads()).toBe(false);
  }));

test("livePoseReads caches the probe: the helper is timed once per transport", () =>
  withGate(undefined, async () => {
    const helper = makeFakeHelper();
    (helper.readLatency as ReturnType<typeof vi.fn>).mockResolvedValue({ meanUs: 150, minUs: 115, maxUs: 700 });
    const t = new LinuxTransport(helper);
    await t.livePoseReads();
    await t.livePoseReads();
    expect(helper.readLatency).toHaveBeenCalledTimes(1);
  }));

test("OBSBOT_LIVE_POSE=1 forces live without probing", () =>
  withGate("1", async () => {
    const helper = makeFakeHelper();
    const t = new LinuxTransport(helper);
    expect(await t.livePoseReads()).toBe(true);
    expect(helper.readLatency).not.toHaveBeenCalled();
  }));

test("OBSBOT_LIVE_POSE=0 forces cached even when the probe would say live", () =>
  withGate("0", async () => {
    const helper = makeFakeHelper();
    (helper.readLatency as ReturnType<typeof vi.fn>).mockResolvedValue({ meanUs: 150, minUs: 115, maxUs: 700 });
    const t = new LinuxTransport(helper);
    expect(await t.livePoseReads()).toBe(false);
    expect(helper.readLatency).not.toHaveBeenCalled();
  }));

test("a probe failure (old helper, unreadable control) degrades to cached, never throws", () =>
  withGate(undefined, async () => {
    const helper = makeFakeHelper();
    (helper.readLatency as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unknown op: read_latency"));
    const t = new LinuxTransport(helper);
    expect(await t.livePoseReads()).toBe(false);
  }));
