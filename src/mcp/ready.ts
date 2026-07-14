import { decodeStatus } from "../codec/commands.js";
import { encodeSetRunStatus } from "../codec/commands.js";
import { ObsbotTransport } from "../transport/transport.js";
import { DeviceSession } from "../device/session.js";

export type ReadyResult =
  | { ok: true; transport: ObsbotTransport; reconnected: boolean }
  | { ok: false; reason: "unreachable" | "wake-timeout"; error: string };

export interface ReadyOpts {
  pollMs?: number;
  wakeTimeoutMs?: number;
  settleMs?: number;
}

const DEFAULTS: Required<ReadyOpts> = { pollMs: 200, wakeTimeoutMs: 2500, settleMs: 300 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const readAwake = async (t: ObsbotTransport): Promise<boolean> =>
  decodeStatus(await t.recvStatus()).awake;

/**
 * Gate a gimbal/AI command on device readiness. A single status read is a 3-way
 * probe: it throws when the device is unreachable, and otherwise reports awake.
 *
 *  - unreachable  → invalidate + one re-open (if a session is given); still
 *                   unreachable → { ok:false, reason:"unreachable" }.
 *  - asleep       → send wake, poll `awake` up to wakeTimeoutMs, settle; never
 *                   wakes → { ok:false, reason:"wake-timeout" }.
 *  - awake        → { ok:true, transport, reconnected }.
 *
 * The command is only sent by the caller after ok:true — a gate failure never
 * touches the gimbal. Without a session, self-heal is skipped but awake-gating
 * still applies.
 */
export async function ensureReady(
  getTransport: () => Promise<ObsbotTransport>,
  session?: DeviceSession,
  opts: ReadyOpts = {},
): Promise<ReadyResult> {
  const { pollMs, wakeTimeoutMs, settleMs } = { ...DEFAULTS, ...opts };

  let t: ObsbotTransport;
  try {
    t = await getTransport();
  } catch (e) {
    return { ok: false, reason: "unreachable", error: `camera not found: ${msg(e)}` };
  }

  let awake: boolean;
  try {
    awake = await readAwake(t);
  } catch (e) {
    // Probe failed — device likely unplugged. Self-heal once if we have a session.
    if (!session) {
      return { ok: false, reason: "unreachable", error: `camera not reachable: ${msg(e)}` };
    }
    session.invalidate();
    try {
      t = await getTransport();
      awake = await readAwake(t);
    } catch (e2) {
      return { ok: false, reason: "unreachable", error: `camera not reachable: ${msg(e2)}` };
    }
  }

  if (!awake) {
    await t.sendVendor(encodeSetRunStatus("run").buildFrame(t.nextSeq()));
    let waited = 0;
    while (waited < wakeTimeoutMs) {
      await sleep(pollMs);
      waited += pollMs;
      try {
        if (await readAwake(t)) {
          awake = true;
          break;
        }
      } catch {
        // transient read during wake — keep polling until the deadline
      }
    }
    if (!awake) {
      return { ok: false, reason: "wake-timeout", error: "camera did not wake within timeout" };
    }
    await sleep(settleMs); // let the gimbal finish rising before we drive it
  }

  return { ok: true, transport: t, reconnected: session?.takeReconnected() ?? false };
}
