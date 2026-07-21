import { describe, test, expect, afterEach } from "vitest";
import net from "node:net";
import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
import { OwnerServer } from "../../src/ipc/owner.js";
import { encodeFrame, FrameDecoder } from "../../src/ipc/protocol.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

// Minimal framed client for exercising the owner (the real one is brick 4).
async function rawClient(path: string): Promise<{
  call: (body: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  close: () => void;
}> {
  const socket = net.connect(path);
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", rej);
  });
  const dec = new FrameDecoder();
  const pending = new Map<number, (b: unknown) => void>();
  socket.on("data", (chunk: Buffer) => {
    for (const m of dec.push(chunk)) {
      const r = pending.get(m.id);
      if (r) {
        pending.delete(m.id);
        r(m.body);
      }
    }
  });
  let nextId = 1;
  return {
    call(body) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve as (b: unknown) => void);
        socket.write(encodeFrame({ id, body }));
      });
    },
    close: () => socket.destroy(),
  };
}

async function owner(path: string, handle: (body: unknown) => Promise<unknown>): Promise<OwnerServer> {
  const role = await elect(path);
  if (role.role !== "owner") throw new Error("expected to elect as owner");
  return new OwnerServer(role.server, handle);
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
});
