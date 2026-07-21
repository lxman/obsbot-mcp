#!/usr/bin/env node
// Cross-process election smoke test for the IPC layer (IPC-DESIGN.md).
//
// Unit tests exercise elect() within one Node process; this proves it works
// across SEPARATE OS processes over a real named pipe / Unix-domain socket —
// exactly one owner, one client — which is the whole point on Windows, where
// the OS does not otherwise arbitrate camera access.
//
// Usage: node scripts/ipc-smoke.mjs   (after `npm run build`)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "--child") {
  const { elect } = await import("../dist/ipc/rendezvous.js");
  try {
    const r = await elect(process.env.SMOKE_PATH);
    process.stdout.write(JSON.stringify({ pid: process.pid, role: r.role }) + "\n");
    if (r.role === "owner") {
      await new Promise((res) => setTimeout(res, 500)); // hold so the sibling sees it taken
      r.server.close();
    } else {
      r.socket.destroy();
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ pid: process.pid, error: String(e) }) + "\n");
  }
  process.exit(0);
}

const path =
  process.platform === "win32"
    ? `\\\\.\\pipe\\obsbot-smoke-${process.pid}`
    : `/tmp/obsbot-smoke-${process.pid}.sock`;

function child() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [self, "--child"], {
      env: { ...process.env, SMOKE_PATH: path },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => resolve(out.trim()));
  });
}

const a = child();
await new Promise((r) => setTimeout(r, 200)); // let A elect + hold the endpoint
const b = child();
const [ra, rb] = await Promise.all([a, b]);

console.log("child A:", ra);
console.log("child B:", rb);

const roles = [ra, rb]
  .map((s) => {
    try {
      return JSON.parse(s).role;
    } catch {
      return "?";
    }
  })
  .sort();

const ok = roles[0] === "client" && roles[1] === "owner";
console.log(ok ? "SMOKE PASS: one owner + one client across processes" : `SMOKE FAIL: roles=${JSON.stringify(roles)}`);
process.exit(ok ? 0 : 1);
