# Newest Build Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the newest build alive own the camera endpoint and execute every tool call, so that starting one server from a new build is enough and no other session has to be closed.

**Architecture:** Each build is stamped with an identity (`dist/build-info.json`) that a process reads once at startup. Every connection to the owner opens with an exchange of identities; an owner that meets a newer build lets its running call finish, releases the camera, and gives up the endpoint, and the newer instance binds it. A client that cannot get a newer build into the owner's seat refuses to run calls on the older one.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), Node `net` (Unix-domain socket / named pipe), vitest, plain `.mjs` build scripts.

**Spec:** `docs/superpowers/specs/2026-09-27-newest-build-wins-design.md`

## Global Constraints

- **Module resolution is NodeNext:** every relative import carries a `.js` extension, even in `.ts` source. Omitting it will not compile.
- **TypeScript is `strict`.** `npx tsc -p tsconfig.json --noEmit` must print nothing at the end of every task.
- **Ordering is by build time alone.** `version` is carried for log lines and takes no part in deciding who is newer.
- **Stamp format, exactly:** `{ "version": string, "builtAt": <ms since epoch>, "digest": <64 lower-case hex> }` in `dist/build-info.json`. The digest is SHA-256 over every `*.js` under `dist/` and every file under `native/prebuilt/`, in sorted order of POSIX-style relative path, each contributing `path`, NUL, contents, NUL.
- **Timing constants, exactly:** `HELLO_TIMEOUT_MS` 2000 · `STEP_DOWN_GRACE_MS` 500 · `ELECTION_JITTER_MS` 0–100 uniform · `STEP_DOWN_TIMEOUT_MS` 15000 · `MAX_TAKEOVER_ROUNDS` 5 · `RELEASE_TIMEOUT_MS` 10000 (added by this plan, see Deviations).
- **Log lines are a contract** — the harnesses match on them. Exactly:
  - `obsbot-mcp: build <build label>`
  - `obsbot-mcp: ipc role=owner`
  - `obsbot-mcp: ipc role=client owner-pid=<pid> owner-build=<build label>` (legacy owner: `owner-pid=unknown owner-build=legacy`)
  - `obsbot-mcp: ipc takeover requested from pid <pid>`
  - `obsbot-mcp: ipc stepping down for pid <pid>`
  - `obsbot-mcp: ipc owner is older and cannot hand over; tool calls will fail until it exits`
- **A build label** is `<version>/<builtAt as ISO 8601, to the second, UTC>/<first 8 of digest>`, e.g. `0.7.0/2026-09-27T23:29:41Z/3f9a1c07`. Unstamped: `<version>/unstamped`.
- **The refusal message, exactly:** `obsbot-mcp: an older instance owns the camera endpoint and cannot hand it over. This instance will not run calls on older code. Stop the process listening on <endpoint path>; the next call will take over.`
- **`OBSBOT_IPC_NAME`** must match `^[A-Za-z0-9._-]{1,64}$`. Unset or empty means `obsbot-mcp`.
- **No test and no harness may use the default rendezvous name.** Unit tests use `tempPath()`; harnesses set `OBSBOT_IPC_NAME`. Under this design a server on the default name would take the endpoint away from the developer's live session.
- **No automated step touches hardware.** Task 12's harness is run by a person, against a Tiny 2. Nothing in this plan sends anything to a Tail 2, and nothing here is a reason to work round the candidacy gate in `src/device/manager.ts`.
- **Test style in `test/ipc/`:** `describe` / `test` from vitest, real sockets, a `cleanup` array drained in `afterEach`. Match the surrounding file.
- **Commits:** conventional style matching `git log` (`feat(ipc): …`, `test(ipc): …`, `docs: …`), each ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Inputs and failure modes the spec implies but does not spell out, most likely to bite first. Each has a test in the task that owns the code.

1. **`release()` throws, or never settles, while an owner is stepping down.** The endpoint must still change hands; a stuck helper must not strand both instances. → Task 7, "a release that throws…" and "a release that never settles…".
2. **A large reply is still in the socket buffer when the owner steps down.** A snapshot is megabytes; closing the socket the abrupt way truncates it. → Task 5, "a large reply written just before stepping down arrives complete"; Task 7, "a large reply still on its way…".
3. **The owner is killed outright and leaves a stale socket file.** A surviving client must take the endpoint without anyone making a tool call. → Task 11, the `SIGKILL` step of the smoke test.
4. **The owner answers the hello with something malformed.** A half-valid identity must never be compared as if it were a build. → Task 6, "an owner that answers with … is treated as legacy, never as a peer".
5. **`OBSBOT_IPC_NAME` is empty, or hostile** (path separators, a parent-directory walk, a NUL, overlong). Empty must mean the default; the rest must be refused before they reach a path. → Task 3.

## Deviations from the spec

Found while writing the code. Task 13 writes each back into the spec.

| Spec | Plan | Why |
|---|---|---|
| §7.3 lists five constants | Adds `RELEASE_TIMEOUT_MS` = 10000 | The spec bounds how long the successor waits but not how long the old owner waits on its own `release`. Without a bound a hung helper strands both. It must stay under `STEP_DOWN_TIMEOUT_MS`. |
| §10: anything not matching the pattern is a startup error | An **empty** `OBSBOT_IPC_NAME` means the default | An MCP client config that declares the variable with no value should not stop the server starting. |
| §12: the lock moves "into the coordinator" | It moves into its own file, `src/ipc/gate.ts`, owned by the coordinator | It is a unit with one job and its own tests. |
| §12: `Coordinator` options are `path`, `build`, `release`, `log` | Adds `pid`, `timing`, `elect` | In-process tests share one real pid and cannot wait real delays; `elect` lets a test decide who binds first, which is otherwise a race. |
| §11: `server.ts` logs the role | The coordinator logs it, on every change | The role is no longer fixed at startup. |
| §13.2: the smoke test covers the takeover | It also kills the owner with `SIGKILL` | Review Focus 3. |

## How the code in this plan was checked

Every code block in Tasks 1–11 was run before this plan was written, in a throwaway copy of the sources outside the repository:

- At the end of **each** task the project compiled (`tsc`) and its tests passed.
- Each task's tests were run against the previous task's code first. The "Expected" counts under "verify it fails" are what that produced.
- The sharing-layer suite was run 25 to 30 times over at each of Tasks 7, 8 and 9 without a failure. One test did fail intermittently in the first draft; it asserted an exact sequence that is genuinely a race. It was rewritten to assert what holds either way, and the comment on it says so.
- Task 11's smoke test ran against two real server processes, including the `SIGKILL` step.

**Task 12 was not run.** It needs a Tiny 2. Its script passes `node --check` and shares its process handling with Task 11's.

Diff blocks are exact. Save one to a file and `git apply` it, or make the change by hand.

## Before you start

- [ ] **Work on a branch, not on `master`.**

```bash
git switch -c feat/newest-build-wins
```

- [ ] **Check what the working tree is carrying.** On 2026-09-27 it held uncommitted changes to `TAIL2-PROTOCOL.md`, `native/macos/helper.m`, `scripts/build-helper.mjs`, `src/device/manager.ts` and `test/device/manager.test.ts` (the Tail 2 candidacy guard, and the staging fix in the build script). This plan builds on them: Task 2 edits `scripts/build-helper.mjs` and Task 10 appends to `test/device/manager.test.ts`. If they are still uncommitted, stop and ask whether to commit them first. Do not start in a fresh worktree made from `HEAD` without them.

```bash
git status --short
```

- [ ] **Build once, so the suite has a `dist/` to look at.**

```bash
npm run build && npm test
```

Expected: every test passes. `test/bin-entry.test.ts` needs `dist/index.js`, and from Task 2 on `test/stamp-build.test.ts` needs `dist/build-info.json`.

---

### Task 1: Build identity

What a process knows about the build it loaded, and how two builds are ordered.

**Files:**
- Create: `src/ipc/build-id.ts`
- Test: `test/ipc/build-id.test.ts`

**Interfaces:**
- Consumes: `VERSION` from `src/version.ts`.
- Produces:
  - `interface BuildId { version: string; builtAt: number; digest: string }`
  - `UNSTAMPED_DIGEST = "unstamped"`
  - `unstampedBuild(): BuildId` — `{ version: VERSION, builtAt: 0, digest: "unstamped" }`
  - `isBuildId(x: unknown): x is BuildId`
  - `defaultBuildInfoPath(): string`
  - `loadBuildId(path?: string): BuildId` — never throws
  - `compareBuilds(a: BuildId, b: BuildId): number` — positive when `a` is newer, zero when they are the same build
  - `buildLabel(b: BuildId): string`

- [ ] **Step 1: Write the failing test**

Create `test/ipc/build-id.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ipc/build-id.test.ts`

Expected: FAIL — `Cannot find module '../../src/ipc/build-id.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/ipc/build-id.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ipc/build-id.test.ts && npx tsc -p tsconfig.json --noEmit`

Expected: 29 passed. `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/build-id.ts test/ipc/build-id.test.ts
git commit -m "feat(ipc): a build identity that can tell two rebuilds apart" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Stamp the build

Writes `dist/build-info.json`, and runs wherever a build is made.

**Files:**
- Create: `scripts/stamp-build.mjs`
- Test: `test/stamp-build.test.ts`
- Modify: `package.json` (one script)
- Modify: `scripts/build-helper.mjs` (one import, one block at the end)
- Modify: `.github/workflows/release.yml` (one step, one check)

**Interfaces:**
- Consumes: nothing from earlier tasks. The stamp it writes is what Task 1's `loadBuildId()` reads.
- Produces, from `scripts/stamp-build.mjs`:
  - `computeDigest(root: string): string`
  - `stampBuild(root: string, now?: number): { written: boolean, info: { version, builtAt, digest } }` — throws if `<root>/dist` does not exist
  - `describeStamp({ written, info }): string`

- [ ] **Step 1: Write the failing test**

Create `test/stamp-build.test.ts`:

```ts
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

```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/stamp-build.test.ts`

Expected: FAIL — `Cannot find module '../scripts/stamp-build.mjs'`.

- [ ] **Step 3: Write the script**

Create `scripts/stamp-build.mjs`:

```js
#!/usr/bin/env node
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
```

- [ ] **Step 4: Run it on every build**

In `package.json`, add `postbuild` directly after the `build` script:

```json
    "build": "tsc -p tsconfig.json",
    "postbuild": "node scripts/stamp-build.mjs",
```

- [ ] **Step 5: Run it after a helper is staged**

In `scripts/build-helper.mjs`, add this import after the existing `node:path` import:

```js
import { describeStamp, stampBuild } from "./stamp-build.mjs";
```

and append this to the end of the file, after the last `console.log`:

```js

// A new helper is a new build. Every running instance compares build
// identities to decide who owns the camera, and the identity covers the staged
// helpers — so stamp it now, or a helper-only rebuild would look like no change
// at all and the instance already running would keep its old helper.
if (existsSync(join(repoRoot, "dist"))) {
  console.log(describeStamp(stampBuild(repoRoot)));
} else {
  console.log("→ dist/ is not built yet; `npm run build` will stamp the build identity");
}
```

`existsSync`, `join` and `repoRoot` are already in scope in that file.

- [ ] **Step 6: Run it in the release job, after the helpers arrive**

In `.github/workflows/release.yml`, insert this step immediately before the step named `Verify staged binary layout`:

```yaml
      # The build identity (dist/build-info.json) covers dist/ AND the prebuilt
      # helpers. `npm run build` above stamped dist/ alone, because the helpers
      # had not been downloaded yet. Stamp again now that they are in place, so
      # the identity that ships describes what ships. See scripts/stamp-build.mjs.
      - name: Stamp the build identity
        run: node scripts/stamp-build.mjs
```

and in the step named `Verify tarball contents`, add this check directly after the `dist/index.js` one:

```yaml
          grep -q "dist/build-info.json" pack.txt \
            || { echo "::error::dist/build-info.json missing from tarball"; exit 1; }
```

- [ ] **Step 7: Build, then run the test to verify it passes**

Run: `npm run build && npx vitest run test/stamp-build.test.ts`

Expected: the build's last line is `→ stamped build 0.7.0/<time>/<8 hex>`. Then 13 passed.

Run `npm run build` a second time. Expected last line: `→ build unchanged, stamp kept: …` with the **same** time.

- [ ] **Step 8: Check the package would carry it**

Run: `npm pack --dry-run 2>&1 | grep build-info`

Expected: one line naming `dist/build-info.json`.

- [ ] **Step 9: Commit**

```bash
git add scripts/stamp-build.mjs test/stamp-build.test.ts package.json scripts/build-helper.mjs .github/workflows/release.yml
git commit -m "build: stamp every build with an identity" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: A rendezvous name you can set

**Files:**
- Modify: `src/ipc/rendezvous.ts`
- Test: `test/ipc/rendezvous.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `rendezvousName(env?: NodeJS.ProcessEnv): string` — throws on a name outside the pattern
  - `rendezvousPath(name?: string): string` — its default is now `rendezvousName()`; an explicit name is used as given, which is what the existing tests rely on

- [ ] **Step 1: Write the failing tests**

Apply to `test/ipc/rendezvous.test.ts`:

```diff
diff --git a/test/ipc/rendezvous.test.ts b/test/ipc/rendezvous.test.ts
index 6bba343..36ac148 100644
--- a/test/ipc/rendezvous.test.ts
+++ b/test/ipc/rendezvous.test.ts
@@ -1,5 +1,5 @@
 import { describe, test, expect, afterEach } from "vitest";
-import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
+import { elect, rendezvousName, rendezvousPath } from "../../src/ipc/rendezvous.js";
 
 // A unique endpoint per test, so we never touch the real "obsbot-mcp"
 // rendezvous (a live MCP server may own it) and parallel tests don't collide.
@@ -37,3 +37,38 @@ describe("peer election", () => {
     expect(c.role).toBe("owner");
   });
 });
+
+describe("rendezvous name", () => {
+  test("defaults to the well-known name", () => {
+    expect(rendezvousName({})).toBe("obsbot-mcp");
+  });
+
+  test("an empty OBSBOT_IPC_NAME means the default", () => {
+    expect(rendezvousName({ OBSBOT_IPC_NAME: "" })).toBe("obsbot-mcp");
+  });
+
+  test("takes the name from OBSBOT_IPC_NAME", () => {
+    expect(rendezvousName({ OBSBOT_IPC_NAME: "obsbot-dev.2_a" })).toBe("obsbot-dev.2_a");
+  });
+
+  test("the name decides the endpoint", () => {
+    const expected =
+      process.platform === "win32" ? "\\\\.\\pipe\\obsbot-dev" : "/tmp/obsbot-dev.sock";
+    expect(rendezvousPath(rendezvousName({ OBSBOT_IPC_NAME: "obsbot-dev" }))).toBe(expected);
+  });
+
+  test.each([
+    ["a path separator", "a/b"],
+    ["a backslash", "a\\b"],
+    ["a parent-directory walk", "../../etc/x"],
+    ["a space", "my name"],
+    ["a NUL", "a\0b"],
+    ["65 characters", "x".repeat(65)],
+  ])("refuses %s", (_what, value) => {
+    expect(() => rendezvousName({ OBSBOT_IPC_NAME: value })).toThrow(/OBSBOT_IPC_NAME/);
+  });
+
+  test("accepts 64 characters", () => {
+    expect(rendezvousName({ OBSBOT_IPC_NAME: "x".repeat(64) })).toBe("x".repeat(64));
+  });
+});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ipc/rendezvous.test.ts`

Expected: 11 failed, 2 passed. The failures are `rendezvousName is not a function`.

- [ ] **Step 3: Write the implementation**

Apply to `src/ipc/rendezvous.ts`:

```diff
diff --git a/src/ipc/rendezvous.ts b/src/ipc/rendezvous.ts
index 333dc74..b759565 100644
--- a/src/ipc/rendezvous.ts
+++ b/src/ipc/rendezvous.ts
@@ -15,8 +15,35 @@ import { unlinkSync } from "node:fs";
 // crash-detection for free.
 // ---------------------------------------------------------------------------
 
-/** Well-known rendezvous name → platform endpoint. */
-export function rendezvousPath(name = "obsbot-mcp"): string {
+const DEFAULT_NAME = "obsbot-mcp";
+const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
+
+/**
+ * The rendezvous name: OBSBOT_IPC_NAME, or the well-known default.
+ *
+ * Every instance that should share one camera owner must use the same name, so
+ * the default is right for normal use. The variable exists for test harnesses
+ * — which would otherwise take the endpoint away from a developer's live
+ * session — and for deliberately isolating one session on its own build.
+ *
+ * The name becomes part of a filesystem path or pipe name, so anything outside
+ * a conservative character set is refused rather than sanitised. Unset and
+ * empty both mean the default: an MCP client config that declares the variable
+ * with no value should not be a startup error.
+ */
+export function rendezvousName(env: NodeJS.ProcessEnv = process.env): string {
+  const raw = env.OBSBOT_IPC_NAME;
+  if (raw === undefined || raw === "") return DEFAULT_NAME;
+  if (!NAME_RE.test(raw)) {
+    throw new Error(
+      `OBSBOT_IPC_NAME must be 1-64 characters from A-Z a-z 0-9 . _ - (got ${JSON.stringify(raw)})`,
+    );
+  }
+  return raw;
+}
+
+/** Rendezvous name → platform endpoint. */
+export function rendezvousPath(name: string = rendezvousName()): string {
   return process.platform === "win32"
     ? `\\\\.\\pipe\\${name}`
     : `/tmp/${name}.sock`; // portable across macOS + Linux; abstract sockets are Linux-only
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ipc/rendezvous.test.ts && npx tsc -p tsconfig.json --noEmit`

