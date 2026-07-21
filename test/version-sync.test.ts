import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
//  The version string is declared in five places and nothing kept them in sync.
//
//  package.json reached 0.4.0 while the MCP server handshake and all three native
//  helpers still reported "0.1.0" — three minor releases of drift, invisible
//  because the helpers are separate C/C++/ObjC binaries that no TS test reads and
//  the server's `version` only surfaces in the MCP initialize handshake.
//
//  The helpers cannot import package.json (they are compiled separately) and
//  src/ cannot import it either (tsconfig sets rootDir: "src"), so the strings
//  have to be duplicated. This test is what makes the duplication safe: it reads
//  the actual bytes of each declaration site and fails if any drifts from
//  package.json. Bumping a release now means updating every site or going red.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");

const pkgVersion = JSON.parse(read("package.json")).version as string;

test("package.json carries a plain semver version", () => {
  expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
});

// Each entry: where the version is declared, and a regex whose first capture
// group is the declared version. The macOS helper appends a "-macos" suffix, so
// the capture stops at the semver and the suffix is allowed to follow.
const SITES: Array<[label: string, path: string, pattern: RegExp]> = [
  ["MCP server handshake", "src/mcp/server.ts", /name:\s*"obsbot-mcp",\s*version:\s*"(\d+\.\d+\.\d+)"/],
  ["windows helper", "native/windows/helper.cpp", /doVersion\(\)\s*\{\s*ok\(",\\"version\\":\\"(\d+\.\d+\.\d+)/],
  ["linux helper", "native/linux/helper.c", /"version\\":\\"(\d+\.\d+\.\d+)/],
  ["macos helper", "native/macos/helper.m", /"version\\":\\"(\d+\.\d+\.\d+)/],
];

test.each(SITES)("%s declares the same version as package.json", (_label, path, pattern) => {
  const match = read(path).match(pattern);
  // A null match means the declaration moved or was reworded — that is a failure
  // too, otherwise this test would silently stop guarding the site.
  expect(match, `no version declaration matched in ${path}`).not.toBeNull();
  expect(match![1]).toBe(pkgVersion);
});
