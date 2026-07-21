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

// ---------------------------------------------------------------------------
//  Replug recovery.
//
//  Hardware-tested 2026-07-21 (macOS, unplug -> replug, same port): after the
//  cable came back, EVERY call kept failing indefinitely. The helper process
//  was alive the whole time -- only its USB handle was dead -- so
//  pruneDeadEntries(), which keys on helper.isDead, never dropped the stale
//  registry entry and the manager kept handing back a transport wired to a
//  device that had re-enumerated. `pkill obsbot-helper` recovered it, which is
//  what proved the diagnosis: the death path works, device-loss had no path.
//
//  A helper that has lost its device must be treated exactly like a dead one.
// ---------------------------------------------------------------------------

/** Fake helper whose device can be yanked mid-session while the process lives. */
function yankableHelperFactory(serial: string) {
  const spawned: { deviceLost: boolean }[] = [];
  // failNextBind: hold every scan empty until cleared.
  // failBinds: fail exactly N scans, then answer — the post-replug camera,
  // whose vendor mailbox is mute for the first attempt or two and then fine.
  // A counter rather than a timer keeps the retry tests deterministic.
  const state = { failNextBind: false, failBinds: 0 };
  const scanFails = (): boolean => {
    if (state.failNextBind) return true;
    if (state.failBinds > 0) { state.failBinds--; return true; }
    return false;
  };
  const factory = async (): Promise<HelperProcess> => {
    let lastSeq = 0;
    const self = {
      deviceLost: false,
      isDead: false,
      start: vi.fn(async () => {}),
      enumerate: vi.fn(async () =>
        scanFails()
          ? []
          : [{ path: "/dev/yank", name: "OBSBOT Tiny 2", locationId: 7, vid: 0x3564, pid: 0xfef8 }],
      ),
      open: vi.fn(async () => 1),
      xuSet: vi.fn(async (_s: number, data: Buffer) => {
        lastSeq = data.readUInt16LE(2);
      }),
      xuGet: vi.fn(async () =>
        buildFrame({ seq: lastSeq, cmd: 0x18c8, receiver: 0x0a, sender: 0x0d,
                     payload: Buffer.from(serial, "ascii") }),
      ),
      close: vi.fn(async () => {}),
    };
    spawned.push(self);
    return self as unknown as HelperProcess;
  };
  const f = Object.assign(factory, { spawned, failNextBind: false, failBinds: 0 });
  // Object.assign copies a getter's VALUE, not the accessor. Declaring these as
  // get/set in the object literal above therefore produced a plain `false`
  // property: every `factory.failNextBind = true` wrote to that property,
  // `state` never changed, and the fault injection was inert — so the tests
  // that set it were binding successfully and passing for the wrong reason.
  Object.defineProperty(f, "failNextBind", {
    get: () => state.failNextBind,
    set: (v: boolean) => { state.failNextBind = v; },
  });
  Object.defineProperty(f, "failBinds", {
    get: () => state.failBinds,
    set: (v: number) => { state.failBinds = v; },
  });
  return f;
}

test("get() re-binds after the bound helper loses its device, without the process dying", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);

  const first = await mgr.get();
  expect(factory.spawned).toHaveLength(1);

  // Cable pulled: the helper stays alive, its device does not.
  factory.spawned[0]!.deviceLost = true;

  const second = await mgr.get();
  expect(second).not.toBe(first); // a fresh binding, not the stranded one
  expect(factory.spawned.length).toBeGreaterThan(1);
});

test("a device-lost binding is reported reconnected once it re-binds", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  factory.spawned[0]!.deviceLost = true;
  await mgr.get();
  expect(mgr.takeReconnected()).toBe(true);
});

test("listCameras() does not report a camera whose device is gone as still bound", async () => {
  // obsbot_devices reported status:"bound" with a serial for a camera that was
  // physically unplugged, because listCameras() reads registry entries without
  // re-opening them. A model reads that as "present and ready" -- backwards.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  factory.spawned[0]!.deviceLost = true;

  const cams = await mgr.listCameras();
  expect(cams.find((c) => c.status === "bound")).toBeUndefined();
});

