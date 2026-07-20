import { expect, test, vi } from "vitest";
import {
  TIERS,
  defineCheck,
  arbitrateTier,
  runCheck,
  measurement,
} from "../scripts/integration/harness.mjs";

test("a check that returns evidence is awarded VERIFIED", () => {
  const out = arbitrateTier({ declared: TIERS.VERIFIED, evidence: { yaw: 30 } });
  expect(out).toMatchObject({ tier: TIERS.VERIFIED, downgraded: false });
});

test("a check intending VERIFIED with no evidence is DOWNGRADED to ACCEPTED", () => {
  // The core safeguard: "the command did not error" must never present itself
  // as "the feature works".
  const out = arbitrateTier({ declared: TIERS.VERIFIED, evidence: undefined });
  expect(out.tier).toBe(TIERS.ACCEPTED);
  expect(out.downgraded).toBe(true);
  expect(out.reason).toMatch(/no independent evidence/i);
});

test("an empty evidence object does not count as evidence", () => {
  const out = arbitrateTier({ declared: TIERS.VERIFIED, evidence: {} });
  expect(out.tier).toBe(TIERS.ACCEPTED);
  expect(out.downgraded).toBe(true);
});

test("a skipped check reports SKIPPED with its reason, not a downgrade", () => {
  const out = arbitrateTier({ declared: TIERS.VERIFIED, skipped: "ffmpeg absent" });
  expect(out).toMatchObject({ tier: TIERS.SKIPPED, downgraded: false, reason: "ffmpeg absent" });
});

test("a check declaring ACCEPTED stays ACCEPTED and is not marked downgraded", () => {
  const out = arbitrateTier({ declared: TIERS.ACCEPTED, evidence: undefined });
  expect(out).toMatchObject({ tier: TIERS.ACCEPTED, downgraded: false });
});

test("defineCheck rejects a declaration missing its tool link", () => {
  // The tool field IS the coverage manifest; a check without it creates a
  // silent hole in coverage reporting.
  expect(() =>
    defineCheck({ id: "x.y", profile: "quick", tier: TIERS.ACCEPTED, run: async () => ({}) }),
  ).toThrow(/tool/);
});

test("runCheck records duration and measurements and marks pass", async () => {
  const check = defineCheck({
    id: "demo.ok",
    tool: "obsbot_status",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async () => ({
      evidence: { awake: true },
      measurements: [measurement("latency", 12, "ms")],
    }),
  });
  const result = await runCheck(check, {});
  expect(result).toMatchObject({ id: "demo.ok", status: "pass", tier: TIERS.VERIFIED });
  expect(result.measurements[0]).toEqual({ name: "latency", value: 12, unit: "ms" });
  expect(typeof result.durationMs).toBe("number");
});

test("runCheck turns a thrown error into a fail without propagating", async () => {
  const check = defineCheck({
    id: "demo.boom",
    tool: "obsbot_status",
    profile: "quick",
    tier: TIERS.ACCEPTED,
    run: async () => {
      throw new Error("camera unplugged");
    },
  });
  const result = await runCheck(check, {});
  expect(result.status).toBe("fail");
  expect(result.error).toContain("camera unplugged");
});

test("runCheck enforces its own timeout so one hung call cannot stall the run", async () => {
  const check = defineCheck({
    id: "demo.hang",
    tool: "obsbot_status",
    profile: "quick",
    tier: TIERS.ACCEPTED,
    timeoutMs: 20,
    run: () => new Promise(() => {}),
  });
  const result = await runCheck(check, {});
  expect(result.status).toBe("fail");
  expect(result.error).toMatch(/timeout/i);
});

test("a MANUAL check is reported without being run", async () => {
  const body = vi.fn();
  const check = defineCheck({
    id: "demo.manual",
    tool: "obsbot_wake",
    profile: "quick",
    tier: TIERS.MANUAL,
    reason: "requires a cable pull",
    run: body,
  });
  const result = await runCheck(check, {});
  expect(result.tier).toBe(TIERS.MANUAL);
  expect(result.status).toBe("skip");
  expect(body).not.toHaveBeenCalled();
});
