import { describe, test, expect, afterEach } from "vitest";
import net from "node:net";
import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
import { OwnerServer, type ControlHandlers, type Handler } from "../../src/ipc/owner.js";
import { OwnerClient } from "../../src/ipc/client.js";
import type { BuildId } from "../../src/ipc/build-id.js";
import { encodeFrame, FrameDecoder, type RpcMessage } from "../../src/ipc/protocol.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

const OWNER_BUILD: BuildId = { version: "0.7.0", builtAt: 500, digest: "a".repeat(64) };
const MY_BUILD: BuildId = { version: "0.7.0", builtAt: 900, digest: "b".repeat(64) };

const REFUSES: ControlHandlers = {
  identity: () => ({ build: OWNER_BUILD, pid: 4242 }),
  takeover: () => ({ ipc: "takeover", granted: false, reason: "not-newer" }),
};

async function ownerOn(
  path: string,
  handle: Handler,
  control: ControlHandlers = REFUSES,
): Promise<OwnerServer> {
  const role = await elect(path);
  if (role.role !== "owner") throw new Error("expected owner");
  return new OwnerServer(role.server, handle, control);
}

/**
 * A raw server that answers each request with whatever `answer` returns for it.
 * Returning undefined sends nothing. Used to stand in for owners the real
 * OwnerServer cannot imitate: one that predates the handshake, one that replies
 * with nonsense, one that never replies.
 */