// Pruning must CLOSE the helper, not just forget it.
//
// First attempt at the replug fix dropped the registry entry but left the
// helper process running. On hardware that turned one stranded handle into a
// process LEAK: every retry pruned, spawned a fresh helper, and left the old
// one alive still holding the USB device — so the replacement could never open
// it and recovery never happened (120s of retries, all failing). invalidate()
// already closes-then-deletes; the prune path has to do the same.
test("pruning a device-lost entry closes its helper so the device is released", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  const stale = factory.spawned[0]! as unknown as { deviceLost: boolean; close: ReturnType<typeof vi.fn> };
  stale.deviceLost = true;

  await mgr.get();
  expect(stale.close).toHaveBeenCalled();
});

test("re-binding after device loss does not leak helpers across repeated attempts", async () => {
  // The failure mode was unbounded growth: one new helper per call, none closed.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();

  for (let i = 0; i < 5; i++) {
    factory.spawned[factory.spawned.length - 1]!.deviceLost = true;
    await mgr.get();
  }

  const alive = (factory.spawned as unknown as { deviceLost: boolean; close: ReturnType<typeof vi.fn> }[])
    .filter((h) => !h.deviceLost && h.close.mock.calls.length === 0);
  expect(alive.length).toBe(1); // exactly the current binding, no corpses
});

// ---------------------------------------------------------------------------
//  A stale scan helper must not poison recovery forever.
//
//  Hardware, 2026-07-21 replug: the macOS helper reports `path` as the
//  AVFoundation uniqueID, correlated to the USB device by locationID. After a
//  replug the USB service returns to the bus BEFORE AVFoundation re-registers
//  the camera, so enumerate emitted a candidate with vid/pid set but an EMPTY
//  path. isObsbotCamera() gates on vid/pid, so it passed -- and open("") fails
//  with "open: missing path". Worse, the helper spawned while the camera was
//  absent kept returning the empty path for over two minutes, while a freshly
//  spawned process saw the device immediately: the cached scan helper was
//  poisoned, so every retry reused it and recovery never happened.
// ---------------------------------------------------------------------------

/** First helper enumerates a pathless candidate; later ones are healthy. */
function poisonedFirstHelperFactory(serial: string) {
  let n = 0;
  const spawned = [];
  const factory = async (): Promise<HelperProcess> => {
    const nth = n++;
    let lastSeq = 0;
    const self = {
      isDead: false,
      deviceLost: false,
      start: vi.fn(async () => {}),
      enumerate: vi.fn(async () => [
        {
          // nth === 0 models the stale AVFoundation view: hardware identity is
          // present, but there is no openable path yet.
          path: nth === 0 ? "" : "/dev/real",
          name: "OBSBOT Tiny 2",
          locationId: 7,
          vid: 0x3564,
          pid: 0xfef8,
        },
      ]),
      open: vi.fn(async (p: string) => {
        if (!p) throw new Error("open: missing path");
        return 1;
      }),
      xuSet: vi.fn(async (_s: number, d: Buffer) => { lastSeq = d.readUInt16LE(2); }),
      xuGet: vi.fn(async () =>
        buildFrame({ seq: lastSeq, cmd: 0x18c8, receiver: 0x0a, sender: 0x0d,
                     payload: Buffer.from(serial, "ascii") })),
      close: vi.fn(async () => {}),
    };
    spawned.push(self);
    return self as unknown as HelperProcess;
  };
  return Object.assign(factory, { spawned });
}

test("a candidate enumerated without a path is rejected with a reason, not silently retried", async () => {
  const factory = poisonedFirstHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await expect(mgr.get()).rejects.toThrow(/path/i);
});

test("a failed bind discards the scan helper so the next attempt starts fresh", async () => {
  // This is what makes replug recovery actually converge: retrying on the same
  // poisoned helper can never succeed.
  const factory = poisonedFirstHelperFactory("AAA");
  const mgr = new DeviceManager(factory);

  await expect(mgr.get()).rejects.toThrow();   // poisoned helper #0
  const t = await mgr.get();                   // must use a NEW helper
  expect(await t.readSerial()).toBe("AAA");
  expect(factory.spawned.length).toBeGreaterThan(1);
});

