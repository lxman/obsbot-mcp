import { expect, test, vi } from "vitest";
import { buildFrame } from "../../src/codec/frame.js";
import { DeviceManager } from "../../src/device/manager.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

// ---------------------------------------------------------------------------
//  A bound camera whose helper has died must re-bind on the NEXT call.
//
//  Field incident 2026-07-21 (second half). After the transport learned to fail
//  fast, killing the helper stopped hanging the server -- but obsbot_status then
//  returned the same error forever. Only the 11 tools that route through
//  ensureReady() call invalidate(); the ~19 ungated call sites resolve straight
//  through DeviceManager.get(), which returned the cached registry entry without
//  ever checking whether its helper was still alive. Recovery therefore required
//  the caller to invoke a DIFFERENT tool -- a hidden incantation.
//
//  That is unacceptable here specifically because the caller is an LLM, and not
//  necessarily a strong one. A weak model facing a repeating error will retry the
//  same tool or tell the human the camera is broken -- which is false, and sends
//  someone to power-cycle working hardware. Recovery must not depend on the
//  caller guessing which other tool to run.
//
//  Fixing it in get() rather than per-handler covers every ungated call site at
//  once, costs a boolean check (no round trip), and cannot auto-wake the camera
//  the way routing reads through the readiness gate would.
// ---------------------------------------------------------------------------

interface Spec {
  serial: string;
  locationId?: number;
}

/** Fake helper factory whose spawned helpers can be marked dead, as a real one is. */
function factory(cameras: Spec[]) {
  const pathFor = (s: string) => `/dev/fake-${s}`;
  const spawned: Array<HelperProcess & { isDead: boolean }> = [];

  const make = async (): Promise<HelperProcess> => {
    let openedSerial: string | undefined;
    let lastSeq = 0;
    const helper = {
      isDead: false, // real HelperProcess exposes this as a getter off `dead`
      start: vi.fn(async () => {}),
      enumerate: vi.fn(async () =>
        cameras.map((c) => ({
          path: pathFor(c.serial),
          name: "OBSBOT Tiny 2",
          locationId: c.locationId,
          vid: 0x3564,
          pid: 0xfef8,
        })),
      ),
      open: vi.fn(async (path: string) => {
        const cam = cameras.find((c) => pathFor(c.serial) === path);
        if (!cam) throw new Error(`fake-helper: no such device ${path}`);
        openedSerial = cam.serial;
        return 1;
      }),
      xuSet: vi.fn(async (_sel: number, data: Buffer) => {
        lastSeq = data.readUInt16LE(2);
      }),
      xuGet: vi.fn(async () =>
        buildFrame({
          seq: lastSeq,
          cmd: 0x18c8,
          receiver: 0x0a,
          sender: 0x0d,
          payload: Buffer.from(openedSerial ?? "", "ascii"),
        }),
      ),
      close: vi.fn(async () => {}),
    } as unknown as HelperProcess & { isDead: boolean };
    spawned.push(helper);
    return helper;
  };

  return { make, spawned };
}

test("get() re-binds when the bound camera's helper has died", async () => {
  const { make, spawned } = factory([{ serial: "AAA" }]);
  const mgr = new DeviceManager(make);

  const first = await mgr.get();
  expect(first).toBeDefined();
  const spawnsAfterBind = spawned.length;

  // The helper dies (crash, or killed to swap its binary).
  spawned.forEach((h) => (h.isDead = true));

  // Before the fix this returned the cached transport built on the dead helper,
  // so every later call failed identically, forever.
  const second = await mgr.get();
  expect(second).toBeDefined();
  expect(spawned.length).toBeGreaterThan(spawnsAfterBind); // a fresh helper was spawned
  expect(spawned[spawned.length - 1]!.isDead).toBe(false);
});

test("re-binding after a helper death is reported as a reconnect", async () => {
  const { make, spawned } = factory([{ serial: "AAA" }]);
  const mgr = new DeviceManager(make);

  await mgr.get();
  mgr.takeReconnected(); // drain the initial bind
  spawned.forEach((h) => (h.isDead = true));

  await mgr.get();
  // The caller must still learn a reset happened -- silent recovery would hide a
  // flapping cable behind seamless retries.
  expect(mgr.takeReconnected()).toBe(true);
});

test("get(serial) re-binds that camera when its helper has died", async () => {
  const { make, spawned } = factory([{ serial: "AAA" }, { serial: "BBB", locationId: 2 }]);
  const mgr = new DeviceManager(make);

  await mgr.get("BBB");
  const before = spawned.length;
  spawned.forEach((h) => (h.isDead = true));

  await mgr.get("BBB");
  expect(spawned.length).toBeGreaterThan(before);
});

test("a LIVE bound camera is not re-bound (no spawn churn on the hot path)", async () => {
  const { make, spawned } = factory([{ serial: "AAA" }]);
  const mgr = new DeviceManager(make);

  await mgr.get();
  const after = spawned.length;
  for (let i = 0; i < 5; i++) await mgr.get();
  // "Once bound, stay bound" must survive the liveness check: a dead-helper guard
  // that re-scanned every call would spawn a helper per tool call.
  expect(spawned.length).toBe(after);
});
