import { test, expect, vi } from "vitest";
import { verifyFraming } from "../../src/mcp/framing.js";
import { decodeStatus } from "../../src/codec/commands.js";

// ---------------------------------------------------------------------------
//  SEAM test: decodeStatus -> verifyFraming
//
//  Why this file exists (regression 2026-07-18 .. 2026-07-21).
//
//  verifyFraming() does not consume raw bytes; it consumes the AiModeStatus that
//  decodeStatus() produces. Its whole settle contract rests on ONE assumption
//  about that seam: the mid-switch transient the device parks at must decode to
//  "unknown", because "unknown" is what verifyFraming reads as "not settled yet".
//  Any tuple that decodes to a real framing instead is treated as a landing and
//  ends the poll.
//
//  That assumption was broken by a one-line change on the OTHER side of the seam:
//  AI_MODE_TABLE gained `"6,0": "hand"` as a defensive mapping from the Tiny4Linux
//  reference. On this firmware m=6 IS the transient (hand is m=3), so every framing
//  switch could early-exit with a false-negative `verified:"hand", matched:false`
//  on a write that had actually succeeded.
//
//  Both existing suites stayed green through all of it, because neither crossed
//  the seam: test/codec/commands.test.ts asserted the tuple->label mapping and
//  test/mcp/framing.test.ts hand-fed the literal string "unknown" as the transient.
//  Each half was self-consistent; only the join was wrong.
//
//  So these tests deliberately start from BYTES, not labels.
// ---------------------------------------------------------------------------

const noSleep = vi.fn(async (_ms: number) => {});

/** A 60-byte status block carrying the AI-mode tuple at (0x18, 0x1c). */
function blockWithTuple(m: number, n: number): Buffer {
  const b = Buffer.alloc(60);
  b[0x18] = m;
  b[0x1c] = n;
  return b;
}

/** Reads real status blocks through the real decoder, exactly as the tool does. */
function blockReader(blocks: Buffer[]) {
  let i = 0;
  return vi.fn(async () => decodeStatus(blocks[Math.min(i++, blocks.length - 1)]).aiMode);
}

const NORMAL = blockWithTuple(2, 0);
const UPPER_BODY = blockWithTuple(2, 1);
const TRANSIENT = blockWithTuple(6, 0); // the m=6 mid-switch transient
const NO_TRACKING = blockWithTuple(0, 0);

// The regression, reproduced at the seam. Hardware (2026-07-21, XU sel 6 @ 60 ms)
// showed exactly this block sequence across a normal->upper-body switch:
//   m=2,n=0 (before) -> m=6,n=0 (~200 ms transient) -> m=2,n=1 (landed).
// With `"6,0": "hand"` in the table this returned {verified:"hand", matched:false}.
test("a raw m=6 transient block does not end the poll (the regression)", async () => {
  const read = blockReader([NORMAL, TRANSIENT, UPPER_BODY]);
  const result = await verifyFraming(read, "upper-body", "normal", { attempts: 8, sleep: noSleep });
  expect(result).toEqual({ verified: "upper-body", matched: true });
  expect(read).toHaveBeenCalledTimes(3);
});

// Guards the assumption directly, so a future re-add of `"6,0"` (or any new tuple
// mapped onto the transient) fails here with a message that names the cause.
test("the m=6 tuple decodes to the 'not settled yet' sentinel verifyFraming expects", () => {
  expect(decodeStatus(TRANSIENT).aiMode).toBe("unknown");
});

// A transient that outlives several polls still must not be mistaken for a landing.
test("a sustained m=6 transient is polled through, not reported as a framing", async () => {
  const read = blockReader([NORMAL, ...Array(12).fill(TRANSIENT), UPPER_BODY]);
  const result = await verifyFraming(read, "upper-body", "normal", { attempts: 30, sleep: noSleep });
  expect(result).toEqual({ verified: "upper-body", matched: true });
});

// The counterpart: a genuinely different framing must still end the poll promptly.
// Without this, "never exit early" would pass the tests above and hang for the full
// ~6 s window on the real no-subject case.
test("a real settled framing from raw bytes still ends the poll (matched:false)", async () => {
  const read = blockReader([NORMAL, TRANSIENT, NO_TRACKING]);
  const result = await verifyFraming(read, "upper-body", "normal", { attempts: 30, sleep: noSleep });
  expect(result).toEqual({ verified: "no-tracking", matched: false });
  expect(read).toHaveBeenCalledTimes(3);
});

// Hand is m=3 on this firmware and is a REAL framing — it must remain a landing,
// so the fix cannot be "treat hand as transient".
test("hand (m=3) is a real landing, not a transient", async () => {
  const read = blockReader([NORMAL, blockWithTuple(3, 0)]);
  const result = await verifyFraming(read, "hand", "normal", { attempts: 8, sleep: noSleep });
  expect(result).toEqual({ verified: "hand", matched: true });
});
