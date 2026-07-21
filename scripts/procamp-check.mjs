#!/usr/bin/env node
// Hardware check for the Processing Unit (image adjust / white balance) path.
//
// Guards the 2026-07-21 regression where every ProcAmp transfer was issued at
// 4 bytes while the device declares these controls as 2 (GET_LEN). The extra
// bytes came back as junk that VARIED between calls (0x0200 one moment,
// 0x0001 the next), so min/max were corrupted by a large, unstable offset.
//
//   - obsbot_image_adjust survived by luck: it maps a 0-100 percentage onto
//     [min,max], so a constant offset cancels in the low bytes. Only the
//     reported `value` was visibly garbage (e.g. 33554482 for "brightness 50").
//   - obsbot_image_wb_manual was genuinely BROKEN: it clamps an ABSOLUTE Kelvin
//     value against that range, so any sane temperature fell below the
//     corrupted minimum and pinned to it. 5600K requested -> 2000K delivered.
//
// Ranges are the sharpest signal, and they need no readback path: a corrupted
// transfer shows up immediately as an absurd min/max. Non-destructive -- reads
// ranges only, sets nothing, moves nothing.
//
// Usage: node scripts/procamp-check.mjs   (after `npm run build` + `make -C native/macos`)

import { DeviceManager } from "../dist/device/manager.js";
import { HelperProcess } from "../dist/transport/helper-process.js";

// IAMVideoProcAmp property indices, as used by src/mcp/tools.ts.
const SUPPORTED = [
  { prop: 0, name: "brightness", min: 0, max: 100 },
  { prop: 1, name: "contrast", min: 1, max: 100 },
  { prop: 2, name: "hue", min: 1, max: 100 },
  { prop: 3, name: "saturation", min: 1, max: 100 },
  { prop: 4, name: "sharpness", min: 1, max: 100 },
  { prop: 7, name: "white-balance", min: 2000, max: 10000 },
];
// Declared by the Tiny 2 with GET_LEN 0 — not implemented. These must be
// REFUSED, not silently accepted: this firmware does not stall undefined
// selectors, so a write appears to succeed and does nothing.
const UNSUPPORTED = [
  { prop: 8, name: "backlight-compensation" },
  { prop: 9, name: "gain" },
];

const mgr = new DeviceManager(async () => {
  const h = new HelperProcess();
  await h.start();
  return h;
});

let failures = 0;
try {
  const t = await mgr.get();

  for (const c of SUPPORTED) {
    let line;
    try {
      const { min, max } = await t.procAmpRange(c.prop);
      const ok = min === c.min && max === c.max;
      if (!ok) failures++;
      line = `${ok ? "ok  " : "FAIL"} ${c.name.padEnd(22)} ${min}..${max}` +
             (ok ? "" : `   expected ${c.min}..${c.max}`);
    } catch (e) {
      failures++;
      line = `FAIL ${c.name.padEnd(22)} threw: ${e.message}`;
    }
    console.log(line);
  }

  for (const c of UNSUPPORTED) {
    let refused = false;
    try {
      await t.procAmpRange(c.prop);
    } catch {
      refused = true;
    }
    if (!refused) failures++;
    console.log(`${refused ? "ok  " : "FAIL"} ${c.name.padEnd(22)} refused as unsupported`);
  }

  console.log(failures === 0 ? "\nPROCAMP CHECK PASS" : `\nPROCAMP CHECK FAIL (${failures})`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("PROCAMP CHECK ERROR:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await mgr.invalidate().catch(() => {});
}
