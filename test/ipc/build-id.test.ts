import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBuildId,
  compareBuilds,
  buildLabel,
  isBuildId,
  type BuildId,
} from "../../src/ipc/build-id.js";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const build = (builtAt: number, digest: string): BuildId => ({ version: "0.7.0", builtAt, digest });

// The version an unstamped build must report, read from package.json rather
// than from the module under test.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_VERSION = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;
const UNSTAMPED = { version: PKG_VERSION, builtAt: 0, digest: "unstamped" };

function stampFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "obsbot-build-id-")), "build-info.json");
  writeFileSync(path, content);
  return path;
}

describe("loadBuildId", () => {
  test("reads a well-formed stamp", () => {
    const path = stampFile(JSON.stringify({ version: "0.7.0", builtAt: 1790551781000, digest: D1 }));
    expect(loadBuildId(path)).toEqual({ version: "0.7.0", builtAt: 1790551781000, digest: D1 });
  });

  test("a missing stamp is an unstamped build, not an error", () => {
    expect(loadBuildId(join(tmpdir(), "obsbot-no-such-dir", "build-info.json"))).toEqual(UNSTAMPED);
  });

  test.each([
    ["not JSON", "{ version: "],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["builtAt as a string", JSON.stringify({ version: "0.7.0", builtAt: "1790551781000", digest: D1 })],
    ["a negative builtAt", JSON.stringify({ version: "0.7.0", builtAt: -1, digest: D1 })],
    ["a short digest", JSON.stringify({ version: "0.7.0", builtAt: 1, digest: "abc123" })],
    ["an upper-case digest", JSON.stringify({ version: "0.7.0", builtAt: 1, digest: "A".repeat(64) })],
    ["no version", JSON.stringify({ builtAt: 1, digest: D1 })],
    ["a stamp that claims to be unstamped", JSON.stringify({ version: "9.9.9", builtAt: 0, digest: "unstamped" })],
  ])("%s is an unstamped build", (_what, content) => {
    expect(loadBuildId(stampFile(content))).toEqual(UNSTAMPED);
  });
});

describe("compareBuilds", () => {
  test("the same digest is the same build, whatever the build times say", () => {
    expect(compareBuilds(build(100, D1), build(999, D1))).toBe(0);
  });

  test("the later build time is newer", () => {
    expect(compareBuilds(build(200, D1), build(100, D2))).toBeGreaterThan(0);
    expect(compareBuilds(build(100, D2), build(200, D1))).toBeLessThan(0);
  });

  test("equal build times fall back to the digest, the same way from both sides", () => {
    expect(compareBuilds(build(100, D2), build(100, D1))).toBeGreaterThan(0);
    expect(compareBuilds(build(100, D1), build(100, D2))).toBeLessThan(0);
  });

  test("version takes no part: an older version built later is newer", () => {
    const release = { version: "0.8.0", builtAt: 100, digest: D1 };
    const dev = { version: "0.7.0", builtAt: 200, digest: D2 };
    expect(compareBuilds(dev, release)).toBeGreaterThan(0);
  });

  test("an unstamped build is older than any stamped one", () => {
    expect(compareBuilds(UNSTAMPED, build(1, D1))).toBeLessThan(0);
    expect(compareBuilds(build(1, D1), UNSTAMPED)).toBeGreaterThan(0);
  });

  test("two unstamped builds are the same build", () => {
    expect(compareBuilds(UNSTAMPED, { ...UNSTAMPED, version: "0.1.0" })).toBe(0);
  });
});

describe("buildLabel", () => {
  test("version, build time to the second in UTC, first 8 of the digest", () => {
    const b = { version: "0.7.0", builtAt: 1790551781000, digest: "3f9a1c07" + "0".repeat(56) };
    expect(buildLabel(b)).toBe("0.7.0/2026-09-27T23:29:41Z/3f9a1c07");
  });

  test("an unstamped build says so", () => {
    expect(buildLabel({ version: "0.7.0", builtAt: 0, digest: "unstamped" })).toBe("0.7.0/unstamped");
  });
});

describe("isBuildId", () => {
  test("accepts a stamped and an unstamped identity", () => {
    expect(isBuildId(build(1, D1))).toBe(true);
    expect(isBuildId(UNSTAMPED)).toBe(true);
  });

  test.each([
    ["undefined", undefined],
    ["a string", "0.7.0"],
    ["null", null],
    ["an empty object", {}],
    ["a fractional-looking but infinite builtAt", { version: "0.7.0", builtAt: Infinity, digest: D1 }],
    ["NaN builtAt", { version: "0.7.0", builtAt: NaN, digest: D1 }],
    ["an unstamped digest with a build time", { version: "0.7.0", builtAt: 5, digest: "unstamped" }],
    ["an empty version", { version: "", builtAt: 1, digest: D1 }],
  ])("rejects %s", (_what, value) => {
    expect(isBuildId(value)).toBe(false);
  });
});
