import { describe, test, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { elect, rendezvousName, rendezvousPath, type Role } from "../../src/ipc/rendezvous.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const posix = process.platform !== "win32";

/**
 * Leave a socket file behind with nobody listening on it, the way an owner
 * that was killed outright does. A server closed in this process would tidy
 * its file away, so it takes a real process and a real SIGKILL.
 */
async function staleEndpoint(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"));` +
        "setInterval(() => {}, 1000);",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((r) => child.stdout.once("data", () => r()));
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGKILL");
  await gone;
  if (!existsSync(path)) throw new Error("expected the killed owner to leave its socket file");
}

const release = (r: Role): void => void (r.role === "owner" ? r.server.close() : r.socket.destroy());
const connections = (s: net.Server): Promise<number> =>
  new Promise((resolve, reject) => s.getConnections((e, n) => (e ? reject(e) : resolve(n))));

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

describe("a stale endpoint", () => {
  const held: Role[] = [];
  const files: string[] = [];
  afterEach(() => {
    for (const r of held.splice(0)) release(r);
    for (const f of files.splice(0)) {
      try {
        unlinkSync(f);
      } catch {
        // already gone
      }
    }
  });

  test.skipIf(!posix)("is taken over by one caller", async () => {
    const path = tempPath();
    await staleEndpoint(path);

    const r = await elect(path);
    held.push(r);

    expect(r.role).toBe("owner");
  });

  test.skipIf(!posix)("found by several callers at once still elects exactly one owner", async () => {
    // Each of them sees a name that is taken and a connection that is refused.
    // If each clears the stale file and binds, the second unlinks the FIRST
    // one's live socket and binds a new one: two owners, and the first never
    // finds out. This is what clients do when the owner they shared is killed.
    const path = tempPath();
    await staleEndpoint(path);

    const roles = await Promise.all([elect(path), elect(path), elect(path), elect(path)]);
    held.push(...roles);

    expect(roles.map((r) => r.role).sort()).toEqual(["client", "client", "client", "owner"]);
    const owner = roles.find((r) => r.role === "owner");
    if (owner?.role !== "owner") throw new Error("unreachable");
    await sleep(20); // let the owner accept what connected to it
    expect(await connections(owner.server)).toBe(3); // and the clients are ITS clients
  });

  test.skipIf(!posix)("leaves no lock behind", async () => {
    const path = tempPath();
    await staleEndpoint(path);

    held.push(await elect(path));

    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test.skipIf(!posix)("waits for a caller that is already clearing it", async () => {
    const path = tempPath();
    await staleEndpoint(path);
    writeFileSync(`${path}.lock`, ""); // someone else is in the middle of it
    files.push(`${path}.lock`);
    setTimeout(() => unlinkSync(`${path}.lock`), 60);

    const started = Date.now();
    const r = await elect(path);
    held.push(r);

    expect(r.role).toBe("owner");
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  test.skipIf(!posix)("is not held up by a lock whose holder died", async () => {
    const path = tempPath();
    await staleEndpoint(path);
    writeFileSync(`${path}.lock`, "");
    files.push(`${path}.lock`);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, longAgo, longAgo);

    const started = Date.now();
    const r = await elect(path);
    held.push(r);

    expect(r.role).toBe("owner");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("a pipe that vanishes between the two attempts (win32)", () => {
  test("is retried, not reported as a failure", async () => {
    // On Windows nothing is ever stale, so a name that is taken and then
    // refuses a connection means the owner went away in between. That is a
    // reason to try again, not to fail startup.
    const path = tempPath();
    const first = net.createServer();
    await new Promise<void>((r) => first.listen(path, () => r()));

    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    let r: Role;
    try {
      const electing = elect(path); // its bind is attempted now, while the name is taken
      first.close(); // …and the owner is gone before it gets to connect
      r = await electing;
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
    release(r);

    expect(r.role).toBe("owner");
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
