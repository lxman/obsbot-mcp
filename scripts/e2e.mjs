#!/usr/bin/env node
// End-to-end hardware verification for obsbot-mcp (Windows + Linux).
//
// Drives the REAL compiled stack (dist/) against a physically connected
// OBSBOT Tiny 2: opens the device, wakes it, zooms in, pans, recenters,
// exercises two-axis moves through the transport API, zooms back out, and
// puts it to sleep. Every step is logged before it runs and separated by a
// short pause so a human supervisor can watch the gimbal/camera and confirm
// each action is correct.
//
// Note the two kinds of movement here, which are DIFFERENT code paths: the
// vendor-frame steps (encodePtzMoveAngle/encodeRecenter) and the transport
// steps (gimbalSet/gimbalRecenter). Covering only the first is how a
// one-axis-cancellation bug once passed this script with EXIT=0.
//
// SAFETY: this script MOVES THE PHYSICAL GIMBAL. Only run it under human
// supervision, with a clear line of sight to the camera. Angles are kept
// conservative (<=30 deg) and every move is followed by a recenter, with
// the camera always left asleep at the end (even on error, via try/finally).
//
// Usage: node scripts/e2e.mjs   (after `npm run build`)
//
// OBSBOT_HELPER_CMD overrides the helper binary, so the no-camera path can be
// exercised without physically unplugging the camera:
//   OBSBOT_HELPER_CMD="node test/device/fake-helper-no-obsbot.mjs" node scripts/e2e.mjs

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

/**
 * Log both axes after a move. Printed, never asserted — on most kernels this
 * readback is the driver's echo of what we last wrote, so it would happily
 * "confirm" a gimbal that never moved. It is here to give the human supervisor
 * a number to compare against what they physically see, which is the only real
 * verification. (On a kernel carrying the uvcvideo volatile-position patch it
 * is a genuine live reading — see UVCVIDEO-LINUX-POSITION-2026-07-21.md.)
 */
async function reportPose(transport, label) {
  try {
    const [pan, tilt] = await Promise.all([
      transport.camCtrlGet(0),
      transport.camCtrlGet(1),
    ]);
    console.log(`   ${label}: pan=${pan.value} tilt=${tilt.value}`);
  } catch (err) {
    // A platform without pan/tilt readback must not fail the sequence.
    console.log(`   ${label}: readback unavailable (${err instanceof Error ? err.message : err})`);
  }
}

async function main() {
  const helper = new HelperProcess(process.env.OBSBOT_HELPER_CMD?.split(" "));
  console.log("→ starting native helper process...");
  await helper.start();

  // Everything below runs inside try/finally: the helper is a child process
  // whose stdio keeps the event loop alive, so any path that leaves without
  // closing it hangs the script forever and orphans the helper. That includes
  // the no-camera path — the most likely one to hit.
  try {
    const mgr = new DeviceManager(async () => helper);

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

    // Everything above moves the gimbal with VENDOR FRAMES, which leaves the
    // transport's own gimbalSet/gimbalRecenter completely unexercised — those
    // are a different code path on every platform (V4L2 pan/tilt on Linux,
    // vendor frames on Windows/macOS). A bug that cancelled one axis of a
    // two-axis move once shipped straight through this script with EXIT=0.
    //
    // So drive both axes at once through the transport API, to DIFFERENT
    // targets: a symmetric move, or one that only travels on a single axis,
    // cannot show an axis being dropped.
    console.log("→ moving both axes via transport.gimbalSet (yaw=20, pitch=10)...");
    await transport.gimbalSet(20, 10);
    await sleep(STEP_PAUSE_MS);
    await reportPose(transport, "after gimbalSet");

    // Small pitch against large yaw: if one axis is being cancelled, the
    // small-travel one is where it shows.
    console.log("→ asymmetric move via transport.gimbalSet (yaw=25, pitch=1)...");
    await transport.gimbalSet(25, 1);
    await sleep(STEP_PAUSE_MS);
    await reportPose(transport, "after asymmetric gimbalSet");

    console.log("→ recentering via transport.gimbalRecenter()...");
    await transport.gimbalRecenter();
    await sleep(STEP_PAUSE_MS);
    await reportPose(transport, "after gimbalRecenter");

    console.log("→ zooming back to 1.0x...");
    await transport.zoomSet(zoomRatioToUnits(1.0, min, max));
    await sleep(STEP_PAUSE_MS);

    console.log("→ sleeping (set_run_status: sleep)...");
    await transport.sendVendor(encodeSetRunStatus("sleep").buildFrame(transport.nextSeq()));
    await sleep(STEP_PAUSE_MS);

    console.log("\ne2e sequence complete. Camera left recentered + asleep.");
  } finally {
    // Closing the helper is what releases the child process; every transport's
    // close() just delegates here anyway.
    console.log("→ closing helper...");
    await helper.close();
  }
}

main().catch((err) => {
  console.error("\ne2e script failed:");
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
