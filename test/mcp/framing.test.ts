import { test, expect, vi } from "vitest";
import { verifyFraming } from "../../src/mcp/framing.js";
import type { AiModeStatus } from "../../src/codec/commands.js";

// A scripted reader that yields the given aiMode sequence, then repeats the last.
function scriptedReader(seq: AiModeStatus[]) {
  let i = 0;
  return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]);
}

const noSleep = vi.fn(async (_ms: number) => {});

// verifyFraming(readAiMode, want, before, opts): after the write, wait until the
// framing settles to a value different from `before` (it "changed"), or lands on
// `want`, or the window expires — skipping the m=6 transient ('unknown') and the
// race where the first read still shows the pre-write framing.

test("verifyFraming matches as soon as it lands on want, without sleeping", async () => {
  const read = scriptedReader(["upper-body"]);
  const sleep = vi.fn(async (_ms: number) => {});
  const result = await verifyFraming(read, "upper-body", "close-up", { attempts: 5, intervalMs: 10, sleep });
  expect(result).toEqual({ verified: "upper-body", matched: true });
  expect(read).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("verifyFraming does not exit while status still shows the pre-write framing (race guard)", async () => {
  // The first reads still show `before` (the write has not taken effect yet), then
  // the transient, then the target. It must keep polling through the stale reads.
  const read = scriptedReader(["close-up", "close-up", "unknown", "upper-body"]);
  const result = await verifyFraming(read, "upper-body", "close-up", { attempts: 8, sleep: noSleep });
  expect(result).toEqual({ verified: "upper-body", matched: true });
  expect(read).toHaveBeenCalledTimes(4);
});

test("verifyFraming polls past the m=6 transient ('unknown') until it settles", async () => {
  const read = scriptedReader(["unknown", "unknown", "upper-body"]);
  const result = await verifyFraming(read, "upper-body", "close-up", { attempts: 8, sleep: noSleep });
  expect(result).toEqual({ verified: "upper-body", matched: true });
  expect(read).toHaveBeenCalledTimes(3);
});

test("verifyFraming exits early when it settles to a framing other than requested", async () => {
  // No subject: after the transient it settles to no-tracking, not the requested
  // framing. It has 'changed' from `before`, so we stop immediately — no 6s block.
  const read = scriptedReader(["unknown", "no-tracking"]);
  const result = await verifyFraming(read, "upper-body", "close-up", { attempts: 30, sleep: noSleep });
  expect(result).toEqual({ verified: "no-tracking", matched: false });
  expect(read).toHaveBeenCalledTimes(2);
});

test("verifyFraming times out (matched:false) if it never leaves the transient", async () => {
  const read = scriptedReader(["unknown"]);
  const result = await verifyFraming(read, "upper-body", "close-up", { attempts: 3, sleep: noSleep });
  expect(result).toEqual({ verified: "unknown", matched: false });
  expect(read).toHaveBeenCalledTimes(3);
});

test("verifyFraming default window tolerates a long m=6 transient before settling", async () => {
  // Field bug 2026-07-13: an awake->awake framing switch parked at m=6 ('unknown')
  // longer than the original 12-attempt window, so verify reported a false
  // matched:false even though the device settled to the requested framing a moment
  // later. Here a stale pre-write read plus 20 transient reads precede the settle.
  const seq = ["close-up", ...Array(20).fill("unknown"), "upper-body"] as AiModeStatus[];
  const result = await verifyFraming(scriptedReader(seq), "upper-body", "close-up", { sleep: noSleep });
  expect(result).toEqual({ verified: "upper-body", matched: true });
});
