import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Build identity — which build a server process has LOADED.
//
// package.json's version cannot tell two development rebuilds apart, so the
// identity comes from dist/build-info.json, written by scripts/stamp-build.mjs.
// It is read once at startup and never again: a rebuild under a running process
// changes the file but not the process, and the identity has to describe the
// process. See docs/superpowers/specs/2026-09-27-newest-build-wins-design.md §5.
// ---------------------------------------------------------------------------

export interface BuildId {
  /** package.json version. For log lines only — it takes no part in ordering. */
  version: string;
  /** Milliseconds since the epoch, taken when the stamp was written. */
  builtAt: number;
  /** SHA-256 (hex) of the code this build can run, or UNSTAMPED_DIGEST. */
  digest: string;
}

export const UNSTAMPED_DIGEST = "unstamped";

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** A build with no stamp file: older than every stamped build, equal to every other unstamped one. */
export function unstampedBuild(): BuildId {
  return { version: VERSION, builtAt: 0, digest: UNSTAMPED_DIGEST };
}

/** Is this a well-formed identity? Used on the stamp file and on what a peer sends. */
export function isBuildId(x: unknown): x is BuildId {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  if (typeof b.version !== "string" || b.version.length === 0) return false;
  if (typeof b.builtAt !== "number" || !Number.isFinite(b.builtAt) || b.builtAt < 0) return false;
  if (typeof b.digest !== "string") return false;
  return b.digest === UNSTAMPED_DIGEST ? b.builtAt === 0 : DIGEST_RE.test(b.digest);
}

/** dist/ipc/build-id.js → dist/build-info.json */
export function defaultBuildInfoPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "build-info.json");
}

/** Read the stamp. A missing or malformed file is an unstamped build, never an error. */
export function loadBuildId(path: string = defaultBuildInfoPath()): BuildId {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isBuildId(raw) && raw.digest !== UNSTAMPED_DIGEST) {
      return { version: raw.version, builtAt: raw.builtAt, digest: raw.digest };
    }
  } catch {
    // missing, unreadable, or not JSON
  }
  return unstampedBuild();
}

/**
 * Order two builds. Positive: `a` is newer. Negative: `b` is newer. Zero: the
 * same build. Both sides of a connection run this on the same two identities,
 * so it must be a total order that cannot disagree with itself.
 */
export function compareBuilds(a: BuildId, b: BuildId): number {
  if (a.digest === b.digest) return 0;
  if (a.builtAt !== b.builtAt) return a.builtAt > b.builtAt ? 1 : -1;
  return a.digest > b.digest ? 1 : -1;
}

/** `<version>/<builtAt as ISO 8601>/<first 8 of digest>`, or `<version>/unstamped`. */
export function buildLabel(b: BuildId): string {
  if (b.digest === UNSTAMPED_DIGEST) return `${b.version}/unstamped`;
  const iso = new Date(b.builtAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${b.version}/${iso}/${b.digest.slice(0, 8)}`;
}