Expected: 13 passed. `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/rendezvous.ts test/ipc/rendezvous.test.ts
git commit -m "feat(ipc): OBSBOT_IPC_NAME selects the rendezvous endpoint" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The call gate

The single-camera lock, with a way to close it.

**Files:**
- Create: `src/ipc/gate.ts`
- Test: `test/ipc/gate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class StepDownError extends Error` — `name === "StepDownError"`
  - `class CallGate` with `run<T>(fn: () => Promise<T>): Promise<T>`, `close(): Promise<void>`, `open(): void`

- [ ] **Step 1: Write the failing test**

Create `test/ipc/gate.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { CallGate, StepDownError } from "../../src/ipc/gate.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("call gate", () => {
  test("runs calls one at a time, in the order they were made", async () => {
    const gate = new CallGate();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const call = (name: string, ms: number) =>
      gate.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(ms);
        order.push(name);
        inFlight--;
        return name;
      });

    const results = await Promise.all([call("a", 15), call("b", 1), call("c", 5)]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxInFlight).toBe(1);
  });

  test("a failing call does not stop the ones behind it", async () => {
    const gate = new CallGate();
    const first = gate.run(async () => {
      throw new Error("kaboom");
    });
    const second = gate.run(async () => "fine");

    await expect(first).rejects.toThrow("kaboom");
    expect(await second).toBe("fine");
  });

  test("closing lets the running call finish and refuses the ones that had not started", async () => {
    const gate = new CallGate();
    const events: string[] = [];
    const running = gate.run(async () => {
      await sleep(20);
      events.push("running finished");
      return "ran";
    });
    let queuedStarted = false;
    const queued = gate.run(async () => {
      queuedStarted = true;
      return "must not run";
    });
    const queuedOutcome = queued.then(
      () => "resolved",
      (e: unknown) => e,
    );

    await sleep(5); // the first call is now in flight
    await gate.close().then(() => events.push("close resolved"));

    expect(await running).toBe("ran");
    expect(await queuedOutcome).toBeInstanceOf(StepDownError);
    expect(queuedStarted).toBe(false);
    expect(events).toEqual(["running finished", "close resolved"]);
  });

  test("a call made after the gate closed is refused", async () => {
    const gate = new CallGate();
    await gate.close();
    await expect(gate.run(async () => "no")).rejects.toBeInstanceOf(StepDownError);
  });

  test("closing an idle gate resolves at once", async () => {
    const gate = new CallGate();
    await expect(gate.close()).resolves.toBeUndefined();
  });

  test("an opened gate runs calls again", async () => {
    const gate = new CallGate();
    await gate.close();
    gate.open();
    expect(await gate.run(async () => "back")).toBe("back");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ipc/gate.test.ts`

Expected: FAIL — `Cannot find module '../../src/ipc/gate.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/ipc/gate.ts`:

```ts
// ---------------------------------------------------------------------------
// The single-camera lock, with a way to close it.
//
// Tool calls run strictly one at a time: the camera is one device and the XU
// selector-2 reply mailbox is a single shared slot, so two calls in flight at
// once would interleave on the wire. That part is unchanged from the old
// serialize() wrapper.
//
// What is new is close(). An owner that is handing the endpoint to a newer
// build must let the call that is RUNNING finish, and must stop every call that
// has not started — those belong to the new owner now. close() does both, and
// resolves once nothing is running.
// ---------------------------------------------------------------------------

/** Thrown to a call that had not started when the gate closed. */
export class StepDownError extends Error {
  constructor() {
    super("obsbot-mcp: this instance is handing the camera to a newer build");
    this.name = "StepDownError";
  }
}

export class CallGate {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  /** Run `fn` after every call queued before it. Rejects with StepDownError if the gate closes first. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.closed) throw new StepDownError();
      return fn();
    });
    // Errors don't break the chain.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Refuse calls that have not started; resolve when the running one has finished. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  /** Accept calls again. */
  open(): void {
    this.closed = false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ipc/gate.test.ts && npx tsc -p tsconfig.json --noEmit`

Expected: 6 passed. `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/gate.ts test/ipc/gate.test.ts
git commit -m "feat(ipc): a call gate that can refuse what has not started" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The owner answers control messages

Hello and takeover are answered at once, outside the queue. A call the gate refused goes unanswered. Stepping down frees the endpoint and lets what is already written arrive.

`OwnerServer`'s constructor gains a required third argument, so this task also makes the two existing callers pass one. The coordinator gets a placeholder that refuses every takeover; Task 7 replaces it.

**Files:**
- Modify: `src/ipc/protocol.ts` (append)
- Modify: `src/ipc/owner.ts` (replace)
- Modify: `src/ipc/coordinator.ts` (keep it compiling)
- Test: `test/ipc/owner.test.ts`
- Modify: `test/ipc/client.test.ts` (its `ownerOn` helper only)

**Interfaces:**
- Consumes: `BuildId`, `isBuildId`, `unstampedBuild` (Task 1); `StepDownError` (Task 4).
- Produces, from `src/ipc/protocol.ts`:
  - `NOTICE_ID = 0`
  - `interface HelloBody { ipc: "hello"; build: BuildId; pid: number }`
  - `interface TakeoverBody { ipc: "takeover"; build: BuildId; pid: number }`
  - `interface SteppingDownBody { ipc: "stepping-down"; successorPid: number }`
  - `type TakeoverResult = { ipc: "takeover"; granted: true } | { ipc: "takeover"; granted: false; reason: "not-newer" }`
  - `asHello(body: unknown): HelloBody | undefined`
  - `asTakeover(body: unknown): TakeoverBody | undefined`
  - `isSteppingDown(body: unknown): body is SteppingDownBody`
- Produces, from `src/ipc/owner.ts`:
  - `interface ControlHandlers { identity: () => { build: BuildId; pid: number }; takeover: (build: BuildId, pid: number) => TakeoverResult }`
  - `new OwnerServer(server: net.Server, handle: Handler, control: ControlHandlers)`
  - `OwnerServer.idle(): Promise<void>`
  - `OwnerServer.stepDown(notice: SteppingDownBody): Promise<void>`
  - `OwnerServer.close(): Promise<void>` — unchanged
  - `Handler`, `ReplyBody` — unchanged

- [ ] **Step 1: Write the failing tests**

Apply to `test/ipc/owner.test.ts`:

```diff
diff --git a/test/ipc/owner.test.ts b/test/ipc/owner.test.ts
index c3fe832..a798ee4 100644
--- a/test/ipc/owner.test.ts
+++ b/test/ipc/owner.test.ts
@@ -1,8 +1,10 @@
 import { describe, test, expect, afterEach } from "vitest";
 import net from "node:net";
 import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
-import { OwnerServer } from "../../src/ipc/owner.js";
+import { OwnerServer, type ControlHandlers } from "../../src/ipc/owner.js";
 import { encodeFrame, FrameDecoder } from "../../src/ipc/protocol.js";
+import { StepDownError } from "../../src/ipc/gate.js";
+import type { BuildId } from "../../src/ipc/build-id.js";
 
 const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
 
@@ -10,9 +12,22 @@ function tempPath(): string {
   return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
 }
 
+const OWNER_BUILD: BuildId = { version: "0.7.0", builtAt: 500, digest: "a".repeat(64) };
+const NEWER_BUILD: BuildId = { version: "0.7.0", builtAt: 900, digest: "b".repeat(64) };
+
+/** An owner that knows who it is and never hands over. */
+const REFUSES: ControlHandlers = {
+  identity: () => ({ build: OWNER_BUILD, pid: 4242 }),
+  takeover: () => ({ ipc: "takeover", granted: false, reason: "not-newer" }),
+};
+
 // Minimal framed client for exercising the owner (the real one is brick 4).
 async function rawClient(path: string): Promise<{
   call: (body: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
+  /** Frames that were not a reply to any call, in arrival order. */
+  notices: Array<{ id: number; body: unknown }>;
+  /** Resolves when the owner closes the connection. */
+  ended: Promise<void>;
   close: () => void;
 }> {
   const socket = net.connect(path);
@@ -22,15 +37,19 @@ async function rawClient(path: string): Promise<{
   });
   const dec = new FrameDecoder();
   const pending = new Map<number, (b: unknown) => void>();
+  const notices: Array<{ id: number; body: unknown }> = [];
   socket.on("data", (chunk: Buffer) => {
     for (const m of dec.push(chunk)) {
       const r = pending.get(m.id);
       if (r) {
         pending.delete(m.id);
         r(m.body);
+      } else {
+        notices.push(m);
       }
     }
   });
+  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
   let nextId = 1;
   return {
     call(body) {
@@ -40,14 +59,20 @@ async function rawClient(path: string): Promise<{
         socket.write(encodeFrame({ id, body }));
       });
     },
+    notices,
+    ended,
     close: () => socket.destroy(),
   };
 }
 
-async function owner(path: string, handle: (body: unknown) => Promise<unknown>): Promise<OwnerServer> {
+async function owner(
+  path: string,
+  handle: (body: unknown) => Promise<unknown>,
+  control: ControlHandlers = REFUSES,
+): Promise<OwnerServer> {
   const role = await elect(path);
   if (role.role !== "owner") throw new Error("expected to elect as owner");
-  return new OwnerServer(role.server, handle);
+  return new OwnerServer(role.server, handle, control);
 }
 
 describe("owner server", () => {
@@ -100,4 +125,169 @@ describe("owner server", () => {
     expect(maxInFlight).toBe(1); // never two handler calls at once
     expect(replies.every((r) => r.ok === true)).toBe(true);
   });
+
+  test("answers a hello with its own identity", async () => {
+    const path = tempPath();
+    const srv = await owner(path, async () => "unused");
+    cleanup.push(() => srv.close());
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    expect(await c.call({ ipc: "hello", build: NEWER_BUILD, pid: 7 })).toEqual({
+      ok: true,
+      result: { ipc: "hello", build: OWNER_BUILD, pid: 4242 },
+    });
+  });
+
+  test("answers a hello while a tool call is still running", async () => {
+    const path = tempPath();
+    const srv = await owner(path, async () => {
+      await sleep(150);
+      return "slow";
+    });
+    cleanup.push(() => srv.close());
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    const arrived: string[] = [];
+    const slow = c.call({ tool: "obsbot_capture_snapshot", args: {} }).then(() => arrived.push("tool"));
+    const hello = c.call({ ipc: "hello", build: NEWER_BUILD, pid: 7 }).then(() => arrived.push("hello"));
+    await Promise.all([slow, hello]);
+
+    expect(arrived).toEqual(["hello", "tool"]);
+  });
+
+  test("hands a takeover request to the control handler and replies with its decision", async () => {
+    const path = tempPath();
+    const asked: Array<{ build: BuildId; pid: number }> = [];
+    const srv = await owner(path, async () => "unused", {
+      identity: REFUSES.identity,
+      takeover: (build, pid) => {
+        asked.push({ build, pid });
+        return { ipc: "takeover", granted: true };
+      },
+    });
+    cleanup.push(() => srv.close());
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    expect(await c.call({ ipc: "takeover", build: NEWER_BUILD, pid: 7 })).toEqual({
+      ok: true,
+      result: { ipc: "takeover", granted: true },
+    });
+    expect(asked).toEqual([{ build: NEWER_BUILD, pid: 7 }]);
+  });
+
+  test.each([
+    ["a hello with no build", { ipc: "hello", pid: 7 }],
+    ["a hello with a malformed build", { ipc: "hello", build: { version: "x" }, pid: 7 }],
+    ["a takeover with no pid", { ipc: "takeover", build: NEWER_BUILD }],
+    ["an unknown control message", { ipc: "reboot" }],
+  ])("treats %s as an ordinary request, not as control", async (_what, body) => {
+    const path = tempPath();
+    let takeovers = 0;
+    const srv = await owner(
+      path,
+      async () => {
+        throw new Error("unknown tool: undefined");
+      },
+      {
+        identity: REFUSES.identity,
+        takeover: () => {
+          takeovers++;
+          return { ipc: "takeover", granted: true };
+        },
+      },
+    );
+    cleanup.push(() => srv.close());
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    expect(await c.call(body)).toEqual({ ok: false, error: "unknown tool: undefined" });
+    expect(takeovers).toBe(0);
+  });
+
+  test("leaves a request refused by the closed gate unanswered", async () => {
+    const path = tempPath();
+    const srv = await owner(path, async (body) => {
+      if ((body as { tool: string }).tool === "refused") throw new StepDownError();
+      return "answered";
+    });
+    cleanup.push(() => srv.close());
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    let refusedReply: unknown = "no reply";
+    void c.call({ tool: "refused", args: {} }).then((r) => (refusedReply = r));
+    // A later request on the same connection is answered, so the silence above
+    // is a decision and not a stalled queue.
+    expect(await c.call({ tool: "fine", args: {} })).toEqual({ ok: true, result: "answered" });
+    expect(refusedReply).toBe("no reply");
+  });
+
+  test("idle() resolves once everything received so far has been dealt with", async () => {
+    const path = tempPath();
+    let done = 0;
+    const srv = await owner(path, async () => {
+      await sleep(20);
+      done++;
+      return done;
+    });
+    cleanup.push(() => srv.close());
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    void c.call({ tool: "a", args: {} });
+    void c.call({ tool: "b", args: {} });
+    await sleep(5); // both have reached the owner
+    await srv.idle();
+
+    expect(done).toBe(2);
+  });
+
+  test("stepping down tells every client why, then closes their connections", async () => {
+    const path = tempPath();
+    const srv = await owner(path, async () => "unused");
+    const c1 = await rawClient(path);
+    const c2 = await rawClient(path);
+    cleanup.push(() => c1.close());
+    cleanup.push(() => c2.close());
+
+    await srv.stepDown({ ipc: "stepping-down", successorPid: 99 });
+    await Promise.all([c1.ended, c2.ended]);
+
+    const notice = { id: 0, body: { ipc: "stepping-down", successorPid: 99 } };
+    expect(c1.notices).toEqual([notice]);
+    expect(c2.notices).toEqual([notice]);
+  });
+
+  test("the endpoint is free as soon as stepping down has finished", async () => {
+    const path = tempPath();
+    const srv = await owner(path, async () => "unused");
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    await srv.stepDown({ ipc: "stepping-down", successorPid: 99 });
+
+    const next = await elect(path);
+    cleanup.push(() => next.role === "owner" && next.server.close());
+    expect(next.role).toBe("owner");
+  });
+
+  test("a large reply written just before stepping down arrives complete", async () => {
+    // A snapshot is megabytes of base64. destroy() would drop whatever had not
+    // been flushed yet; the reply must survive the handover.
+    const path = tempPath();
+    const big = "x".repeat(4 * 1024 * 1024);
+    const srv = await owner(path, async () => big);
+    const c = await rawClient(path);
+    cleanup.push(() => c.close());
+
+    const reply = c.call({ tool: "obsbot_capture_snapshot", args: {} });
+    await sleep(5); // the request has reached the owner
+    await srv.idle(); // …and its reply has been written
+    await srv.stepDown({ ipc: "stepping-down", successorPid: 99 });
+
+    expect(await reply).toEqual({ ok: true, result: big });
+  });
 });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ipc/owner.test.ts`

Expected: 8 failed, 6 passed. The old owner treats a hello as a tool call, so `answers a hello with its own identity` gets `{ ok: true, result: 'unused' }`, and `stepDown` / `idle` do not exist yet.

- [ ] **Step 3: Add the control messages to the protocol**

Apply to `src/ipc/protocol.ts`:

```diff
diff --git a/src/ipc/protocol.ts b/src/ipc/protocol.ts
index 7676384..232b6cd 100644
--- a/src/ipc/protocol.ts
+++ b/src/ipc/protocol.ts
@@ -1,3 +1,5 @@
+import { isBuildId, type BuildId } from "./build-id.js";
+
 // ---------------------------------------------------------------------------
 // Length-prefixed JSON framing for the client↔owner control channel.
 //
@@ -60,3 +62,67 @@ export class FrameDecoder {
     return out;
   }
 }
+
+// ---------------------------------------------------------------------------
+// Control messages — how instances agree on who owns the endpoint.
+//
+// A tool request's body is {tool, args}. A control message is a body with a
+// reserved `ipc` key, carried in the same frames. See
+// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md §6.
+//
+// An instance that predates these treats any body as a tool call, so a hello
+// sent to it comes back as {ok:false, error:"unknown tool: undefined"} — which
+// is how a legacy owner is recognised. A legacy CLIENT ignores a frame whose id
+// it is not waiting for, so a notice sent with NOTICE_ID is harmless to it.
+// ---------------------------------------------------------------------------
+
+/** Frame id of an owner→client notice. Request ids start at 1, so it never matches a reply. */
+export const NOTICE_ID = 0;
+
+export interface HelloBody {
+  ipc: "hello";
+  build: BuildId;
+  pid: number;
+}
+
+export interface TakeoverBody {
+  ipc: "takeover";
+  build: BuildId;
+  pid: number;
+}
+
+export interface SteppingDownBody {
+  ipc: "stepping-down";
+  successorPid: number;
+}
+
+export type TakeoverResult =
+  | { ipc: "takeover"; granted: true }
+  | { ipc: "takeover"; granted: false; reason: "not-newer" };
+
+const isPid = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;
+
+function identityOf(body: unknown, kind: "hello" | "takeover"): { build: BuildId; pid: number } | undefined {
+  if (typeof body !== "object" || body === null) return undefined;
+  const b = body as Record<string, unknown>;
+  if (b.ipc !== kind || !isBuildId(b.build) || !isPid(b.pid)) return undefined;
+  return { build: b.build, pid: b.pid };
+}
+
+/** The body as a hello, or undefined if it is not a well-formed one. */
+export function asHello(body: unknown): HelloBody | undefined {
+  const id = identityOf(body, "hello");
+  return id && { ipc: "hello", ...id };
+}
+
+/** The body as a takeover request, or undefined if it is not a well-formed one. */
+export function asTakeover(body: unknown): TakeoverBody | undefined {
+  const id = identityOf(body, "takeover");
+  return id && { ipc: "takeover", ...id };
+}
+
+export function isSteppingDown(body: unknown): body is SteppingDownBody {
+  if (typeof body !== "object" || body === null) return false;
+  const b = body as Record<string, unknown>;
+  return b.ipc === "stepping-down" && isPid(b.successorPid);
+}
```

- [ ] **Step 4: Replace the owner server**

Replace `src/ipc/owner.ts` with:

```ts
import net from "node:net";
import type { BuildId } from "./build-id.js";
import { StepDownError } from "./gate.js";
import {
  encodeFrame,
  FrameDecoder,
  NOTICE_ID,
  asHello,
  asTakeover,
  type RpcMessage,
  type SteppingDownBody,
  type TakeoverResult,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Owner-side IPC server.
//
// The elected owner accepts client connections over the rendezvous endpoint,
// decodes framed requests, and runs each through an injected `handle` —
// SERIALIZED across every client. Serialization is not optional: the camera is
// one device and the XU selector-2 reply mailbox is a single shared slot, so
// two requests in flight at once would interleave on the wire and cross-read
// each other's replies. Replies are framed back with the request's `id`.
//
// `handle` is intentionally opaque here (it's wired to the real tool dispatch
// at startup). The owner holds the ONE DeviceManager + native helper; clients
// never touch the device directly — they forward whole requests to this server.
//
// Control messages (hello, takeover) are NOT tool calls and do not wait in that
// queue. A client's startup waits on its hello, and startup must not wait for
// someone else's snapshot or gimbal move to finish.
// ---------------------------------------------------------------------------

export type Handler = (body: unknown) => Promise<unknown>;

export type ReplyBody =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface ControlHandlers {
  /** This instance's identity, for the hello reply. */
  identity: () => { build: BuildId; pid: number };
  /** A client asks for the endpoint. Decide; if granted, the caller starts stepping down. */
  takeover: (build: BuildId, pid: number) => TakeoverResult;
}

/** How long a client gets to close its end after we have ended ours. */
const STRAGGLER_MS = 1000;

export class OwnerServer {
  /** Single promise chain → exactly one handler call runs at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly server: net.Server,
    private readonly handle: Handler,
    private readonly control: ControlHandlers,
  ) {
    this.server.on("connection", (sock) => this.accept(sock));
  }

  private accept(sock: net.Socket): void {
    this.sockets.add(sock);
    const dec = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      let msgs: RpcMessage[];
      try {
        msgs = dec.push(chunk);
      } catch {
        sock.destroy(); // unrecoverable framing error → drop this client
        return;
      }
      for (const msg of msgs) {
        if (!this.answerControl(sock, msg)) this.enqueue(sock, msg);
      }
    });
    const drop = (): void => {
      this.sockets.delete(sock);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  }

  /** Answer a control message at once, outside the queue. False if `msg` is not one. */
  private answerControl(sock: net.Socket, msg: RpcMessage): boolean {
    const reply = (result: unknown): void => {
      if (!sock.destroyed) sock.write(encodeFrame({ id: msg.id, body: { ok: true, result } }));
    };
    if (asHello(msg.body)) {
      reply({ ipc: "hello", ...this.control.identity() });
      return true;
    }
    const takeover = asTakeover(msg.body);
    if (takeover) {
      // Written before anything the grant sets in motion can close this socket.
      reply(this.control.takeover(takeover.build, takeover.pid));
      return true;
    }
    return false;
  }

  private enqueue(sock: net.Socket, msg: RpcMessage): void {
    // Chain onto the shared queue so requests run one-at-a-time across all
    // clients. The chain never rejects (errors become error replies), so one
    // failing op can't stall the rest.
    this.queue = this.queue.then(async () => {
      const body = await this.run(msg.body);
      if (body === undefined) return;
      if (!sock.destroyed) sock.write(encodeFrame({ id: msg.id, body }));
    });
  }

  /** The reply for a request, or undefined when the request must go unanswered. */
  private async run(reqBody: unknown): Promise<ReplyBody | undefined> {
    try {
      return { ok: true, result: await this.handle(reqBody) };
    } catch (e) {
      // The gate closed before this call started: it belongs to the next owner.
      // An error reply would be wrong — the client would surface it. Left
      // unanswered, the closing socket makes the client retry it there.
      if (e instanceof StepDownError) return undefined;
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Resolves once every request received so far has been answered or dropped. */
  idle(): Promise<void> {
    return this.queue;
  }

  /**
   * Give up the endpoint in an orderly way: free the name, tell every client
   * why, and let what is already written reach them.
   *
   * end(), not destroy(): destroy() discards whatever is still buffered, which
   * would lose the notice and could truncate the reply to the call that just
   * finished — a snapshot is megabytes.
   */
  async stepDown(notice: SteppingDownBody): Promise<void> {
    // Stops listening now, which frees the endpoint for the successor; the
    // callback waits for the connections below to finish closing.
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const s of this.sockets) {
      if (s.destroyed) continue;
      s.write(encodeFrame({ id: NOTICE_ID, body: notice }));
      s.end();
    }
    const stragglers = setTimeout(() => {
      for (const s of this.sockets) s.destroy();
    }, STRAGGLER_MS);
    await closed;
    clearTimeout(stragglers);
    this.sockets.clear();
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
```

- [ ] **Step 5: Keep the two existing callers compiling**

Apply to `src/ipc/coordinator.ts`:

```diff
diff --git a/src/ipc/coordinator.ts b/src/ipc/coordinator.ts
index f5358ad..1b5f5f3 100644
--- a/src/ipc/coordinator.ts
+++ b/src/ipc/coordinator.ts
@@ -1,6 +1,7 @@
 import { elect, rendezvousPath } from "./rendezvous.js";
 import { OwnerServer } from "./owner.js";
 import { OwnerClient } from "./client.js";
+import { unstampedBuild } from "./build-id.js";
 
 // ---------------------------------------------------------------------------
 // Ties election + owner server + client proxy into the one thing startup needs:
@@ -105,10 +106,17 @@ export class Coordinator {
   private async doElect(): Promise<void> {
     const r = await elect(this.path);
     if (r.role === "owner") {
-      this.ownerServer = new OwnerServer(r.server, (body) => {
-        const { tool, args } = body as { tool: string; args: Record<string, unknown> };
-        return this.runLocal(tool, args);
-      });
+      this.ownerServer = new OwnerServer(
+        r.server,
+        (body) => {
+          const { tool, args } = body as { tool: string; args: Record<string, unknown> };
+          return this.runLocal(tool, args);
+        },
+        {
+          identity: () => ({ build: unstampedBuild(), pid: process.pid }),
+          takeover: () => ({ ipc: "takeover", granted: false, reason: "not-newer" }),
+        },
+      );
       this.role = "owner";
     } else {
       this.client = OwnerClient.adopt(r.socket);
```

Apply to `test/ipc/client.test.ts`:

```diff
diff --git a/test/ipc/client.test.ts b/test/ipc/client.test.ts
index 9863b1d..d668335 100644
--- a/test/ipc/client.test.ts
+++ b/test/ipc/client.test.ts
@@ -1,8 +1,9 @@
 import { describe, test, expect, afterEach } from "vitest";
 import net from "node:net";
 import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
-import { OwnerServer, type Handler } from "../../src/ipc/owner.js";
+import { OwnerServer, type ControlHandlers, type Handler } from "../../src/ipc/owner.js";
 import { OwnerClient } from "../../src/ipc/client.js";
+import type { BuildId } from "../../src/ipc/build-id.js";
 import { encodeFrame, FrameDecoder, type RpcMessage } from "../../src/ipc/protocol.js";
 
 const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
@@ -11,10 +12,21 @@ function tempPath(): string {
   return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
 }
 
-async function ownerOn(path: string, handle: Handler): Promise<OwnerServer> {
+const OWNER_BUILD: BuildId = { version: "0.7.0", builtAt: 500, digest: "a".repeat(64) };
+
+const REFUSES: ControlHandlers = {
+  identity: () => ({ build: OWNER_BUILD, pid: 4242 }),
+  takeover: () => ({ ipc: "takeover", granted: false, reason: "not-newer" }),
+};
+
+async function ownerOn(
+  path: string,
+  handle: Handler,
+  control: ControlHandlers = REFUSES,
+): Promise<OwnerServer> {
   const role = await elect(path);
   if (role.role !== "owner") throw new Error("expected owner");
-  return new OwnerServer(role.server, handle);
+  return new OwnerServer(role.server, handle, control);
 }
 
 describe("owner client", () => {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run test/ipc`

Expected: `tsc` prints nothing. `owner.test.ts` 14 passed, `client.test.ts` 5 passed, `coordinator.test.ts` 3 passed, and nothing failed in the rest.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/protocol.ts src/ipc/owner.ts src/ipc/coordinator.ts test/ipc/owner.test.ts test/ipc/client.test.ts
git commit -m "feat(ipc): the owner answers hello and takeover outside the call queue" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The client says hello

**Files:**
- Modify: `src/ipc/client.ts` (replace)
- Test: `test/ipc/client.test.ts`

**Interfaces:**
- Consumes: `BuildId`, `isBuildId` (Task 1); `NOTICE_ID`, `isSteppingDown` (Task 5); `ReplyBody` from `src/ipc/owner.ts`.
- Produces:
  - `type Peer = { kind: "peer"; build: BuildId; pid: number } | { kind: "legacy" }`
  - `OwnerClient.hello(build: BuildId, pid: number, timeoutMs: number): Promise<Peer>` — rejects only if the connection closes first
  - `OwnerClient.takeover(build: BuildId, pid: number): Promise<boolean>`
  - `OwnerClient.noticed: boolean` — true once a stepping-down notice has arrived
  - `OwnerClient.onClose(fn: () => void): void` — fires once
  - `OwnerClient.waitClosed(timeoutMs: number): Promise<boolean>`
  - `adopt`, `connect`, `request`, `closed`, `close` — unchanged

- [ ] **Step 1: Write the failing tests**

Apply to `test/ipc/client.test.ts`:

```diff
diff --git a/test/ipc/client.test.ts b/test/ipc/client.test.ts
index d668335..fe5105b 100644
--- a/test/ipc/client.test.ts
+++ b/test/ipc/client.test.ts
@@ -13,6 +13,7 @@ function tempPath(): string {
 }
 
 const OWNER_BUILD: BuildId = { version: "0.7.0", builtAt: 500, digest: "a".repeat(64) };
+const MY_BUILD: BuildId = { version: "0.7.0", builtAt: 900, digest: "b".repeat(64) };
 
 const REFUSES: ControlHandlers = {
   identity: () => ({ build: OWNER_BUILD, pid: 4242 }),
@@ -29,6 +30,54 @@ async function ownerOn(
   return new OwnerServer(role.server, handle, control);
 }
 
+/**
+ * A raw server that answers each request with whatever `answer` returns for it.
+ * Returning undefined sends nothing. Used to stand in for owners the real
+ * OwnerServer cannot imitate: one that predates the handshake, one that replies
+ * with nonsense, one that never replies.
+ */
+async function scriptedOwner(
+  path: string,
+  answer: (body: unknown, send: (frame: { id: number; body: unknown }) => void) => unknown,
+): Promise<{ close: () => Promise<void>; dropAll: () => void }> {
+  const server = net.createServer();
+  const socks = new Set<net.Socket>();
+  server.on("connection", (sock) => {
+    socks.add(sock);
+    sock.on("close", () => socks.delete(sock));
+    const dec = new FrameDecoder();
+    sock.on("data", (chunk: Buffer) => {
+      for (const m of dec.push(chunk)) {
+        const send = (frame: { id: number; body: unknown }): void => {
+          sock.write(encodeFrame(frame));
+        };
+        const body = answer(m.body, send);
+        if (body !== undefined) send({ id: m.id, body });
+      }
+    });
+  });
+  await new Promise<void>((r) => server.listen(path, () => r()));
+  const dropAll = (): void => {
+    for (const s of socks) s.destroy();
+  };
+  return {
+    dropAll,
+    close: () =>
+      new Promise<void>((r) => {
+        dropAll();
+        server.close(() => r());
+      }),
+  };
+}
+
+/** What a 0.7.0 owner does with any body that is not a tool it knows. */
+const legacyAnswer = (body: unknown): unknown => {
+  const tool = (body as { tool?: string }).tool;
+  return tool === "obsbot_status"
+    ? { ok: true, result: { awake: true } }
+    : { ok: false, error: `unknown tool: ${tool}` };
+};
+
 describe("owner client", () => {
   const cleanup: Array<() => void | Promise<void>> = [];
   afterEach(async () => {
@@ -119,4 +168,213 @@ describe("owner client", () => {
     expect(client.closed).toBe(true);
     await expect(client.request({ after: true })).rejects.toThrow(/closed/);
   });
+
+  test("hello returns the owner's build and pid", async () => {
+    const path = tempPath();
+    const srv = await ownerOn(path, async () => "unused");
+    cleanup.push(() => srv.close());
+    const client = await OwnerClient.connect(path);
+    cleanup.push(() => client.close());
+
+    expect(await client.hello(MY_BUILD, 7, 1000)).toEqual({
+      kind: "peer",
+      build: OWNER_BUILD,
+      pid: 4242,
+    });
+  });
+
+  test("an owner that predates the handshake is recognised as legacy", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, legacyAnswer);
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    expect(await client.hello(MY_BUILD, 7, 1000)).toEqual({ kind: "legacy" });
+  });
+
+  test.each([
+    ["a hello with no build", { ipc: "hello", pid: 4242 }],
+    ["a hello whose digest is not a digest", { ipc: "hello", build: { version: "0.7.0", builtAt: 5, digest: "zz" }, pid: 4242 }],
+    ["a hello with a pid of 0", { ipc: "hello", build: OWNER_BUILD, pid: 0 }],
+    ["something that is not a hello", { awake: true }],
+    ["null", null],
+  ])("an owner that answers with %s is treated as legacy, never as a peer", async (_what, result) => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, () => ({ ok: true, result }));
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    expect(await client.hello(MY_BUILD, 7, 1000)).toEqual({ kind: "legacy" });
+  });
+
+  test("an owner that does not answer the hello in time is treated as legacy", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, (body) =>
+      (body as { ipc?: string }).ipc === "hello" ? undefined : { ok: true, result: "still here" },
+    );
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    const started = Date.now();
+    expect(await client.hello(MY_BUILD, 7, 60)).toEqual({ kind: "legacy" });
+    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
+    // The connection is still good for ordinary requests afterwards.
+    expect(await client.request({ tool: "obsbot_status" })).toBe("still here");
+  });
+
+  test("a hello reply that turns up after the timeout is ignored", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, (body, send) => {
+      if ((body as { ipc?: string }).ipc !== "hello") return { ok: true, result: "request" };
+      // Reply to the hello (id 1) late, after the client has given up on it.
+      setTimeout(() => send({ id: 1, body: { ok: true, result: "late hello" } }), 80);
+      return undefined;
+    });
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    expect(await client.hello(MY_BUILD, 7, 30)).toEqual({ kind: "legacy" });
+    const next = client.request({ tool: "obsbot_status" });
+    await sleep(100); // the late hello reply has arrived by now
+    expect(await next).toBe("request");
+  });
+
+  test("hello rejects when the connection closes before an answer", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, () => undefined);
+    const client = await OwnerClient.connect(path);
+    cleanup.push(() => srv.close());
+
+    const hello = client.hello(MY_BUILD, 7, 1000);
+    await sleep(10);
+    srv.dropAll();
+
+    await expect(hello).rejects.toThrow(/closed/);
+  });
+
+  test("takeover is true when the owner grants it", async () => {
+    const path = tempPath();
+    const srv = await ownerOn(path, async () => "unused", {
+      identity: REFUSES.identity,
+      takeover: () => ({ ipc: "takeover", granted: true }),
+    });
+    cleanup.push(() => srv.close());
+    const client = await OwnerClient.connect(path);
+    cleanup.push(() => client.close());
+
+    expect(await client.takeover(MY_BUILD, 7)).toBe(true);
+  });
+
+  test("takeover is false when the owner refuses", async () => {
+    const path = tempPath();
+    const srv = await ownerOn(path, async () => "unused");
+    cleanup.push(() => srv.close());
+    const client = await OwnerClient.connect(path);
+    cleanup.push(() => client.close());
+
+    expect(await client.takeover(MY_BUILD, 7)).toBe(false);
+  });
+
+  test("takeover is false against an owner that predates the handshake", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, legacyAnswer);
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    expect(await client.takeover(MY_BUILD, 7)).toBe(false);
+  });
+
+  test("a stepping-down notice is recorded and disturbs no pending request", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, (body, send) => {
+      // Notice first, then the real reply.
+      send({ id: 0, body: { ipc: "stepping-down", successorPid: 99 } });
+      return { ok: true, result: (body as { n: number }).n + 1 };
+    });
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    expect(client.noticed).toBe(false);
+    expect(await client.request({ n: 41 })).toBe(42);
+    expect(client.noticed).toBe(true);
+  });
+
+  test("a frame with the notice id that is not a stepping-down notice is ignored", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, (_body, send) => {
+      send({ id: 0, body: { ipc: "something-else" } });
+      return { ok: true, result: "ok" };
+    });
+    const client = await OwnerClient.connect(path);
+    cleanup.push(async () => {
+      client.close();
+      await srv.close();
+    });
+
+    expect(await client.request({})).toBe("ok");
+    expect(client.noticed).toBe(false);
+  });
+
+  test("onClose fires once when the owner goes away", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, () => undefined);
+    const client = await OwnerClient.connect(path);
+    cleanup.push(() => srv.close());
+    let fired = 0;
+    client.onClose(() => fired++);
+
+    srv.dropAll();
+    await sleep(30);
+    client.close(); // closing again must not fire it a second time
+
+    expect(fired).toBe(1);
+  });
+
+  test("onClose on a connection that has already closed still fires", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, () => undefined);
+    const client = await OwnerClient.connect(path);
+    cleanup.push(() => srv.close());
+    client.close();
+
+    let fired = 0;
+    client.onClose(() => fired++);
+    await sleep(5);
+
+    expect(fired).toBe(1);
+  });
+
+  test("waitClosed is true when the connection closes in time, false when it does not", async () => {
+    const path = tempPath();
+    const srv = await scriptedOwner(path, () => undefined);
+    cleanup.push(() => srv.close());
+    const stays = await OwnerClient.connect(path);
+    cleanup.push(() => stays.close());
+    const goes = await OwnerClient.connect(path);
+
+    const open = stays.waitClosed(40);
+    const closing = goes.waitClosed(1000);
+    goes.close();
+
+    expect(await closing).toBe(true);
+    expect(await open).toBe(false);
+  });
 });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ipc/client.test.ts`

Expected: 18 failed, 5 passed. The failures are `client.hello is not a function` and its siblings.

- [ ] **Step 3: Replace the client**

Replace `src/ipc/client.ts` with:

```ts
import net from "node:net";
import type { BuildId } from "./build-id.js";
import { isBuildId } from "./build-id.js";
import { encodeFrame, FrameDecoder, NOTICE_ID, isSteppingDown, type RpcMessage } from "./protocol.js";
import type { ReplyBody } from "./owner.js";

