import { describe, test, expect, afterEach } from "vitest";
import { rendezvousPath } from "../../src/ipc/rendezvous.js";
import { Coordinator, serialize, type RunLocal } from "../../src/ipc/coordinator.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

describe("coordinator", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  test("first instance owns; the second forwards its calls to the owner", async () => {
    const path = tempPath();
    const ran: string[] = [];
    const a = new Coordinator(async (tool) => {
      ran.push(`A:${tool}`);
      return "from-A";
    }, path);
    await a.start();
    const b = new Coordinator(async (tool) => {
      ran.push(`B:${tool}`);
      return "from-B";
    }, path);
    await b.start();
    cleanup.push(() => a.close());
    cleanup.push(() => b.close());

    expect(a.roleName).toBe("owner");
    expect(b.roleName).toBe("client");

    // b's call must EXECUTE ON THE OWNER (a), not locally on b.
    expect(await b.dispatch("obsbot_status", {})).toBe("from-A");
    expect(ran).toContain("A:obsbot_status");
    expect(ran).not.toContain("B:obsbot_status");
  });

  test("a client re-elects to owner when the owner goes away", async () => {
    const path = tempPath();
    const a = new Coordinator(async () => "A", path);
    await a.start();
    const b = new Coordinator(async () => "B", path);
    await b.start();
    cleanup.push(() => b.close());

    expect(b.roleName).toBe("client");

    await a.close(); // owner leaves
    await sleep(50); // let the drop propagate + the pipe/socket free up

    const result = await b.dispatch("obsbot_wake", {}); // triggers re-election
    expect(b.roleName).toBe("owner");
    expect(result).toBe("B"); // now runs locally on b
  });

  test("serializes owner-local and forwarded-client calls through ONE lock", async () => {
    const path = tempPath();
    let inFlight = 0;
    let maxInFlight = 0;
    const guarded: RunLocal = serialize(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(8);
      inFlight--;
      return "ok";
    });

    const owner = new Coordinator(guarded, path);
    await owner.start();
    expect(owner.roleName).toBe("owner");
    const client = new Coordinator(async () => "unused", path);
    await client.start();
    expect(client.roleName).toBe("client");
    cleanup.push(() => owner.close());
    cleanup.push(() => client.close());

    // Owner-local calls (owner.dispatch → guarded) and forwarded client calls
    // (client.dispatch → owner's OwnerServer → guarded) must never overlap.
    await Promise.all([
      owner.dispatch("local", {}),
      client.dispatch("fwd", {}),
      owner.dispatch("local", {}),
      client.dispatch("fwd", {}),
    ]);

    expect(maxInFlight).toBe(1);
  });
});
