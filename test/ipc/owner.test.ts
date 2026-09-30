import { describe, test, expect, afterEach } from "vitest";
import net from "node:net";
import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
import { OwnerServer, type ControlHandlers } from "../../src/ipc/owner.js";
import { encodeFrame, FrameDecoder } from "../../src/ipc/protocol.js";
import { StepDownError } from "../../src/ipc/gate.js";
import type { BuildId } from "../../src/ipc/build-id.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

const OWNER_BUILD: BuildId = { version: "0.7.0", builtAt: 500, digest: "a".repeat(64) };
const NEWER_BUILD: BuildId = { version: "0.7.0", builtAt: 900, digest: "b".repeat(64) };

/** An owner that knows who it is and never hands over. */
const REFUSES: ControlHandlers = {
  identity: () => ({ build: OWNER_BUILD, pid: 4242 }),
  takeover: () => ({ ipc: "takeover", granted: false, reason: "not-newer" }),
};

// Minimal framed client for exercising the owner (the real one is brick 4).
async function rawClient(path: string): Promise<{
  call: (body: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Frames that were not a reply to any call, in arrival order. */
  notices: Array<{ id: number; body: unknown }>;
  /** Resolves when the owner closes the connection. */
  ended: Promise<void>;
  close: () => void;
}> {
  const socket = net.connect(path);
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", rej);
  });
  const dec = new FrameDecoder();
  const pending = new Map<number, (b: unknown) => void>();
  const notices: Array<{ id: number; body: unknown }> = [];
  socket.on("data", (chunk: Buffer) => {
    for (const m of dec.push(chunk)) {
      const r = pending.get(m.id);
      if (r) {
        pending.delete(m.id);
        r(m.body);
      } else {
        notices.push(m);
      }
    }
  });
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let nextId = 1;
  return {
    call(body) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve as (b: unknown) => void);
        socket.write(encodeFrame({ id, body }));
      });
    },
    notices,
    ended,
    close: () => socket.destroy(),
  };
}

async function owner(
  path: string,
  handle: (body: unknown) => Promise<unknown>,
  control: ControlHandlers = REFUSES,
): Promise<OwnerServer> {
  const role = await elect(path);
  if (role.role !== "owner") throw new Error("expected to elect as owner");
  return new OwnerServer(role.server, handle, control);
}

