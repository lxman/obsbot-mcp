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
// - Cross-helper exclusivity: real hardware only ever has one open handle
//   per device. `heldBy` (shared across every helper instance this factory
//   call spawns) tracks which helper instance currently holds which path;
//   a DIFFERENT helper instance opening an already-held path throws
//   exclusive-access, same as the real OS would against our own registry
//   helper. Opening a new path on the SAME helper instance releases
//   whatever it previously held first — mirrors native doOpen()'s
//   unconditional releaseSession()-before-open, which is why one scratch
//   helper can walk multiple candidates in a single scan.
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
  /**
   * Models a branded software source (e.g. the "OBSBOT Virtual Camera"
   * DirectShow filter): its name matches OBSBOT, but it has no USB vid/pid, so
   * the hardware-identity gate must exclude it from binding.
   */
  virtual?: boolean;
  /**
   * Opens fine, but the vendor reply mailbox never produces a UG_GET_SN reply,
   * so readSerial() throws. Models the hardware-verified 2026-07-21 macOS
   * failure where selector 2 returned only our own echoed request frame: the
   * camera enumerates and opens, but cannot be identified.
   */
  mute?: boolean;
}

function fakeHelperFactory(cameras: FakeCameraSpec[]) {
  const pathFor = (serial: string) => `/dev/fake-${serial}`;
  const heldBy = new Map<string, object>(); // path -> owning helper instance's identity token

  return async (): Promise<HelperProcess> => {
    const identity = {}; // unique per helper instance
    let openedSerial: string | undefined;
    let openedPath: string | undefined;
    let lastSeq = 0;

    const helper = {
      start: vi.fn(async () => {}),
      enumerate: vi.fn(async () =>
        cameras.map((c) => ({
          path: pathFor(c.serial),
          name: c.name ?? "OBSBOT Tiny 2",
          locationId: c.locationId,
          // Real OBSBOT hardware reports Remo's VID + the model PID; a `virtual`
          // spec models a branded software source that reports neither.
          vid: c.virtual ? undefined : 0x3564,
          pid: c.virtual ? undefined : 0xfef8,
        })),
      ),
      open: vi.fn(async (path: string) => {
        const cam = cameras.find((c) => pathFor(c.serial) === path);
        if (!cam) throw new Error(`fake-helper: no such device ${path}`);
        if (cam.busy) {
          throw new Error("open failed: kIOReturnExclusiveAccess (0xe00002c5)");
        }
        const holder = heldBy.get(path);
        if (holder && holder !== identity) {
          throw new Error("open failed: kIOReturnExclusiveAccess (0xe00002c5)");
        }
        if (openedPath) heldBy.delete(openedPath); // release what this helper previously held
        heldBy.set(path, identity);
        openedPath = path;
        openedSerial = cam.serial;
        return cam.noXu ? -1 : 1; // xuNode; -1 = opened, but no XU unit
      }),
      xuSet: vi.fn(async (_selector: number, data: Buffer) => {
        lastSeq = data.readUInt16LE(2);
      }),
      xuGet: vi.fn(async (_selector: number, _length: number) => {
        const cam = cameras.find((c) => c.serial === openedSerial);
        // A `mute` camera's mailbox never yields a matching reply, so
        // readSerialVia() exhausts its polls and throws.
        if (cam?.mute) return Buffer.alloc(60);
        return buildFrame({
          seq: lastSeq,
          cmd: 0x18c8,
          receiver: 0x0a,
          sender: 0x0d,
          payload: Buffer.from(openedSerial ?? "", "ascii"),
        });
      }),
      close: vi.fn(async () => {
        if (openedPath && heldBy.get(openedPath) === identity) heldBy.delete(openedPath);
      }),
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

// A camera that enumerates and opens but cannot be identified used to be
// indistinguishable from no camera at all: bind()'s bare `catch { continue }`
// discarded the reason, and the caller saw the same bare "no OBSBOT camera
// found" it gets when nothing is plugged in. That cost a full debugging
// session on 2026-07-21 against real hardware whose vendor mailbox had gone
// quiet. The rejection reason must survive into the error.
test("a camera that opens but cannot be identified reports WHY, not just 'not found'", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", mute: true }]));
  await expect(mgr.get()).rejects.toThrow(/UG_GET_SN|readSerial/i);
});

test("the unidentifiable camera's path appears in the error so it can be located", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", mute: true }]));
  await expect(mgr.get()).rejects.toThrow(/fake-AAA/);
});

test("'no camera found' stays clean when genuinely nothing is attached", async () => {
  // The diagnostic must not turn the empty case into a confusing message.
  const mgr = new DeviceManager(fakeHelperFactory([]));
  await expect(mgr.get()).rejects.toThrow(/no OBSBOT camera found$/);
});

test("listCameras() explains why an enumerable camera is unusable", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", mute: true }]));
  const [cam] = await mgr.listCameras();
  expect(cam.status).toBe("busy");
  expect(cam.reason).toMatch(/UG_GET_SN|readSerial/i);
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
    {
      path: "/dev/fake-AAA",
      name: "OBSBOT Tiny 2",
      locationId: undefined,
      vid: 0x3564,
      pid: 0xfef8,
    },
  ]);
});

