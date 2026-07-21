#!/usr/bin/env node
// Two-instance hardware smoke test for the IPC layer (IPC-DESIGN.md).
//
// Launches TWO real `dist/index.js` MCP servers against the physically
// connected camera and speaks MCP over stdio to each:
//   - Instance A starts first → elects OWNER (stderr: "ipc role=owner").
//   - Instance B starts second → elects CLIENT (stderr: "ipc role=client").
//   - Both call obsbot_status. A reads the camera directly; B's call is
//     FORWARDED to A and served by the one owner. Both must return a valid
//     status block — no collision, no "no device open".
//
// Non-destructive: obsbot_status only reads; the gimbal is never moved.
//
// NOTE: keep any other obsbot-mcp instance (e.g. the one in your editor) idle
// while this runs — a pre-IPC instance won't join the election and could
// contend for the camera on Windows.
//
// Usage: node scripts/ipc-hw-smoke.mjs   (after `npm run build`)

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(label) {
  const proc = spawn(process.execPath, [DIST, "--debug"], { stdio: ["pipe", "pipe", "pipe"] });
  let role = "(unknown)";
  proc.stderr.on("data", (d) => {
    const m = /ipc role=(\w+)/.exec(String(d));
    if (m) role = m[1];
  });

  const pending = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`${label} ${method} timed out`)), 8000);
      pending.set(myId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  return {
    label,
    proc,
    role: () => role,
    async handshake() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ipc-hw-smoke", version: "0" },
      });
      notify("notifications/initialized");
    },
    async status() {
      const resp = await send("tools/call", { name: "obsbot_status", arguments: {} });
      const text = resp?.result?.content?.[0]?.text ?? "";
      return { raw: resp, text };
    },
    kill: () => proc.kill(),
  };
}

let a, b;
try {
  a = launch("A");
  await sleep(700); // let A elect owner + settle before B joins
  b = launch("B");
  await sleep(500);

  await a.handshake();
  await b.handshake();

  const sa = await a.status();
  const sb = await b.status();

  console.log(`A role=${a.role()}  status=${sa.text.slice(0, 80)}`);
  console.log(`B role=${b.role()}  status=${sb.text.slice(0, 80)}`);

  const aOwner = a.role() === "owner";
  const bClient = b.role() === "client";
  const aOk = /awake/.test(sa.text);
  const bOk = /awake/.test(sb.text); // B's status came THROUGH the owner

  const pass = aOwner && bClient && aOk && bOk;
  console.log(
    pass
      ? "HW SMOKE PASS: A owns, B forwards; both read the camera with no collision"
      : `HW SMOKE FAIL: aOwner=${aOwner} bClient=${bClient} aOk=${aOk} bOk=${bOk}`,
  );
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error("HW SMOKE ERROR:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  a?.kill();
  b?.kill();
}
