#!/usr/bin/env node
// Supervised hardware integration test for obsbot-mcp.
//
// SAFETY: this MOVES THE PHYSICAL GIMBAL. Run it only under human supervision
// with a clear line of sight to the camera. Slews are capped at +/-90 yaw and
// +/-30 pitch, and the camera is always left asleep via try/finally.
//
// IT DELETES ALL PRESETS. Slots are create-once with no device-side history, so
// nothing is recoverable. This is a test camera by explicit decision.
//
// Usage:
//   node scripts/integration/run.mjs                 quick profile (default)
//   node scripts/integration/run.mjs --deep          adds the provoked-race probes
//   node scripts/integration/run.mjs --json <path>   override the report path
//
// Requires `npm run build` first: the compiled dist/ output is the system
// under test.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCheck } from "./harness.mjs";
import { buildReport, renderMarkdown } from "./report.mjs";
import { HelperProcess } from "../../dist/transport/helper-process.js";
import { DeviceManager } from "../../dist/device/manager.js";
import { createTools } from "../../dist/mcp/tools.js";

import { deviceChecks } from "./checks/device.mjs";
import { gimbalChecks } from "./checks/gimbal.mjs";
import { zoomChecks } from "./checks/zoom.mjs";
import { aiChecks } from "./checks/ai.mjs";
import { imagingChecks } from "./checks/imaging.mjs";
import { presetChecks } from "./checks/presets.mjs";
import { captureChecks } from "./checks/capture.mjs";
import { transitionChecks } from "./checks/transitions.mjs";

const ALL_TOOLS = [
  "obsbot_list_devices", "obsbot_set_run_status", "obsbot_ptz_move_angle",
  "obsbot_ptz_move_speed", "obsbot_gimbal_recenter", "obsbot_zoom_absolute",
  "obsbot_ai_tracking", "obsbot_ai_track_speed", "obsbot_zoom_speed",
  "obsbot_face_focus", "obsbot_get_status", "obsbot_probe", "obsbot_fov",
  "obsbot_hdr", "obsbot_focus", "obsbot_gimbal_position", "obsbot_preset_list",
  "obsbot_preset_save", "obsbot_preset_recall", "obsbot_preset_update",
  "obsbot_preset_rename", "obsbot_preset_delete", "obsbot_white_balance",
  "obsbot_image_control", "obsbot_exposure", "obsbot_snapshot",
  "obsbot_record_start", "obsbot_preview_start", "obsbot_capture_stop",
  "obsbot_capture_list",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const deep = process.argv.includes("--deep");
  const profile = deep ? "deep" : "quick";
  const jsonFlag = process.argv.indexOf("--json");
  const startedAt = new Date().toISOString();

  const helper = new HelperProcess(process.env.OBSBOT_HELPER_CMD?.split(" "));
  await helper.start();

  // Hoisted so the finally block can reuse the SAME open transport. Opening a
  // second one during teardown risks failing exactly when the run has already
  // gone wrong, which is when leaving the camera asleep matters most.
  let byName = null;

  try {
    const mgr = new DeviceManager(helper);
    const transport = await mgr.openFirstObsbot();
    const tools = createTools(async () => transport, mgr);
    byName = new Map(tools.map((t) => [t.name, t]));

    const call = async (name, args = {}) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`no such tool: ${name}`);
      return tool.handler(args);
    };

    const ctx = {
      call,
      sleep,
      log: (m) => console.log(`   ${m}`),
      deep,
      pos: async () => call("obsbot_gimbal_position"),
      status: async () => call("obsbot_get_status"),
      // Collect `count` samples spaced `everyMs` apart — the primitive behind the
      // mid-flight probes. A single sample of a system in motion describes one
      // instant, not the state the next call lands in.
      samples: async (fn, { count = 5, everyMs = 200 } = {}) => {
        const out = [];
        for (let i = 0; i < count; i++) {
          out.push(await fn());
          await sleep(everyMs);
        }
        return out;
      },
      until: async (fn, { timeoutMs = 8000, everyMs = 250 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const v = await fn();
          if (v) return v;
          if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
          await sleep(everyMs);
        }
      },
    };

    const checks = [
      ...deviceChecks, ...gimbalChecks, ...zoomChecks, ...aiChecks,
      ...imagingChecks, ...presetChecks, ...captureChecks, ...transitionChecks,
    ].filter((c) => c.profile === "quick" || deep);

    const results = [];
    for (const check of checks) {
      console.log(`→ ${check.id}`);
      const r = await runCheck(check, ctx);
      console.log(`   ${r.tier} / ${r.status}${r.error ? ` — ${r.error}` : ""}`);
      results.push(r);
    }

    const report = buildReport({ results, checks, toolNames: ALL_TOOLS, profile, startedAt });
    const outPath =
      jsonFlag !== -1
        ? process.argv[jsonFlag + 1]
        : path.join("artifacts", `integration-${startedAt.replace(/[:.]/g, "-")}.json`);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    await writeFile(outPath.replace(/\.json$/, ".md"), renderMarkdown(report), "utf8");

    console.log(`\n${renderMarkdown(report)}`);
    console.log(`report: ${outPath}`);
    process.exitCode = report.summary.fail > 0 ? 1 : 0;
  } finally {
    // Always leave the camera asleep, including on error or abort.
    try {
      await byName?.get("obsbot_set_run_status")?.handler({ state: "sleep" });
    } catch {
      /* teardown is best-effort; never mask the original failure */
    }
    await helper.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