test("get() ignores a name-matching virtual camera and binds the real hardware", async () => {
  // Regression: on Windows the OBSBOT-branded "OBSBOT Virtual Camera" DirectShow
  // filter matched the old /obsbot/i candidacy, so a no-serial bind probed it on
  // the shared scan helper and clobbered the real camera's session. With the
  // hardware-identity gate it has no vid/pid and is never a candidate.
  //
  // Pin a non-Linux platform: the strict vid/pid gate applies on Windows/macOS,
  // whose helpers report vid/pid. Linux still uses the name fallback (its helper
  // does not report vid/pid yet), which is a documented, separate limitation.
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const mgr = new DeviceManager(
      fakeHelperFactory([
        { serial: "AAA", locationId: 1 },
        { serial: "VIRT", name: "OBSBOT Virtual Camera", virtual: true },
      ]),
    );
    const t = await mgr.get(); // no selector: must resolve unambiguously to the real one
    expect(await t.readSerial()).toBe("AAA");
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  }
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

test("listCameras() reports an already-bound camera exactly once even with no locationId (off-macOS)", async () => {
  // locationId is macOS-only; Linux/Windows enumerate() leaves it undefined.
  // Without a path-keyed dedup, the scan re-opens the bound camera's path
  // against a fresh scratch helper, collides with the registry helper's own
  // held-open handle (exclusive-access, modeled by the fake's `heldBy`
  // tracking), and gets double-reported as a second, serial-less "busy"
  // entry alongside the correct "bound" one.
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }]));
  await mgr.get("AAA");
  const cameras = await mgr.listCameras();
  expect(cameras).toEqual([expect.objectContaining({ serial: "AAA", status: "bound" })]);
});

// ---------------------------------------------------------------------------
// invalidate() — the reconnect/self-heal regression test. Without this,
// mgr.get() with one registry entry always returns the SAME cached
// transport, even after the physical device has re-enumerated behind a
// fresh helper. This is the test that would have caught that regression;
// the session/ready tests mock openFirstObsbot() directly and never
// exercise the real DeviceManager registry here.
// ---------------------------------------------------------------------------
test("invalidate() closes the bound helper and drops it, so the next get() re-scans via a fresh helper", async () => {
  const baseFactory = fakeHelperFactory([{ serial: "AAA" }]);
  const helpers: HelperProcess[] = [];
  const factory = async () => {
    const h = await baseFactory();
    helpers.push(h);
    return h;
  };
  const mgr = new DeviceManager(factory);

  const first = await mgr.get();
  expect(helpers).toHaveLength(1);

  await mgr.invalidate();
  expect(helpers[0]!.close).toHaveBeenCalledTimes(1);

  const second = await mgr.get();
  expect(helpers).toHaveLength(2); // a fresh helper was spawned by the re-scan, not reused
  expect(second).not.toBe(first); // the dead cached transport is not what get() returns
});

