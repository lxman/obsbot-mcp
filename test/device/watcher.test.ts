import { expect, test, vi } from "vitest";
import { buildFrame } from "../../src/codec/frame.js";
import { DeviceManager } from "../../src/device/manager.js";
import { helperFactory } from "../../src/device/helper-factory.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

// ---------------------------------------------------------------------------
//  Bus events are delivered PER PROCESS, and this fake models the two rules
//  that decide which processes actually receive them. Both are measured on
//  hardware (darwin-arm64, Tiny 2 RMOWAHG3293TTL, 2026-07-21, same-port replug),
//  not assumed:
//
//  1. A CLOSED helper receives nothing. Obvious, but load-bearing: after a
//     departure closes the registry helper, the process that would have heard
//     the arrival is gone.
//
//  2. A helper that has never enumerated WHILE THE CAMERA WAS PRESENT receives
//     nothing. Three helpers were driven through one unplug/replug: the two
//     that had called `enumerate` got both events; the one that never did got
//     NEITHER, while staying alive the whole run and answering a later
//     `enumerate` correctly.
//
//  Rule 2 is why a "listen-only" watcher that never scans is deaf on BOTH
//  platforms — for two unrelated reasons:
//
//    macOS   — AVFoundation. Registering the observers (helper.m:1220) does not
//              start device-change delivery; touching the device list does.
//              Presence at prime time is IRRELEVANT here: an arm primed during
//              an absence still received the arrival, same millisecond as one
//              primed while present.
//    Windows — helper.cpp:1021 drops any event whose path is missing from
//              `g_knownPaths`, which only `enumerate` fills (helper.cpp:410),
//              per-process. Presence at prime time IS load-bearing: an
//              enumerate during an absence cannot cache the camera's path.
//
//  This fake models the stricter (Windows) rule, because the code ships on both.
//
//  A fake that instead hands the event to a helper the TEST picked cannot see
//  any of this — eligibility stops being something the implementation earns.
//  That is why the Windows-side patch passed three green tests while being deaf.
// ---------------------------------------------------------------------------

interface CameraEvent {
  path: string;
  name: string;
}

const SERIAL = "AAA";
const PATH = `/dev/fake-${SERIAL}`;
const NAME = "OBSBOT Tiny 2";

/**
 * `primeNeedsPresence` selects which platform's rule this bus enforces:
 *   true  (default) — Windows. Only an enumerate that SEES the camera primes,
 *                     because g_knownPaths caches paths, not the act of scanning.
 *   false           — macOS. Any enumerate primes; measured, an arm primed
 *                     during an absence still received the arrival.
 * Tests default to the stricter rule; the macOS rule is selected explicitly
 * where the behaviour under test is one only macOS can deliver.
 */
