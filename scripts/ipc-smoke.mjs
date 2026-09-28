#!/usr/bin/env node
// Cross-process election smoke test for the IPC layer (IPC-DESIGN.md).
//
// Unit tests exercise elect() within one Node process; this proves it works
// across SEPARATE OS processes over a real named pipe / Unix-domain socket —
// exactly one owner, one client — which is the whole point on Windows, where
// the OS does not otherwise arbitrate camera access.
//
// It then proves the handover works across processes too: two REAL servers,
// launched from two copies of dist/ carrying different build stamps, where the
// newer one must take the endpoint from the older and the older's calls must
// then be served by it. See
// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md.
//
// No hardware is touched. The only tool called is obsbot_tail2_devices, which
// reads an in-memory registry. Every process here uses its own rendezvous name
// (OBSBOT_IPC_NAME), so a server running in your editor is not disturbed.
//
// WHO ANSWERED is part of what is checked, not just that someone did. Each
// server is pointed at a different pretend Tail 2 — a few lines of HTTP on
// localhost — so the registry a reply came from names the process that ran
// the call. Without that, a build whose clients quietly ran every call on
// their own code passed this test.
//
// Usage: node scripts/ipc-smoke.mjs              (after `npm run build`)
//        node scripts/ipc-smoke.mjs --sabotage   proves the check can fail: the
//                                                older copy is broken so that it
//                                                runs calls itself, and the test
//                                                must then report FAIL

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const self = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(self), "..");

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

// ---------------------------------------------------------------------------
// Takeover across processes
// ---------------------------------------------------------------------------

const ipcName = `obsbot-smoke-${process.pid}`;
const endpoint =
  process.platform === "win32" ? `\\\\.\\pipe\\${ipcName}` : `/tmp/${ipcName}.sock`;
// Inside the repository, so the copies resolve node_modules and "type": "module"
// by walking up to the root. artifacts/ is already ignored.
const runDir = join(repoRoot, "artifacts", "ipc-builds", String(process.pid));

/** A copy of dist/ that claims to be a different build. Returns its entry point. */
function stagedBuild(name, builtAt, digestChar) {
  const dist = join(runDir, name, "dist");
  cpSync(join(repoRoot, "dist"), dist, { recursive: true });
  writeFileSync(
    join(dist, "build-info.json"),
    JSON.stringify({ version: "0.0.0-smoke", builtAt, digest: digestChar.repeat(64) }),
  );
  return join(dist, "index.js");
}

/**
 * A pretend Tail 2: answers the one request the registry makes when it is told
 * about a host. Whichever server is pointed at it lists `mac` as its camera.
 */
function pretendTail2(mac) {
  const server = http.createServer((req, res) => {
    if (req.url === "/camera/sdk/device_info") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ mac, device_name: `pretend ${mac}` }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ mac, host: `127.0.0.1:${server.address().port}`, close: () => server.close() }),
    ),
  );
}

