#!/usr/bin/env node
// Propagate package.json's version to the sites that cannot read it themselves.
//
// package.json is the single source of truth. The native helpers get the
// version at compile time (native/cmake/ObsbotVersion.cmake), so they are not
// handled here. Two sites remain:
//
//   src/version.ts  — src/ cannot import package.json because tsconfig sets
//                     rootDir: "src", which would drag the repo root into the
//                     compilation. Generated instead.
//   server.json     — the MCP Registry manifest. Plain JSON with no way to
//                     reference another file, and it carries the version TWICE
//                     (the server's own, and the npm package's).
//
// Runs in two places:
//   - `prebuild`, so a build can never compile a stale version
//   - the `version` npm lifecycle script, so `npm version patch` rewrites
//     everything and includes it in the release commit
//
// Idempotent: files are only written when the content actually changes, so
// running it on every build does not dirty the tree.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repoRoot, p), "utf8");

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version '${version}' is not plain semver`);
  process.exit(1);
}

/** Write only if changed, and report. Returns true if the file was touched. */
function writeIfChanged(relPath, content) {
  let current = null;
  try {
    current = read(relPath);
  } catch {
    // New file.
  }
  if (current === content) return false;
  writeFileSync(join(repoRoot, relPath), content);
  console.log(`  updated ${relPath}`);
  return true;
}

// --- src/version.ts --------------------------------------------------------

const versionTs = `// GENERATED FILE — do not edit.
//
// Written by scripts/sync-version.mjs from package.json, which is the single
// source of truth for the version. Edit package.json (or run \`npm version\`)
// instead; anything you write here is overwritten on the next build.
//
// This exists because tsconfig sets rootDir: "src", so importing ../package.json
// would pull the repo root into the compilation and change the dist/ layout.
export const VERSION = ${JSON.stringify(version)};
`;

// --- server.json -----------------------------------------------------------

const serverJson = JSON.parse(read("server.json"));
serverJson.version = version;
const npmPkg = serverJson.packages?.find((p) => p.registryType === "npm");
if (!npmPkg) {
  console.error("server.json has no npm package entry — cannot sync its version");
  process.exit(1);
}
npmPkg.version = version;

// --- write -----------------------------------------------------------------

console.log(`→ syncing version ${version} from package.json`);
const touched =
  writeIfChanged("src/version.ts", versionTs) |
  writeIfChanged("server.json", JSON.stringify(serverJson, null, 2) + "\n");

if (!touched) console.log("  already in sync");