function fakeBus({ primeNeedsPresence = true }: { primeNeedsPresence?: boolean } = {}) {
  let present = true;
  /** Spawn index whose `enumerate` fails; -1 = none. */
  let breakEnumerateAt = -1;
  const heldBy = new Map<string, object>();
  const spawned: Array<{
    /** Has enumerated at least once WHILE THE CAMERA WAS PRESENT — see rule 2. */
    primed: boolean;
    closed: boolean;
    dead: boolean;
    emit: (kind: "arrived" | "departed", e: CameraEvent) => void;
  }> = [];

  const make = (): HelperProcess => {
    const identity = {};
    const arrived: Array<(e: CameraEvent) => void> = [];
    const departed: Array<(e: CameraEvent) => void> = [];
    let openedPath: string | undefined;
    let lastSeq = 0;

    const record = {
      primed: false,
      closed: false,
      dead: false,
      emit: (kind: "arrived" | "departed", e: CameraEvent): void => {
        for (const fn of kind === "arrived" ? arrived : departed) fn(e);
      },
    };
    const index = spawned.push(record) - 1;

    const helper = {
      start: vi.fn(async () => {}),
      onCameraArrived: (fn: (e: CameraEvent) => void) => arrived.push(fn),
      onCameraDeparted: (fn: (e: CameraEvent) => void) => departed.push(fn),
      get isDead() {
        return record.dead;
      },
      enumerate: vi.fn(async () => {
        if (record.dead) throw new Error("helper is dead");
        if (index === breakEnumerateAt) throw new Error("enumerate: helper blew up");
        // See rule 2 — whether an absent-camera scan counts is platform-specific.
        if (present || !primeNeedsPresence) record.primed = true;
        return present ? [{ path: PATH, name: NAME, vid: 0x3564, pid: 0xfef8, locationId: 1 }] : [];
      }),
      open: vi.fn(async (path: string) => {
        if (!present || path !== PATH) throw new Error(`fake-helper: no such device ${path}`);
        const holder = heldBy.get(path);
        if (holder && holder !== identity) {
          throw new Error("open failed: kIOReturnExclusiveAccess (0xe00002c5)");
        }
        if (openedPath) heldBy.delete(openedPath);
        heldBy.set(path, identity);
        openedPath = path;
        return 1;
      }),
      xuSet: vi.fn(async (_selector: number, data: Buffer) => {
        lastSeq = data.readUInt16LE(2);
      }),
      xuGet: vi.fn(async () =>
        buildFrame({
          seq: lastSeq,
          cmd: 0x18c8,
          receiver: 0x0a,
          sender: 0x0d,
          payload: Buffer.from(SERIAL, "ascii"),
        }),
      ),
      close: vi.fn(async () => {
        record.closed = true;
        if (openedPath && heldBy.get(openedPath) === identity) heldBy.delete(openedPath);
      }),
    } as unknown as HelperProcess;

    return helper;
  };

  /** Deliver as the OS does: to every process still listening, and no other. */
  const deliver = (kind: "arrived" | "departed"): void => {
    for (const h of spawned) {
      if (h.closed || h.dead || !h.primed) continue;
      h.emit(kind, { path: PATH, name: NAME });
    }
  };

  return {
    make,
    spawned,
    /** Simulate the process dying, as a crashed or killed helper would. */
    kill: (i: number): void => {
      spawned[i]!.dead = true;
    },
    /** Make exactly the helper at spawn index `n` fail its enumerate. */
    breakEnumerateAt: (n: number): void => {
      breakEnumerateAt = n;
    },
    unplug: (): void => {
      present = false;
      heldBy.clear();
      deliver("departed");
    },
    replug: (): void => {
      present = true;
      deliver("arrived");
    },
  };
}

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wire a manager exactly as startServer() does: through the real helperFactory. */
function managerOn(bus: ReturnType<typeof fakeBus>): DeviceManager {
  let mgr: DeviceManager;
  const factory = helperFactory(
    () => mgr,
    bus.make as unknown as () => HelperProcess,
  );
  mgr = new DeviceManager(factory, { arrivalBackoffMs: [0], log: () => {} });
  return mgr;
}

// ---------------------------------------------------------------------------

test("a replug re-binds the camera without a tool call", async () => {
  // The bound steady state is exactly ONE live helper: promote() hands the
  // scratch helper to the registry and clears `scanHelper` (manager.ts:380).
  // handleCameraDeparted() then closes that one (manager.ts:520) — so unless
  // something else is listening, the arrival is delivered to nobody and the
  // camera stays unbound until the user's next call fails.
  const bus = fakeBus();
  const mgr = managerOn(bus);

  await mgr.get(); // binds AAA
  bus.unplug();
  await settle();
  bus.replug();
  await settle();

  expect(await mgr.listCameras()).toEqual([
    expect.objectContaining({ serial: SERIAL, status: "bound" }),
  ]);
});

test("a watcher replaced while the camera is away is re-primed by the next bind", async () => {
  // The hole in "prime once, at creation". If the watcher process dies and its
  // replacement is spawned during an ABSENCE, that replacement never sees the
  // camera's path — and on Windows it is then permanently deaf, because
  // ensureWatcher() early-returns on a watcher that is alive but useless. One
  // unlucky death and proactive arrival is off for the life of the process.
  //
  // Priming on EVERY call closes it: the next successful bind happens with the
  // camera present by definition, so it re-primes and the watcher recovers.
  //
  // macOS does not need this — measured across two full replug cycles, a single
  // prime at startup kept delivering (arrived=2 departed=2, identical to an arm
  // that re-primed after every departure). It is here for the Windows path,
  // which is now hardware-confirmed on that platform: watcher SIGKILLed while
  // bound, cable out, replacement born during the absence, cable back in — no
  // arrival was ever seen and the camera read `available`, never `bound`. The
  // identical run on macOS recovers proactively. This test therefore encodes a
  // real Windows failure, not a hypothetical one.
  const bus = fakeBus();
  const mgr = managerOn(bus);

  await mgr.get(); // binds; watcher spawned and primed while present
  bus.kill(1); // the watcher process dies
  bus.unplug();
  await settle();

  // A tool call while the camera is away: fails, and replaces the dead watcher
  // with one that cannot see the camera and so cannot be primed by this scan.
  await expect(mgr.get()).rejects.toThrow(/no OBSBOT camera found/);
  bus.replug();
  await settle();

  // Nothing heard that arrival, so the user calls a tool and binds by hand. That
  // bind must leave a WORKING watcher behind, not the deaf one.
  await mgr.get();
  bus.unplug();
  await settle();
  bus.replug();
  await settle();

  expect(await mgr.listCameras()).toEqual([
    expect.objectContaining({ serial: SERIAL, status: "bound" }),
  ]);
});

