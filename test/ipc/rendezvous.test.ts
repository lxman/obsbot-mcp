import { describe, test, expect, afterEach } from "vitest";
import { elect, rendezvousName, rendezvousPath } from "../../src/ipc/rendezvous.js";

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

describe("rendezvous name", () => {
  test("defaults to the well-known name", () => {
    expect(rendezvousName({})).toBe("obsbot-mcp");
  });

  test("an empty OBSBOT_IPC_NAME means the default", () => {
    expect(rendezvousName({ OBSBOT_IPC_NAME: "" })).toBe("obsbot-mcp");
  });

  test("takes the name from OBSBOT_IPC_NAME", () => {
    expect(rendezvousName({ OBSBOT_IPC_NAME: "obsbot-dev.2_a" })).toBe("obsbot-dev.2_a");
  });

  test("the name decides the endpoint", () => {
    const expected =
      process.platform === "win32" ? "\\\\.\\pipe\\obsbot-dev" : "/tmp/obsbot-dev.sock";
    expect(rendezvousPath(rendezvousName({ OBSBOT_IPC_NAME: "obsbot-dev" }))).toBe(expected);
  });

  test.each([
    ["a path separator", "a/b"],
    ["a backslash", "a\\b"],
    ["a parent-directory walk", "../../etc/x"],
    ["a space", "my name"],
    ["a NUL", "a\0b"],
    ["65 characters", "x".repeat(65)],
  ])("refuses %s", (_what, value) => {
    expect(() => rendezvousName({ OBSBOT_IPC_NAME: value })).toThrow(/OBSBOT_IPC_NAME/);
  });

  test("accepts 64 characters", () => {
    expect(rendezvousName({ OBSBOT_IPC_NAME: "x".repeat(64) })).toBe("x".repeat(64));
  });
});