/** Launch a real server and speak MCP to it over stdio. */
function launch(label, entry, tail2) {
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, OBSBOT_IPC_NAME: ipcName, OBSBOT_TAIL2_HOSTS: tail2.host },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = [];
  let errBuf = "";
  proc.stderr.on("data", (d) => {
    errBuf += d;
    let i;
    while ((i = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, i);
      errBuf = errBuf.slice(i + 1);
      lines.push(line);
      for (const w of waiters.splice(0)) w();
    }
  });

  const pending = new Map();
  let outBuf = "";
  proc.stdout.on("data", (d) => {
    outBuf += d;
    let i;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
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

  return {
    label,
    pid: proc.pid,
    lines,
    /** Resolve once `count` logged lines match `re`. Reject after `ms`. */
    async sees(re, count = 1, ms = 8000) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (lines.filter((l) => re.test(l)).length >= count) return;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `${label} never logged ${re} x${count}. It logged:\n  ${lines.join("\n  ")}`,
          );
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async handshake() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ipc-smoke", version: "0" },
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
    },
    async tail2Devices() {
      const resp = await send("tools/call", { name: "obsbot_tail2_devices", arguments: {} });
      return resp?.result?.content?.[0]?.text ?? JSON.stringify(resp);
    },
    /**
     * Call through this instance until the reply lists `mac`, and say so. A
     * server learns about its pretend camera a moment after it starts, so the
     * first reply may be empty; a reply that names a DIFFERENT camera is wrong
     * at once and is not waited out.
     */
    async answeredBy(expected, others, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const text = await this.tail2Devices();
        for (const o of others) {
          if (text.includes(o.mac)) {
            throw new Error(
              `a call through ${label} was run by the instance that owns ${o.mac}, ` +
                `not the one that owns ${expected.mac}: ${text}`,
            );
          }
        }
        if (text.includes(expected.mac)) return text;
        if (Date.now() > deadline) {
          throw new Error(`a call through ${label} never listed ${expected.mac}: ${text}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    kill: (signal) => proc.kill(signal),
  };
}

const sabotage = process.argv.includes("--sabotage");
let takeoverOk = false;
let older, newer, olderCam, newerCam;
try {
  if (!existsSync(join(repoRoot, "dist", "index.js"))) {
    throw new Error("dist/index.js is missing — run `npm run build` first");
  }
  const olderEntry = stagedBuild("older", 1790100000000, "a");
  const newerEntry = stagedBuild("newer", 1790300000000, "c");
  if (sabotage) {
    // Break the older copy so that, as a client, it runs calls on its own code
    // instead of forwarding them. The checks below must notice.
    const file = join(dirname(olderEntry), "ipc", "coordinator.js");
    const forward = "await target.request({ tool, args })";
    const code = readFileSync(file, "utf8");
    if (!code.includes(forward)) throw new Error(`--sabotage: nothing to break in ${file}`);
    writeFileSync(file, code.replace(forward, "await this.runLocal(tool, args)"));
    console.log("sabotage: the older copy now runs forwarded calls itself");
  }
  olderCam = await pretendTail2("02:00:00:00:00:0a");
  newerCam = await pretendTail2("02:00:00:00:00:0c");

  older = launch("older", olderEntry, olderCam);
  await older.sees(/ipc role=owner/);

  newer = launch("newer", newerEntry, newerCam);
  await newer.sees(/ipc role=owner/);
  await older.sees(new RegExp(`ipc stepping down for pid ${newer.pid}$`));
  await older.sees(new RegExp(`ipc role=client owner-pid=${newer.pid} `));
  console.log(`takeover: pid ${newer.pid} (newer) took the endpoint from pid ${older.pid} (older)`);

  await older.handshake();
  const viaOlder = await older.answeredBy(newerCam, [olderCam]);
  console.log(`takeover: a call through the older instance was run by the newer one: ${viaOlder}`);

  // Kill the owner outright. On POSIX that leaves a stale socket file behind.
  // The survivor has to notice and take the endpoint without being asked to do
  // anything — nobody makes a tool call here.
  newer.kill("SIGKILL");
  await older.sees(/ipc role=owner/, 2);
  console.log(`takeover: pid ${older.pid} took the endpoint back after its owner was killed`);

  const afterKill = await older.answeredBy(olderCam, [newerCam]);
  console.log(`takeover: and now runs its own calls: ${afterKill}`);

  takeoverOk = true;
  console.log("SMOKE PASS: the newer build took over, and the survivor recovered from a killed owner");
} catch (e) {
  console.log(`SMOKE FAIL (takeover): ${e instanceof Error ? e.message : e}`);
} finally {
  older?.kill();
  newer?.kill();
  olderCam?.close();
  newerCam?.close();
  rmSync(runDir, { recursive: true, force: true });
  if (process.platform !== "win32") {
    try {
      unlinkSync(endpoint);
    } catch {
      // already gone
    }
  }
}

process.exit(ok && takeoverOk ? 0 : 1);
