import { describe, test, expect, afterEach } from "vitest";
import { elect, rendezvousPath } from "../../src/ipc/rendezvous.js";

// A unique endpoint per test, so we never touch the real "obsbot-mcp"
// rendezvous (a live MCP server may own it) and parallel tests don't collide.
function tempPath(): string {
  return rendezvousPath(`obsbot-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
}

describe("peer election", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  test("first caller becomes owner, the second becomes a client", async () => {
    const path = tempPath();

    const a = await elect(path);
    cleanup.push(() => a.role === "owner" && a.server.close());
    expect(a.role).toBe("owner");

    const b = await elect(path);
    cleanup.push(() => b.role === "client" && b.socket.destroy());
    expect(b.role).toBe("client");
  });

  test("after the owner closes, the next caller re-elects as owner", async () => {
    const path = tempPath();

    const a = await elect(path);
    expect(a.role).toBe("owner");
    if (a.role === "owner") await new Promise<void>((r) => a.server.close(() => r()));

    const c = await elect(path);
    cleanup.push(() => c.role === "owner" && c.server.close());
    expect(c.role).toBe("owner");
  });
});