describe("owner server", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  test("correlates replies by id and reports handler errors", async () => {
    const path = tempPath();
    const srv = await owner(path, async (body) => {
      const b = body as { v?: number; boom?: boolean };
      if (b.boom) throw new Error("kaboom");
      return { got: b.v };
    });
    cleanup.push(() => srv.close());

    const c = await rawClient(path);
    cleanup.push(() => c.close());

    expect(await c.call({ v: 42 })).toEqual({ ok: true, result: { got: 42 } });
    expect(await c.call({ boom: true })).toEqual({ ok: false, error: "kaboom" });
  });

  test("serializes handler calls across concurrent clients", async () => {
    const path = tempPath();
    let inFlight = 0;
    let maxInFlight = 0;
    const srv = await owner(path, async (body) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(8);
      inFlight--;
      return body;
    });
    cleanup.push(() => srv.close());

    const c1 = await rawClient(path);
    const c2 = await rawClient(path);
    cleanup.push(() => c1.close());
    cleanup.push(() => c2.close());

    const reqs: Promise<{ ok: boolean }>[] = [];
    for (let i = 0; i < 4; i++) {
      reqs.push(c1.call({ client: 1, i }));
      reqs.push(c2.call({ client: 2, i }));
    }
    const replies = await Promise.all(reqs);

    expect(maxInFlight).toBe(1); // never two handler calls at once
    expect(replies.every((r) => r.ok === true)).toBe(true);
  });

  test("answers a hello with its own identity", async () => {
    const path = tempPath();
    const srv = await owner(path, async () => "unused");
    cleanup.push(() => srv.close());
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    expect(await c.call({ ipc: "hello", build: NEWER_BUILD, pid: 7 })).toEqual({
      ok: true,
      result: { ipc: "hello", build: OWNER_BUILD, pid: 4242 },
    });
  });

  test("answers a hello while a tool call is still running", async () => {
    const path = tempPath();
    const srv = await owner(path, async () => {
      await sleep(150);
      return "slow";
    });
    cleanup.push(() => srv.close());
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    const arrived: string[] = [];
    const slow = c.call({ tool: "obsbot_capture_snapshot", args: {} }).then(() => arrived.push("tool"));
    const hello = c.call({ ipc: "hello", build: NEWER_BUILD, pid: 7 }).then(() => arrived.push("hello"));
    await Promise.all([slow, hello]);

    expect(arrived).toEqual(["hello", "tool"]);
  });

  test("hands a takeover request to the control handler and replies with its decision", async () => {
    const path = tempPath();
    const asked: Array<{ build: BuildId; pid: number }> = [];
    const srv = await owner(path, async () => "unused", {
      identity: REFUSES.identity,
      takeover: (build, pid) => {
        asked.push({ build, pid });
        return { ipc: "takeover", granted: true };
      },
    });
    cleanup.push(() => srv.close());
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    expect(await c.call({ ipc: "takeover", build: NEWER_BUILD, pid: 7 })).toEqual({
      ok: true,
      result: { ipc: "takeover", granted: true },
    });
    expect(asked).toEqual([{ build: NEWER_BUILD, pid: 7 }]);
  });

  test.each([
    ["a hello with no build", { ipc: "hello", pid: 7 }],
    ["a hello with a malformed build", { ipc: "hello", build: { version: "x" }, pid: 7 }],
    ["a takeover with no pid", { ipc: "takeover", build: NEWER_BUILD }],
    ["an unknown control message", { ipc: "reboot" }],
  ])("treats %s as an ordinary request, not as control", async (_what, body) => {
    const path = tempPath();
    let takeovers = 0;
    const srv = await owner(
      path,
      async () => {
        throw new Error("unknown tool: undefined");
      },
      {
        identity: REFUSES.identity,
        takeover: () => {
          takeovers++;
          return { ipc: "takeover", granted: true };
        },
      },
    );
    cleanup.push(() => srv.close());
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    expect(await c.call(body)).toEqual({ ok: false, error: "unknown tool: undefined" });
    expect(takeovers).toBe(0);
  });

  test("leaves a request refused by the closed gate unanswered", async () => {
    const path = tempPath();
    const srv = await owner(path, async (body) => {
      if ((body as { tool: string }).tool === "refused") throw new StepDownError();
      return "answered";
    });
    cleanup.push(() => srv.close());
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    let refusedReply: unknown = "no reply";
    void c.call({ tool: "refused", args: {} }).then((r) => (refusedReply = r));
    // A later request on the same connection is answered, so the silence above
    // is a decision and not a stalled queue.
    expect(await c.call({ tool: "fine", args: {} })).toEqual({ ok: true, result: "answered" });
    expect(refusedReply).toBe("no reply");
  });

  test("idle() resolves once everything received so far has been dealt with", async () => {
    const path = tempPath();
    let done = 0;
    const srv = await owner(path, async () => {
      await sleep(20);
      done++;
      return done;
    });
    cleanup.push(() => srv.close());
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    void c.call({ tool: "a", args: {} });
    void c.call({ tool: "b", args: {} });
    await sleep(5); // both have reached the owner
    await srv.idle();

    expect(done).toBe(2);
  });

  test("stepping down tells every client why, then closes their connections", async () => {
    const path = tempPath();
    const srv = await owner(path, async () => "unused");
    const c1 = await rawClient(path);
    const c2 = await rawClient(path);
    cleanup.push(() => c1.close());
    cleanup.push(() => c2.close());

    // One round-trip each, so both connections are registered on the owner
    // before it steps down. On Windows a named-pipe client's 'connect' can
    // fire before the server's 'connection' does; without this, stepDown()
    // may find an empty socket set and send no notices. The real protocol
    // always handshakes (hello) first, so it cannot hit that window.
    await Promise.all([c1.call({ probe: 1 }), c2.call({ probe: 2 })]);

    await srv.stepDown({ ipc: "stepping-down", successorPid: 99 });
    await Promise.all([c1.ended, c2.ended]);

    const notice = { id: 0, body: { ipc: "stepping-down", successorPid: 99 } };
    expect(c1.notices).toEqual([notice]);
    expect(c2.notices).toEqual([notice]);
  });

  test("the endpoint is free as soon as stepping down has finished", async () => {
    const path = tempPath();
    const srv = await owner(path, async () => "unused");
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    await srv.stepDown({ ipc: "stepping-down", successorPid: 99 });

    const next = await elect(path);
    cleanup.push(() => next.role === "owner" && next.server.close());
    expect(next.role).toBe("owner");
  });

  test("a large reply written just before stepping down arrives complete", async () => {
    // A snapshot is megabytes of base64. destroy() would drop whatever had not
    // been flushed yet; the reply must survive the handover.
    const path = tempPath();
    const big = "x".repeat(4 * 1024 * 1024);
    const srv = await owner(path, async () => big);
    const c = await rawClient(path);
    cleanup.push(() => c.close());

    const reply = c.call({ tool: "obsbot_capture_snapshot", args: {} });
    await sleep(5); // the request has reached the owner
    await srv.idle(); // …and its reply has been written
    await srv.stepDown({ ipc: "stepping-down", successorPid: 99 });

    expect(await reply).toEqual({ ok: true, result: big });
  });
});
