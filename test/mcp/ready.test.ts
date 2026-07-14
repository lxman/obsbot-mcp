import { expect, test, vi } from "vitest";
import { ensureReady } from "../../src/mcp/ready.js";
import type { ObsbotTransport } from "../../src/transport/transport.js";
import { DeviceSession } from "../../src/device/session.js";
import type { DeviceManager } from "../../src/device/manager.js";

const awakeBlock = () => Buffer.alloc(60); // byte 0x02 = 0 → awake
const asleepBlock = () => {
  const b = Buffer.alloc(60);
  b[0x02] = 1;
  return b;
};

function fakeTransport(over: Partial<ObsbotTransport> = {}): ObsbotTransport {
  return {
    sendVendor: vi.fn(async () => {}),
    recvVendor: vi.fn(async () => Buffer.alloc(60)),
    recvStatus: vi.fn(async () => awakeBlock()),
    xuRaw: vi.fn(async () => {}),
    xuGetRaw: vi.fn(async () => Buffer.alloc(60)),
    zoomRange: vi.fn(async () => ({ min: 0, max: 100 })),
    zoomSet: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ mime: "", width: 0, height: 0, base64: "" })),
    camCtrlSet: vi.fn(async () => {}),
    camCtrlRange: vi.fn(async () => ({ min: 0, max: 0 })),
    procAmpSet: vi.fn(async () => {}),
    procAmpRange: vi.fn(async () => ({ min: 0, max: 0 })),
    nextSeq: vi.fn(() => 1),
    close: vi.fn(async () => {}),
    ...over,
  } satisfies ObsbotTransport;
}

const fast = { pollMs: 1, wakeTimeoutMs: 10, settleMs: 1 };

test("awake → ok, transport returned, no wake sent", async () => {
  const t = fakeTransport();
  const r = await ensureReady(async () => t, undefined, fast);
  expect(r).toMatchObject({ ok: true, reconnected: false });
  expect(t.sendVendor).not.toHaveBeenCalled();
});

test("asleep then wakes → ok, one wake sent", async () => {
  let n = 0;
  const t = fakeTransport({
    recvStatus: vi.fn(async () => (n++ === 0 ? asleepBlock() : awakeBlock())),
  });
  const r = await ensureReady(async () => t, undefined, fast);
  expect(r.ok).toBe(true);
  expect(t.sendVendor).toHaveBeenCalledTimes(1);
});

test("asleep and never wakes → wake-timeout", async () => {
  const t = fakeTransport({ recvStatus: vi.fn(async () => asleepBlock()) });
  const r = await ensureReady(async () => t, undefined, fast);
  expect(r).toMatchObject({ ok: false, reason: "wake-timeout" });
});

test("recvStatus throws with no session → unreachable", async () => {
  const t = fakeTransport({
    recvStatus: vi.fn(async () => {
      throw new Error("KsProperty GET failed");
    }),
  });
  const r = await ensureReady(async () => t, undefined, fast);
  expect(r).toMatchObject({ ok: false, reason: "unreachable" });
});

test("recvStatus throws then a session re-opens to a live device → ok + reconnected", async () => {
  const dead = fakeTransport({
    recvStatus: vi.fn(async () => {
      throw new Error("device gone");
    }),
  });
  const live = fakeTransport();
  const opens = [dead, live];
  const openFirstObsbot = vi.fn(async () => opens.shift()!);
  const session = new DeviceSession({ openFirstObsbot } as unknown as DeviceManager);
  const r = await ensureReady(() => session.get(), session, fast);
  expect(r).toMatchObject({ ok: true, reconnected: true });
  expect(openFirstObsbot).toHaveBeenCalledTimes(2);
});

test("getTransport throws (no device) → unreachable", async () => {
  const r = await ensureReady(
    async () => {
      throw new Error("no OBSBOT Tiny 2 found");
    },
    undefined,
    fast,
  );
  expect(r).toMatchObject({ ok: false, reason: "unreachable" });
});
