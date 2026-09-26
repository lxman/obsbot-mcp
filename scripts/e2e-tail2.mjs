#!/usr/bin/env node
// End-to-end hardware verification for the Tail 2 module (all platforms —
// the Tail 2 is HTTP/WS, so there is no native helper and no platform
// variance; see TAIL2-PROTOCOL.md).
//
// Drives the REAL compiled stack (dist/) against a live OBSBOT Tail 2 on the
// network: registers it, lists it, reads a full status push, and exercises
// the write path with a TRUE no-op (the zoom ratio the camera itself just
// reported is written straight back, so the PUT + verify-ladder runs without
// moving anything).
//
// SAFETY: unlike scripts/e2e.mjs (Tiny 2), this script does NOT move the
// camera — no gimbal motion, no zoom change, no mode flips. It exists to
// prove the transport against real hardware, including its quirks: this
// sequence is what caught the WS-teardown crash of 2026-09-26, where
// stripping listeners at settle left an unhandled 'error' when the camera's
// next 1 Hz status push raced the close handshake.
//
// Usage: node scripts/e2e-tail2.mjs [host]     (after `npm run build`)
// The host defaults to 192.168.0.132 — pass yours, or find it with
// OBSBOT Center or a port scan for 5960/5961 (NDI|HX).

import { Tail2Registry } from "../dist/tail2/registry.js";
import { createTail2Tools } from "../dist/tail2/tools.js";

const HOST = process.argv[2] ?? "192.168.0.132";

const step = async (name, fn) => {
  console.log(`\n== ${name}`);
  const r = await fn();
  console.log(JSON.stringify(r));
  return r;
};

const reg = new Tail2Registry();
const entry = await step(`register ${HOST}`, () => reg.addHost(HOST));
if (!entry) {
  console.error(`no Tail 2 answered at ${HOST} — check power/network/IP`);
  process.exit(1);
}

const tools = createTail2Tools(reg);
const tool = (name) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
};

await step("obsbot_tail2_devices", () => tool("obsbot_tail2_devices").handler({}));

const status = await step("obsbot_tail2_status", () => tool("obsbot_tail2_status").handler({}));
console.log(
  `   -> ai=${status.ai_mode} zoom=${status.zoom_ratio} portrait=${status.switch_portrait} ` +
    `roll_bias=${status.roll_bias} ndi=${JSON.stringify(status.ndi)} ` +
    `battery=${status.device_status?.battery_cap}%`,
);

// Rapid consecutive reads: max overlap between one read's teardown and the
// next's traffic — the window where the 2026-09-26 crash lived.
await step("status x8 (teardown-race regression check)", async () => {
  const reads = await Promise.all(
    Array.from({ length: 8 }, () => tool("obsbot_tail2_status").handler({})),
  );
  return { ok: reads.length, allHaveMac: reads.every((r) => typeof r.camera === "string") };
});

// TRUE no-op write: the camera's own reported zoom, written straight back.
const zoom = await step("obsbot_tail2_zoom (write-back no-op)", () =>
  tool("obsbot_tail2_zoom").handler({ ratio: status.zoom_ratio }),
);
if (zoom.settled !== true) {
  console.error("verify ladder did not settle on live hardware");
  process.exit(1);
}

// Snapshot through the real SRT listener (requires Center's SRT toggle on).
if (status.srt?.enable === true) {
  const snap = await step("obsbot_tail2_snapshot (live SRT frame)", () =>
    tool("obsbot_tail2_snapshot").handler({ resolution: 640, quality: 80 }),
  );
  const img = snap.content?.find((c) => c.type === "image");
  if (!img?.data || img.data.length < 1000) {
    console.error("snapshot returned no usable image");
    process.exit(1);
  }
  console.log(`   -> image: ${Math.round(img.data.length * 0.75 / 1024)} KB base64-decoded`);
} else {
  console.log("\n== obsbot_tail2_snapshot: skipped (SRT not enabled in Center)");
}

console.log("\nTAIL 2 E2E OK");
