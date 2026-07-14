import type { AiModeStatus } from "../codec/commands.js";

export interface VerifyFramingOpts {
  /** How many status reads to attempt before giving up. */
  attempts?: number;
  /** Delay between reads, ms. */
  intervalMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

// Default window: 30 × 200 ms = 6 s ceiling. The m=6 mid-switch transient is
// variable — an awake->awake framing switch was observed parking there for ~3-4 s
// (a 2.4 s window produced flaky false-negative matched:false in the field), so we
// budget generous headroom. Success early-exits the moment aiMode == want, so a
// normal landing still returns in ~1-4 s; only a framing that never lands (no
// subject tracked) pays the full ceiling.
const DEFAULT_ATTEMPTS = 30;
const DEFAULT_INTERVAL_MS = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the AI framing to settle after a write, then report where it landed:
 * "wait until it changes, or the window (~6 s) expires".
 *
 * Switching framing briefly parks the status tuple at m=6 (which decodes to
 * "unknown") before settling to (m=2, n=framing). There is also a race where the
 * first read after the write still shows the pre-write framing (`before`), because
 * the device has not applied the change yet. So we poll and:
 *   - return matched:true the moment aiMode equals `want`;
 *   - return matched:false as soon as it settles to a *different, stable* framing
 *     (aiMode is neither the "unknown" transient nor still `before`) — e.g. no
 *     subject in frame so it lands on "no-tracking"; polling longer won't help;
 *   - otherwise keep polling (still transient, or still showing the old value)
 *     until the window expires, then report matched:false with the last read.
 *
 * Best-effort by design: the write already succeeded; this only reports where the
 * device actually settled.
 */
export async function verifyFraming(
  readAiMode: () => Promise<AiModeStatus>,
  want: AiModeStatus,
  before: AiModeStatus,
  opts: VerifyFramingOpts = {},
): Promise<{ verified: AiModeStatus; matched: boolean }> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let last: AiModeStatus = before;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    const aiMode = await readAiMode();
    last = aiMode;
    if (aiMode === want) return { verified: aiMode, matched: true };
    if (aiMode !== "unknown" && aiMode !== before) return { verified: aiMode, matched: false };
  }
  return { verified: last, matched: false };
}
