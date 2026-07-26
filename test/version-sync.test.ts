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

// ---------------------------------------------------------------------------
//  server.json is the MCP Registry's copy of the same facts, and it drifts in
//  two ways the sites above cannot: it carries the version twice (the server's
//  own, and the npm package's), and its `name` has to equal package.json's
//  `mcpName` or the registry rejects the publish with "you do not have
//  permission to publish this server". Both are parsed rather than regexed —
//  it is our JSON, so there is no reason to read it as bytes.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(read("package.json"));
const serverJson = JSON.parse(read("server.json"));
const npmPackage = serverJson.packages?.find((p: { registryType: string }) => p.registryType === "npm");

test("server.json declares the same version as package.json", () => {
  expect(serverJson.version).toBe(pkgVersion);
});

test("server.json's npm package entry pins the published version", () => {
  expect(npmPackage, "no npm package entry in server.json").toBeDefined();
  expect(npmPackage.identifier).toBe(pkg.name);
  expect(npmPackage.version).toBe(pkgVersion);
});

test("server.json name matches package.json mcpName", () => {
  // The registry verifies npm ownership by reading mcpName out of the published
  // tarball's package.json and comparing it to this name. A mismatch is only
  // discovered at publish time, on a tag, after npm has already gone out.
  expect(pkg.mcpName).toBe(serverJson.name);
});
