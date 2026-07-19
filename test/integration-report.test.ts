import { expect, test } from "vitest";
import { coverage, buildReport, renderMarkdown } from "../scripts/integration/report.mjs";
import { TIERS } from "../scripts/integration/harness.mjs";

const checks = [
  { id: "a.1", tool: "obsbot_get_status", profile: "quick", tier: TIERS.VERIFIED },
  { id: "b.1", tool: "obsbot_fov", profile: "quick", tier: TIERS.ACCEPTED },
];
const allTools = ["obsbot_get_status", "obsbot_fov", "obsbot_snapshot"];

test("coverage reports which tools have no check at all", () => {
  // 'every feature we are aware of' must be readable off the artifact rather
  // than trusted, so an untested tool has to surface as an explicit hole.
  const out = coverage(checks, allTools);
  expect(out.covered).toEqual(["obsbot_fov", "obsbot_get_status"]);
  expect(out.holes).toEqual(["obsbot_snapshot"]);
});

test("buildReport surfaces downgrades as their own list", () => {
  const results = [
    {
      id: "a.1", tool: "obsbot_get_status", tier: TIERS.ACCEPTED, downgraded: true,
      reason: "no independent evidence returned", status: "pass",
      measurements: [], durationMs: 5, error: null,
    },
    {
      id: "b.1", tool: "obsbot_fov", tier: TIERS.ACCEPTED, downgraded: false,
      reason: "", status: "pass", measurements: [], durationMs: 3, error: null,
    },
  ];
  const report = buildReport({
    results, checks, toolNames: allTools, profile: "quick",
    startedAt: "2026-07-19T00:00:00.000Z",
  });
  expect(report.summary).toMatchObject({ total: 2, pass: 2, fail: 0, skip: 0 });
  expect(report.downgrades).toHaveLength(1);
  expect(report.downgrades[0].id).toBe("a.1");
  expect(report.coverage.holes).toEqual(["obsbot_snapshot"]);
});

test("buildReport counts failures so a caller can set a non-zero exit code", () => {
  const results = [
    {
      id: "a.1", tool: "obsbot_get_status", tier: TIERS.ACCEPTED, downgraded: false,
      reason: "", status: "fail", measurements: [], durationMs: 5, error: "boom",
    },
  ];
  const report = buildReport({
    results, checks, toolNames: allTools, profile: "quick", startedAt: "x",
  });
  expect(report.summary.fail).toBe(1);
});

test("renderMarkdown includes the downgrade list and the coverage holes", () => {
  const report = buildReport({
    results: [
      {
        id: "a.1", tool: "obsbot_get_status", tier: TIERS.ACCEPTED, downgraded: true,
        reason: "no independent evidence returned", status: "pass",
        measurements: [], durationMs: 5, error: null,
      },
    ],
    checks, toolNames: allTools, profile: "quick",
    startedAt: "2026-07-19T00:00:00.000Z",
  });
  const md = renderMarkdown(report);
  expect(md).toContain("Downgraded");
  expect(md).toContain("a.1");
  expect(md).toContain("obsbot_snapshot");
});