// ---------------------------------------------------------------------------
// Client-side proxy to the owner.
//
// A non-owner instance connects here and forwards each request (a tool call) to
// the owner, which runs it against the single DeviceManager + helper and frames
// the reply back. Requests are correlated by `id`, so many can be in flight at
// once and replies may arrive in any order. If the connection drops (the owner
// exited, crashed, or stepped down), every pending request rejects and the
// proxy is marked closed — the coordinator treats that as the signal to
// re-elect.
//
// It also speaks the control messages: hello, to learn the owner's build, and
// takeover, to ask an older owner for the endpoint.
// ---------------------------------------------------------------------------

/** What is on the other end of the connection. */
export type Peer =
  | { kind: "peer"; build: BuildId; pid: number }
  /** An instance that predates the handshake, or one that did not answer it. */
  | { kind: "legacy" };

interface Waiter {
  resolve: (r: ReplyBody) => void;
  reject: (e: Error) => void;
}

class ReplyTimeout extends Error {}

export class OwnerClient {
  private nextId = NOTICE_ID + 1;
  private readonly pending = new Map<number, Waiter>();
  private readonly dec = new FrameDecoder();
  private readonly closeListeners: Array<() => void> = [];
  private closedErr?: Error;
  private gotNotice = false;

  private constructor(private readonly socket: net.Socket) {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("close", () => this.failAll(new Error("owner connection closed")));
    this.socket.on("error", (e: Error) => this.failAll(e));
  }

