import { describe, test, expect, afterEach } from "vitest";
import net from "node:net";
import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";
import { OwnerServer, type Handler } from "../../src/ipc/owner.js";
import { OwnerClient } from "../../src/ipc/client.js";
import { encodeFrame, FrameDecoder, type RpcMessage } from "../../src/ipc/protocol.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

async function ownerOn(path: string, handle: Handler): Promise<OwnerServer> {
  const role = await elect(path);
  if (role.role !== "owner") throw new Error("expected owner");
  return new OwnerServer(role.server, handle);
}

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
});
