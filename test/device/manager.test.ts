import { expect, test, vi } from "vitest";
import { buildFrame } from "../../src/codec/frame.js";
import {
  DeviceManager,
  AmbiguousCameraError,
  UnknownCameraError,
} from "../../src/device/manager.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

// ---------------------------------------------------------------------------
// Fake HelperProcess factory — simulates the native helper closely enough to
// drive DeviceManager's registry logic (enumerate/open/readSerial) without a
// real subprocess. Each call to the returned factory produces a fresh
// HelperProcess-shaped object, mirroring "one helper process per camera":
// DeviceManager may spawn several across a single scan.
//
// - enumerate() always reports the full simulated fleet (system-wide, like a
//   real helper), one DeviceInfo per configured camera.
// - open(path) matches by path; a `busy` camera throws an exclusive-access-
//   style error (any open failure is treated as "skip" by the manager).
// - xuSet/xuGet implement just enough of the UG_GET_SN wire protocol (via the
//   repo's real buildFrame, so CRCs are valid) for readSerial() to resolve to
//   whichever camera this instance most recently opened — same pattern as
//   test/transport/macos.test.ts's makeFakeHelperWithSerial.
// ---------------------------------------------------------------------------
interface FakeCameraSpec {
  serial: string;
  locationId?: number;
  name?: string;
  busy?: boolean;
  /** Simulates the secondary (non-XU) /dev node a real OBSBOT also exposes. */
  noXu?: boolean;
}

function fakeHelperFactory(cameras: FakeCameraSpec[]) {
  const pathFor = (serial: string) => `/dev/fake-${serial}`;

  return async (): Promise<HelperProcess> => {
    let openedSerial: string | undefined;
    let lastSeq = 0;

    const helper = {
      start: vi.fn(async () => {}),
      enumerate: vi.fn(async () =>
        cameras.map((c) => ({
          path: pathFor(c.serial),
          name: c.name ?? "OBSBOT Tiny 2",
          locationId: c.locationId,
        })),
      ),
      open: vi.fn(async (path: string) => {
        const cam = cameras.find((c) => pathFor(c.serial) === path);
        if (!cam) throw new Error(`fake-helper: no such device ${path}`);
        if (cam.busy) {
          throw new Error("open failed: kIOReturnExclusiveAccess (0xe00002c5)");
        }
        openedSerial = cam.serial;
        return cam.noXu ? -1 : 1; // xuNode; -1 = opened, but no XU unit
      }),
      xuSet: vi.fn(async (_selector: number, data: Buffer) => {
        lastSeq = data.readUInt16LE(2);
      }),
      xuGet: vi.fn(async (_selector: number, _length: number) =>
        buildFrame({
          seq: lastSeq,
          cmd: 0x18c8,
          receiver: 0x0a,
          sender: 0x0d,
          payload: Buffer.from(openedSerial ?? "", "ascii"),
        }),
      ),
      close: vi.fn(async () => {}),
    } as unknown as HelperProcess;

    return helper;
  };
}

test("get() with one camera and no selector binds and returns it", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", locationId: 1 }]));
  const t = await mgr.get();
  expect(t).toBeDefined();
  expect(await t.readSerial()).toBe("AAA");
});

test("get() with two cameras and no selector throws AmbiguousCameraError listing serials", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }, { serial: "BBB" }]));
  await expect(mgr.get()).rejects.toMatchObject({
    name: "AmbiguousCameraError",
    available: ["AAA", "BBB"],
  });
});

test("get('BBB') binds the requested camera even when others are attached", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }, { serial: "BBB" }]));
  expect(await mgr.get("BBB")).toBeDefined();
});

test("get('ZZZ') throws UnknownCameraError listing what IS available", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }]));
  await expect(mgr.get("ZZZ")).rejects.toMatchObject({
    name: "UnknownCameraError",
    available: ["AAA"],
  });
});

test("a camera that fails open with exclusiveAccess is skipped, not fatal", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", busy: true }, { serial: "BBB" }]));
  expect(await mgr.get("BBB")).toBeDefined();
});

test("a busy camera never appears in an error's available list", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", busy: true }, { serial: "BBB" }]));
  await expect(mgr.get("ZZZ")).rejects.toMatchObject({
    name: "UnknownCameraError",
    available: ["BBB"],
  });
});

test("get() with no cameras attached throws", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([]));
  await expect(mgr.get()).rejects.toThrow();
});

test("a second /dev node with no XU unit is skipped in favor of one that has it", async () => {
  // Mirrors the real OBSBOT: one node is video-capture (has the XU), the
  // other is metadata/ISP (open succeeds, xuNode < 0). Both entries share a
  // camera identity in this fake via distinct serials is not representative,
  // but exercising the noXu skip path itself is what matters here.
  const mgr = new DeviceManager(
    fakeHelperFactory([{ serial: "AAA", noXu: true }, { serial: "BBB" }]),
  );
  expect(await mgr.get("BBB")).toBeDefined();
});

test("get(serial) reuses the already-bound transport instead of rescanning", async () => {
  const factory = fakeHelperFactory([{ serial: "AAA" }]);
  let calls = 0;
  const countingFactory = async () => {
    calls++;
    return factory();
  };
  const mgr = new DeviceManager(countingFactory);
  const first = await mgr.get("AAA");
  const callsAfterFirst = calls;
  const second = await mgr.get("AAA");
  expect(second).toBe(first);
  expect(calls).toBe(callsAfterFirst); // no new helper spawned on the cache hit
});

test("openFirstObsbot() is a compat shim for get() with no selector", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }]));
  const t = await mgr.openFirstObsbot();
  expect(await t.readSerial()).toBe("AAA");
});

test("list() returns the raw enumerated devices", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", name: "OBSBOT Tiny 2" }]));
  const devices = await mgr.list();
  expect(devices).toEqual([
    { path: "/dev/fake-AAA", name: "OBSBOT Tiny 2", locationId: undefined },
  ]);
});

test("listCameras() reports available cameras with their serial", async () => {
  const mgr = new DeviceManager(
    fakeHelperFactory([{ serial: "AAA", locationId: 1 }, { serial: "BBB", locationId: 2 }]),
  );
  const cameras = await mgr.listCameras();
  expect(cameras).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ serial: "AAA", status: "available" }),
      expect.objectContaining({ serial: "BBB", status: "available" }),
    ]),
  );
});

test("listCameras() reports a busy camera without a serial, not omitted", async () => {
  const mgr = new DeviceManager(
    fakeHelperFactory([{ serial: "AAA", busy: true }, { serial: "BBB" }]),
  );
  const cameras = await mgr.listCameras();
  expect(cameras).toHaveLength(2);
  const busy = cameras.find((c) => c.status === "busy");
  expect(busy).toBeDefined();
  expect(busy?.serial).toBeUndefined();
  const available = cameras.find((c) => c.status === "available");
  expect(available?.serial).toBe("BBB");
});

test("listCameras() reports an already-bound camera as bound", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", locationId: 1 }]));
  await mgr.get("AAA");
  const cameras = await mgr.listCameras();
  expect(cameras).toEqual([
    expect.objectContaining({ serial: "AAA", status: "bound" }),
  ]);
});