test("invalidate(serial) drops only that camera, leaving other bound cameras alone", async () => {
  const mgr = new DeviceManager(
    fakeHelperFactory([{ serial: "AAA" }, { serial: "BBB" }]),
  );
  await mgr.get("AAA");
  await mgr.get("BBB");

  await mgr.invalidate("AAA");

  const cameras = await mgr.listCameras();
  const bbb = cameras.find((c) => c.serial === "BBB");
  expect(bbb?.status).toBe("bound");
  const aaa = cameras.find((c) => c.serial === "AAA");
  expect(aaa?.status).not.toBe("bound"); // AAA was dropped, so it's rescanned as available
});

test("invalidate() with no serial drops every bound camera", async () => {
  const mgr = new DeviceManager(
    fakeHelperFactory([{ serial: "AAA" }, { serial: "BBB" }]),
  );
  await mgr.get("AAA");
  await mgr.get("BBB");

  await mgr.invalidate();

  const cameras = await mgr.listCameras();
  expect(cameras.every((c) => c.status !== "bound")).toBe(true);
});

// ---------------------------------------------------------------------------
// takeReconnected() — per-camera reconnect tracking, folded in from the retired
// DeviceSession. A first bind is NEVER a reconnect; a re-bind after invalidate()
// IS. The flag must survive invalidate() dropping the registry entry (tracked
// separately from the registry Map), and clears on read.
// ---------------------------------------------------------------------------
test("a first-ever get() is not a reconnect", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }]));
  await mgr.get();
  expect(mgr.takeReconnected()).toBe(false);
});

test("get() → invalidate() → get() flags reconnected exactly once, then clears", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }]));
  await mgr.get();
  await mgr.invalidate();
  await mgr.get();
  expect(mgr.takeReconnected()).toBe(true);
  expect(mgr.takeReconnected()).toBe(false); // cleared after being taken
});

test("takeReconnected(serial) tracks and clears per camera; an un-rebound camera stays false", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA" }, { serial: "BBB" }]));
  await mgr.get("AAA");
  await mgr.get("BBB");
  await mgr.invalidate("AAA");
  await mgr.get("AAA");
  expect(mgr.takeReconnected("BBB")).toBe(false); // BBB was never re-bound
  expect(mgr.takeReconnected("AAA")).toBe(true); // AAA was re-bound after invalidate
  expect(mgr.takeReconnected("AAA")).toBe(false); // cleared after being taken
});

test("invalidate() swallows a helper whose close() throws (best-effort) and still drops the entry", async () => {
  const mgr = new DeviceManager(
    fakeHelperFactory([{ serial: "AAA" }]),
  );
  await mgr.get("AAA");
  // Sabotage the bound helper's close() after the fact, simulating a
  // helper that's already dead (e.g. its subprocess crashed on unplug).
  const cameras = await mgr.listCameras();
  expect(cameras[0]?.status).toBe("bound");

  // Reach into the registry indirectly: rebind isn't possible without
  // invalidate, so instead verify invalidate() itself never throws even
  // when the underlying close() rejects — construct a manager whose sole
  // helper's close() is poisoned.
  const poisonFactory = async (): Promise<HelperProcess> => {
    const h = await fakeHelperFactory([{ serial: "ZZZ" }])();
    (h.close as unknown as { mockImplementation: (fn: () => Promise<void>) => void }).mockImplementation(
      async () => {
        throw new Error("helper already dead");
      },
    );
    return h;
  };
  const poisonMgr = new DeviceManager(poisonFactory);
  await poisonMgr.get("ZZZ");
  await expect(poisonMgr.invalidate()).resolves.toBeUndefined();
  const after = await poisonMgr.listCameras();
  expect(after.find((c) => c.serial === "ZZZ")?.status).not.toBe("bound");
});