  /** Wrap an already-connected socket (e.g. the one elect() returned). */
  static adopt(socket: net.Socket): OwnerClient {
    return new OwnerClient(socket);
  }

  static connect(path: string): Promise<OwnerClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      const onError = (e: unknown): void => reject(e);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        resolve(new OwnerClient(socket));
      });
    });
  }

  /** Forward a request to the owner; resolve with its result or throw its error. */
  async request(body: unknown): Promise<unknown> {
    const reply = await this.send(body);
    if (reply.ok) return reply.result;
    throw new Error(reply.error);
  }

  /**
   * Exchange identities with the owner.
   *
   * Anything other than a well-formed hello back means the owner cannot take
   * part in a handover: an error reply (a legacy owner rejecting what it takes
   * for a tool call), a reply that is not a hello, or no reply in `timeoutMs`.
   * Throws only if the connection itself closes first.
   */
  async hello(build: BuildId, pid: number, timeoutMs: number): Promise<Peer> {
    let reply: ReplyBody;
    try {
      reply = await this.send({ ipc: "hello", build, pid }, timeoutMs);
    } catch (e) {
      if (e instanceof ReplyTimeout) return { kind: "legacy" };
      throw e;
    }
    if (!reply.ok) return { kind: "legacy" };
    const r = reply.result as Record<string, unknown> | null;
    if (
      typeof r === "object" &&
      r !== null &&
      r.ipc === "hello" &&
      isBuildId(r.build) &&
      typeof r.pid === "number" &&
      Number.isInteger(r.pid) &&
      r.pid > 0
    ) {
      return { kind: "peer", build: r.build, pid: r.pid };
    }
    return { kind: "legacy" };
  }

  /** Ask the owner for the endpoint. True if it agreed to step down. */
  async takeover(build: BuildId, pid: number): Promise<boolean> {
    const reply = await this.send({ ipc: "takeover", build, pid });
    if (!reply.ok) return false;
    const r = reply.result as Record<string, unknown> | null;
    return typeof r === "object" && r !== null && r.ipc === "takeover" && r.granted === true;
  }

  get closed(): boolean {
    return this.closedErr !== undefined;
  }

  /** True once the owner has said it is stepping down for a newer build. */
  get noticed(): boolean {
    return this.gotNotice;
  }

  /** Call `fn` once, when the connection closes for any reason. */
  onClose(fn: () => void): void {
    if (this.closedErr) queueMicrotask(fn);
    else this.closeListeners.push(fn);
  }

  /** Resolve true when the connection closes, or false if it is still open after `timeoutMs`. */
  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closedErr) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeListeners.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): void {
    this.socket.destroy();
    this.failAll(new Error("owner connection closed by client"));
  }

  private send(body: unknown, timeoutMs?: number): Promise<ReplyBody> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const id = this.nextId++;
    return new Promise<ReplyBody>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = <T>(fn: (v: T) => void) => (v: T): void => {
        if (timer) clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // Forget the request: a reply that turns up later matches no waiter.
          this.pending.delete(id);
          reject(new ReplyTimeout(`no reply within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.socket.write(encodeFrame({ id, body }));
    });
  }

  private onData(chunk: Buffer): void {
    let msgs: RpcMessage[];
    try {
      msgs = this.dec.push(chunk);
    } catch (e) {
      this.failAll(e instanceof Error ? e : new Error(String(e)));
      this.socket.destroy();
      return;
    }
    for (const m of msgs) {
      if (m.id === NOTICE_ID) {
        if (isSteppingDown(m.body)) this.gotNotice = true;
        continue;
      }
      const w = this.pending.get(m.id);
      if (w) {
        this.pending.delete(m.id);
        w.resolve(m.body as ReplyBody);
      }
      // Unknown id (late reply after timeout, or a duplicate) → ignore.
    }
  }

  private failAll(err: Error): void {
    if (this.closedErr) return; // already failed; keep the first cause
    this.closedErr = err;
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
    for (const fn of this.closeListeners.splice(0)) fn();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run test/ipc/client.test.ts`

Expected: `tsc` prints nothing. 23 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/client.ts test/ipc/client.test.ts
git commit -m "feat(ipc): the client exchanges build identities and can ask for the endpoint" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The coordinator hands the endpoint to a newer build

The handshake on every connection, the takeover, stepping down, and what happens to calls caught in the middle. After this task a newer build takes over; a client still re-elects only when it next has something to send (Task 8), and still forwards to an owner it could not take over from (Task 9).

`serialize()` is removed — the coordinator owns a `CallGate` instead — so `src/mcp/server.ts` stops wrapping `runLocal`. Task 10 does the rest of the server wiring.

**Files:**
- Modify: `src/ipc/coordinator.ts` (replace)
- Modify: `src/mcp/server.ts` (two small edits)
- Test: `test/ipc/coordinator.test.ts` (replace)

**Interfaces:**
- Consumes: `elect`, `rendezvousPath`, `Role` (`src/ipc/rendezvous.ts`); `OwnerServer` (Task 5); `OwnerClient`, `Peer` (Task 6); `CallGate`, `StepDownError` (Task 4); `BuildId`, `buildLabel`, `compareBuilds`, `unstampedBuild` (Task 1); `TakeoverResult` (Task 5).
- Produces:
  - `type RunLocal = (tool: string, args: Record<string, unknown>) => Promise<unknown>` — unchanged
  - `interface Timing { helloTimeoutMs; stepDownGraceMs; electionJitterMs; stepDownTimeoutMs; releaseTimeoutMs; maxTakeoverRounds }` — all `number`
  - `DEFAULT_TIMING: Timing`
  - `interface CoordinatorOptions { path?: string; build?: BuildId; pid?: number; release?: () => Promise<void>; log?: (line: string) => void; timing?: Partial<Timing>; elect?: (path: string) => Promise<Role> }`
  - `new Coordinator(runLocal: RunLocal, opts?: CoordinatorOptions)` — **the second argument was a path and is now an options object**
  - `start()`, `dispatch(tool, args)`, `close()`, `roleName` — same signatures as before
  - `serialize` is **no longer exported**

- [ ] **Step 1: Write the failing tests**

Replace `test/ipc/coordinator.test.ts` with:

```ts
import { describe, test, expect, afterEach } from "vitest";
import net from "node:net";
import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
import {
  Coordinator,
  type CoordinatorOptions,
  type RunLocal,
  type Timing,
} from "../../src/ipc/coordinator.js";
import { encodeFrame, FrameDecoder } from "../../src/ipc/protocol.js";
import type { BuildId } from "../../src/ipc/build-id.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

// Four builds, oldest to newest. Labels, for the log assertions:
//   OLDEST 0.7.0/2026-09-21T14:13:20Z/00000000
//   OLD    0.7.0/2026-09-22T18:00:00Z/aaaaaaaa
//   MID    0.7.0/2026-09-23T21:46:40Z/bbbbbbbb
//   NEW    0.7.0/2026-09-25T01:33:20Z/cccccccc
const OLDEST: BuildId = { version: "0.7.0", builtAt: 1790000000000, digest: "0".repeat(64) };
const OLD: BuildId = { version: "0.7.0", builtAt: 1790100000000, digest: "a".repeat(64) };
const MID: BuildId = { version: "0.7.0", builtAt: 1790200000000, digest: "b".repeat(64) };
const NEW: BuildId = { version: "0.7.0", builtAt: 1790300000000, digest: "c".repeat(64) };

// The real delays are hundreds of milliseconds to seconds. These keep the
// same ordering (jitter < grace < release < step-down) at test speed.
const FAST: Timing = {
  helloTimeoutMs: 200,
  stepDownGraceMs: 60,
  electionJitterMs: 10,
  stepDownTimeoutMs: 1500,
  releaseTimeoutMs: 300,
  maxTakeoverRounds: 3,
};

/** Long enough for a handover and the re-elections that follow it to settle. */
const SETTLE_MS = FAST.stepDownGraceMs + FAST.electionJitterMs + 80;

interface Instance {
  c: Coordinator;
  /** Every line this instance logged. */
  log: string[];
  /** How many times this instance was asked to release the camera. */
  released: () => number;
}

describe("coordinator", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  /** `<instance>:<tool>` for every call, in the order they STARTED, across all instances. */
  let ran: string[] = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    ran = [];
  });

  /**
   * One server instance. Its tools record where they ran and return
   * `<name>:<tool>`; a tool named `slow` takes 80 ms and `big` returns 4 MiB.
   */
  function instance(
    name: string,
    build: BuildId,
    path: string,
    opts: Omit<CoordinatorOptions, "path" | "build" | "log"> & { run?: RunLocal } = {},
  ): Instance {
    const log: string[] = [];
    let released = 0;
    const { run, release, timing, ...rest } = opts;
    const runLocal: RunLocal =
      run ??
      (async (tool) => {
        ran.push(`${name}:${tool}`);
        if (tool === "slow") await sleep(80);
        if (tool === "big") return "x".repeat(4 * 1024 * 1024);
        return `${name}:${tool}`;
      });
    const c = new Coordinator(runLocal, {
      path,
      build,
      log: (line) => log.push(line),
      timing: { ...FAST, ...timing },
      release: async () => {
        released++;
        await release?.();
      },
      ...rest,
    });
    cleanup.push(() => c.close());
    return { c, log, released: () => released };
  }

  // -- unchanged behaviour ---------------------------------------------------

  test("first instance owns; the second forwards its calls to the owner", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const b = instance("B", OLD, path);
    await b.c.start();

    expect(a.c.roleName).toBe("owner");
    expect(b.c.roleName).toBe("client");

    // b's call must EXECUTE ON THE OWNER (a), not locally on b.
    expect(await b.c.dispatch("obsbot_status", {})).toBe("A:obsbot_status");
    expect(ran).toEqual(["A:obsbot_status"]);
  });

  test("a client re-elects to owner when the owner goes away", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const b = instance("B", OLD, path);
    await b.c.start();
    expect(b.c.roleName).toBe("client");

    await a.c.close(); // owner leaves
    await sleep(50); // let the drop propagate + the pipe/socket free up

    expect(await b.c.dispatch("obsbot_wake", {})).toBe("B:obsbot_wake"); // now runs locally on b
    expect(b.c.roleName).toBe("owner");
  });

  test("serializes owner-local and forwarded-client calls through ONE lock", async () => {
    const path = tempPath();
    let inFlight = 0;
    let maxInFlight = 0;
    const counted: RunLocal = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(8);
      inFlight--;
      return "ok";
    };
    const owner = instance("owner", OLD, path, { run: counted });
    await owner.c.start();
    const client = instance("client", OLD, path);
    await client.c.start();
    expect(owner.c.roleName).toBe("owner");
    expect(client.c.roleName).toBe("client");

    // Owner-local calls and forwarded client calls must never overlap.
    await Promise.all([
      owner.c.dispatch("local", {}),
      client.c.dispatch("fwd", {}),
      owner.c.dispatch("local", {}),
      client.c.dispatch("fwd", {}),
    ]);

    expect(maxInFlight).toBe(1);
  });

  test("a genuine error from the owner is surfaced, not retried", async () => {
    const path = tempPath();
    let calls = 0;
    const a = instance("A", OLD, path, {
      run: async () => {
        calls++;
        throw new Error("no OBSBOT camera found");
      },
    });
    await a.c.start();
    const b = instance("B", OLD, path);
    await b.c.start();

    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow("no OBSBOT camera found");
    expect(calls).toBe(1);
  });

  // -- who owns the endpoint --------------------------------------------------

  test("a newer build takes the endpoint from an older owner", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path, { pid: 1001 });
    await a.c.start();
    const b = instance("B", NEW, path, { pid: 1002 });
    await b.c.start();

    expect(b.c.roleName).toBe("owner");
    expect(a.released()).toBe(1);

    // The old owner's own calls now run on the new build.
    expect(await a.c.dispatch("obsbot_status", {})).toBe("B:obsbot_status");
    expect(a.c.roleName).toBe("client");
    expect(ran).toEqual(["B:obsbot_status"]);
  });

  test("the same build does not take over", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const b = instance("B", { ...OLD, builtAt: OLD.builtAt + 5000 }, path);
    await b.c.start();

    expect(a.c.roleName).toBe("owner");
    expect(b.c.roleName).toBe("client");
    expect(a.released()).toBe(0);
    expect(await b.c.dispatch("obsbot_status", {})).toBe("A:obsbot_status");
  });

  test("an older build stays a client of a newer owner", async () => {
    const path = tempPath();
    const a = instance("A", NEW, path);
    await a.c.start();
    const b = instance("B", OLD, path);
    await b.c.start();

    expect(a.c.roleName).toBe("owner");
    expect(b.c.roleName).toBe("client");
    expect(a.released()).toBe(0);
    expect(await b.c.dispatch("obsbot_status", {})).toBe("A:obsbot_status");
  });

  test("two unstamped builds behave as instances always have", async () => {
    const path = tempPath();
    const a = new Coordinator(async () => "A", { path, timing: FAST });
    const b = new Coordinator(async () => "B", { path, timing: FAST });
    cleanup.push(() => a.close());
    cleanup.push(() => b.close());
    await a.start();
    await b.start();

    expect(a.roleName).toBe("owner");
    expect(b.roleName).toBe("client");
    expect(await b.dispatch("obsbot_status", {})).toBe("A");
  });

  test("an owner refuses a takeover from a build that is not newer", async () => {
    const path = tempPath();
    const a = instance("A", NEW, path);
    await a.c.start();

    // Speak the protocol directly: a well-behaved client never asks for this.
    const sock = net.connect(path);
    await new Promise<void>((r) => sock.once("connect", () => r()));
    cleanup.push(() => void sock.destroy());
    const dec = new FrameDecoder();
    const reply = new Promise<unknown>((resolve) =>
      sock.on("data", (chunk: Buffer) => {
        for (const m of dec.push(chunk)) resolve(m.body);
      }),
    );
    sock.write(encodeFrame({ id: 1, body: { ipc: "takeover", build: OLD, pid: 7 } }));

    expect(await reply).toEqual({
      ok: true,
      result: { ipc: "takeover", granted: false, reason: "not-newer" },
    });
    await sleep(SETTLE_MS);
    expect(a.c.roleName).toBe("owner");
    expect(a.released()).toBe(0);
  });

  test("two instances of the same newer build that start together: one owns, one is its client", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const b1 = instance("B1", NEW, path);
    const b2 = instance("B2", NEW, path);
    await Promise.all([b1.c.start(), b2.c.start()]);

    expect([b1.c.roleName, b2.c.roleName].sort()).toEqual(["client", "owner"]);
    expect(a.released()).toBe(1);
  });

  test("when someone else wins the bind, the newer build takes over from them too", async () => {
    // Closing a listener and binding it again is not atomic. Here B is made
    // slow to bind after its first takeover, so by the time it tries, the grace
    // period has run out and one of the others — the old owner A, or the
    // bystander X — holds the endpoint. Which of the two is a race, and the
    // assertions below hold either way.
    const path = tempPath();
    const a = instance("A", OLD, path, { pid: 1001 });
    await a.c.start();
    const x = instance("X", OLDEST, path, { pid: 1002 });
    await x.c.start();
    expect(x.c.roleName).toBe("client");

    let elections = 0;
    const b = instance("B", NEW, path, {
      pid: 1003,
      elect: async (p) => {
        if (++elections === 2) await sleep(FAST.stepDownGraceMs + FAST.electionJitterMs + 40);
        return elect(p);
      },
    });

    const slow = x.c.dispatch("slow", {});
    const queued = x.c.dispatch("queued", {});
    await sleep(10); // `slow` is running on A, `queued` is waiting behind it
    await b.c.start();

    expect(b.c.roleName).toBe("owner");
    const takeovers = b.log.filter((l) => l.includes("takeover requested"));
    expect(takeovers).toHaveLength(2);
    expect(takeovers[0]).toBe("obsbot-mcp: ipc takeover requested from pid 1001");
    expect(takeovers[1]).toMatch(/^obsbot-mcp: ipc takeover requested from pid 100[12]$/);

    expect(await slow).toBe("A:slow");
    // `queued` ran once, on whoever owned the endpoint when it started — never
    // on a build older than X's own, and never twice.
    expect(await queued).toMatch(/^[AX]:queued$/);
    expect(ran.filter((r) => r.endsWith(":queued"))).toHaveLength(1);

    // Everything B does from here on runs on B.
    await sleep(SETTLE_MS);
    expect(await x.c.dispatch("after", {})).toBe("B:after");
    expect(await a.c.dispatch("after", {})).toBe("B:after");
  });

  // -- calls caught in the middle --------------------------------------------

  test("a call running during a takeover finishes on the old owner, and its reply arrives", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const c = instance("C", OLD, path);
    await c.c.start();

    const slow = c.c.dispatch("slow", {});
    await sleep(10); // in flight on A
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(await slow).toBe("A:slow");
    expect(b.c.roleName).toBe("owner");
    expect(ran).toEqual(["A:slow"]);
  });

  test("a client's call queued behind it runs exactly once, on the new owner", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const c = instance("C", OLD, path);
    await c.c.start();

    const slow = c.c.dispatch("slow", {});
    const queued = c.c.dispatch("queued", {});
    await sleep(10);
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(await slow).toBe("A:slow");
    expect(await queued).toBe("B:queued");
    expect(ran).toEqual(["A:slow", "B:queued"]);
  });

  test("the old owner's own call queued behind it runs exactly once, on the new owner", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();

    const slow = a.c.dispatch("slow", {});
    const queued = a.c.dispatch("queued", {});
    await sleep(10);
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(await slow).toBe("A:slow");
    expect(await queued).toBe("B:queued");
    expect(ran).toEqual(["A:slow", "B:queued"]);
  });

  test("a call made while the old owner is stepping down is held, then forwarded", async () => {
    const path = tempPath();
    let releasing!: () => void;
    const a = instance("A", OLD, path, {
      release: () => new Promise<void>((r) => (releasing = r)),
    });
    await a.c.start();
    const b = instance("B", NEW, path);
    const bStarted = b.c.start();
    await sleep(30); // A has granted the takeover and is inside release()

    const during = a.c.dispatch("during", {});
    releasing();
    await bStarted;

    expect(await during).toBe("B:during");
    expect(ran).toEqual(["B:during"]);
  });

  test("a large reply still on its way when the owner steps down arrives complete", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const c = instance("C", OLD, path);
    await c.c.start();

    const big = c.c.dispatch("big", {});
    const b = instance("B", NEW, path);
    await b.c.start();

    const result = (await big) as string;
    expect(result.length).toBe(4 * 1024 * 1024);
    expect(ran).toEqual(["A:big"]);
  });

  // -- a release that misbehaves ---------------------------------------------

  test("a release that throws does not stop the handover", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path, {
      release: async () => {
        throw new Error("helper already gone");
      },
    });
    await a.c.start();
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(b.c.roleName).toBe("owner");
    expect(a.log).toContain(
      "obsbot-mcp: ipc release failed while stepping down: helper already gone",
    );
    expect(await a.c.dispatch("obsbot_status", {})).toBe("B:obsbot_status");
  });

  test("a release that never settles is abandoned after releaseTimeoutMs", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path, { release: () => new Promise<void>(() => {}) });
    await a.c.start();
    const b = instance("B", NEW, path);
    const started = Date.now();
    await b.c.start();

    expect(b.c.roleName).toBe("owner");
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.releaseTimeoutMs - 20);
    expect(a.log).toContain(
      `obsbot-mcp: ipc release failed while stepping down: release did not finish in ${FAST.releaseTimeoutMs} ms`,
    );
  });

  // -- what gets logged -------------------------------------------------------

  test("logs its role, and whose build it is a client of", async () => {
    const path = tempPath();
    const a = instance("A", NEW, path, { pid: 1001 });
    await a.c.start();
    const b = instance("B", OLD, path, { pid: 1002 });
    await b.c.start();

    expect(a.log).toEqual(["obsbot-mcp: ipc role=owner"]);
    expect(b.log).toEqual([
      "obsbot-mcp: ipc role=client owner-pid=1001 owner-build=0.7.0/2026-09-25T01:33:20Z/cccccccc",
    ]);
  });

  test("logs both sides of a takeover", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path, { pid: 1001 });
    await a.c.start();
    const b = instance("B", NEW, path, { pid: 1002 });
    await b.c.start();
    await sleep(SETTLE_MS); // A has re-elected as B's client

    expect(b.log).toEqual([
      "obsbot-mcp: ipc takeover requested from pid 1001",
      "obsbot-mcp: ipc role=owner",
    ]);
    expect(a.log).toEqual([
      "obsbot-mcp: ipc role=owner",
      "obsbot-mcp: ipc stepping down for pid 1002",
      "obsbot-mcp: ipc role=client owner-pid=1002 owner-build=0.7.0/2026-09-25T01:33:20Z/cccccccc",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ipc/coordinator.test.ts`

Expected: 12 failed, 8 passed. The old coordinator takes the options object for a path and knows nothing about builds, so no takeover happens.

- [ ] **Step 3: Replace the coordinator**

Replace `src/ipc/coordinator.ts` with:

```ts
import type net from "node:net";
import { elect as electEndpoint, rendezvousPath, type Role } from "./rendezvous.js";
import { OwnerServer } from "./owner.js";
import { OwnerClient, type Peer } from "./client.js";
import { CallGate, StepDownError } from "./gate.js";
import { buildLabel, compareBuilds, unstampedBuild, type BuildId } from "./build-id.js";
import type { TakeoverResult } from "./protocol.js";

// ---------------------------------------------------------------------------
// Ties election + owner server + client proxy into the one thing startup needs:
// "run this tool call, wherever the camera actually lives."
//
//   - OWNER  → run it locally against the single DeviceManager.
//   - CLIENT → forward it to the owner; if the owner has vanished, RE-ELECT
//              (become the new owner, or reconnect to whoever won) and retry.
//
// The owner is the NEWEST BUILD alive, not whoever started first. Every
// connection opens with an exchange of build identities, and an owner that
// meets a newer build steps down for it: it lets the call in flight finish,
// releases the camera, and gives up the endpoint. See
// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md.
//
// Single-instance is the common case and stays a no-op change: the first
// instance elects owner and runs everything locally, with an idle OwnerServer
// listening for peers that may never come.
// ---------------------------------------------------------------------------

export type RunLocal = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface Timing {
  /** How long a client waits for its hello to be answered. */
  helloTimeoutMs: number;
  /** How long everyone but the successor waits before re-electing after a step-down. */
  stepDownGraceMs: number;
  /** Upper bound of the random delay that spreads simultaneous re-elections. */
  electionJitterMs: number;
  /** Longest a successor waits for the owner's running call and release. */
  stepDownTimeoutMs: number;
  /** Longest a stepping-down owner waits for its own release. Must be under stepDownTimeoutMs. */
  releaseTimeoutMs: number;
  /** How many owners one election will take the endpoint from before settling. */
  maxTakeoverRounds: number;
}

export const DEFAULT_TIMING: Timing = {
  helloTimeoutMs: 2000,
  stepDownGraceMs: 500,
  electionJitterMs: 100,
  stepDownTimeoutMs: 15000,
  releaseTimeoutMs: 10000,
  maxTakeoverRounds: 5,
};

export interface CoordinatorOptions {
  /** Rendezvous endpoint. Default: the one OBSBOT_IPC_NAME selects. */
  path?: string;
  /** What this process loaded. Default: an unstamped build. */
  build?: BuildId;
  /** Reported to peers in the hello. Default: process.pid. */
  pid?: number;
  /** Drop everything that holds the camera. Runs when this instance steps down. */
  release?: () => Promise<void>;
  /** Receives the `obsbot-mcp: ipc …` lines. Default: discard. */
  log?: (line: string) => void;
  timing?: Partial<Timing>;
  /** The election primitive. Injectable so a test can decide who binds first. */
  elect?: (path: string) => Promise<Role>;
}

type RoleName = "none" | "owner" | "client";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Coordinator {
  private role: RoleName = "none";
  private client?: OwnerClient;
  private ownerServer?: OwnerServer;
  private steppingDown = false;
  private closing = false;
  /** A role change in progress — an election, or stepping down. Never rejects. */
  private pending?: Promise<void>;
  /** THE single-camera lock: the owner's own calls and the ones forwarded to it. */
  private readonly gate = new CallGate();

  private readonly path: string;
  private readonly build: BuildId;
  private readonly pid: number;
  private readonly release: () => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly t: Timing;
  private readonly elect: (path: string) => Promise<Role>;

  constructor(
    private readonly runLocal: RunLocal,
    opts: CoordinatorOptions = {},
  ) {
    this.path = opts.path ?? rendezvousPath();
    this.build = opts.build ?? unstampedBuild();
    this.pid = opts.pid ?? process.pid;
    this.release = opts.release ?? (async (): Promise<void> => {});
    this.log = opts.log ?? ((): void => {});
    this.t = { ...DEFAULT_TIMING, ...opts.timing };
    this.elect = opts.elect ?? electEndpoint;
  }

  /** Establish the initial role eagerly at startup. */
  start(): Promise<void> {
    return this.ensureRole();
  }

  get roleName(): RoleName {
    return this.role;
  }

  async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    let failure: unknown;
    // Twice at most: a call that lost its owner is retried exactly once.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureRole();
      const client = this.client;
      try {
        return this.role === "owner"
          ? await this.gate.run(() => this.runLocal(tool, args))
          : await client!.request({ tool, args });
      } catch (e) {
        if (e instanceof StepDownError) {
          // We were the owner and are handing over; this call had not started.
          // ensureRole() waits the handover out, and the retry forwards it.
          failure = e;
          continue;
        }
        if (client?.closed) {
          failure = e;
          this.ownerLost(client);
          continue;
        }
        throw e; // a genuine owner-side error → surface it unchanged
      }
    }
    throw failure;
  }

  async close(): Promise<void> {
    this.closing = true;
    const server = this.ownerServer;
    const client = this.client;
    this.reset();
    client?.close();
    if (server) await server.close();
    // A role change that was under way sees `closing` and cleans up after itself.
    while (this.pending) await this.pending;
  }

  private reset(): void {
    this.role = "none";
    this.client = undefined;
    this.ownerServer = undefined;
    this.steppingDown = false;
  }

  private jitter(): number {
    return Math.floor(Math.random() * (this.t.electionJitterMs + 1));
  }

  /** Queue a role change behind any already under way. The result never rejects. */
  private begin(work: () => Promise<void>): Promise<void> {
    const prev = this.pending ?? Promise.resolve();
    const p: Promise<void> = prev
      .then(work)
      .catch((e: unknown) => this.log(`obsbot-mcp: ipc role change failed: ${errText(e)}`))
      .finally(() => {
        if (this.pending === p) this.pending = undefined;
      });
    this.pending = p;
    return p;
  }

  private async ensureRole(): Promise<void> {
    while (this.pending) await this.pending;
    if (this.role !== "none") return;
    if (this.closing) throw new Error("obsbot-mcp: ipc coordinator is closed");
    let failed = false;
    let failure: unknown;
    await this.begin(async () => {
      try {
        await this.doElect();
      } catch (e) {
        failed = true;
        failure = e;
      }
    });
    if (failed) throw failure;
  }

  /**
   * Settle on a role: bind the endpoint, or connect to whoever holds it and
   * compare builds. If ours is newer, ask for the endpoint and go round again.
   */
  private async doElect(): Promise<void> {
    let takeovers = 0;
    for (let attempt = 0; attempt < this.t.maxTakeoverRounds + 3; attempt++) {
      if (this.closing || this.role !== "none") return;
      const r = await this.elect(this.path);
      if (r.role === "owner") return this.becomeOwner(r.server);

      const client = OwnerClient.adopt(r.socket);
      let peer: Peer;
      try {
        peer = await client.hello(this.build, this.pid, this.t.helloTimeoutMs);
      } catch {
        client.close(); // the owner went away between connect and hello
        continue;
      }

      if (
        peer.kind !== "peer" ||
        compareBuilds(this.build, peer.build) <= 0 ||
        takeovers >= this.t.maxTakeoverRounds
      ) {
        return this.becomeClient(client, peer);
      }

      takeovers++;
      this.log(`obsbot-mcp: ipc takeover requested from pid ${peer.pid}`);
      let granted: boolean;
      try {
        granted = await client.takeover(this.build, this.pid);
      } catch {
        granted = true; // closed before it could answer: the endpoint is free either way
      }
      if (!granted || !(await client.waitClosed(this.t.stepDownTimeoutMs))) {
        return this.becomeClient(client, peer);
      }
      // The old owner has let go. Go round again and bind.
    }
    throw new Error(`obsbot-mcp: ipc could not settle on an owner for ${this.path}`);
  }

  private becomeOwner(server: net.Server): void {
    if (this.closing) {
      server.close();
      return;
    }
    this.ownerServer = new OwnerServer(
      server,
      (body) => {
        const { tool, args } = body as { tool: string; args: Record<string, unknown> };
        return this.gate.run(() => this.runLocal(tool, args));
      },
      {
        identity: () => ({ build: this.build, pid: this.pid }),
        takeover: (build, pid) => this.onTakeover(build, pid),
      },
    );
    this.role = "owner";
    this.log("obsbot-mcp: ipc role=owner");
  }

  private becomeClient(client: OwnerClient, peer: Peer): void {
    if (this.closing) {
      client.close();
      return;
    }
    this.client = client;
    this.role = "client";
    const owner =
      peer.kind === "peer"
        ? `owner-pid=${peer.pid} owner-build=${buildLabel(peer.build)}`
        : "owner-pid=unknown owner-build=legacy";
    this.log(`obsbot-mcp: ipc role=client ${owner}`);
  }

  /** The owner has gone. Re-elect — after the grace period if it stepped down for someone. */
  private ownerLost(client: OwnerClient): void {
    if (this.client !== client || this.closing) return;
    const delay = client.noticed ? this.t.stepDownGraceMs + this.jitter() : 0;
    this.reset();
    void this.begin(async () => {
      if (delay > 0) await sleep(delay);
      await this.doElect();
    });
  }

  /** A client asks for the endpoint. Both sides run the same comparison, so this cannot disagree with it. */
  private onTakeover(build: BuildId, pid: number): TakeoverResult {
    if (compareBuilds(build, this.build) <= 0) {
      return { ipc: "takeover", granted: false, reason: "not-newer" };
    }
    this.stepDown(pid);
    return { ipc: "takeover", granted: true };
  }

  private stepDown(successorPid: number): void {
    if (this.steppingDown) return; // a second request while stepping down needs nothing more
    this.steppingDown = true;
    const server = this.ownerServer!;
    this.log(`obsbot-mcp: ipc stepping down for pid ${successorPid}`);
    void this.begin(async () => {
      await this.gate.close(); // the call in flight finishes; nothing else starts
      await server.idle(); // …and its reply has been written
      await this.releaseBounded(); // the successor cannot open the camera until this is done
      await server.stepDown({ ipc: "stepping-down", successorPid });
      this.reset();
      this.gate.open();
      // Let the successor bind before we look for an owner to be a client of.
      await sleep(this.t.stepDownGraceMs + this.jitter());
      await this.doElect();
    });
  }

  /** A release that throws or never settles must not stop the handover. */
  private async releaseBounded(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`release did not finish in ${this.t.releaseTimeoutMs} ms`)),
        this.t.releaseTimeoutMs,
      );
    });
    try {
      await Promise.race([this.release(), timeout]);
    } catch (e) {
      this.log(`obsbot-mcp: ipc release failed while stepping down: ${errText(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Stop wrapping `runLocal` in the server**

Apply to `src/mcp/server.ts`:

```diff
diff --git a/src/mcp/server.ts b/src/mcp/server.ts
index 5c3a318..b353d67 100644
--- a/src/mcp/server.ts
+++ b/src/mcp/server.ts
@@ -13,7 +13,7 @@ import { Tail2Registry } from "../tail2/registry.js";
 import { createTail2Tools } from "../tail2/tools.js";
 import { renderToolResult } from "./render.js";
 import { CaptureManager } from "../capture/manager.js";
-import { Coordinator, serialize } from "../ipc/coordinator.js";
+import { Coordinator, type RunLocal } from "../ipc/coordinator.js";
 import { VERSION } from "../version.js";
 
 export async function startServer(opts: { debug?: boolean } = {}): Promise<void> {
@@ -53,11 +53,11 @@ export async function startServer(opts: { debug?: boolean } = {}): Promise<void>
   // any forwarded from clients (the local path bypasses OwnerServer's queue). A
   // lone instance is simply the owner with no peers: it behaves exactly as
   // before, plus an idle listener.
-  const runLocal = serialize(async (name, args) => {
+  const runLocal: RunLocal = async (name, args) => {
     const tool = tools.find((t) => t.name === name);
     if (!tool) throw new Error(`unknown tool: ${name}`);
     return tool.handler(args);
-  });
+  };
   const coordinator = new Coordinator(runLocal);
   await coordinator.start();
   // Report the coordination role on STDERR (never stdout — that's the JSON-RPC
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run test/ipc`

Expected: `tsc` prints nothing. `coordinator.test.ts` 20 passed, nothing failed in the rest.

- [ ] **Step 6: Run the coordinator tests ten times**

These tests use real sockets and real timers. One pass does not show they are stable.

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do npx vitest run test/ipc/coordinator.test.ts 2>&1 | grep -E "Tests |failed"; done
```

Expected: ten lines reading `Tests  20 passed (20)`. A single failure is a finding to report, not something to re-run past.

- [ ] **Step 7: Commit**

```bash
git add src/ipc/coordinator.ts src/mcp/server.ts test/ipc/coordinator.test.ts
git commit -m "feat(ipc): an owner steps down for a newer build" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Re-elect when the connection closes

Until now a client noticed a lost owner only when it next made a call. With builds old, middle and new, where new owns and then exits: if old makes the next call, old becomes owner and runs old code while middle sits idle. Clients now re-elect as soon as the connection closes.

**Files:**
- Modify: `src/ipc/coordinator.ts`
- Test: `test/ipc/coordinator.test.ts`

**Interfaces:**
- Consumes: `OwnerClient.onClose`, `OwnerClient.noticed` (Task 6).
- Produces: no new names. `Coordinator` changes behaviour only: a client's role changes without `dispatch` being called.

- [ ] **Step 1: Write the failing tests**

Apply to `test/ipc/coordinator.test.ts`:

```diff
diff --git a/test/ipc/coordinator.test.ts b/test/ipc/coordinator.test.ts
index c722379..f5420b0 100644
--- a/test/ipc/coordinator.test.ts
+++ b/test/ipc/coordinator.test.ts
@@ -120,8 +120,9 @@ describe("coordinator", () => {
     expect(b.c.roleName).toBe("client");
 
     await a.c.close(); // owner leaves
-    await sleep(50); // let the drop propagate + the pipe/socket free up
 
+    // No sleep: a call made the instant the owner is lost waits for the
+    // re-election instead of failing.
     expect(await b.c.dispatch("obsbot_wake", {})).toBe("B:obsbot_wake"); // now runs locally on b
     expect(b.c.roleName).toBe("owner");
   });
@@ -313,6 +314,100 @@ describe("coordinator", () => {
     expect(await a.c.dispatch("after", {})).toBe("B:after");
   });
 
+  // -- when the owner goes away ------------------------------------------------
+
+  test("a client takes the endpoint when the owner exits, without a tool call being made", async () => {
+    const path = tempPath();
+    const a = instance("A", OLD, path);
+    await a.c.start();
+    const b = instance("B", OLD, path, { pid: 1002 });
+    await b.c.start();
+
+    await a.c.close();
+    await sleep(SETTLE_MS);
+
+    expect(b.c.roleName).toBe("owner");
+    expect(ran).toEqual([]);
+  });
+
+  test("if the oldest client binds first, a newer one takes over without a tool call being made", async () => {
+    const path = tempPath();
+    const a = instance("A", NEW, path, { pid: 1001 });
+    await a.c.start();
+    const o = instance("O", OLD, path, { pid: 1002 });
+    await o.c.start();
+    // M is slow to re-elect, so O holds the endpoint by the time it tries.
+    let elections = 0;
+    const m = instance("M", MID, path, {
+      pid: 1003,
+      elect: async (p) => {
+        if (++elections === 2) await sleep(50);
+        return elect(p);
+      },
+    });
+    await m.c.start();
+    expect([o.c.roleName, m.c.roleName]).toEqual(["client", "client"]);
+
+    await a.c.close();
+    await sleep(50 + SETTLE_MS * 2);
+
+    expect(m.c.roleName).toBe("owner");
+    expect(o.c.roleName).toBe("client");
+    expect(o.released()).toBe(1); // O owned it briefly, then handed it over
+    expect(m.log).toContain("obsbot-mcp: ipc takeover requested from pid 1002");
+    expect(ran).toEqual([]);
+  });
+
+  test("clients that all lose the same owner settle on exactly one of them", async () => {
+    const path = tempPath();
+    const a = instance("A", OLD, path);
+    await a.c.start();
+    const clients = [1, 2, 3, 4, 5].map((n) => instance(`C${n}`, OLD, path));
+    for (const c of clients) await c.c.start();
+
+    await a.c.close();
+    await sleep(SETTLE_MS);
+
+    const roles = clients.map((c) => c.c.roleName).sort();
+    expect(roles).toEqual(["client", "client", "client", "client", "owner"]);
+  });
+
+  test("after a handover, a bystander becomes the successor's client without making a call", async () => {
+    const path = tempPath();
+    const a = instance("A", OLD, path, { pid: 1001 });
+    await a.c.start();
+    const c = instance("C", OLD, path, { pid: 1002 });
+    await c.c.start();
+
+    const b = instance("B", NEW, path, { pid: 1003 });
+    await b.c.start();
+    await sleep(SETTLE_MS);
+
+    expect(b.c.roleName).toBe("owner");
+    expect(c.c.roleName).toBe("client");
+    expect(c.log.at(-1)).toBe(
+      "obsbot-mcp: ipc role=client owner-pid=1003 owner-build=0.7.0/2026-09-25T01:33:20Z/cccccccc",
+    );
+    expect(ran).toEqual([]);
+  });
+
+  test("a coordinator that has been closed does not take the endpoint back", async () => {
+    const path = tempPath();
+    const a = instance("A", OLD, path);
+    await a.c.start();
+    const b = instance("B", OLD, path);
+    await b.c.start();
+
+    await b.c.close();
+    await a.c.close();
+    await sleep(SETTLE_MS);
+
+    expect(b.c.roleName).toBe("none");
+    const next = await elect(path);
+    cleanup.push(() => void (next.role === "owner" ? next.server.close() : next.socket.destroy()));
+    expect(next.role).toBe("owner"); // nobody was holding it
+  });
+
   // -- calls caught in the middle --------------------------------------------
 
   test("a call running during a takeover finishes on the old owner, and its reply arrives", async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ipc/coordinator.test.ts`

Expected: 4 failed, 21 passed. The four are the ones that make no tool call and expect a role to have changed anyway.

`a coordinator that has been closed does not take the endpoint back` passes already. It is there to catch this task's change resurrecting a closed instance, which is the obvious way to get it wrong.

- [ ] **Step 3: Write the implementation**

Apply to `src/ipc/coordinator.ts`:

```diff
diff --git a/src/ipc/coordinator.ts b/src/ipc/coordinator.ts
index a5dc072..de15d32 100644
--- a/src/ipc/coordinator.ts
+++ b/src/ipc/coordinator.ts
@@ -264,6 +264,10 @@ export class Coordinator {
     }
     this.client = client;
     this.role = "client";
+    // Re-elect when the connection closes, not when we next have something to
+    // send: an idle newer build must not sit disconnected while an older one
+    // takes the endpoint and runs calls.
+    client.onClose(() => this.ownerLost(client));
     const owner =
       peer.kind === "peer"
         ? `owner-pid=${peer.pid} owner-build=${buildLabel(peer.build)}`
@@ -271,13 +275,17 @@ export class Coordinator {
     this.log(`obsbot-mcp: ipc role=client ${owner}`);
   }
 
-  /** The owner has gone. Re-elect — after the grace period if it stepped down for someone. */
+  /**
+   * The owner has gone. Re-elect — after the grace period if it stepped down
+   * for someone, so the successor binds first; after jitter alone if it simply
+   * went, so clients that all lost it at once do not stampede.
+   */
   private ownerLost(client: OwnerClient): void {
     if (this.client !== client || this.closing) return;
-    const delay = client.noticed ? this.t.stepDownGraceMs + this.jitter() : 0;
+    const delay = (client.noticed ? this.t.stepDownGraceMs : 0) + this.jitter();
     this.reset();
     void this.begin(async () => {
-      if (delay > 0) await sleep(delay);
+      await sleep(delay);
       await this.doElect();
     });
   }
```

- [ ] **Step 4: Run the tests to verify they pass, ten times**

```bash
npx tsc -p tsconfig.json --noEmit
for i in 1 2 3 4 5 6 7 8 9 10; do npx vitest run test/ipc 2>&1 | grep -E "Tests |failed"; done
```

Expected: `tsc` prints nothing, then ten lines with no `failed`. `coordinator.test.ts` has 25 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/coordinator.ts test/ipc/coordinator.test.ts
git commit -m "feat(ipc): clients re-elect when the owner goes, not when they next call" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Refuse to run on an older owner

A client that is newer than its owner and could not take over does not forward. This reverses today's behaviour on purpose: see §2 and §9 of the spec.

**Files:**
- Modify: `src/ipc/coordinator.ts`
- Test: `test/ipc/coordinator.test.ts`

**Interfaces:**
- Consumes: everything Task 7 consumed.
- Produces: no new names. `Coordinator.dispatch` now rejects with the refusal message (Global Constraints) when its owner is older and cannot hand over.

- [ ] **Step 1: Write the failing tests**

Apply to `test/ipc/coordinator.test.ts`:

```diff
diff --git a/test/ipc/coordinator.test.ts b/test/ipc/coordinator.test.ts
index f5420b0..ac2daaa 100644
--- a/test/ipc/coordinator.test.ts
+++ b/test/ipc/coordinator.test.ts
@@ -48,6 +48,81 @@ interface Instance {
   released: () => number;
 }
 
+/** What an owner that is not a Coordinator does with each kind of message. */
+interface Script {
+  /** Reply to a hello. Default: what a 0.7.0 owner says to any body it takes for a tool call. */
+  hello?: (send: (result: unknown) => void, fail: (error: string) => void) => void;
+  /** Reply to a takeover request. `drop` closes the requester's connection. */
+  takeover?: (send: (result: unknown) => void, drop: () => void) => void;
+}
+
+/**
+ * A raw owner on `path`, for standing in for instances a Coordinator cannot
+ * imitate: one that predates the handshake, one that grants a takeover and
+ * never lets go, one that refuses. It counts what reaches it.
+ */
+async function scriptedOwner(
+  path: string,
+  script: Script = {},
+): Promise<{ toolCalls: string[]; takeovers: () => number; close: () => Promise<void> }> {
+  const server = net.createServer();
+  const socks = new Set<net.Socket>();
+  const toolCalls: string[] = [];
+  let takeovers = 0;
+  server.on("connection", (sock) => {
+    socks.add(sock);
+    sock.on("close", () => socks.delete(sock));
+    sock.on("error", () => socks.delete(sock));
+    const dec = new FrameDecoder();
+    sock.on("data", (chunk: Buffer) => {
+      for (const m of dec.push(chunk)) {
+        const body = m.body as { ipc?: string; tool?: string };
+        const send = (result: unknown): void => {
+          sock.write(encodeFrame({ id: m.id, body: { ok: true, result } }));
+        };
+        const fail = (error: string): void => {
+          sock.write(encodeFrame({ id: m.id, body: { ok: false, error } }));
+        };
+        if (body.ipc === "hello" && script.hello) {
+          script.hello(send, fail);
+        } else if (body.ipc === "takeover" && script.takeover) {
+          takeovers++;
+          script.takeover(send, () => sock.destroy());
+        } else if (body.tool !== undefined) {
+          toolCalls.push(body.tool);
+          send(`scripted:${body.tool}`);
+        } else {
+          // Exactly what 0.7.0 does with a body it cannot read as a tool call.
+          fail(`unknown tool: ${body.tool}`);
+        }
+      }
+    });
+  });
+  await new Promise<void>((r) => server.listen(path, () => r()));
+  return {
+    toolCalls,
+    takeovers: () => takeovers,
+    close: () =>
+      new Promise<void>((r) => {
+        for (const s of socks) s.destroy();
+        server.close(() => r());
+      }),
+  };
+}
+
+const olderPeer =
+  (pid: number) =>
+  (send: (result: unknown) => void): void =>
+    send({ ipc: "hello", build: OLD, pid });
+
+const REFUSAL = (path: string): string =>
+  "obsbot-mcp: an older instance owns the camera endpoint and cannot hand it over. " +
+  "This instance will not run calls on older code. " +
+  `Stop the process listening on ${path}; the next call will take over.`;
+
+const CANNOT_HAND_OVER =
+  "obsbot-mcp: ipc owner is older and cannot hand over; tool calls will fail until it exits";
+
 describe("coordinator", () => {
   const cleanup: Array<() => void | Promise<void>> = [];
   /** `<instance>:<tool>` for every call, in the order they STARTED, across all instances. */
@@ -408,6 +483,153 @@ describe("coordinator", () => {
     expect(next.role).toBe("owner"); // nobody was holding it
   });
 
+  // -- when the newer build cannot take over -----------------------------------
+
+  test("a client of an owner that predates the handshake refuses to run calls on it", async () => {
+    const path = tempPath();
+    const legacy = await scriptedOwner(path);
+    cleanup.push(() => legacy.close());
+    const b = instance("B", NEW, path);
+    await b.c.start();
+
+    expect(b.c.roleName).toBe("client");
+    expect(b.log).toEqual([
+      "obsbot-mcp: ipc role=client owner-pid=unknown owner-build=legacy",
+      CANNOT_HAND_OVER,
+    ]);
+    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+    expect(legacy.toolCalls).toEqual([]); // nothing was forwarded
+    expect(ran).toEqual([]); // and nothing ran here either
+  });
+
+  test("an unstamped build refuses a legacy owner too", async () => {
+    const path = tempPath();
+    const legacy = await scriptedOwner(path);
+    cleanup.push(() => legacy.close());
+    const b = new Coordinator(async () => "B", { path, timing: FAST });
+    cleanup.push(() => b.close());
+    await b.start();
+
+    await expect(b.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+    expect(legacy.toolCalls).toEqual([]);
+  });
+
+  test("once the legacy owner exits, the next call takes over and succeeds", async () => {
+    const path = tempPath();
+    const legacy = await scriptedOwner(path);
+    const b = instance("B", NEW, path);
+    await b.c.start();
+    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+
+    await legacy.close();
+
+    expect(await b.c.dispatch("obsbot_status", {})).toBe("B:obsbot_status");
+    expect(b.c.roleName).toBe("owner");
+  });
+
+  test("an owner that does not answer the hello in time is refused the same way", async () => {
+    const path = tempPath();
+    const silent = await scriptedOwner(path, { hello: () => {} });
+    cleanup.push(() => silent.close());
+    const b = instance("B", NEW, path, { timing: { helloTimeoutMs: 40 } });
+    await b.c.start();
+
+    expect(b.log).toContain(CANNOT_HAND_OVER);
+    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+    expect(silent.toolCalls).toEqual([]);
+  });
+
+  test("an owner that grants a takeover and never lets go is refused after stepDownTimeoutMs", async () => {
+    const path = tempPath();
+    const stuck = await scriptedOwner(path, {
+      hello: olderPeer(2001),
+      takeover: (send) => send({ ipc: "takeover", granted: true }), // …and then nothing
+    });
+    cleanup.push(() => stuck.close());
+    const b = instance("B", NEW, path, { timing: { stepDownTimeoutMs: 80 } });
+    const started = Date.now();
+    await b.c.start();
+
+    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
+    expect(b.c.roleName).toBe("client");
+    expect(b.log).toContain(CANNOT_HAND_OVER);
+    expect(stuck.takeovers()).toBe(1);
+
+    // Each call asks once more before giving up.
+    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+    expect(stuck.takeovers()).toBe(2);
+    expect(stuck.toolCalls).toEqual([]);
+  });
+
+  test("an owner that refuses the takeover is not used", async () => {
+    const path = tempPath();
+    const stubborn = await scriptedOwner(path, {
+      hello: olderPeer(2001),
+      takeover: (send) => send({ ipc: "takeover", granted: false, reason: "not-newer" }),
+    });
+    cleanup.push(() => stubborn.close());
+    const b = instance("B", NEW, path);
+    await b.c.start();
+
+    expect(b.log).toContain(CANNOT_HAND_OVER);
+    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+    expect(stubborn.toolCalls).toEqual([]);
+  });
+
+  test("losing the bind maxTakeoverRounds times settles as a client that refuses", async () => {
+    const path = tempPath();
+    // Grants every takeover, drops the requester, and is still listening when
+    // the requester comes back — an older instance winning the bind every time.
+    const squatter = await scriptedOwner(path, {
+      hello: olderPeer(2001),
+      takeover: (send, drop) => {
+        send({ ipc: "takeover", granted: true });
+        setTimeout(drop, 5);
+      },
+    });
+    cleanup.push(() => squatter.close());
+    const b = instance("B", NEW, path);
+    await b.c.start();
+
+    expect(squatter.takeovers()).toBe(FAST.maxTakeoverRounds);
+    expect(b.c.roleName).toBe("client");
+    expect(b.log.at(-1)).toBe(CANNOT_HAND_OVER);
+    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
+    expect(squatter.toolCalls).toEqual([]);
+  });
+
+  test("an older client is still served by a newer owner it cannot take over from", async () => {
+    // The refusal is about running on OLDER code. An old client of a new owner
+    // is the normal case and must keep working.
+    const path = tempPath();
+    const a = instance("A", NEW, path);
+    await a.c.start();
+    const b = instance("B", OLD, path);
+    await b.c.start();
+
+    expect(b.log).not.toContain(CANNOT_HAND_OVER);
+    expect(await b.c.dispatch("obsbot_status", {})).toBe("A:obsbot_status");
+  });
+
+  test("a client that predates the handshake is served with no hello", async () => {
+    const path = tempPath();
+    const a = instance("A", NEW, path);
+    await a.c.start();
+
+    const sock = net.connect(path);
+    await new Promise<void>((r) => sock.once("connect", () => r()));
+    cleanup.push(() => void sock.destroy());
+    const dec = new FrameDecoder();
+    const reply = new Promise<unknown>((resolve) =>
+      sock.on("data", (chunk: Buffer) => {
+        for (const m of dec.push(chunk)) resolve(m);
+      }),
+    );
+    sock.write(encodeFrame({ id: 1, body: { tool: "obsbot_status", args: {} } }));
+
+    expect(await reply).toEqual({ id: 1, body: { ok: true, result: "A:obsbot_status" } });
+  });
+
   // -- calls caught in the middle --------------------------------------------
 
   test("a call running during a takeover finishes on the old owner, and its reply arrives", async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ipc/coordinator.test.ts`

Expected: 7 failed, 27 passed. The failures are of two kinds: the call was forwarded and came back as `scripted:obsbot_status` instead of being refused, or the `cannot hand over` line was never logged.

Two of the new tests pass already: `an older client is still served by a newer owner it cannot take over from` and `a client that predates the handshake is served with no hello`. They mark the edge of the refusal — it is about running on *older* code, and must not spread to the normal case.

- [ ] **Step 3: Write the implementation**

Apply to `src/ipc/coordinator.ts`:

```diff
diff --git a/src/ipc/coordinator.ts b/src/ipc/coordinator.ts
index de15d32..8344fed 100644
--- a/src/ipc/coordinator.ts
+++ b/src/ipc/coordinator.ts
@@ -77,6 +77,8 @@ export class Coordinator {
   private client?: OwnerClient;
   private ownerServer?: OwnerServer;
   private steppingDown = false;
+  /** Client of an owner that is older than us and could not be made to hand over. */
+  private blocked = false;
   private closing = false;
   /** A role change in progress — an election, or stepping down. Never rejects. */
   private pending?: Promise<void>;
@@ -118,6 +120,13 @@ export class Coordinator {
     // Twice at most: a call that lost its owner is retried exactly once.
     for (let attempt = 0; attempt < 2; attempt++) {
       await this.ensureRole();
+      if (this.role === "client" && this.blocked) {
+        await this.tryAgain();
+        // Still an older owner, still unable to hand over: do not run the call
+        // on its code. A call that succeeds on code the caller did not expect
+        // is worse than one that fails and says why.
+        if (this.role === "client" && this.blocked) throw new Error(this.blockedMessage());
+      }
       const client = this.client;
       try {
         return this.role === "owner"
@@ -157,6 +166,7 @@ export class Coordinator {
     this.client = undefined;
     this.ownerServer = undefined;
     this.steppingDown = false;
+    this.blocked = false;
   }
 
   private jitter(): number {
@@ -213,13 +223,11 @@ export class Coordinator {
         continue;
       }
 
-      if (
-        peer.kind !== "peer" ||
-        compareBuilds(this.build, peer.build) <= 0 ||
-        takeovers >= this.t.maxTakeoverRounds
-      ) {
-        return this.becomeClient(client, peer);
-      }
+      // An owner that cannot take part in a handover is older than anything that can.
+      if (peer.kind !== "peer") return this.becomeClient(client, peer, true);
+      if (compareBuilds(this.build, peer.build) <= 0) return this.becomeClient(client, peer, false);
+      // From here on the owner is older than us, so settling as its client means refusing to use it.
+      if (takeovers >= this.t.maxTakeoverRounds) return this.becomeClient(client, peer, true);
 
       takeovers++;
       this.log(`obsbot-mcp: ipc takeover requested from pid ${peer.pid}`);
@@ -230,7 +238,7 @@ export class Coordinator {
         granted = true; // closed before it could answer: the endpoint is free either way
       }
       if (!granted || !(await client.waitClosed(this.t.stepDownTimeoutMs))) {
-        return this.becomeClient(client, peer);
+        return this.becomeClient(client, peer, true);
       }
       // The old owner has let go. Go round again and bind.
     }
@@ -257,13 +265,14 @@ export class Coordinator {
     this.log("obsbot-mcp: ipc role=owner");
   }
 
-  private becomeClient(client: OwnerClient, peer: Peer): void {
+  private becomeClient(client: OwnerClient, peer: Peer, blocked: boolean): void {
     if (this.closing) {
       client.close();
       return;
     }
     this.client = client;
     this.role = "client";
+    this.blocked = blocked;
     // Re-elect when the connection closes, not when we next have something to
     // send: an idle newer build must not sit disconnected while an older one
     // takes the endpoint and runs calls.
@@ -273,6 +282,27 @@ export class Coordinator {
         ? `owner-pid=${peer.pid} owner-build=${buildLabel(peer.build)}`
         : "owner-pid=unknown owner-build=legacy";
     this.log(`obsbot-mcp: ipc role=client ${owner}`);
+    if (blocked) {
+      this.log(
+        "obsbot-mcp: ipc owner is older and cannot hand over; tool calls will fail until it exits",
+      );
+    }
+  }
+
+  /** The owner is older and still there. Try once more: a fresh connection, hello, takeover. */
+  private async tryAgain(): Promise<void> {
+    const client = this.client;
+    this.reset(); // first, so closing our own connection is not mistaken for losing the owner
+    client?.close();
+    await this.ensureRole();
+  }
+
+  private blockedMessage(): string {
+    return (
+      "obsbot-mcp: an older instance owns the camera endpoint and cannot hand it over. " +
+      "This instance will not run calls on older code. " +
+      `Stop the process listening on ${this.path}; the next call will take over.`
+    );
   }
 
   /**
```

- [ ] **Step 4: Run the tests to verify they pass, ten times**

```bash
npx tsc -p tsconfig.json --noEmit
for i in 1 2 3 4 5 6 7 8 9 10; do npx vitest run test/ipc 2>&1 | grep -E "Tests |failed"; done
```

Expected: `tsc` prints nothing, then ten lines with no `failed`. `coordinator.test.ts` has 34 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/coordinator.ts test/ipc/coordinator.test.ts
git commit -m "feat(ipc): never run a call on an owner older than this build" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Wire the server

The server loads its identity before anything else, gives the coordinator a way to release the camera, and lets the coordinator report its own role.

`release` calls `DeviceManager.shutdown()` on a process that stays alive and may be re-elected later. Nothing relied on a manager surviving `shutdown()` before, so this task pins that it does.

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `test/device/manager.test.ts` (append)

**Interfaces:**
- Consumes: `loadBuildId`, `buildLabel` (Task 1); `Coordinator`, `CoordinatorOptions` (Task 7); `DeviceManager.shutdown()`, `CaptureManager.stopAll()` — both already exist.
- Produces: nothing new for later tasks. The server's stderr now carries the lines in Global Constraints.

- [ ] **Step 1: Write the tests**

Append to the end of `test/device/manager.test.ts`:

```ts

// ---------------------------------------------------------------------------
// shutdown() is no longer only a way out. An owner that steps down for a newer
// build calls it and stays alive (src/mcp/server.ts, the coordinator's
// `release`), and may be re-elected later — so the same manager has to let go
// of everything AND still work afterwards.
// ---------------------------------------------------------------------------

test("shutdown() closes every helper the manager is holding", async () => {
  const make = fakeHelperFactory([{ serial: "AAA", locationId: 1 }]);
  const spawned: HelperProcess[] = [];
  const mgr = new DeviceManager(async () => {
    const h = await make();
    spawned.push(h);
    return h;
  });
  await mgr.get(); // binds: a registry helper, and a watcher
  expect(spawned.length).toBeGreaterThan(0);

  await mgr.shutdown();

  for (const h of spawned) expect(vi.mocked(h.close)).toHaveBeenCalled();
});

test("a manager that has been shut down binds again on the next call", async () => {
  const mgr = new DeviceManager(fakeHelperFactory([{ serial: "AAA", locationId: 1 }]));
  const first = await mgr.get();
  expect(await first.readSerial()).toBe("AAA");

  await mgr.shutdown();
  expect(await mgr.listCameras()).toEqual([
    expect.objectContaining({ serial: "AAA", status: "available" }), // no longer bound
  ]);

  const second = await mgr.get();
  expect(second).not.toBe(first);
  expect(await second.readSerial()).toBe("AAA");
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run test/device/manager.test.ts -t "shut"`

Expected: 2 passed. These describe behaviour the manager already has; they are here because the design now depends on it. **If either fails, stop and report it** — the `release` hook below is built on an assumption that would then be false.

- [ ] **Step 3: Write the implementation**

Apply to `src/mcp/server.ts`:

```diff
diff --git a/src/mcp/server.ts b/src/mcp/server.ts
index b353d67..c08c3d4 100644
--- a/src/mcp/server.ts
+++ b/src/mcp/server.ts
@@ -14,9 +14,16 @@ import { createTail2Tools } from "../tail2/tools.js";
 import { renderToolResult } from "./render.js";
 import { CaptureManager } from "../capture/manager.js";
 import { Coordinator, type RunLocal } from "../ipc/coordinator.js";
+import { buildLabel, loadBuildId } from "../ipc/build-id.js";
 import { VERSION } from "../version.js";
 
 export async function startServer(opts: { debug?: boolean } = {}): Promise<void> {
+  // Which build this process loaded. Read first and never again: a rebuild
+  // under a running process changes the stamp file but not the process, and
+  // the identity has to describe the process. See src/ipc/build-id.ts.
+  const build = loadBuildId();
+  console.error(`obsbot-mcp: build ${buildLabel(build)}`);
+
   // helperFactory subscribes every helper it spawns to the OS bus events, so
   // the manager hears about a camera arriving or leaving instead of finding
   // out by failing a call. See src/device/helper-factory.ts.
@@ -48,22 +55,33 @@ export async function startServer(opts: { debug?: boolean } = {}): Promise<void>
   // Single-owner camera coordination across concurrent MCP clients (see
   // IPC-DESIGN.md). Every instance elects: the owner runs tool calls locally
   // against the one DeviceManager; clients forward theirs to the owner and
-  // re-elect if it dies. runLocal is the tool dispatch, serialize()-wrapped so
-  // it is the single-camera lock — covering both this instance's own calls and
-  // any forwarded from clients (the local path bypasses OwnerServer's queue). A
-  // lone instance is simply the owner with no peers: it behaves exactly as
+  // re-elect if it goes away. The owner is the newest build alive — an older
+  // owner steps down for a newer one (see
+  // docs/superpowers/specs/2026-09-27-newest-build-wins-design.md). runLocal is
+  // the bare tool dispatch; the coordinator runs it behind the single-camera
+  // lock, which covers this instance's own calls and the ones forwarded to it.
+  // A lone instance is simply the owner with no peers: it behaves exactly as
   // before, plus an idle listener.
   const runLocal: RunLocal = async (name, args) => {
     const tool = tools.find((t) => t.name === name);
     if (!tool) throw new Error(`unknown tool: ${name}`);
     return tool.handler(args);
   };
-  const coordinator = new Coordinator(runLocal);
+  const coordinator = new Coordinator(runLocal, {
+    build,
+    // The coordinator reports its role on every change, on STDERR (never
+    // stdout — that's the JSON-RPC channel). "Which build will run my next
+    // call" is answered by the last `ipc role=` line; the harnesses match on it.
+    log: (line) => console.error(line),
+    // What stepping down for a newer build has to let go of: the same things a
+    // clean exit does, without the exit. On macOS the control open is
+    // exclusive, so the successor cannot open the camera until this is done.
+    release: async () => {
+      capture.stopAll();
+      await mgr.shutdown();
+    },
+  });
   await coordinator.start();
-  // Report the coordination role on STDERR (never stdout — that's the JSON-RPC
-  // channel). Useful for ops ("am I the owner or a client?") and observed by the
-  // ipc-hw-smoke harness to confirm a client really forwards to the owner.
-  console.error(`obsbot-mcp: ipc role=${coordinator.roleName}`);
 
   // Kill any recording/preview child processes when the server exits, so nothing
   // orphans, and drop the IPC endpoint / owner connection.
```

- [ ] **Step 4: Build and run the whole suite**

Run: `npm run build && npm test`

Expected: the build ends with a stamp line. Every test passes.

- [ ] **Step 5: See it start**

Use a rendezvous name of its own, so the server started here neither disturbs nor is disturbed by one in a live session.

```bash
OBSBOT_IPC_NAME=obsbot-plan-check node dist/index.js < /dev/null &
SERVER=$!; sleep 1; kill $SERVER; wait $SERVER 2>/dev/null
ls /tmp/obsbot-plan-check.sock 2>/dev/null || echo "(endpoint cleaned up)"
```

The server does not exit by itself when stdin is closed, which is why this starts it in the
background and stops it. Expected:

```
obsbot-mcp: build 0.7.0/<time>/<8 hex>
obsbot-mcp: ipc role=owner
(endpoint cleaned up)
```

Then check a bad name is refused:

```bash
OBSBOT_IPC_NAME='../x' node dist/index.js < /dev/null; echo "exit: $?"
```

Expected: an error naming `OBSBOT_IPC_NAME`, and `exit: 1`.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts test/device/manager.test.ts
git commit -m "feat(ipc): the server loads its build identity and can release the camera" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Prove it across processes

Two real servers, launched from two copies of `dist/` with different stamps. No hardware: the only tool called is `obsbot_tail2_devices`, which reads an in-memory registry.

**Files:**
- Modify: `scripts/ipc-smoke.mjs` (replace)

**Interfaces:**
- Consumes: the built `dist/`, the log lines in Global Constraints, `OBSBOT_IPC_NAME` (Task 3).
- Produces: nothing for later tasks. Exit code 0 means both the election case and the takeover case passed.

- [ ] **Step 1: Replace the script**

Replace `scripts/ipc-smoke.mjs` with:

```js
#!/usr/bin/env node
// Cross-process election smoke test for the IPC layer (IPC-DESIGN.md).
//
// Unit tests exercise elect() within one Node process; this proves it works
// across SEPARATE OS processes over a real named pipe / Unix-domain socket —
// exactly one owner, one client — which is the whole point on Windows, where
// the OS does not otherwise arbitrate camera access.
//
// It then proves the handover works across processes too: two REAL servers,
// launched from two copies of dist/ carrying different build stamps, where the
// newer one must take the endpoint from the older and the older's calls must
// then be served by it. See
// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md.
//
// No hardware is touched. The only tool called is obsbot_tail2_devices, which
// reads an in-memory registry. Every process here uses its own rendezvous name
// (OBSBOT_IPC_NAME), so a server running in your editor is not disturbed.
//
// Usage: node scripts/ipc-smoke.mjs   (after `npm run build`)

import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const self = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(self), "..");

if (process.argv[2] === "--child") {
  const { elect } = await import("../dist/ipc/rendezvous.js");
  try {
    const r = await elect(process.env.SMOKE_PATH);
    process.stdout.write(JSON.stringify({ pid: process.pid, role: r.role }) + "\n");
    if (r.role === "owner") {
      await new Promise((res) => setTimeout(res, 500)); // hold so the sibling sees it taken
      r.server.close();
    } else {
      r.socket.destroy();
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ pid: process.pid, error: String(e) }) + "\n");
  }
  process.exit(0);
}

const path =
  process.platform === "win32"
    ? `\\\\.\\pipe\\obsbot-smoke-${process.pid}`
    : `/tmp/obsbot-smoke-${process.pid}.sock`;

function child() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [self, "--child"], {
      env: { ...process.env, SMOKE_PATH: path },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => resolve(out.trim()));
  });
}

const a = child();
await new Promise((r) => setTimeout(r, 200)); // let A elect + hold the endpoint
const b = child();
const [ra, rb] = await Promise.all([a, b]);

console.log("child A:", ra);
console.log("child B:", rb);

const roles = [ra, rb]
  .map((s) => {
    try {
      return JSON.parse(s).role;
    } catch {
      return "?";
    }
  })
  .sort();

const ok = roles[0] === "client" && roles[1] === "owner";
console.log(ok ? "SMOKE PASS: one owner + one client across processes" : `SMOKE FAIL: roles=${JSON.stringify(roles)}`);

// ---------------------------------------------------------------------------
// Takeover across processes
// ---------------------------------------------------------------------------

const ipcName = `obsbot-smoke-${process.pid}`;
const endpoint =
  process.platform === "win32" ? `\\\\.\\pipe\\${ipcName}` : `/tmp/${ipcName}.sock`;
// Inside the repository, so the copies resolve node_modules and "type": "module"
// by walking up to the root. artifacts/ is already ignored.
const runDir = join(repoRoot, "artifacts", "ipc-builds", String(process.pid));

/** A copy of dist/ that claims to be a different build. Returns its entry point. */
function stagedBuild(name, builtAt, digestChar) {
  const dist = join(runDir, name, "dist");
  cpSync(join(repoRoot, "dist"), dist, { recursive: true });
  writeFileSync(
    join(dist, "build-info.json"),
    JSON.stringify({ version: "0.0.0-smoke", builtAt, digest: digestChar.repeat(64) }),
  );
  return join(dist, "index.js");
}

/** Launch a real server and speak MCP to it over stdio. */
function launch(label, entry) {
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, OBSBOT_IPC_NAME: ipcName },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = [];
  let errBuf = "";
  proc.stderr.on("data", (d) => {
    errBuf += d;
    let i;
    while ((i = errBuf.indexOf("\n")) >= 0) {
      const line = errBuf.slice(0, i);
      errBuf = errBuf.slice(i + 1);
      lines.push(line);
      for (const w of waiters.splice(0)) w();
    }
  });

  const pending = new Map();
  let outBuf = "";
  proc.stdout.on("data", (d) => {
    outBuf += d;
    let i;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`${label} ${method} timed out`)), 8000);
      pending.set(myId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });

  return {
    label,
    pid: proc.pid,
    lines,
    /** Resolve once `count` logged lines match `re`. Reject after `ms`. */
    async sees(re, count = 1, ms = 8000) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (lines.filter((l) => re.test(l)).length >= count) return;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `${label} never logged ${re} x${count}. It logged:\n  ${lines.join("\n  ")}`,
          );
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async handshake() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ipc-smoke", version: "0" },
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
    },
    async tail2Devices() {
      const resp = await send("tools/call", { name: "obsbot_tail2_devices", arguments: {} });
      return resp?.result?.content?.[0]?.text ?? JSON.stringify(resp);
    },
    kill: (signal) => proc.kill(signal),
  };
}

let takeoverOk = false;
let older, newer;
try {
  if (!existsSync(join(repoRoot, "dist", "index.js"))) {
    throw new Error("dist/index.js is missing — run `npm run build` first");
  }
  const olderEntry = stagedBuild("older", 1790100000000, "a");
  const newerEntry = stagedBuild("newer", 1790300000000, "c");

  older = launch("older", olderEntry);
  await older.sees(/ipc role=owner/);

  newer = launch("newer", newerEntry);
  await newer.sees(/ipc role=owner/);
  await older.sees(new RegExp(`ipc stepping down for pid ${newer.pid}$`));
  await older.sees(new RegExp(`ipc role=client owner-pid=${newer.pid} `));
  console.log(`takeover: pid ${newer.pid} (newer) took the endpoint from pid ${older.pid} (older)`);

  await older.handshake();
  const viaOlder = await older.tail2Devices();
  if (!/"cameras"/.test(viaOlder)) throw new Error(`call through the older instance failed: ${viaOlder}`);
  console.log(`takeover: a call through the older instance was answered: ${viaOlder}`);

  // Kill the owner outright. On POSIX that leaves a stale socket file behind.
  // The survivor has to notice and take the endpoint without being asked to do
  // anything — nobody makes a tool call here.
  newer.kill("SIGKILL");
  await older.sees(/ipc role=owner/, 2);
  console.log(`takeover: pid ${older.pid} took the endpoint back after its owner was killed`);

  const afterKill = await older.tail2Devices();
  if (!/"cameras"/.test(afterKill)) throw new Error(`call after the owner was killed failed: ${afterKill}`);

  takeoverOk = true;
  console.log("SMOKE PASS: the newer build took over, and the survivor recovered from a killed owner");
} catch (e) {
  console.log(`SMOKE FAIL (takeover): ${e instanceof Error ? e.message : e}`);
} finally {
  older?.kill();
  newer?.kill();
  rmSync(runDir, { recursive: true, force: true });
  if (process.platform !== "win32") {
    try {
      unlinkSync(endpoint);
    } catch {
      // already gone
    }
  }
}

process.exit(ok && takeoverOk ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `npm run build && node scripts/ipc-smoke.mjs; echo "exit: $?"`

Expected, with different pids:

```
child A: {"pid":27750,"role":"owner"}
child B: {"pid":27751,"role":"client"}
SMOKE PASS: one owner + one client across processes
takeover: pid 27753 (newer) took the endpoint from pid 27752 (older)
takeover: a call through the older instance was answered: {"cameras":[]}
takeover: pid 27752 took the endpoint back after its owner was killed
SMOKE PASS: the newer build took over, and the survivor recovered from a killed owner
exit: 0
```

- [ ] **Step 3: Check it cleaned up**

```bash
ls artifacts/ipc-builds/ 2>/dev/null; ls /tmp/obsbot-smoke-* 2>/dev/null; pgrep -fl "ipc-builds" || echo "(no leftover servers)"
```

Expected: no run directory, no socket file, `(no leftover servers)`.

- [ ] **Step 4: Commit**

```bash
git add scripts/ipc-smoke.mjs
git commit -m "test(ipc): smoke-test a handover between two real server processes" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The hardware harness

**This task has a step only a person can do.** An agent writes the script and checks its syntax, and stops there.

**Files:**
- Modify: `scripts/ipc-hw-smoke.mjs` (replace)

**Interfaces:**
- Consumes: the built `dist/` and `native/prebuilt/`, the log lines in Global Constraints, `OBSBOT_IPC_NAME` (Task 3).
- Produces: nothing for later tasks.

- [ ] **Step 1: Replace the script**

Replace `scripts/ipc-hw-smoke.mjs` with:

```js
#!/usr/bin/env node
// Hardware smoke test for the IPC layer (IPC-DESIGN.md), against a physically
// connected OBSBOT Tiny 2. Two cases, each with two real MCP servers speaking
// MCP over stdio:
//
//   1. Sharing. Instance A starts first → OWNER. Instance B starts second →
//      CLIENT. Both call obsbot_status. A reads the camera directly; B's call
//      is FORWARDED to A. Both must return a valid status block — no
//      collision, no "no device open".
//
//   2. Handover. An OLDER build owns the endpoint and has the camera open. A
//      NEWER build starts. The older one must release the camera and step
//      down, the newer one must open it, and obsbot_status through BOTH must
//      then succeed. On macOS the control open is exclusive, so this only
//      passes if the old owner has really let go before the new one opens.
//      See docs/superpowers/specs/2026-09-27-newest-build-wins-design.md.
//
// Non-destructive: obsbot_status only reads; the gimbal is never moved.
//
// TINY 2 ONLY. This harness binds the camera, and binding sends the Tiny 2
// serial query as a vendor write. The candidacy gate keeps that away from a
// Tail 2, so with only a Tail 2 attached this fails with "no OBSBOT camera
// found" and touches nothing — but do not go looking for a way round that.
//
// Every server here uses its own rendezvous name (OBSBOT_IPC_NAME), so a
// server running in your editor or a Claude session is not disturbed, and
// does not disturb this.
//
// Usage: node scripts/ipc-hw-smoke.mjs   (after `npm run build:all`)

import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(repoRoot, "dist", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function endpointFor(ipcName) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${ipcName}` : `/tmp/${ipcName}.sock`;
}

function launch(label, ipcName, entry = DIST) {
  const proc = spawn(process.execPath, [entry, "--debug"], {
    env: { ...process.env, OBSBOT_IPC_NAME: ipcName },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = [];
  let errBuf = "";
  proc.stderr.on("data", (d) => {
    errBuf += d;
    let i;
    while ((i = errBuf.indexOf("\n")) >= 0) {
      lines.push(errBuf.slice(0, i));
      errBuf = errBuf.slice(i + 1);
      for (const w of waiters.splice(0)) w();
    }
  });

  const pending = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`${label} ${method} timed out`)), 8000);
      pending.set(myId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  return {
    label,
    proc,
    pid: proc.pid,
    lines,
    /** The role this instance last reported. It changes when the endpoint changes hands. */
    role: () => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /ipc role=(\w+)/.exec(lines[i]);
        if (m) return m[1];
      }
      return "(unknown)";
    },
    /** Resolve once `count` logged lines match `re`. Reject after `ms`. */
    async sees(re, count = 1, ms = 20000) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (lines.filter((l) => re.test(l)).length >= count) return;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `${label} never logged ${re} x${count}. It logged:\n  ${lines.join("\n  ")}`,
          );
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async handshake() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ipc-hw-smoke", version: "0" },
      });
      notify("notifications/initialized");
    },
    async status() {
      const resp = await send("tools/call", { name: "obsbot_status", arguments: {} });
      const text = resp?.result?.content?.[0]?.text ?? "";
      return { raw: resp, text };
    },
    kill: () => proc.kill(),
  };
}

