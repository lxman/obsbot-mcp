import { test, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
//  npm installs a package's `bin` as a SYMLINK on POSIX:
//
//    /usr/local/bin/obsbot-mcp -> ../lib/node_modules/obsbot-mcp/dist/index.js
//
//  and node reports process.argv[1] as the path it was invoked by, not the file
//  that path resolves to. src/index.ts gates startServer() on argv[1] matching
//  import.meta.url, so for every global install and every `npx` run on Linux and
//  macOS the two differed, the server never started, and the process exited 0
//  with no output — a silent no-op, the worst shape a launch failure can take.
//
//  Windows hid it completely: npm writes a .cmd shim that calls node with the
//  real path, so the comparison succeeded there and only there.
//
//  This test reproduces the install layout — a symlink pointing at the built
//  entry point — and asserts the server actually comes up and answers. Nothing
//  cheaper would have caught it: the bug lives in the gap between the source
//  tree (where argv[1] IS the real path) and the installed tree.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

beforeAll(() => {
  // `npm test` runs after `npm run build` in CI. Failing loudly beats skipping:
  // a silently-skipped test guarding a silent bug is no guard at all.
  expect(
    existsSync(entry),
    `dist/index.js missing — run \`npm run build\` before \`npm test\``,
  ).toBe(true);
});

/** Spawn `node <script>`, speak MCP at it, resolve the initialize result. */
async function initializeVia(script: string): Promise<{ name: string; version: string }> {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bin-entry-test", version: "1.0" },
        },
      }) + "\n",
    );

    return await new Promise((resolve, reject) => {
      let buf = "";
      // A dead-silent exit is the exact failure being guarded, so the timeout
      // has to report *that* rather than a bare "timed out".
      const timer = setTimeout(
        () => reject(new Error(`no initialize response within 20s (stderr: ${err.trim() || "empty"})`)),
        20_000,
      );
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name: string; version: string } } };
            if (msg.id === 1 && msg.result?.serverInfo) {
              clearTimeout(timer);
              resolve(msg.result.serverInfo);
              return;
            }
          } catch {
            /* partial line — wait for more */
          }
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited with code ${code} before responding (stderr: ${err.trim() || "empty"})`));
      });
    });
  } finally {
    child.kill();
  }
}

test("starts when invoked at its real path", async () => {
  const info = await initializeVia(entry);
  expect(info.name).toBe("obsbot-mcp");
}, 30_000);

// Creating a symlink on Windows needs elevation or developer mode and usually
// fails with EPERM. Probe once so the test below reports as SKIPPED there rather
// than passing without asserting anything — a green tick for a test that never
// ran is how this class of bug survives in the first place. The platforms that
// actually install via symlink (Linux, macOS) always run it.
const canSymlink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "obsbot-symprobe-"));
  try {
    symlinkSync(entry, join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

test.skipIf(!canSymlink)("starts when invoked through a symlink, as npm installs it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obsbot-bin-"));
  const link = join(dir, "obsbot-mcp");
  try {
    symlinkSync(entry, link);
    const info = await initializeVia(link);
    expect(info.name).toBe("obsbot-mcp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
