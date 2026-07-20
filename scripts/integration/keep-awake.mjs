// Keep-awake heartbeat: sends SET_RUN_STATUS(run) every 200ms forever.
// Run in background. Kill with SIGTERM/SIGINT to stop.
import { HelperProcess } from "../../dist/transport/helper-process.js";
import { DeviceManager } from "../../dist/device/manager.js";
import { encodeSetRunStatus } from "../../dist/codec/commands.js";

const helper = new HelperProcess();
await helper.start();
try {
  const transport = await new DeviceManager(async () => helper).openFirstObsbot();
  console.log("keep-awake heartbeat running (200ms interval). Ctrl+C to stop.");
  while (true) {
    await transport.sendVendor(encodeSetRunStatus(true).buildFrame(transport.nextSeq()));
    await new Promise((r) => setTimeout(r, 200));
  }
} catch (e) {
  console.error("heartbeat error:", e.message);
} finally {
  await helper.close();
}