async function scriptedOwner(
  path: string,
  answer: (body: unknown, send: (frame: { id: number; body: unknown }) => void) => unknown,
): Promise<{ close: () => Promise<void>; dropAll: () => void }> {
  const server = net.createServer();
  const socks = new Set<net.Socket>();
  server.on("connection", (sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    const dec = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      for (const m of dec.push(chunk)) {
        const send = (frame: { id: number; body: unknown }): void => {
          sock.write(encodeFrame(frame));
        };
        const body = answer(m.body, send);
        if (body !== undefined) send({ id: m.id, body });
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  const dropAll = (): void => {
    for (const s of socks) s.destroy();
  };
  return {
    dropAll,
    close: () =>
      new Promise<void>((r) => {
        dropAll();
        server.close(() => r());
      }),
  };
}

/** What a 0.7.0 owner does with any body that is not a tool it knows. */
const legacyAnswer = (body: unknown): unknown => {
  const tool = (body as { tool?: string }).tool;
  return tool === "obsbot_status"
    ? { ok: true, result: { awake: true } }
    : { ok: false, error: `unknown tool: ${tool}` };
};

describe("owner client", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  test("round-trips a request through a real owner", async () => {
    const path = tempPath();
    const srv = await ownerOn(path, async (b) => ({ echoed: b }));
    cleanup.push(() => srv.close());
    const client = await OwnerClient.connect(path);
    cleanup.push(() => client.close());

    expect(await client.request({ tool: "obsbot_status" })).toEqual({
      echoed: { tool: "obsbot_status" },
    });
  });

  test("keeps concurrent requests correctly correlated", async () => {
    const path = tempPath();
    const srv = await ownerOn(path, async (b) => (b as { n: number }).n * 10);
    cleanup.push(() => srv.close());
    const client = await OwnerClient.connect(path);
    cleanup.push(() => client.close());

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) => client.request({ n })),
    );
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });

  test("correlates replies that arrive out of order", async () => {
    const path = tempPath();
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(path, () => r()));

    const seen: RpcMessage[] = [];
    server.on("connection", (sock) => {
      const dec = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        for (const m of dec.push(chunk)) {
          seen.push(m);
          if (seen.length === 2) {
            // answer the SECOND request first, then the first
            sock.write(encodeFrame({ id: seen[1].id, body: { ok: true, result: "B" } }));
            sock.write(encodeFrame({ id: seen[0].id, body: { ok: true, result: "A" } }));
          }
        }
      });
    });

    const client = await OwnerClient.connect(path);
    // Close the client BEFORE the raw server, or server.close() blocks on the
    // still-open connection and the afterEach hook times out.
    cleanup.push(async () => {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const pA = client.request({ tag: "A" });
    const pB = client.request({ tag: "B" });
    expect(await pA).toBe("A");
    expect(await pB).toBe("B");
  });

  test("propagates an owner-side handler error", async () => {
    const path = tempPath();
    const srv = await ownerOn(path, async () => {
      throw new Error("device not found");
    });
    cleanup.push(() => srv.close());
    const client = await OwnerClient.connect(path);
    cleanup.push(() => client.close());

    await expect(client.request({})).rejects.toThrow("device not found");
  });

  test("rejects pending + all future requests when the owner goes away", async () => {
    const path = tempPath();
    const hang: Handler = () => new Promise<never>(() => {}); // never completes
    const srv = await ownerOn(path, hang);
    const client = await OwnerClient.connect(path);

    const pending = client.request({ hang: true });
    await sleep(20); // ensure it's in flight on the owner
    await srv.close(); // kills the connection

    await expect(pending).rejects.toThrow(/closed/);
    expect(client.closed).toBe(true);
    await expect(client.request({ after: true })).rejects.toThrow(/closed/);
  });

  test("hello returns the owner's build and pid", async () => {
    const path = tempPath();
    const srv = await ownerOn(path, async () => "unused");
    cleanup.push(() => srv.close());
    const client = await OwnerClient.connect(path);
    cleanup.push(() => client.close());

    expect(await client.hello(MY_BUILD, 7, 1000)).toEqual({
      kind: "peer",
      build: OWNER_BUILD,
      pid: 4242,
    });
  });

  test("an owner that predates the handshake is recognised as legacy", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, legacyAnswer);
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    expect(await client.hello(MY_BUILD, 7, 1000)).toEqual({ kind: "legacy" });
  });

  test.each([
    ["a hello with no build", { ipc: "hello", pid: 4242 }],
    ["a hello whose digest is not a digest", { ipc: "hello", build: { version: "0.7.0", builtAt: 5, digest: "zz" }, pid: 4242 }],
    ["a hello with a pid of 0", { ipc: "hello", build: OWNER_BUILD, pid: 0 }],
    ["something that is not a hello", { awake: true }],
    ["null", null],
  ])("an owner that answers with %s is treated as legacy, never as a peer", async (_what, result) => {
    const path = tempPath();
    const srv = await scriptedOwner(path, () => ({ ok: true, result }));
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    expect(await client.hello(MY_BUILD, 7, 1000)).toEqual({ kind: "legacy" });
  });

  test("an owner that does not answer the hello in time is treated as legacy", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, (body) =>
      (body as { ipc?: string }).ipc === "hello" ? undefined : { ok: true, result: "still here" },
    );
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    const started = Date.now();
    expect(await client.hello(MY_BUILD, 7, 60)).toEqual({ kind: "legacy" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    // The connection is still good for ordinary requests afterwards.
    expect(await client.request({ tool: "obsbot_status" })).toBe("still here");
  });

  test("a hello reply that turns up after the timeout is ignored", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, (body, send) => {
      if ((body as { ipc?: string }).ipc !== "hello") return { ok: true, result: "request" };
      // Reply to the hello (id 1) late, after the client has given up on it.
      setTimeout(() => send({ id: 1, body: { ok: true, result: "late hello" } }), 80);
      return undefined;
    });
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    expect(await client.hello(MY_BUILD, 7, 30)).toEqual({ kind: "legacy" });
    const next = client.request({ tool: "obsbot_status" });
    await sleep(100); // the late hello reply has arrived by now
    expect(await next).toBe("request");
  });

  test("hello rejects when the connection closes before an answer", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, () => undefined);
    const client = await OwnerClient.connect(path);
    cleanup.push(() => srv.close());

    const hello = client.hello(MY_BUILD, 7, 1000);
    await sleep(10);
    srv.dropAll();

    await expect(hello).rejects.toThrow(/closed/);
  });

  test("takeover is true when the owner grants it", async () => {
    const path = tempPath();
    const srv = await ownerOn(path, async () => "unused", {
      identity: REFUSES.identity,
      takeover: () => ({ ipc: "takeover", granted: true }),
    });
    cleanup.push(() => srv.close());
    const client = await OwnerClient.connect(path);
    cleanup.push(() => client.close());

    expect(await client.takeover(MY_BUILD, 7)).toBe(true);
  });

  test("takeover is false when the owner refuses", async () => {
    const path = tempPath();
    const srv = await ownerOn(path, async () => "unused");
    cleanup.push(() => srv.close());
    const client = await OwnerClient.connect(path);
    cleanup.push(() => client.close());

    expect(await client.takeover(MY_BUILD, 7)).toBe(false);
  });

  test("takeover is false when the owner does not answer in time", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, () => undefined);
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    const started = Date.now();
    expect(await client.takeover(MY_BUILD, 7, 60)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  test("takeover is false against an owner that predates the handshake", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, legacyAnswer);
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    expect(await client.takeover(MY_BUILD, 7)).toBe(false);
  });

  test("a stepping-down notice is recorded and disturbs no pending request", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, (body, send) => {
      // Notice first, then the real reply.
      send({ id: 0, body: { ipc: "stepping-down", successorPid: 99 } });
      return { ok: true, result: (body as { n: number }).n + 1 };
    });
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    expect(client.noticed).toBe(false);
    expect(await client.request({ n: 41 })).toBe(42);
    expect(client.noticed).toBe(true);
  });

  test("a frame with the notice id that is not a stepping-down notice is ignored", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, (_body, send) => {
      send({ id: 0, body: { ipc: "something-else" } });
      return { ok: true, result: "ok" };
    });
    const client = await OwnerClient.connect(path);
    cleanup.push(async () => {
      client.close();
      await srv.close();
    });

    expect(await client.request({})).toBe("ok");
    expect(client.noticed).toBe(false);
  });

  test("onClose fires once when the owner goes away", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, () => undefined);
    const client = await OwnerClient.connect(path);
    cleanup.push(() => srv.close());
    let fired = 0;
    client.onClose(() => fired++);

    srv.dropAll();
    await sleep(30);
    client.close(); // closing again must not fire it a second time

    expect(fired).toBe(1);
  });

  test("onClose on a connection that has already closed still fires", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, () => undefined);
    const client = await OwnerClient.connect(path);
    cleanup.push(() => srv.close());
    client.close();

    let fired = 0;
    client.onClose(() => fired++);
    await sleep(5);

    expect(fired).toBe(1);
  });

  test("waitClosed is true when the connection closes in time, false when it does not", async () => {
    const path = tempPath();
    const srv = await scriptedOwner(path, () => undefined);
    cleanup.push(() => srv.close());
    const stays = await OwnerClient.connect(path);
    cleanup.push(() => stays.close());
    const goes = await OwnerClient.connect(path);

    const open = stays.waitClosed(40);
    const closing = goes.waitClosed(1000);
    goes.close();

    expect(await closing).toBe(true);
    expect(await open).toBe(false);
  });
});
