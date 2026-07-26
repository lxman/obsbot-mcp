#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./mcp/server.js";

export const NAME = "obsbot-mcp";

// npm installs a `bin` entry as a SYMLINK on POSIX:
//
//   /usr/local/bin/obsbot-mcp -> ../lib/node_modules/obsbot-mcp/dist/index.js
//
// and node reports argv[1] as the path it was *invoked by*, not the file that
// path resolves to. Comparing the two raw strings therefore failed for every
// global install and every `npx` run on Linux and macOS: startServer() was never
// called and the process exited 0 in silence. Windows hid it — npm writes a .cmd
// shim that runs node against the real path, so the raw comparison held there.
// Resolve both sides before comparing. See test/bin-entry.test.ts.
const resolved = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    // argv[1] need not name an existing file; fall back to the raw string so an
    // unresolvable path simply fails to match rather than throwing on startup.
    return p;
  }
};

const isMain =
  process.argv[1] !== undefined &&
  resolved(fileURLToPath(import.meta.url)) === resolved(process.argv[1]);

if (isMain) {
  const debug = process.argv.includes("--debug");
  startServer({ debug }).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