function freeEndpoint(ipcName) {
  if (process.platform === "win32") return;
  try {
    unlinkSync(endpointFor(ipcName));
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Case 1 — sharing
// ---------------------------------------------------------------------------

async function sharing() {
  const ipcName = `obsbot-hw-smoke-${process.pid}-share`;
  let a, b;
  try {
    a = launch("A", ipcName);
    await a.sees(/ipc role=owner/);
    b = launch("B", ipcName);
    await b.sees(/ipc role=client/);

    await a.handshake();
    await b.handshake();

    const sa = await a.status();
    const sb = await b.status();

    console.log(`A role=${a.role()}  status=${sa.text.slice(0, 80)}`);
    console.log(`B role=${b.role()}  status=${sb.text.slice(0, 80)}`);

    const aOwner = a.role() === "owner";
    const bClient = b.role() === "client";
    const aOk = /awake/.test(sa.text);
    const bOk = /awake/.test(sb.text); // B's status came THROUGH the owner

    const pass = aOwner && bClient && aOk && bOk;
    console.log(
      pass
        ? "HW SMOKE PASS (sharing): A owns, B forwards; both read the camera with no collision"
        : `HW SMOKE FAIL (sharing): aOwner=${aOwner} bClient=${bClient} aOk=${aOk} bOk=${bOk}`,
    );
    return pass;
  } finally {
    a?.kill();
    b?.kill();
    await sleep(500); // let the helpers exit and the camera free up before the next case
    freeEndpoint(ipcName);
  }
}

// ---------------------------------------------------------------------------
// Case 2 — handover
// ---------------------------------------------------------------------------

/**
 * A copy of this build that claims to be a different one. It needs the helper
 * as well as dist/, because the server resolves native/prebuilt/ relative to
 * where it was launched from. Returns the entry point.
 */
function stagedBuild(runDir, name, builtAt, digestChar) {
  const root = join(runDir, name);
  cpSync(join(repoRoot, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(repoRoot, "native", "prebuilt"), join(root, "native", "prebuilt"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "dist", "build-info.json"),
    JSON.stringify({ version: "0.0.0-smoke", builtAt, digest: digestChar.repeat(64) }),
  );
  return join(root, "dist", "index.js");
}

async function handover() {
  const ipcName = `obsbot-hw-smoke-${process.pid}-handover`;
  // Inside the repository, so the copies resolve node_modules and
  // "type": "module" by walking up to the root. artifacts/ is already ignored.
  const runDir = join(repoRoot, "artifacts", "ipc-builds", `hw-${process.pid}`);
  let older, newer;
  try {
    const olderEntry = stagedBuild(runDir, "older", 1790100000000, "a");
    const newerEntry = stagedBuild(runDir, "newer", 1790300000000, "c");

    older = launch("older", ipcName, olderEntry);
    await older.sees(/ipc role=owner/);
    await older.handshake();
    const before = await older.status(); // the older build now has the camera open
    console.log(`older role=${older.role()}  status=${before.text.slice(0, 80)}`);
    if (!/awake/.test(before.text)) {
      throw new Error(`the older build could not read the camera: ${before.text}`);
    }

    newer = launch("newer", ipcName, newerEntry);
    await newer.sees(/ipc role=owner/);
    await older.sees(new RegExp(`ipc stepping down for pid ${newer.pid}$`));
    await older.sees(new RegExp(`ipc role=client owner-pid=${newer.pid} `));
    await newer.handshake();

    const viaNewer = await newer.status();
    const viaOlder = await older.status(); // forwarded to the newer build
    console.log(`newer role=${newer.role()}  status=${viaNewer.text.slice(0, 80)}`);
    console.log(`older role=${older.role()}  status=${viaOlder.text.slice(0, 80)}`);

    const newerOwns = newer.role() === "owner";
    const olderForwards = older.role() === "client";
    const newerOk = /awake/.test(viaNewer.text);
    const olderOk = /awake/.test(viaOlder.text);

    const pass = newerOwns && olderForwards && newerOk && olderOk;
    console.log(
      pass
        ? "HW SMOKE PASS (handover): the older build released the camera and the newer one opened it"
        : `HW SMOKE FAIL (handover): newerOwns=${newerOwns} olderForwards=${olderForwards} ` +
            `newerOk=${newerOk} olderOk=${olderOk}`,
    );
    return pass;
  } finally {
    older?.kill();
    newer?.kill();
    rmSync(runDir, { recursive: true, force: true });
    freeEndpoint(ipcName);
  }
}

// ---------------------------------------------------------------------------

let ok = false;
try {
  if (!existsSync(DIST)) throw new Error("dist/index.js is missing — run `npm run build:all` first");
  const shared = await sharing();
  const handed = await handover();
  ok = shared && handed;
} catch (e) {
  console.error("HW SMOKE ERROR:", e instanceof Error ? e.message : e);
}
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Check its syntax. Do not run it.**

Run: `node --check scripts/ipc-hw-smoke.mjs && echo "syntax ok"`

Expected: `syntax ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/ipc-hw-smoke.mjs
git commit -m "test(hardware): the IPC harness covers a handover, on its own rendezvous name" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4 — PERSON ONLY: run it against a Tiny 2**

Ask the user to do this, and wait. Requirements: a **Tiny 2** attached, and no other program holding it open.

```bash
npm run build:all && node scripts/ipc-hw-smoke.mjs
```

Expected: `HW SMOKE PASS (sharing): …` then `HW SMOKE PASS (handover): …`, exit code 0. Record the result, the platform and the date in Task 13's spec edit. If it has not been run, the spec says so.

---

### Task 13: Documentation

**Files:**
- Modify: `README.md`
- Modify: `IPC-DESIGN.md`
- Modify: `docs/superpowers/specs/2026-09-27-newest-build-wins-design.md`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1–11.
- Produces: nothing for later tasks.

- [ ] **Step 1: Rewrite the README's first trap**

In `README.md`, under `### Testing changes through the live MCP tools`, replace everything from the paragraph that begins `**Rebuilding and reloading is not enough — kill stale server processes first.**` down to and including the paragraph that ends `since descriptions come from the new process either way.` with:

````markdown
**Rebuild, then start one server from the new build.** The MCP server runs from `dist/`, so a
source change is invisible until `npm run build`. This project coordinates concurrent clients by
electing a single owner process (see `IPC-DESIGN.md`), and **the owner executes every tool call**,
whichever session made it. The owner is the newest build alive: when a server starts from a newer
build than the owner's, the owner finishes the call in flight, releases the camera, and hands the
endpoint over. Reloading the server in one MCP client is therefore enough. Other sessions stay open
and their calls are served by the new build.

Three things to know:

- **The tool list of other sessions does not refresh.** A session that started on an older build
  keeps the list it had; its calls run the new code. Reload that session's server to get new tools.
- **A server that predates the handover cannot hand over** (0.7.0 and earlier). A newer server
  will not run calls on it, and says so: `an older instance owns the camera endpoint and cannot
  hand it over`. Stop the old process once; after that, rebuilds take over on their own.
- **Use `npm run build` and `npm run build:helper`.** They stamp the build with its identity
  (`dist/build-info.json`). A bare `tsc`, or a helper copied into place by hand, is not stamped and
  does not count as a newer build.

To see which build will run your next call, read the last `ipc role=` line in the server's log.
`role=owner` means this process; `role=client owner-pid=… owner-build=…` names the one that will.
Claude Code keeps the log under `~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-obsbot/` on
macOS.

```bash
# Linux / macOS — every server process, with its start time
pgrep -af "obsbot.*dist/index.js"
```

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*Obsbot*" } |
  Select-Object ProcessId, CreationDate
```

Set `OBSBOT_IPC_NAME` to give a server a rendezvous endpoint of its own (1–64 characters from
`A-Z a-z 0-9 . _ -`). Test harnesses do this so they leave a live session alone. Two owners on one
machine can contend for the camera, so it is not for everyday use.
````

- [ ] **Step 2: Point `IPC-DESIGN.md` at the new rule**

In `IPC-DESIGN.md`, insert this directly under the heading `## Chosen design — peer-elected in-process owner (no daemon)`, before the paragraph that begins `The **owner** role is assumed by`:

```markdown
> **Superseded in part, 2026-09-27.** The owner is no longer whichever instance started first. It
> is the newest *build* alive, and an older owner steps down for a newer one. The election, the
> transport and the TCC reasoning below are unchanged. See
> `docs/superpowers/specs/2026-09-27-newest-build-wins-design.md`.

```

- [ ] **Step 3: Bring the spec up to date**

In `docs/superpowers/specs/2026-09-27-newest-build-wins-design.md`:

Replace the status line with:

```markdown
**Status:** approved 2026-09-27. Implemented by `docs/superpowers/plans/2026-09-27-newest-build-wins.md`.
```

In §7.3, add this row to the constants table, after `STEP_DOWN_TIMEOUT_MS`:

```markdown
| `RELEASE_TIMEOUT_MS` | 10000 | Longest a stepping-down owner waits for its own release. Under `STEP_DOWN_TIMEOUT_MS`, so a hung helper cannot strand both instances. |
```

In §10, replace the bullet that begins `It must match` with:

```markdown
- It must match `^[A-Za-z0-9._-]{1,64}$`. Anything else is a startup error, because the name
  becomes part of a filesystem path or pipe name. Unset and empty both mean the default.
```

In §13.3, append the hardware result as a new paragraph. If Task 12 Step 4 was run:

```markdown
**Result.** Run on <platform>, <date>, against a Tiny 2: sharing passed, handover passed.
```

If it was not:

```markdown
**Result.** Not yet run on hardware. `scripts/ipc-hw-smoke.mjs` is written and syntax-checked.
```

- [ ] **Step 4: Run the whole suite one last time**

Run: `npm run build && npm test && node scripts/ipc-smoke.mjs`

Expected: every test passes, and the smoke test ends `exit` 0 with both `SMOKE PASS` lines.

- [ ] **Step 5: Commit**

```bash
git add README.md IPC-DESIGN.md docs/superpowers/specs/2026-09-27-newest-build-wins-design.md
git commit -m "docs: the newest build owns the endpoint" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the last task

- **One last full restart is still needed.** Every server running today predates the handover and cannot step down. Until each has exited once, a server from this branch will refuse to run calls (Task 9). Say this to the user when the work is handed back; it is the one thing they will otherwise trip over.
- **Not in this plan**, and listed in the spec's §16: clients taking their tool list from the owner, a tool that reports the role, reloading on a change to `dist/`, and any Tail 2 USB transport.
- **Seen while checking Task 10, and not addressed here:** a server started with stdin already closed keeps running. If the same is true when an MCP client goes away without signalling it, servers outlive their sessions. Under this design such a server is harmless to newer builds, because it steps down for them, but it is still a process nobody owns. Worth its own look.
- **`CHANGELOG.md` is untouched.** Its newest entry is 0.7.0 and it has no unreleased section; the entry for this belongs to whoever cuts the release.
