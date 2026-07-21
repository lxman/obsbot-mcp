import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HelperProcess } from "../../src/transport/helper-process.js";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-helper.mjs");
const spawnFake = (): HelperProcess => new HelperProcess(["node", fake]);

// Same convention as helper-process.test.ts: reach the private rpc() to drive
// ops the typed methods don't expose (here: the fake helper's death/hang ops).
const rpcOf = (h: HelperProcess) =>
  (
    h as unknown as {
      rpc: (req: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
    }
  ).rpc.bind(h);

// ---------------------------------------------------------------------------
//  A dead or wedged helper must FAIL, never hang.
//
//  Field incident 2026-07-21: the helper was killed to replace its locked
//  binary. The MCP server did not crash and did not recover -- obsbot_status
//  simply never returned. HelperProcess registered no exit/close/error handler
//  and rpcRaw() built a resolve-only promise, so a request sent to a dead child
//  had no path to settle: the caller waited forever.
//
//  This matters beyond that self-inflicted case: any helper crash in the field
//  wedges the server identically, with no error and no timeout.
//
//  Failing fast is also what makes recovery work. ensureReady() already
//  self-heals on a THROW (invalidate() -> re-bind -> fresh helper), so a hang
//  doesn't merely block one call, it silently disables the respawn path that
//  already exists. No new respawn logic is needed -- only a settled promise.
// ---------------------------------------------------------------------------

/** Rejects if `p` hasn't settled within `ms`, so a hang fails the test fast. */
async function mustSettle<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`HUNG: promise did not settle in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

test("an in-flight request rejects when the helper dies under it", async () => {
  const h = spawnFake();
  await h.start();
  // `die` exits the helper WITHOUT answering — a request in flight at the
  // moment of death. This is exactly the killed-helper case.
  await expect(mustSettle(rpcOf(h)({ op: "die" }))).rejects.toThrow(/helper/i);
});

test("a request sent to an already-dead helper rejects instead of hanging", async () => {
  const h = spawnFake();
  await h.start();
  expect(await h.version()).toBe("fake-1"); // alive first

  await h.close();
  await new Promise((r) => setTimeout(r, 200)); // let the child actually go

  await expect(mustSettle(h.version())).rejects.toThrow(/helper/i);
});

test("every queued request rejects, not just the first", async () => {
  const h = spawnFake();
  await h.start();
  await h.close();
  await new Promise((r) => setTimeout(r, 200));

  const results = await mustSettle(
    Promise.allSettled([h.version(), h.enumerate(), h.zoomRange()]),
  );
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
});

test("a wedged helper that never answers times out rather than hanging forever", async () => {
  const h = spawnFake();
  await h.start();
  // `hang` keeps the process ALIVE and silent, so no 'exit' ever fires — only a
  // timeout can settle this. This is the shape a driver-level hardware wedge
  // takes, and the one a death handler alone cannot catch.
  await expect(mustSettle(rpcOf(h)({ op: "hang" }, 400), 4000)).rejects.toThrow(/timed out/i);
  await h.close();
});

test("a slow-but-answering helper is not killed by the timeout", async () => {
  const h = spawnFake();
  await h.start();
  // Generous budget, fast reply: must resolve normally. Guards against a
  // timeout so aggressive it false-positives on legitimately slow ops.
  const resp = await mustSettle(rpcOf(h)({ op: "version" }, 3000));
  expect(resp.version).toBe("fake-1");
  await h.close();
});

test("close() is idempotent and does not wedge", async () => {
  const h = spawnFake();
  await h.start();
  await h.close();
  await mustSettle(h.close());
});
