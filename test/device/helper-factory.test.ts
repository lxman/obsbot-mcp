import { expect, test, vi } from "vitest";
import { helperFactory } from "../../src/device/helper-factory.js";
import type { DeviceManager } from "../../src/device/manager.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

// ---------------------------------------------------------------------------
//  The wiring between "the helper saw the bus change" and "the manager acts on
//  it". helper-events.test.ts proves the transport emits these events;
//  manager.test.ts proves the handlers do the right thing when called. Neither
//  proves anything CONNECTS them — and that connection is the entire feature.
//  Deleted, every other test still passes and the server silently goes back to
//  learning about an unplug by failing a call.
// ---------------------------------------------------------------------------

type CameraEvent = { path: string; name: string };

/** A helper that records its subscriptions and can fire them on demand. */
function fakeHelper() {
  const arrived: Array<(e: CameraEvent) => void> = [];
  const departed: Array<(e: CameraEvent) => void> = [];
  const self = {
    /** How many listeners existed at the moment start() was called. */
    subscribedAtStart: -1,
    onCameraArrived: (fn: (e: CameraEvent) => void) => arrived.push(fn),
    onCameraDeparted: (fn: (e: CameraEvent) => void) => departed.push(fn),
    start: vi.fn(async () => {
      self.subscribedAtStart = arrived.length + departed.length;
    }),
    emitArrived: (e: CameraEvent) => arrived.forEach((fn) => fn(e)),
    emitDeparted: (e: CameraEvent) => departed.forEach((fn) => fn(e)),
  };
  return self;
}

/** A manager stub recording what the listeners forwarded to it. */
function fakeManager(overrides: Partial<Record<"arrive" | "depart", () => Promise<void>>> = {}) {
  const mgr = {
    handleCameraArrived: vi.fn(overrides.arrive ?? (async () => {})),
    handleCameraDeparted: vi.fn(overrides.depart ?? (async () => {})),
  };
  return mgr;
}

const settle = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const factoryFor = (
  mgr: ReturnType<typeof fakeManager>,
  make: () => ReturnType<typeof fakeHelper>,
) => helperFactory(() => mgr as unknown as DeviceManager, make as unknown as () => HelperProcess);

test("an arrival on a spawned helper reaches handleCameraArrived", async () => {
  const mgr = fakeManager();
  const helper = fakeHelper();
  await factoryFor(mgr, () => helper)();

  helper.emitArrived({ path: "/dev/cam", name: "OBSBOT Tiny 2" });

  expect(mgr.handleCameraArrived).toHaveBeenCalledWith({
    path: "/dev/cam",
    name: "OBSBOT Tiny 2",
  });
});

test("a departure on a spawned helper reaches handleCameraDeparted", async () => {
  const mgr = fakeManager();
  const helper = fakeHelper();
  await factoryFor(mgr, () => helper)();

  helper.emitDeparted({ path: "/dev/cam", name: "OBSBOT Tiny 2" });

  expect(mgr.handleCameraDeparted).toHaveBeenCalledWith({
    path: "/dev/cam",
    name: "OBSBOT Tiny 2",
  });
});

test("the factory returns the helper it started", async () => {
  const mgr = fakeManager();
  const helper = fakeHelper();

  const made = await factoryFor(mgr, () => helper)();

  expect(made).toBe(helper as unknown as HelperProcess);
  expect(helper.start).toHaveBeenCalled();
});

test("listeners are attached BEFORE the helper starts", async () => {
  // Subscribing after start() opens a window where a camera plugged in during
  // spawn is never reported — the helper emits into nothing and the arrival is
  // simply lost, which reads exactly like the feature not working.
  const mgr = fakeManager();
  const helper = fakeHelper();

  await factoryFor(mgr, () => helper)();

  expect(helper.subscribedAtStart).toBe(2);
});

test("every helper the factory makes is subscribed, not just the first", async () => {
  // There is no single long-lived helper: the scratch scanner is promoted into
  // the registry on bind and the next scan spawns another. Whichever process
  // happens to be alive when the cable moves has to be the one that reports it.
  const mgr = fakeManager();
  const helpers = [fakeHelper(), fakeHelper(), fakeHelper()];
  let n = 0;
  const factory = factoryFor(mgr, () => helpers[n++]!);

  for (let i = 0; i < helpers.length; i++) await factory();
  helpers[2]!.emitDeparted({ path: "/dev/third", name: "OBSBOT Tiny 2" });

  expect(mgr.handleCameraDeparted).toHaveBeenCalledWith({
    path: "/dev/third",
    name: "OBSBOT Tiny 2",
  });
});

test("the manager is resolved at event time, not at factory-build time", async () => {
  // The manager is constructed WITH this factory, so it does not exist yet when
  // the factory is built. A thunk that were called eagerly would capture
  // undefined and every event would throw.
  const mgr = fakeManager();
  let built: ReturnType<typeof fakeManager> | undefined;
  const helper = fakeHelper();
  const factory = helperFactory(
    () => built as unknown as DeviceManager,
    (() => helper) as unknown as () => HelperProcess,
  );

  await factory();          // helper spawned while the manager is still undefined
  built = mgr;              // ... manager exists only now
  helper.emitArrived({ path: "/dev/late", name: "OBSBOT Tiny 2" });

  expect(mgr.handleCameraArrived).toHaveBeenCalled();
});

test("a rejecting handler does not become an unhandled rejection", async () => {
  // The caller is a stdout line handler inside the transport. An unhandled
  // rejection there takes down the process — losing every in-flight request
  // because a cable moved.
  const mgr = fakeManager({
    arrive: async () => {
      throw new Error("re-bind blew up");
    },
  });
  const helper = fakeHelper();
  await factoryFor(mgr, () => helper)();

  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown): void => {
    unhandled.push(r);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    expect(() => helper.emitArrived({ path: "/dev/cam", name: "OBSBOT Tiny 2" })).not.toThrow();
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  expect(unhandled).toEqual([]);
});