test("discarding a poisoned scan helper closes it rather than leaking the process", async () => {
  const factory = poisonedFirstHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await expect(mgr.get()).rejects.toThrow();
  await mgr.get().catch(() => {});
  expect((factory.spawned[0] as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
});

// Spawn churn on the failure path is an ACCEPTED tradeoff, not an oversight.
//
// The scan helper is discarded after every failed bind, including when the bus
// looks empty, so a retry loop against an absent camera forks one helper per
// attempt (measured: 16 in 15s on hardware). Narrowing this to "only when a
// candidate was rejected" was implemented and reverted: in the hardware run
// that recovered, every retry reported an EMPTY bus with no rejected
// candidate, and recovery worked only because each attempt got a fresh
// process. A stale helper can under-report the bus as empty, so "empty" is not
// evidence it is healthy. This test pins the behaviour so the tempting
// optimisation is not silently reintroduced.
test("every failed bind discards the scan helper, even when the bus looks empty", async () => {
  const factory = fakeHelperFactory([]);   // nothing attached
  let spawns = 0;
  const counting = async () => { spawns++; return factory(); };
  const mgr = new DeviceManager(counting);

  await expect(mgr.get()).rejects.toThrow(/no OBSBOT camera found$/);
  await expect(mgr.get()).rejects.toThrow();
  expect(spawns).toBe(2); // a fresh process per attempt -- deliberate
});

test("a rejected candidate DOES discard the scan helper", async () => {
  const factory = poisonedFirstHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await expect(mgr.get()).rejects.toThrow();
  expect((factory.spawned[0] as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
//  Reacting to pushed camera events.
//
//  Today the manager only learns the camera changed by an op FAILING, which is
//  why obsbot_devices reports a phantom `bound` entry with a serial for a camera
//  sitting unplugged on the desk until something else fails first. With the
//  helper running a run loop it can push arrival/removal, so the manager can
//  react before anyone calls a tool.
//
//  Arrival deliberately re-binds ONLY a camera this process already held. A
//  server that never bound anything stays hands-off, because the Tiny 2 is a
//  device Zoom / OBS / OBSBOT Center also want and grabbing it unasked would
//  make it busy for them.
// ---------------------------------------------------------------------------

test("a departure event drops the binding without waiting for a call to fail", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(true);

  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(false);
});

test("a departure closes the helper rather than leaking it", async () => {
  // Same reason pruneDeadEntries closes: a helper left running keeps holding the
  // device, so the replacement can never open it.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  const stale = factory.spawned[0]! as unknown as { close: ReturnType<typeof vi.fn> };

  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(stale.close).toHaveBeenCalled();
});

test("a departure for a path we never bound leaves the binding alone", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();

  await mgr.handleCameraDeparted({ path: "/dev/someone-elses", name: "Other Cam" });

  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(true);
});

test("an arrival re-binds a camera this process previously held", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();                                     // everBound now has AAA
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(false);

  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(true);
});

test("an arrival does NOT bind a camera this process never held", async () => {
  // Never grab a camera unasked.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);

  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(factory.spawned).toHaveLength(0);             // arrival opened nothing
  // The camera is attached, so listCameras() rightly offers it as `available`.
  // The property under test is that WE did not take it.
  const cams = await mgr.listCameras();
  expect(cams.some((c) => c.status === "bound")).toBe(false);
});

test("an arrival while already bound does not rebind or spawn another helper", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  const spawnedBefore = factory.spawned.length;

  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(factory.spawned.length).toBe(spawnedBefore);
});

test("a failed re-bind on arrival is swallowed, not thrown at the event source", async () => {
  // The caller is a stdout line handler; an unhandled rejection there would take
  // down the reader and wedge every in-flight request.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  factory.failNextBind = true;

  await expect(
    mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" }),
  ).resolves.toBeUndefined();
});

test("duplicate departure events are idempotent", async () => {
  // Observed on hardware: EVERY live helper has its own run loop and observers,
  // so a single unplug produced one event per helper (registry + scan). Rather
  // than dedupe, the handlers are required to be safely repeatable.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();

  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(false);
});

test("duplicate arrival events do not stack up bindings or helpers", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory);
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  const before = factory.spawned.length;

  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  const afterFirst = factory.spawned.length;
  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(factory.spawned.length).toBe(afterFirst);   // later arrivals are no-ops
  expect(afterFirst).toBeGreaterThan(before);        // the first one did re-bind
  const bound = (await mgr.listCameras()).filter((c) => c.status === "bound");
  expect(bound).toHaveLength(1);
});

