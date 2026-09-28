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

/** What an owner that is not a Coordinator does with each kind of message. */
interface Script {
  /** Reply to a hello. Default: what a 0.7.0 owner says to any body it takes for a tool call. */
  hello?: (send: (result: unknown) => void, fail: (error: string) => void) => void;
  /** Reply to a takeover request. `drop` closes the requester's connection. */
  takeover?: (send: (result: unknown) => void, drop: () => void) => void;
}

/**
 * A raw owner on `path`, for standing in for instances a Coordinator cannot
 * imitate: one that predates the handshake, one that grants a takeover and
 * never lets go, one that refuses. It counts what reaches it.
 */
async function scriptedOwner(
  path: string,
  script: Script = {},
): Promise<{ toolCalls: string[]; takeovers: () => number; close: () => Promise<void> }> {
  const server = net.createServer();
  const socks = new Set<net.Socket>();
  const toolCalls: string[] = [];
  let takeovers = 0;
  server.on("connection", (sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => socks.delete(sock));
    const dec = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      for (const m of dec.push(chunk)) {
        const body = m.body as { ipc?: string; tool?: string };
        const send = (result: unknown): void => {
          sock.write(encodeFrame({ id: m.id, body: { ok: true, result } }));
        };
        const fail = (error: string): void => {
          sock.write(encodeFrame({ id: m.id, body: { ok: false, error } }));
        };
        if (body.ipc === "hello" && script.hello) {
          script.hello(send, fail);
        } else if (body.ipc === "takeover" && script.takeover) {
          takeovers++;
          script.takeover(send, () => sock.destroy());
        } else if (body.tool !== undefined) {
          toolCalls.push(body.tool);
          send(`scripted:${body.tool}`);
        } else {
          // Exactly what 0.7.0 does with a body it cannot read as a tool call.
          fail(`unknown tool: ${body.tool}`);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  return {
    toolCalls,
    takeovers: () => takeovers,
    close: () =>
      new Promise<void>((r) => {
        for (const s of socks) s.destroy();
        server.close(() => r());
      }),
  };
}

const olderPeer =
  (pid: number) =>
  (send: (result: unknown) => void): void =>
    send({ ipc: "hello", build: OLD, pid });

const REFUSAL = (path: string): string =>
  "obsbot-mcp: an older instance owns the camera endpoint and cannot hand it over. " +
  "This instance will not run calls on older code. " +
  `Stop the process listening on ${path}; the next call will take over.`;

const CANNOT_HAND_OVER =
  "obsbot-mcp: ipc owner is older and cannot hand over; tool calls will fail until it exits";

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

    // No sleep: a call made the instant the owner is lost waits for the
    // re-election instead of failing.
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

  // -- when the owner goes away ------------------------------------------------

  test("a client takes the endpoint when the owner exits, without a tool call being made", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const b = instance("B", OLD, path, { pid: 1002 });
    await b.c.start();

    await a.c.close();
    await sleep(SETTLE_MS);

    expect(b.c.roleName).toBe("owner");
    expect(ran).toEqual([]);
  });

  test("if the oldest client binds first, a newer one takes over without a tool call being made", async () => {
    const path = tempPath();
    const a = instance("A", NEW, path, { pid: 1001 });
    await a.c.start();
    const o = instance("O", OLD, path, { pid: 1002 });
    await o.c.start();
    // M is slow to re-elect, so O holds the endpoint by the time it tries.
    let elections = 0;
    const m = instance("M", MID, path, {
      pid: 1003,
      elect: async (p) => {
        if (++elections === 2) await sleep(50);
        return elect(p);
      },
    });
    await m.c.start();
    expect([o.c.roleName, m.c.roleName]).toEqual(["client", "client"]);

    await a.c.close();
    await sleep(50 + SETTLE_MS * 2);

    expect(m.c.roleName).toBe("owner");
    expect(o.c.roleName).toBe("client");
    expect(o.released()).toBe(1); // O owned it briefly, then handed it over
    expect(m.log).toContain("obsbot-mcp: ipc takeover requested from pid 1002");
    expect(ran).toEqual([]);
  });

  test("clients that all lose the same owner settle on exactly one of them", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const clients = [1, 2, 3, 4, 5].map((n) => instance(`C${n}`, OLD, path));
    for (const c of clients) await c.c.start();

    await a.c.close();
    await sleep(SETTLE_MS);

    const roles = clients.map((c) => c.c.roleName).sort();
    expect(roles).toEqual(["client", "client", "client", "client", "owner"]);
  });

  test("after a handover, a bystander becomes the successor's client without making a call", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path, { pid: 1001 });
    await a.c.start();
    const c = instance("C", OLD, path, { pid: 1002 });
    await c.c.start();

    const b = instance("B", NEW, path, { pid: 1003 });
    await b.c.start();
    await sleep(SETTLE_MS);

    expect(b.c.roleName).toBe("owner");
    expect(c.c.roleName).toBe("client");
    expect(c.log.at(-1)).toBe(
      "obsbot-mcp: ipc role=client owner-pid=1003 owner-build=0.7.0/2026-09-25T01:33:20Z/cccccccc",
    );
    expect(ran).toEqual([]);
  });

  test("a coordinator that has been closed does not take the endpoint back", async () => {
    const path = tempPath();
    const a = instance("A", OLD, path);
    await a.c.start();
    const b = instance("B", OLD, path);
    await b.c.start();

    await b.c.close();
    await a.c.close();
    await sleep(SETTLE_MS);

    expect(b.c.roleName).toBe("none");
    const next = await elect(path);
    cleanup.push(() => void (next.role === "owner" ? next.server.close() : next.socket.destroy()));
    expect(next.role).toBe("owner"); // nobody was holding it
  });

  // -- when the newer build cannot take over -----------------------------------

  test("a client of an owner that predates the handshake refuses to run calls on it", async () => {
    const path = tempPath();
    const legacy = await scriptedOwner(path);
    cleanup.push(() => legacy.close());
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(b.c.roleName).toBe("client");
    expect(b.log).toEqual([
      "obsbot-mcp: ipc role=client owner-pid=unknown owner-build=legacy",
      CANNOT_HAND_OVER,
    ]);
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(legacy.toolCalls).toEqual([]); // nothing was forwarded
    expect(ran).toEqual([]); // and nothing ran here either
  });

  test("an unstamped build refuses a legacy owner too", async () => {
    const path = tempPath();
    const legacy = await scriptedOwner(path);
    cleanup.push(() => legacy.close());
    const b = new Coordinator(async () => "B", { path, timing: FAST });
    cleanup.push(() => b.close());
    await b.start();

    await expect(b.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(legacy.toolCalls).toEqual([]);
  });

  test("once the legacy owner exits, the next call takes over and succeeds", async () => {
    const path = tempPath();
    const legacy = await scriptedOwner(path);
    const b = instance("B", NEW, path);
    await b.c.start();
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));

    await legacy.close();

    expect(await b.c.dispatch("obsbot_status", {})).toBe("B:obsbot_status");
    expect(b.c.roleName).toBe("owner");
  });

  test("an owner that does not answer the hello in time is refused the same way", async () => {
    const path = tempPath();
    const silent = await scriptedOwner(path, { hello: () => {} });
    cleanup.push(() => silent.close());
    const b = instance("B", NEW, path, { timing: { helloTimeoutMs: 40 } });
    await b.c.start();

    expect(b.log).toContain(CANNOT_HAND_OVER);
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(silent.toolCalls).toEqual([]);
  });

  test("an owner that grants a takeover and never lets go is refused after stepDownTimeoutMs", async () => {
    const path = tempPath();
    const stuck = await scriptedOwner(path, {
      hello: olderPeer(2001),
      takeover: (send) => send({ ipc: "takeover", granted: true }), // …and then nothing
    });
    cleanup.push(() => stuck.close());
    const b = instance("B", NEW, path, { timing: { stepDownTimeoutMs: 80 } });
    const started = Date.now();
    await b.c.start();

    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(b.c.roleName).toBe("client");
    expect(b.log).toContain(CANNOT_HAND_OVER);
    expect(stuck.takeovers()).toBe(1);

    // Each call asks once more before giving up.
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(stuck.takeovers()).toBe(2);
    expect(stuck.toolCalls).toEqual([]);
  });

  test("an owner that refuses the takeover is not used", async () => {
    const path = tempPath();
    const stubborn = await scriptedOwner(path, {
      hello: olderPeer(2001),
      takeover: (send) => send({ ipc: "takeover", granted: false, reason: "not-newer" }),
    });
    cleanup.push(() => stubborn.close());
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(b.log).toContain(CANNOT_HAND_OVER);
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(stubborn.toolCalls).toEqual([]);
  });

  test("losing the bind maxTakeoverRounds times settles as a client that refuses", async () => {
    const path = tempPath();
    // Grants every takeover, drops the requester, and is still listening when
    // the requester comes back — an older instance winning the bind every time.
    const squatter = await scriptedOwner(path, {
      hello: olderPeer(2001),
      takeover: (send, drop) => {
        send({ ipc: "takeover", granted: true });
        setTimeout(drop, 5);
      },
    });
    cleanup.push(() => squatter.close());
    const b = instance("B", NEW, path);
    await b.c.start();

    expect(squatter.takeovers()).toBe(FAST.maxTakeoverRounds);
    expect(b.c.roleName).toBe("client");
    expect(b.log.at(-1)).toBe(CANNOT_HAND_OVER);
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(squatter.toolCalls).toEqual([]);
  });

  test.each([
    ["an owner that predates the handshake", {}],
    [
      "an older owner that refuses the takeover",
      {
        hello: olderPeer(2001),
        takeover: (send: (result: unknown) => void): void =>
          send({ ipc: "takeover", granted: false, reason: "not-newer" }),
      },
    ],
  ])("calls made at the same moment against %s are each refused, with the reason", async (_what, script) => {
    // An MCP client issues tool calls in parallel. Every one of them has to get
    // the refusal — not just the first, with the rest tripping over its retry.
    const path = tempPath();
    const owner = await scriptedOwner(path, script);
    cleanup.push(() => owner.close());
    const b = instance("B", NEW, path);
    await b.c.start();

    const outcomes = await Promise.allSettled([
      b.c.dispatch("obsbot_status", {}),
      b.c.dispatch("obsbot_wake", {}),
      b.c.dispatch("obsbot_gimbal_position", {}),
    ]);

    expect(
      outcomes.map((o) => (o.status === "rejected" ? (o.reason as Error).message : "resolved")),
    ).toEqual([REFUSAL(path), REFUSAL(path), REFUSAL(path)]);
    expect(owner.toolCalls).toEqual([]);
  });

  test("calls made at the same moment ask the owner once more between them, not once each", async () => {
    const path = tempPath();
    const stubborn = await scriptedOwner(path, {
      hello: olderPeer(2001),
      takeover: (send) => send({ ipc: "takeover", granted: false, reason: "not-newer" }),
    });
    cleanup.push(() => stubborn.close());
    const b = instance("B", NEW, path);
    await b.c.start();
    expect(stubborn.takeovers()).toBe(1);

    await Promise.allSettled([
      b.c.dispatch("obsbot_status", {}),
      b.c.dispatch("obsbot_wake", {}),
      b.c.dispatch("obsbot_gimbal_position", {}),
    ]);

    expect(stubborn.takeovers()).toBe(2);
  });

  test("an owner that answers the hello and never answers the takeover does not hang startup", async () => {
    const path = tempPath();
    const silent = await scriptedOwner(path, {
      hello: olderPeer(2001),
      takeover: () => {}, // …nothing, ever
    });
    cleanup.push(() => silent.close());
    const b = instance("B", NEW, path);

    const outcome = await Promise.race([
      b.c.start().then(() => "started"),
      sleep(FAST.helloTimeoutMs + 400).then(() => "still waiting"),
    ]);

    expect(outcome).toBe("started");
    expect(b.c.roleName).toBe("client");
    expect(b.log).toContain(CANNOT_HAND_OVER);
    await expect(b.c.dispatch("obsbot_status", {})).rejects.toThrow(REFUSAL(path));
    expect(silent.toolCalls).toEqual([]);
  });

  test("an older client is still served by a newer owner it cannot take over from", async () => {
    // The refusal is about running on OLDER code. An old client of a new owner
    // is the normal case and must keep working.
    const path = tempPath();
    const a = instance("A", NEW, path);
    await a.c.start();
    const b = instance("B", OLD, path);
    await b.c.start();

    expect(b.log).not.toContain(CANNOT_HAND_OVER);
    expect(await b.c.dispatch("obsbot_status", {})).toBe("A:obsbot_status");
  });

  test("a client that predates the handshake is served with no hello", async () => {
    const path = tempPath();
    const a = instance("A", NEW, path);
    await a.c.start();

    const sock = net.connect(path);
    await new Promise<void>((r) => sock.once("connect", () => r()));
    cleanup.push(() => void sock.destroy());
    const dec = new FrameDecoder();
    const reply = new Promise<unknown>((resolve) =>
      sock.on("data", (chunk: Buffer) => {
        for (const m of dec.push(chunk)) resolve(m);
      }),
    );
    sock.write(encodeFrame({ id: 1, body: { tool: "obsbot_status", args: {} } }));

    expect(await reply).toEqual({ id: 1, body: { ok: true, result: "A:obsbot_status" } });
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
