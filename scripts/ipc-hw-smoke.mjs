#!/usr/bin/env node
// Hardware smoke test for the IPC layer (IPC-DESIGN.md), against a physically
// connected OBSBOT Tiny 2. Two cases, each with two real MCP servers speaking
// MCP over stdio:
//
//   1. Sharing. Instance A starts first → OWNER. Instance B starts second →
//      CLIENT. Both call obsbot_status. A reads the camera directly; B's call
//      is FORWARDED to A. Both must return a valid status block — no
//      collision, no "no device open".
//
//   2. Handover. An OLDER build owns the endpoint and has the camera open. A
//      NEWER build starts. The older one must release the camera and step
//      down, the newer one must open it, and obsbot_status through BOTH must
//      then succeed. On macOS the control open is exclusive, so this only
//      passes if the old owner has really let go before the new one opens.
//      See docs/superpowers/specs/2026-09-27-newest-build-wins-design.md.
//
// Non-destructive: obsbot_status only reads; the gimbal is never moved.
//
// TINY 2 ONLY. This harness binds the camera, and binding sends the Tiny 2
// serial query as a vendor write. The candidacy gate keeps that away from a
// Tail 2, so with only a Tail 2 attached this fails with "no OBSBOT camera
// found" and touches nothing — but do not go looking for a way round that.
//
// Every server here uses its own rendezvous name (OBSBOT_IPC_NAME), so a
// server running in your editor or a Claude session is not disturbed, and
// does not disturb this.
//
// Usage: node scripts/ipc-hw-smoke.mjs   (after `npm run build:all`)

import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(repoRoot, "dist", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function endpointFor(ipcName) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${ipcName}` : `/tmp/${ipcName}.sock`;
}

function launch(label, ipcName, entry = DIST) {
  const proc = spawn(process.execPath, [entry, "--debug"], {
    env: { ...process.env, OBSBOT_IPC_NAME: ipcName },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = [];
  let errBuf = "";
  proc.stderr.on("data", (d) => {
    errBuf += d;
    let i;
    while ((i = errBuf.indexOf("\n")) >= 0) {
      lines.push(errBuf.slice(0, i));
      errBuf = errBuf.slice(i + 1);
      for (const w of waiters.splice(0)) w();
    }
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
    pid: proc.pid,
    lines,
    /** The role this instance last reported. It changes when the endpoint changes hands. */
    role: () => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /ipc role=(\w+)/.exec(lines[i]);
        if (m) return m[1];
      }
      return "(unknown)";
    },
    /** Resolve once `count` logged lines match `re`. Reject after `ms`. */
    async sees(re, count = 1, ms = 20000) {
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

function freeEndpoint(ipcName) {
  if (process.platform === "win32") return;
  try {
    unlinkSync(endpointFor(ipcName));
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Case 1 — sharing
// ---------------------------------------------------------------------------

async function sharing() {
  const ipcName = `obsbot-hw-smoke-${process.pid}-share`;
  let a, b;
  try {
    a = launch("A", ipcName);
    await a.sees(/ipc role=owner/);
    b = launch("B", ipcName);
    await b.sees(/ipc role=client/);

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
        ? "HW SMOKE PASS (sharing): A owns, B forwards; both read the camera with no collision"
        : `HW SMOKE FAIL (sharing): aOwner=${aOwner} bClient=${bClient} aOk=${aOk} bOk=${bOk}`,
    );
    return pass;
  } finally {
    a?.kill();
    b?.kill();
    await sleep(500); // let the helpers exit and the camera free up before the next case
    freeEndpoint(ipcName);
  }
}

// ---------------------------------------------------------------------------
// Case 2 — handover
// ---------------------------------------------------------------------------

/**
 * A copy of this build that claims to be a different one. It needs the helper
 * as well as dist/, because the server resolves native/prebuilt/ relative to
 * where it was launched from. Returns the entry point.
 */
function stagedBuild(runDir, name, builtAt, digestChar) {
  const root = join(runDir, name);
  cpSync(join(repoRoot, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(repoRoot, "native", "prebuilt"), join(root, "native", "prebuilt"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "dist", "build-info.json"),
    JSON.stringify({ version: "0.0.0-smoke", builtAt, digest: digestChar.repeat(64) }),
  );
  return join(root, "dist", "index.js");
}

async function handover() {
  const ipcName = `obsbot-hw-smoke-${process.pid}-handover`;
  // Inside the repository, so the copies resolve node_modules and
  // "type": "module" by walking up to the root. artifacts/ is already ignored.
  const runDir = join(repoRoot, "artifacts", "ipc-builds", `hw-${process.pid}`);
  let older, newer;
  try {
    const olderEntry = stagedBuild(runDir, "older", 1790100000000, "a");
    const newerEntry = stagedBuild(runDir, "newer", 1790300000000, "c");

    older = launch("older", ipcName, olderEntry);
    await older.sees(/ipc role=owner/);
    await older.handshake();
    const before = await older.status(); // the older build now has the camera open
    console.log(`older role=${older.role()}  status=${before.text.slice(0, 80)}`);
    if (!/awake/.test(before.text)) {
      throw new Error(`the older build could not read the camera: ${before.text}`);
    }

    newer = launch("newer", ipcName, newerEntry);
    await newer.sees(/ipc role=owner/);
    await older.sees(new RegExp(`ipc stepping down for pid ${newer.pid}$`));
    await older.sees(new RegExp(`ipc role=client owner-pid=${newer.pid} `));
    await newer.handshake();

    const viaNewer = await newer.status();
    const viaOlder = await older.status(); // forwarded to the newer build
    console.log(`newer role=${newer.role()}  status=${viaNewer.text.slice(0, 80)}`);
    console.log(`older role=${older.role()}  status=${viaOlder.text.slice(0, 80)}`);

    const newerOwns = newer.role() === "owner";
    const olderForwards = older.role() === "client";
    const newerOk = /awake/.test(viaNewer.text);
    const olderOk = /awake/.test(viaOlder.text);

    const pass = newerOwns && olderForwards && newerOk && olderOk;
    console.log(
      pass
        ? "HW SMOKE PASS (handover): the older build released the camera and the newer one opened it"
        : `HW SMOKE FAIL (handover): newerOwns=${newerOwns} olderForwards=${olderForwards} ` +
            `newerOk=${newerOk} olderOk=${olderOk}`,
    );
    return pass;
  } finally {
    older?.kill();
    newer?.kill();
    rmSync(runDir, { recursive: true, force: true });
    freeEndpoint(ipcName);
  }
}

// ---------------------------------------------------------------------------

let ok = false;
try {
  if (!existsSync(DIST)) throw new Error("dist/index.js is missing — run `npm run build:all` first");
  const shared = await sharing();
  const handed = await handover();
  ok = shared && handed;
} catch (e) {
  console.error("HW SMOKE ERROR:", e instanceof Error ? e.message : e);
}
process.exit(ok ? 0 : 1);
