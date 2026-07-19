// Check registry, tier arbitration and timing for the hardware integration test.
// Pure logic — no device access — so it is unit-tested in test/integration-harness.test.ts.

export const TIERS = Object.freeze({
  VERIFIED: "VERIFIED",
  ACCEPTED: "ACCEPTED",
  SKIPPED: "SKIPPED",
  MANUAL: "MANUAL",
});

const DEFAULT_TIMEOUT_MS = 15000;

export const measurement = (name, value, unit) => ({ name, value, unit });

const hasEvidence = (e) =>
  e != null && (Array.isArray(e) ? e.length > 0 : Object.keys(e).length > 0);

/**
 * Award a tier from what the check actually produced.
 *
 * A check declares the tier it INTENDS. VERIFIED is awarded only when the check
 * returns non-empty evidence from a channel independent of the command under
 * test; otherwise it is downgraded to ACCEPTED with the reason recorded. This is
 * the safeguard that stops "the command did not error" reading as "the feature
 * works" — the conflation behind several wrong conclusions during the 2026-07-19
 * hardware session.
 */
export function arbitrateTier({ declared, evidence, skipped }) {
  if (skipped) return { tier: TIERS.SKIPPED, downgraded: false, reason: skipped };
  if (declared === TIERS.MANUAL) return { tier: TIERS.MANUAL, downgraded: false, reason: "" };
  if (declared === TIERS.VERIFIED && !hasEvidence(evidence)) {
    return {
      tier: TIERS.ACCEPTED,
      downgraded: true,
      reason:
        "no independent evidence returned; command was accepted but its effect is unconfirmed",
    };
  }
  return { tier: declared, downgraded: false, reason: "" };
}

export function defineCheck(spec) {
  for (const field of ["id", "tool", "profile", "tier", "run"]) {
    if (!spec[field]) {
      throw new Error(`check ${spec.id ?? "<anonymous>"} is missing required field: ${field}`);
    }
  }
  if (!Object.values(TIERS).includes(spec.tier)) {
    throw new Error(`check ${spec.id} has unknown tier: ${spec.tier}`);
  }
  if (!["quick", "deep"].includes(spec.profile)) {
    throw new Error(`check ${spec.id} has unknown profile: ${spec.profile}`);
  }
  return Object.freeze({ timeoutMs: DEFAULT_TIMEOUT_MS, reason: "", ...spec });
}

const withTimeout = (promise, ms, id) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms in check ${id}`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

export async function runCheck(check, ctx) {
  const base = {
    id: check.id,
    tool: check.tool,
    profile: check.profile,
    declared: check.tier,
  };

  // MANUAL checks exist to keep a known gap visible in the report. Running them
  // is impossible by definition, so record and move on.
  if (check.tier === TIERS.MANUAL) {
    return {
      ...base,
      tier: TIERS.MANUAL,
      downgraded: false,
      reason: check.reason,
      status: "skip",
      measurements: [],
      durationMs: 0,
      error: null,
    };
  }

  const started = Date.now();
  try {
    const out =
      (await withTimeout(Promise.resolve(check.run(ctx)), check.timeoutMs, check.id)) ?? {};
    const { tier, downgraded, reason } = arbitrateTier({
      declared: check.tier,
      evidence: out.evidence,
      skipped: out.skip,
    });
    return {
      ...base,
      tier,
      downgraded,
      reason,
      status: out.skip ? "skip" : "pass",
      measurements: out.measurements ?? [],
      durationMs: Date.now() - started,
      error: null,
    };
  } catch (e) {
    return {
      ...base,
      tier: TIERS.ACCEPTED,
      downgraded: false,
      reason: "",
      status: "fail",
      measurements: [],
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
