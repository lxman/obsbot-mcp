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
import { CaptureManager } from "../../dist/capture/manager.js";

import { deviceChecks } from "./checks/device.mjs";
import { gimbalChecks } from "./checks/gimbal.mjs";
import { zoomChecks } from "./checks/zoom.mjs";
import { aiChecks } from "./checks/ai.mjs";
import { imagingChecks } from "./checks/imaging.mjs";
import { presetChecks } from "./checks/presets.mjs";
import { captureChecks } from "./checks/capture.mjs";
import { transitionChecks } from "./checks/transitions.mjs";

const ALL_TOOLS = [
  "obsbot_devices", "obsbot_wake", "obsbot_sleep", "obsbot_gimbal_move",
  "obsbot_gimbal_move_speed", "obsbot_gimbal_recenter", "obsbot_zoom_uvc",
  "obsbot_ai_track", "obsbot_ai_track_speed", "obsbot_zoom_vendor",
  "obsbot_focus_face", "obsbot_status", "obsbot_debug_probe", "obsbot_image_fov",
  "obsbot_image_hdr", "obsbot_focus_auto", "obsbot_focus_manual",
  "obsbot_gimbal_position", "obsbot_preset_list",
  "obsbot_preset_save", "obsbot_preset_recall", "obsbot_preset_update",
  "obsbot_preset_rename", "obsbot_preset_delete", "obsbot_image_wb_auto",
  "obsbot_image_wb_manual", "obsbot_image_adjust", "obsbot_image_exposure_auto",
  "obsbot_image_exposure_manual", "obsbot_capture_snapshot",
  "obsbot_capture_record", "obsbot_capture_preview", "obsbot_capture_stop",
  "obsbot_capture_list",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard ceiling on the whole run. Per-check timeouts do not cover a hang in
// teardown or a USB call that never returns, and a hung script means a human
// has to notice and kill it. Fail loudly on our own terms instead.
const WATCHDOG_MS = process.argv.includes("--deep") ? 15 * 60_000 : 10 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`
WATCHDOG: run exceeded ${WATCHDOG_MS / 60000} minutes — forcing exit.`);
  console.error("The camera may be left awake; run obsbot_sleep if so.");
  process.exit(2);
}, WATCHDOG_MS);

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
    const mgr = new DeviceManager(async () => helper);
    // Bind the single camera eagerly; createTools resolves per-camera via mgr.get()
    // inside each handler (no `camera` selector => this one bound camera).
    await mgr.openFirstObsbot();
    // debug=true exposes obsbot_debug_probe (RE/diagnostics, filtered out otherwise), and a
    // CaptureManager is required or every capture tool returns 'not configured'.
    const tools = createTools(mgr, new CaptureManager(), true);
    byName = new Map(tools.map((t) => [t.name, t]));

    const call = async (name, args = {}) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`no such tool: ${name}`);
      return tool.handler(args);
    };

    // The camera sleeps after roughly a minute of idle, and obsbot_gimbal_position
    // does NOT go through the readiness gate — it reads the UVC controls directly.
    // So a polling loop made of position reads will happily poll a sleeping camera
    // until it times out. Everything that waits therefore heartbeats a wake, and
    // the runner wakes before each check, except for the checks whose whole point
    // is to observe sleep (they set managesSleep).
    let keepAwake = true;
    let lastWake = 0;
    const HEARTBEAT_MS = 20000;
    // Post-wake self-centering window; commands issued inside it are overridden.
    const WAKE_SETTLE_MS = 2000;
    const heartbeat = async () => {
      if (!keepAwake) return;
      if (Date.now() - lastWake < HEARTBEAT_MS) return;
      lastWake = Date.now();
      await call("obsbot_wake");
    };

    const ctx = {
      call,
      sleep,
      log: (m) => console.log(`   ${m}`),
      deep,
      pos: async () => call("obsbot_gimbal_position"),
      status: async () => call("obsbot_status"),
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
          await heartbeat();
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
      keepAwake = !check.managesSleep;
      if (keepAwake) {
        // Start every check from a known-awake camera, but only wake when it is
        // actually asleep: the gimbal self-centers for ~1-2s after a wake and
        // overrides commands issued inside that window, so an unconditional wake
        // before every check makes the next move silently fail.
        const st = await call("obsbot_status");
        if (st.awake === false) {
          await call("obsbot_wake");
          await sleep(WAKE_SETTLE_MS);
        }
        lastWake = Date.now();
      }
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
      await byName?.get("obsbot_sleep")?.handler({});
    } catch {
      /* teardown is best-effort; never mask the original failure */
    }
    // close(), not stop(): the child process keeps Node's event loop alive, so a
    // wrong method name here makes the script hang after its work is done. This
    // is the same rough edge documented for scripts/e2e.mjs.
    await helper.close();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    // Explicit exit: any lingering child handle would otherwise keep the loop
    // alive and turn a finished run into a hang.
    process.exit(process.exitCode ?? 0);
  });