test("a watcher that cannot be primed does not fail the bind that succeeded", async () => {
  // ensureWatcher() runs AFTER promote(), so a throw here escapes bind() with
  // the camera already in the registry: the caller sees an exception while
  // listCameras() reports it bound. The watcher is an optimisation — losing it
  // costs one extra call after a replug, which is where we were anyway.
  const bus = fakeBus();
  const mgr = managerOn(bus);

  bus.breakEnumerateAt(1); // [0] is the scanner and must still work; [1] is the watcher

  const t = await mgr.get();
  expect(await t.readSerial()).toBe(SERIAL);
  expect(await mgr.listCameras()).toEqual([
    expect.objectContaining({ serial: SERIAL, status: "bound" }),
  ]);
});

test("a watcher that dies while bound is replaced by the departure itself (macOS)", async () => {
  // A watcher can die at any time, and nothing notices until the next bind —
  // by which point the replug it existed for has already been missed.
  //
  // The departure is still heard, though: the registry helper is alive and
  // primed right up until handleCameraDeparted() closes it. Replacing the
  // watcher from there recovers the arrival that follows.
  //
  // macOS ONLY, and the fake says so. The replacement is necessarily spawned
  // with the camera absent, which primes it on macOS (measured) but not on
  // Windows (g_knownPaths cannot learn a path that is not there). On Windows
  // this same sequence falls back to the next tool call, and the re-prime in
  // ensureWatcher() repairs the watcher at that point — covered above.
  const bus = fakeBus({ primeNeedsPresence: false });
  const mgr = managerOn(bus);

  await mgr.get();
  bus.kill(1); // watcher dies, unnoticed, while the camera is still bound

  bus.unplug();
  await settle();
  bus.replug();
  await settle();

  expect(await mgr.listCameras()).toEqual([
    expect.objectContaining({ serial: SERIAL, status: "bound" }),
  ]);
});

test("a failed bind restores a watcher when the departure was never heard (macOS)", async () => {
  // The departure call site only fires if SOMETHING was alive to receive the
  // departure. If the watcher had already died and no camera was bound, the
  // unplug is heard by nobody at all, and the failing tool call is the only
  // remaining signal that anything changed.
  //
  // discardScanHelper() then closes the last process in existence. Replacing the
  // listener right after it — not the scanner, which must stay unconditionally
  // fresh — is what keeps the following replug recoverable without a second
  // failed call.
  const bus = fakeBus({ primeNeedsPresence: false });
  const mgr = managerOn(bus);

  await mgr.get();
  await mgr.invalidate(); // closes the registry helper; only the watcher is left
  bus.kill(1); // ... and now it dies too

  bus.unplug(); // delivered to nobody: nothing is alive to hear it
  await settle();

  await expect(mgr.get()).rejects.toThrow(/no OBSBOT camera found/);

  bus.replug();
  await settle();

  expect(await mgr.listCameras()).toEqual([
    expect.objectContaining({ serial: SERIAL, status: "bound" }),
  ]);
});

test("shutdown() closes every helper the manager holds, watcher included", async () => {
  // The watcher is the first helper designed to outlive every operation, so it
  // is the first one whose lifetime is not bounded by something else. Until now
  // helpers relied on process exit to clean up (they terminate on stdin EOF),
  // which is fine for a crash but leaves nothing to call for an orderly stop.
  const bus = fakeBus();
  const mgr = managerOn(bus);

  await mgr.get(); // [0] promoted into the registry, [1] the watcher
  await mgr.listCameras(); // [2] a scratch scanner

  await mgr.shutdown();

  expect(bus.spawned.map((h) => h.closed)).toEqual([true, true, true]);
});
