import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs build script with no type declarations
import { computeDigest, stampBuild } from "../scripts/stamp-build.mjs";

// A throwaway repo root holding just what the stamp looks at.
function fakeRepo(files: Record<string, string>, version = "1.2.3"): string {
  const root = mkdtempSync(join(tmpdir(), "obsbot-stamp-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const BASE = {
  "dist/index.js": "console.log('index')",
  "dist/ipc/owner.js": "console.log('owner')",
  "dist/index.js.map": "{}",
  "dist/index.d.ts": "export {};",
  "native/prebuilt/darwin-arm64/obsbot-helper": "HELPER-V1",
};

const stampOf = (root: string): { version: string; builtAt: number; digest: string } =>
  JSON.parse(readFileSync(join(root, "dist", "build-info.json"), "utf8"));

describe("computeDigest", () => {
  test("hashes path, NUL, contents, NUL for each file in sorted path order", () => {
    const root = fakeRepo({
      "native/prebuilt/x/helper": "H",
      "dist/b.js": "B",
      "dist/a.js": "A",
    });
    // Written out by hand, in sorted order, so this does not lean on the script.
    const expected = createHash("sha256")
      .update("dist/a.js\0A\0dist/b.js\0B\0native/prebuilt/x/helper\0H\0")
      .digest("hex");
    expect(computeDigest(root)).toBe(expected);
  });

  test("source maps and type declarations are not part of the build", () => {
    const withExtras = fakeRepo({ "dist/a.js": "A", "dist/a.js.map": "{}", "dist/a.d.ts": "x" });
    const without = fakeRepo({ "dist/a.js": "A" });
    expect(computeDigest(withExtras)).toBe(computeDigest(without));
  });

  test("a repo with no prebuilt helpers still has a digest", () => {
    const root = fakeRepo({ "dist/a.js": "A" });
    expect(computeDigest(root)).toBe(
      createHash("sha256").update("dist/a.js\0A\0").digest("hex"),
    );
  });
});

describe("stampBuild", () => {
  test("writes version, the build time it was given, and the digest of the code", () => {
    const root = fakeRepo({ "dist/a.js": "A", "native/prebuilt/x/helper": "H" });
    const r = stampBuild(root, 1000);
    expect(r.written).toBe(true);
    expect(stampOf(root)).toEqual({
      version: "1.2.3",
      builtAt: 1000,
      digest: createHash("sha256")
        .update("dist/a.js\0A\0native/prebuilt/x/helper\0H\0")
        .digest("hex"),
    });
  });

  test("rebuilding identical code keeps the stamp, build time included", () => {
    const root = fakeRepo(BASE);
    stampBuild(root, 1000);
    const again = stampBuild(root, 2000);
    expect(again.written).toBe(false);
    expect(stampOf(root).builtAt).toBe(1000);
  });

  test("a changed .js file is a new build", () => {
    const root = fakeRepo(BASE);
    const before = stampBuild(root, 1000).info.digest;
    writeFileSync(join(root, "dist/ipc/owner.js"), "console.log('owner v2')");
    const r = stampBuild(root, 2000);
    expect(r.written).toBe(true);
    expect(stampOf(root).builtAt).toBe(2000);
    expect(stampOf(root).digest).not.toBe(before);
  });

  test("a changed helper binary is a new build", () => {
    const root = fakeRepo(BASE);
    stampBuild(root, 1000);
    writeFileSync(join(root, "native/prebuilt/darwin-arm64/obsbot-helper"), "HELPER-V2");
    expect(stampBuild(root, 2000).written).toBe(true);
    expect(stampOf(root).builtAt).toBe(2000);
  });

  test("a changed source map is not a new build", () => {
    const root = fakeRepo(BASE);
    stampBuild(root, 1000);
    writeFileSync(join(root, "dist/index.js.map"), '{"changed":true}');
    expect(stampBuild(root, 2000).written).toBe(false);
    expect(stampOf(root).builtAt).toBe(1000);
  });

  test("a version bump restamps even when the code is identical", () => {
    const root = fakeRepo(BASE);
    stampBuild(root, 1000);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.2.4" }));
    expect(stampBuild(root, 2000).written).toBe(true);
    expect(stampOf(root)).toMatchObject({ version: "1.2.4", builtAt: 2000 });
  });

  test("the stamp does not change the digest it records", () => {
    const root = fakeRepo(BASE);
    const before = computeDigest(root);
    stampBuild(root, 1000);
    expect(computeDigest(root)).toBe(before);
  });

  test("an unreadable stamp is replaced", () => {
    const root = fakeRepo(BASE);
    writeFileSync(join(root, "dist", "build-info.json"), "not json");
    expect(stampBuild(root, 1000).written).toBe(true);
    expect(stampOf(root).builtAt).toBe(1000);
  });

  test("refuses to stamp when nothing has been built", () => {
    const root = fakeRepo({ "native/prebuilt/x/helper": "H" });
    expect(() => stampBuild(root, 1000)).toThrow(/npm run build/);
    expect(existsSync(join(root, "dist"))).toBe(false);
  });
});

describe("this checkout", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const stampPath = join(repoRoot, "dist", "build-info.json");

  test("`npm run build` left a stamp that describes the code on disk", () => {
    expect(
      existsSync(stampPath),
      "dist/build-info.json missing — run `npm run build` before `npm test`",
    ).toBe(true);
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(stamp.version).toBe(pkg.version);
    expect(Number.isFinite(stamp.builtAt) && stamp.builtAt > 0).toBe(true);
    // If this fails, dist/ or native/prebuilt/ changed without a stamp: a bare
    // `tsc`, or a helper copied into place by hand. `npm run build` fixes it.
    expect(stamp.digest).toBe(computeDigest(repoRoot));
  });
});