// ---------------------------------------------------------------------------
//  Retrying the arrival re-bind.
//
//  Hardware, 2026-07-21: for many seconds after a USB re-enumeration the Tiny 2's
//  vendor mailbox is intermittently not-ready — 22 of 80 readSerial attempts
//  failed across the first 14s after a replug, against 0 of 120 in steady state.
//  A single bind attempt on arrival is therefore a coin flip, and losing it was
//  silent: the camera stayed unbound until the user's next tool call.
//
//  The retry is bounded and gives up: arrival is a hint, and a camera that never
//  answers must not spawn helpers forever.
// ---------------------------------------------------------------------------

test("an arrival re-bind that loses the first attempt succeeds on a retry", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0, 0] });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  factory.failBinds = 1;   // the mute-mailbox attempt, then the device answers

  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(true);
});

test("the arrival re-bind gives up instead of retrying forever", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0, 0] });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  const spawnedBefore = factory.spawned.length;

  factory.failNextBind = true;                       // never answers
  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  // Counted before listCameras(), which spawns a scan helper of its own and
  // would otherwise be charged to the ladder.
  const laddersSpawns = factory.spawned.length - spawnedBefore;
  expect((await mgr.listCameras()).some((c) => c.status === "bound")).toBe(false);
  // One spawn per attempt (a failed bind discards the scratch helper), bounded
  // by the ladder — not an unbounded fork loop.
  expect(laddersSpawns).toBe(3);
});

test("the arrival re-bind stops early once something else binds the camera", async () => {
  // A tool call racing the ladder wins; the ladder must not bind a second time
  // on top of it.
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0, 0] });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  factory.failNextBind = true;
  const ladder = mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  factory.failNextBind = false;
  await mgr.get();                                   // the tool call binds first
  const spawnedAfterBind = factory.spawned.length;
  await ladder;

  expect(factory.spawned.length).toBe(spawnedAfterBind); // ladder spawned nothing more
});

test("a second arrival while a ladder is running does not start another", async () => {
  const factory = yankableHelperFactory("AAA");
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0, 0] });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  const spawnedBefore = factory.spawned.length;

  factory.failNextBind = true;
  const first = mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  const second = mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });
  await Promise.all([first, second]);

  // Two concurrent ladders would double the spawns and race two binds into
  // promote(), which asserts on the scratch helper being present.
  expect(factory.spawned.length - spawnedBefore).toBeLessThanOrEqual(3);
});

// ---------------------------------------------------------------------------
//  Reporting the arrival re-bind.
//
//  The ladder was silent, so a fired ladder and a clean first attempt looked
//  identical from outside the process — which is why the retry could not be
//  observed on hardware even once it existed. Failures and retried successes
//  are reported; the happy path stays quiet.
//
//  stderr, never stdout: stdout is the JSON-RPC channel.
// ---------------------------------------------------------------------------

test("a failed arrival re-bind attempt is reported with its reason", async () => {
  const factory = yankableHelperFactory("AAA");
  const log: string[] = [];
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0], log: (m) => log.push(m) });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  factory.failBinds = 1;
  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(log.some((m) => /no OBSBOT camera found/.test(m))).toBe(true);
});

test("a re-bind that needed a retry says which attempt won", async () => {
  // The line that makes the ladder observable on hardware.
  const factory = yankableHelperFactory("AAA");
  const log: string[] = [];
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0], log: (m) => log.push(m) });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  factory.failBinds = 1;
  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(log.some((m) => /attempt 2/.test(m))).toBe(true);
});

test("a re-bind that works first time logs nothing", async () => {
  // No noise on the happy path — every replug would otherwise print.
  const factory = yankableHelperFactory("AAA");
  const log: string[] = [];
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0], log: (m) => log.push(m) });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(log).toEqual([]);
});

test("giving up is reported, so a camera that never came back is not silent", async () => {
  const factory = yankableHelperFactory("AAA");
  const log: string[] = [];
  const mgr = new DeviceManager(factory, { arrivalBackoffMs: [0, 0], log: (m) => log.push(m) });
  await mgr.get();
  await mgr.handleCameraDeparted({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  factory.failNextBind = true;
  await mgr.handleCameraArrived({ path: "/dev/yank", name: "OBSBOT Tiny 2" });

  expect(log.some((m) => /gave up/i.test(m))).toBe(true);
});
