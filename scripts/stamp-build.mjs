// Stamp the build with an identity: dist/build-info.json.
//
// Every obsbot-mcp instance on a machine shares one camera owner, and the owner
// executes every tool call. For a rebuild to take effect without closing every
// session, instances have to be able to tell whose build is newer — and
// package.json's version cannot do that, because it does not change between
// development rebuilds. See
// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md §5.
//
// The stamp is { version, builtAt, digest }. The digest covers the code an
// instance can run: every .js file under dist/ and every file under
// native/prebuilt/. Source maps and .d.ts files are not code an instance runs,
// so they are left out.
//
// Idempotent on purpose: if the digest and version are unchanged the file is
// left alone, builtAt included. Rebuilding identical code must not make a
// "newer" build, or every no-op rebuild would take the camera away from the
// running owner.
//
// Runs from three places:
//   - `postbuild`, so every `npm run build` stamps what tsc just wrote
//   - the end of scripts/build-helper.mjs, so a helper-only rebuild changes the
//     identity too
//   - release.yml, after the prebuilt helpers have been downloaded
//
// Usage: node scripts/stamp-build.mjs

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const STAMP_FILE = "build-info.json";

/** Every file under `dir`, recursively. A missing directory is empty. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * SHA-256 over the runnable code under `root`. Files are visited in sorted
 * order of their POSIX-style relative paths, and each contributes its path, a
 * NUL, its contents, and a NUL — so the digest depends on what the files are
 * called and contain, and on nothing else.
 */
export function computeDigest(root) {
  const files = [
    ...walk(join(root, "dist")).filter((f) => f.endsWith(".js")),
    ...walk(join(root, "native", "prebuilt")),
  ];
  const rels = files.map((f) => relative(root, f).split(sep).join("/")).sort();
  const hash = createHash("sha256");
  for (const rel of rels) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Write dist/build-info.json under `root` if the build changed.
 * Returns { written, info }; `written` is false when the existing stamp
 * already describes this build.
 */
export function stampBuild(root, now = Date.now()) {
  const dist = join(root, "dist");
  if (!existsSync(dist)) {
    throw new Error(`${dist} does not exist — run \`npm run build\` first`);
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const digest = computeDigest(root);
  const path = join(dist, STAMP_FILE);

  let current;
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // no stamp yet, or an unreadable one — either way, write a fresh one
  }
  if (
    current &&
    current.digest === digest &&
    current.version === version &&
    Number.isFinite(current.builtAt)
  ) {
    return { written: false, info: current };
  }

  const info = { version, builtAt: now, digest };
  writeFileSync(path, JSON.stringify(info, null, 2) + "\n");
  return { written: true, info };
}

/** One line for a build log. */
export function describeStamp({ written, info }) {
  const when = new Date(info.builtAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  const label = `${info.version}/${when}/${info.digest.slice(0, 8)}`;
  return written ? `→ stamped build ${label}` : `→ build unchanged, stamp kept: ${label}`;
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    console.log(describeStamp(stampBuild(repoRoot)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
