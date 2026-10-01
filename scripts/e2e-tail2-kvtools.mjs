// Live hardware check for the KV (4454-surface) tools (runs dist/).
// zone/auto-zoom-speed have no readback — verified as send-only; track_custom
// is verified against tracking_settings readback and fully restored.
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

// Send-only tools: fire and confirm the camera is still responsive.
const z = await call("obsbot_tail2_zone_tracking", { enabled: true });
console.log("zone on:", JSON.stringify(z));
await new Promise((r) => setTimeout(r, 500));
const z2 = await call("obsbot_tail2_zone_tracking", { enabled: false });
console.log("zone off:", JSON.stringify(z2));
const s = await call("obsbot_tail2_auto_zoom_speed", { speed: 6 });
console.log("auto zoom speed:", JSON.stringify(s));
// Camera still alive?
must((await call("obsbot_tail2_preset_speed")).speed >= 1, "camera unresponsive after KV writes");

// track_custom: read -> write -> verify -> restore.
const before = await call("obsbot_tail2_track_custom");
console.log("before:", JSON.stringify(before));
const w = await call("obsbot_tail2_track_custom", { enabled: true, pan: 4, tilt: 6, panAuto: true, tiltAuto: false });
console.log("write:", JSON.stringify(w));
must(w.readback.mode === "customized", `mode not customized: ${w.readback.mode}`);
must(Number(w.readback.pan) === 4, `pan not 4: ${w.readback.pan}`);
must(Number(w.readback.tilt) === 6, `tilt not 6: ${w.readback.tilt}`);
must(w.readback.panAuto === true, `panAuto not true: ${w.readback.panAuto}`);
must(w.readback.tiltAuto === false, `tiltAuto not false: ${w.readback.tiltAuto}`);

// Restore the original tracking configuration. Note: REST trackspeed PUT
// to `customized` REQUIRES horizontalSpeed/verticalSpeed in the same body
// (discovered here: bare {"speed":"customized"} is a 400) — so only restore
// the mode when it was something else; the axis values are restored directly.
if (before.mode !== "customized") await call("obsbot_tail2_track_speed", { speed: before.mode });
await call("obsbot_tail2_track_custom", {
  pan: before.pan ?? 4,
  tilt: before.tilt ?? 6,
  panAuto: before.panAuto ?? false,
  tiltAuto: before.tiltAuto ?? false,
});
const after = await call("obsbot_tail2_track_custom");
console.log("after restore:", JSON.stringify(after));
must(after.mode === before.mode, `mode not restored: ${after.mode} vs ${before.mode}`);

console.log("KV TOOLS LIVE OK");
