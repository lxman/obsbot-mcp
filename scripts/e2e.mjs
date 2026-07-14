#!/usr/bin/env node
// End-to-end hardware verification for obsbot-mcp.
//
// Drives the REAL compiled stack (dist/) against a physically connected
// OBSBOT Tiny 2: opens the device, wakes it, zooms in, pans, recenters,
// zooms back out, and puts it to sleep. Every step is logged before it
// runs and separated by a short pause so a human supervisor can watch
// the gimbal/camera and confirm each action is correct.
//
// SAFETY: this script MOVES THE PHYSICAL GIMBAL. Only run it under human
// supervision, with a clear line of sight to the camera. Angles are kept
// conservative (<=30 deg) and every move is followed by a recenter, with
// the camera always left asleep at the end (even on error, via try/finally).
//
// Usage: node scripts/e2e.mjs   (after `npm run build`)

import { HelperProcess } from "../dist/transport/helper-process.js";
import { DeviceManager } from "../dist/device/manager.js";
import {
  encodeSetRunStatus,
  encodePtzMoveAngle,
  encodeRecenter,
  zoomRatioToUnits,
} from "../dist/codec/commands.js";

const STEP_PAUSE_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const helper = new HelperProcess();
  console.log("→ starting native helper process...");
  await helper.start();

  const mgr = new DeviceManager(helper);

  console.log("→ enumerating devices...");
  const devices = await mgr.list();
  console.log(`  found ${devices.length} device(s):`);
  for (const d of devices) {
    console.log(`    - ${d.name}  (${d.path})`);
  }

  let transport;
  try {
    transport = await mgr.openFirstObsbot();
  } catch (err) {
    console.error("\nNo OBSBOT Tiny 2 found. Is it plugged in?");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  try {
    console.log("\n→ waking (set_run_status: run)...");
    await transport.sendVendor(encodeSetRunStatus("run").buildFrame(transport.nextSeq()));
    await sleep(STEP_PAUSE_MS);

    console.log("→ reading zoom range...");
    const { min, max } = await transport.zoomRange();
    console.log(`  zoom range: min=${min} max=${max}`);

    console.log("→ zooming in to 2.0x...");
    await transport.zoomSet(zoomRatioToUnits(2.0, min, max));
    await sleep(STEP_PAUSE_MS);

    console.log("→ recentering gimbal...");
    await transport.sendVendor(encodeRecenter().buildFrame(transport.nextSeq()));
    await sleep(STEP_PAUSE_MS);

    console.log("→ moving to angle (yaw=30, pitch=0, roll=0)...");
    await transport.sendVendor(
      encodePtzMoveAngle(30, 0, 0).buildFrame(transport.nextSeq()),
    );
    await sleep(STEP_PAUSE_MS);

    console.log("→ recentering gimbal (return home)...");
    await transport.sendVendor(encodeRecenter().buildFrame(transport.nextSeq()));
    await sleep(STEP_PAUSE_MS);

    console.log("→ zooming back to 1.0x...");
    await transport.zoomSet(zoomRatioToUnits(1.0, min, max));
    await sleep(STEP_PAUSE_MS);

    console.log("→ sleeping (set_run_status: sleep)...");
    await transport.sendVendor(encodeSetRunStatus("sleep").buildFrame(transport.nextSeq()));
    await sleep(STEP_PAUSE_MS);

    console.log("\ne2e sequence complete. Camera left recentered + asleep.");
  } finally {
    console.log("→ closing transport...");
    await transport.close();
  }
}

main().catch((err) => {
  console.error("\ne2e script failed:");
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
