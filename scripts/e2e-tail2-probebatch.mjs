// Live hardware check for the 2026-10-01 probe batch (runs dist/).
// Value-preserving by design: every write sends the value just read, so the
// camera's state cannot drift. Requires human tracking armed for zoom_type
// (the gate) — armed here and left armed (the session's normal state).
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tail2Registry } from "../dist/tail2/registry.js";
import { createTail2Tools } from "../dist/tail2/tools.js";

const reg = new Tail2Registry();
await reg.addHost("192.168.0.132");
const tool = (name) => {
  const t = createTail2Tools(reg).find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const call = (name, args = {}) => tool(name).handler(args);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// zoom_type needs tracking armed (the gate) — arm it.
await call("obsbot_tail2_ai_track", { enabled: true });

// Bare reads across the batch.
const zt = await call("obsbot_tail2_zoom_type");
const ps = await call("obsbot_tail2_preset_speed");
const um = await call("obsbot_tail2_usb_mode");
const af = await call("obsbot_tail2_af_track");
const an = await call("obsbot_tail2_antiflicker");
const ir = await call("obsbot_tail2_iso_range");
const gs = await call("obsbot_tail2_gesture");
const sc = await call("obsbot_tail2_stream_config");
console.log("reads:", JSON.stringify({ zt, ps, um, af, an, ir, gs, sc: { ...sc, rtspUrls: "<present>" } }));
must(typeof zt.type === "string", "zoom_type read failed");
must(sc.rtspUrls !== undefined, "stream_config read missing RTSP URLs");

// Value-preserving writes (must all verify).
must((await call("obsbot_tail2_zoom_type", { type: zt.type })).settled === true, "zoom_type write");
must((await call("obsbot_tail2_preset_speed", { speed: ps.speed })).settled === true, "preset_speed write");
must((await call("obsbot_tail2_antiflicker", { mode: an.mode })).settled === true, "antiflicker write");
must((await call("obsbot_tail2_af_track", { mode: af.mode })).settled === true, "af_track write");
const irw = await call("obsbot_tail2_iso_range", { min: ir.isomin, max: ir.isomax });
must(irw.settled === true, "iso_range write");
const gsw = await call("obsbot_tail2_gesture", { lockedTarget: gs.lockedTarget, zoomFactor: gs.zoomFactor });
must(gsw.lockedTarget.settled === true && gsw.zoomFactor.settled === true, "gesture write");
// usb mode: no-op write of the current mode (do not flip modes on live hw).
must((await call("obsbot_tail2_usb_mode", { mode: um.mode })).settled === true, "usb_mode write");
// bitrate is ungated; keep resolution untouched (gated on output off).
const brw = await call("obsbot_tail2_stream_config", { bitrate: sc.bitrate });
console.log("bitrate write:", JSON.stringify(brw));
must(brw.bitrate.settled === true, "bitrate write");

// live_status distillation.
const ls = await call("obsbot_tail2_live_status");
must(ls.zoom.hybridDigitalEnable === true, "live_status hybrid flag");
must(typeof ls.gimbal.euler.y === "number", "live_status pose");
must(typeof ls.power.batteryCapacity === "number", "live_status battery");
console.log("live_status:", JSON.stringify(ls));

// export_log round-trip through a temp dir.
const dir = mkdtempSync(join(tmpdir(), "obsbot-e2e-export-"));
try {
  const p = join(dir, "bundle.tar.gz");
  const ex = await call("obsbot_tail2_export_log", { path: p });
  must(ex.ok && ex.bytes > 1_000_000, `export_log too small: ${ex.bytes}`);
  must(statSync(p).size === ex.bytes, "export_log size mismatch");
  console.log("export_log bytes:", ex.bytes);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("PROBE BATCH LIVE OK (tracking left armed, state preserved)");
