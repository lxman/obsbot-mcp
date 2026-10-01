// Live hardware check for obsbot_tail2_hybrid_zoom (runs dist/). Verifies the
// only observable that exists — the 5.0x optical wall's presence/absence:
// zoom above 5.0 settles only while hybrid zoom is enabled, and snaps back
// to the wall when disabled. Leaves the camera UNLOCKED (enabled) at the end.
import { Tail2Registry } from "../dist/tail2/registry.js";
import { createTail2Tools } from "../dist/tail2/tools.js";

const reg = new Tail2Registry();
await reg.addHost("192.168.0.132");
const tool = (name) => {
  const t = createTail2Tools(reg).find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

// Retry once: a readback landing mid-ramp reads as settled:false at an
// intermediate ratio — that's transport lag, not a wrong state.
const zoomTo = async (ratio) => {
  let r = await tool("obsbot_tail2_zoom").handler({ ratio, speed: 8 });
  if (!r.settled) r = await tool("obsbot_tail2_zoom").handler({ ratio, speed: 8 });
  return r;
};

// Start enabled (idempotent) and prove the digital region is reachable.
// The tool's own settled flag now comes from the RM_TEST digital_enable
// readback — assert it, not just the behavioral zoom crossing.
let h = await tool("obsbot_tail2_hybrid_zoom").handler({ enabled: true });
console.log("enable readback:", JSON.stringify(h));
if (h.settled !== true) throw new Error("hybrid enable not readback-verified (digital_enable)");
let r = await zoomTo(8);
console.log("enabled, zoom 8.0 ->", JSON.stringify(r));
if (r.ratio <= 5.05) throw new Error("zoom did NOT cross 5.0 with hybrid zoom enabled");

// Disable and prove the wall returns — from BELOW: the clamp applies to
// movement, so a same-value write at 8.0 would be a no-op. Descend into the
// optical range first, then aim above the wall and expect the pin at ~5.0.
await tool("obsbot_tail2_hybrid_zoom").handler({ enabled: false });
h = await tool("obsbot_tail2_hybrid_zoom").handler({ enabled: false });
if (h.settled !== true) throw new Error("hybrid disable not readback-verified (digital_enable)");
await zoomTo(3);
r = await zoomTo(8);
console.log("disabled, zoom 3.0 -> 8.0 ->", JSON.stringify(r));
if (r.ratio > 5.05) throw new Error("zoom crossed 5.0 with hybrid zoom DISABLED — expected the wall");

// Re-enable, verify the crossing again from below, restore a sane zoom, done.
h = await tool("obsbot_tail2_hybrid_zoom").handler({ enabled: true });
if (h.settled !== true) throw new Error("hybrid re-enable not readback-verified");
r = await zoomTo(6);
console.log("re-enabled, zoom 6.0 ->", JSON.stringify(r));
if (r.ratio <= 5.05) throw new Error("re-enable did not unlock the digital region");
await zoomTo(2.1);
console.log("HYBRID ZOOM LIVE OK (left enabled, zoom 2.1)");
