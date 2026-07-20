import { expect, test, vi } from "vitest";
import { DeviceSession } from "../../src/device/session.js";
import type { DeviceManager } from "../../src/device/manager.js";
import type { ObsbotTransport } from "../../src/transport/transport.js";

function fakeMgr() {
  const openFirstObsbot = vi.fn(async () => ({}) as ObsbotTransport);
  const invalidate = vi.fn(async () => {});
  return {
    mgr: { openFirstObsbot, invalidate } as unknown as DeviceManager,
    openFirstObsbot,
    invalidate,
  };
}

test("get() opens the device once and caches the transport", async () => {
  const { mgr, openFirstObsbot } = fakeMgr();
  const s = new DeviceSession(mgr);
  await s.get();
  await s.get();
  expect(openFirstObsbot).toHaveBeenCalledTimes(1);
});

test("the first open is not a reconnect", async () => {
  const { mgr } = fakeMgr();
  const s = new DeviceSession(mgr);
  await s.get();
  expect(s.takeReconnected()).toBe(false);
});

test("invalidate() drops the cache so the next get() re-opens", async () => {
  const { mgr, openFirstObsbot } = fakeMgr();
  const s = new DeviceSession(mgr);
  await s.get();
  await s.invalidate();
  await s.get();
  expect(openFirstObsbot).toHaveBeenCalledTimes(2);
});

test("invalidate() calls through to the manager's invalidate() so the dead registry entry is dropped too", async () => {
  const { mgr, invalidate } = fakeMgr();
  const s = new DeviceSession(mgr);
  await s.get();
  await s.invalidate();
  expect(invalidate).toHaveBeenCalledTimes(1);
});

test("a re-open after invalidate flags reconnected exactly once", async () => {
  const { mgr } = fakeMgr();
  const s = new DeviceSession(mgr);
  await s.get();
  await s.invalidate();
  await s.get();
  expect(s.takeReconnected()).toBe(true);
  expect(s.takeReconnected()).toBe(false); // cleared after being taken
});
