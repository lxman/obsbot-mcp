#!/usr/bin/env node
// Build the native helper for THIS machine and stage it where the Node stack
// will actually load it.
//
// The staging step is the whole point. `HelperProcess.resolveBinaryPath()`
// resolves `native/prebuilt/<platform>-<arch>/`, NOT the CMake output
// directory, so building alone changes nothing a running server can see. That
// gap is silent in the worst way: a stale binary answers every op correctly
// and simply lacks whatever you just added, so a hardware "verification" can
// pass against code you did not write. This has burned us more than once, most
// recently with a helper 11 days out of date.
//
// The triples and paths mirror .github/workflows/release.yml's build-helper
// matrix. If you change one, change the other — CI builds the binaries that
// actually ship; this script only serves local development and verification.
//
// Usage: npm run build:helper

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Keyed by process.platform. `arch` is taken from the running Node so a
// Rosetta process (darwin + x64) stages into the triple it will later read.
const TARGETS = {
  linux: { src: "native/linux", build: "native/linux/build", out: "native/linux/build", helper: "obsbot-helper" },
  darwin: { src: "native/macos", build: "native/macos/build", out: "native/macos/build", helper: "obsbot-helper" },
  win32: { src: "native/windows", build: "native/windows/build", out: "native/windows/build/Release", helper: "obsbot-helper.exe" },
};

const target = TARGETS[process.platform];
if (!target) {
  console.error(`no native helper for platform ${process.platform}`);
  process.exit(1);
}

const triple = `${process.platform}-${process.arch}`;
const run = (cmd, args) => {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
};

console.log(`→ configuring ${target.src}...`);
run("cmake", ["-S", target.src, "-B", target.build, "-DCMAKE_BUILD_TYPE=Release"]);

console.log(`→ building...`);
run("cmake", ["--build", target.build, "--config", "Release"]);

const built = join(repoRoot, target.out, target.helper);
if (!existsSync(built)) {
  console.error(`build reported success but ${built} is missing`);
  process.exit(1);
}

const destDir = join(repoRoot, "native", "prebuilt", triple);
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, target.helper);
copyFileSync(built, dest);

console.log(`\n→ staged into native/prebuilt/${triple}/${target.helper}`);
console.log("  This is the binary the Node stack loads. Rebuilding without");
console.log("  staging leaves the old one in place, silently.");
