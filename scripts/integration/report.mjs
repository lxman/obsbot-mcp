// Report construction for the hardware integration test. Pure data in, pure
// data out — unit-tested in test/integration-report.test.ts.

import { TIERS } from "./harness.mjs";

export function coverage(checks, toolNames) {
  const covered = [...new Set(checks.map((c) => c.tool))].sort();
  const holes = toolNames.filter((t) => !covered.includes(t)).sort();
  return { covered, holes };
}

export function buildReport({ results, checks, toolNames, profile, startedAt }) {
  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
    verified: results.filter((r) => r.tier === TIERS.VERIFIED).length,
  };
  return {
    startedAt,
    profile,
    platform: process.platform,
    summary,
    coverage: coverage(checks, toolNames),
    // The most valuable page in the report: a standing inventory of what this
    // project cannot currently prove.
    downgrades: results
      .filter((r) => r.downgraded)
      .map((r) => ({ id: r.id, tool: r.tool, reason: r.reason })),
    results,
  };
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Integration report — ${report.profile} — ${report.startedAt}`);
  lines.push("");
  lines.push(`Platform: \`${report.platform}\``);
  lines.push("");
  const s = report.summary;
  lines.push(
    `**${s.pass} passed, ${s.fail} failed, ${s.skip} skipped — ${s.verified} VERIFIED of ${s.total}**`,
  );
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Check | Tool | Tier | Status | Duration | Measurements |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of report.results) {
    const m = r.measurements.map((x) => `${x.name}=${x.value}${x.unit}`).join(", ") || "—";
    lines.push(
      `| \`${r.id}\` | \`${r.tool}\` | ${r.tier} | ${r.status}${r.error ? `: ${r.error}` : ""} | ${r.durationMs}ms | ${m} |`,
    );
  }
  lines.push("");
  lines.push("## Downgraded — intended VERIFIED, not achieved");
  lines.push("");
  if (report.downgrades.length === 0) {
    lines.push("_None._");
  } else {
    for (const d of report.downgrades) lines.push(`- \`${d.id}\` (\`${d.tool}\`) — ${d.reason}`);
  }
  lines.push("");
  lines.push("## Coverage holes — tools with no check");
  lines.push("");
  lines.push(
    report.coverage.holes.length === 0
      ? "_None._"
      : report.coverage.holes.map((h) => `- \`${h}\``).join("\n"),
  );
  lines.push("");
  return lines.join("\n");
}
