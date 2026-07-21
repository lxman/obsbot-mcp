import { expect, test } from "vitest";
import { readSerialVia } from "../../src/transport/read-serial.js";
import { buildFrame } from "../../src/codec/frame.js";

// ---------------------------------------------------------------------------
//  What the mailbox actually held when readSerial gives up.
//
//  "no valid UG_GET_SN reply" is true but useless: it cannot tell an echo-only
//  mailbox from garbage from a stale frame for someone else's request, and
//  those are different faults. That gap is why the 3.2s vendor-path outage of
//  2026-07-21 was never explained — the one datum that would have identified
//  it (the mailbox holding our own request with the magic byte zeroed) was
//  read eight times and thrown away eight times.
//
//  Reproduced since on demand: after a DIFFERENT-port replug the mailbox stays
//  mute through the whole poll, then answers ~420ms later.
// ---------------------------------------------------------------------------

const SERIAL = "RMOWAHG3293TTL";
const UG_GET_SN_CMD = 0x18c8;

/** Drives readSerialVia with a scripted mailbox. */
function fake(mailbox: (req: Buffer, seq: number, read: number) => Buffer) {
  let req = Buffer.alloc(60);
  let seq = 0;
  let reads = 0;
  return {
    xuRaw: async (_sel: number, data: Buffer): Promise<void> => {
      req = Buffer.from(data);
    },
    xuGetRaw: async (): Promise<Buffer> => mailbox(req, seq, reads++),
    nextSeq: (): number => ++seq,
  };
}

const validReply = (seq: number, serial = SERIAL): Buffer =>
  buildFrame({ seq, cmd: UG_GET_SN_CMD, receiver: 0x0a, sender: 0x0d,
               payload: Buffer.from(serial, "ascii") });

test("a valid reply still returns the serial", async () => {
  const serial = await readSerialVia(fake((_req, seq) => validReply(seq)));
  expect(serial).toBe(SERIAL);
});

test("a reply that lands on a later poll is still accepted", async () => {
  // Regression guard: diagnosis must not short-circuit the polling loop.
  const serial = await readSerialVia(
    fake((_req, seq, read) => (read < 3 ? Buffer.alloc(60) : validReply(seq))),
  );
  expect(serial).toBe(SERIAL);
});

test("the echo-only mailbox is named in the error", async () => {
  // The signature from the 2026-07-21 outage: our own request handed back with
  // the magic byte zeroed. Naming it is the whole point — it is the difference
  // between "unexplained" and "that one again".
  const err = await readSerialVia(
    fake((req) => {
      const echo = Buffer.from(req);
      echo[0] = 0x00;
      return echo;
    }),
  ).catch((e: Error) => e);

  expect((err as Error).message).toMatch(/echo/i);
});

test("an unparseable mailbox reports why it would not parse, and its first bytes", async () => {
  const err = await readSerialVia(
    fake(() => Buffer.from([0xde, 0xad, 0xbe, 0xef, ...Array(56).fill(0)])),
  ).catch((e: Error) => e);

  const msg = (err as Error).message;
  expect(msg).toMatch(/magic/i);   // parseFrame's own reason, not swallowed
  expect(msg).toContain("dead");   // the bytes actually seen
});

test("a well-formed reply to somebody else's request reports the cmd and seq seen", async () => {
  // Distinguishes "device is mute" from "device is answering, just not us" —
  // a stale mailbox retains the PREVIOUS reply, and that is not a fault.
  const err = await readSerialVia(
    fake(() =>
      buildFrame({ seq: 999, cmd: 0x1234, receiver: 0x0a, sender: 0x0d,
                   payload: Buffer.from("xx", "ascii") }),
    ),
  ).catch((e: Error) => e);

  const msg = (err as Error).message;
  expect(msg).toContain("0x1234");
  expect(msg).toContain("999");
});

test("a frozen mailbox is distinguished from a changing one", async () => {
  // Frozen = the device never wrote anything back. Changing = it is writing,
  // and the problem is which frames. Different faults, different next steps.
  const frozen = await readSerialVia(fake(() => Buffer.alloc(60))).catch((e: Error) => e);
  expect((frozen as Error).message).toMatch(/unchanged|identical|frozen/i);

  const changing = await readSerialVia(
    fake((_req, _seq, read) => {
      const b = Buffer.alloc(60);
      b[0] = read; // different every poll
      return b;
    }),
  ).catch((e: Error) => e);
  expect((changing as Error).message).not.toMatch(/unchanged|identical|frozen/i);
});

test("the error stays short enough to survive being nested in a bind error", async () => {
  // bind() concatenates one of these per rejected candidate; a 60-byte hex dump
  // per poll would bury the message that matters.
  const err = await readSerialVia(fake(() => Buffer.alloc(60))).catch((e: Error) => e);
  expect((err as Error).message.length).toBeLessThan(240);
});
