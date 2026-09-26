// Live check of the snapshot fallback chain: SRT off + NDI on.
// Pass 1 (bridge stopped) should return the options report.
// Pass 2 (after starting the NDI Webcam bridge) should grab a frame —
// demonstrating the one-time-setup-then-autonomous path.
import { Tail2Registry } from "../dist/tail2/registry.js";
import { createTail2Tools } from "../dist/tail2/tools.js";
import { spawn } from "node:child_process";

const reg = new Tail2Registry();
await reg.addHost("192.168.0.132");
const tools = createTail2Tools(reg);
const snap = tools.find((t) => t.name === "obsbot_tail2_snapshot");

const report = async (label) => {
  const r = await snap.handler({ resolution: 640 });
  const img = r.content?.find((c) => c.type === "image");
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  if (img) {
    console.log(`${label}: IMAGE (${Math.round(img.data.length * 0.75 / 1024)} KB)`);
    console.log(`   ${text}`);
  } else {
    console.log(`${label}: REPORT ->`);
    console.log(text.split("\n").map((l) => `   ${l}`).join("\n"));
  }
};

await report("pass1 (bridge stopped)");

// Try to start the NDI Webcam bridge headless — it may remember its last
// selected source (the Tail 2's NDI stream, if the user ever chose it).
const bridge = spawn("cmd", ["/c", "start", "", "\"C:\\Program Files\\NDI\\NDI 6 Tools\\Webcam\\Webcam.exe\""], { detached: false });
bridge.unref();
console.log("\n(bridge launch requested; waiting 8s for it to come up and present its DirectShow device)");
await new Promise((r) => setTimeout(r, 8000));
await report("pass2 (bridge started)");
process.exit(0);
