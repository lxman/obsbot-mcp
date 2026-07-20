import { encodeVendorGet, decodeSerial } from "../codec/commands.js";
import { parseFrame } from "../codec/frame.js";

// Protocol constant (not platform-specific) — the vendor SET_CUR request and
// the reply mailbox both live on XU selector 2. Kept local to this module
// rather than imported from a transport file so this stays a standalone unit;
// each platform transport separately defines the same constant for its own
// sendVendor/recvVendor use.
const VENDOR_XU_SELECTOR = 0x02;

const UG_GET_SN_CMD = 0x18c8;
const REPLY_LEN = 60;
const POLL_ATTEMPTS = 8;
// The device does not populate the reply mailbox instantly — the framed reply
// lands tens of ms after the request. Polling with NO delay drains all 8
// attempts in ~7ms, before the reply arrives, and reads only the stale previous
// frame → spurious "no reply". A short delay before each read gives the reply
// time to land. Hardware-verified 2026-07-20: 0ms delay fails every rapid read;
// 30ms is reliable. (Unit tests use a synchronous fake helper and never exercise
// this latency, which is why the bug shipped past them.)
const POLL_DELAY_MS = 30;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The transport primitives readSerial needs. MacosTransport, LinuxTransport,
 * and WindowsTransport already implement all three as public methods, so
 * each of them satisfies this structurally with no extra glue beyond
 * `readSerial() { return readSerialVia(this); }`.
 */
export interface VendorReadPrimitives {
  xuRaw(selector: number, data: Buffer): Promise<void>;
  xuGetRaw(selector: number, length: number): Promise<Buffer>;
  nextSeq(): number;
}

/**
 * Send a header-only UG_GET_SN GET frame on the vendor XU selector and poll
 * the selector-2 reply mailbox until a valid, matching reply appears.
 *
 * The mailbox retains the PREVIOUS reply until the new one lands (reply
 * latency varies), so a single unvalidated read can return stale data. A
 * reply is trusted only once it: parses cleanly (magic + header CRC +
 * payload CRC via parseFrame), has cmd === UG_GET_SN's wire cmd, and echoes
 * the seq this call just sent. Throws if no such reply shows up within
 * POLL_ATTEMPTS reads.
 *
 * Shared by all three platform transports so this polling/validation logic
 * exists exactly once instead of three near-identical copies.
 */
export async function readSerialVia(t: VendorReadPrimitives): Promise<string> {
  const seq = t.nextSeq();
  const req = encodeVendorGet("UG_GET_SN").buildFrame(seq);
  await t.xuRaw(VENDOR_XU_SELECTOR, req);

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_DELAY_MS); // let the reply land before reading the mailbox
    const raw = await t.xuGetRaw(VENDOR_XU_SELECTOR, REPLY_LEN);
    try {
      const f = parseFrame(raw);
      if (f.cmd === UG_GET_SN_CMD && f.seq === seq && f.payload.length > 0) {
        return decodeSerial(f.payload);
      }
    } catch {
      // Not our reply yet (stale mailbox, still in flight, or garbage) —
      // keep polling.
    }
  }
  throw new Error("readSerial: no valid UG_GET_SN reply");
}
