import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The rule that decides which USB device an AVFoundation uniqueID names lives
// in C, in the macOS helper, where no TypeScript test can reach it. It is also
// the last thing standing between "open this Tiny 2" and the helper opening
// the camera next to it. So it is kept in a header with no Apple dependencies,
// and compiled and run here with whatever C compiler the machine has.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = join(repoRoot, "native", "macos", "unique_id_test.c");

const compiler = ["cc", "clang", "gcc"].find(
  (c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0,
);

// A compiler can exist and still be unusable: clang on Windows finds no Visual
// Studio installation unless it is run from a developer prompt, and then it
// cannot find <stdio.h>. Prove the toolchain can build a trivial program
// before trusting it with the real one.
function toolchainWorks(): boolean {
  if (!compiler) return false;
  const dir = mkdtempSync(join(tmpdir(), "obsbot-c-canary-"));
  try {
    const src = join(dir, "canary.c");
    writeFileSync(src, "int main(void) { return 0; }\n");
    const out = join(dir, process.platform === "win32" ? "canary.exe" : "canary");
    return spawnSync(compiler, ["-o", out, src], { stdio: "ignore" }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reported as SKIPPED where there is no usable compiler, rather than passing
// without having run. CI has one.
test.skipIf(!toolchainWorks())("a uniqueID names the device it belongs to, and no other", () => {
  const dir = mkdtempSync(join(tmpdir(), "obsbot-unique-id-"));
  try {
    const exe = join(dir, process.platform === "win32" ? "t.exe" : "t");
    const build = spawnSync(compiler!, ["-std=c11", "-Wall", "-Wextra", "-o", exe, source], {
      encoding: "utf8",
    });
    expect(build.status, `did not compile:\n${build.stderr}`).toBe(0);

    const run = spawnSync(exe, [], { encoding: "utf8" });
    expect(run.status, run.stdout).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
