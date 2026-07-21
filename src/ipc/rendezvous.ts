import net from "node:net";
import { unlinkSync } from "node:fs";

// ---------------------------------------------------------------------------
// Peer election over a well-known local endpoint.
//
// Every obsbot-mcp instance calls elect() on startup. Exactly one wins the
// bind and becomes the OWNER (it will run the single DeviceManager + native
// helper and serve everyone else); the rest get EADDRINUSE and attach as
// CLIENTS that forward their helper ops to the owner. The bind is the lock —
// there is no check-then-create step to race (see IPC-DESIGN.md).
//
// Transport is a named pipe (Windows) / Unix-domain socket (macOS, Linux),
// NOT shared memory: it gives atomic election, framing, wakeup, and clean
// crash-detection for free.
// ---------------------------------------------------------------------------

/** Well-known rendezvous name → platform endpoint. */
export function rendezvousPath(name = "obsbot-mcp"): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : `/tmp/${name}.sock`; // portable across macOS + Linux; abstract sockets are Linux-only
}

export type Role =
  | { role: "owner"; server: net.Server }
  | { role: "client"; socket: net.Socket };

/**
 * Become the owner, or attach as a client.
 *
 * 1. Try to listen on `path` → win the bind → OWNER.
 * 2. EADDRINUSE → someone's there → connect → CLIENT.
 * 3. Connect refused on POSIX → the endpoint file is STALE (owner crashed
 *    without cleaning up); unlink it and retry the listen → OWNER. Windows
 *    named pipes are kernel-refcounted and never go stale, so this branch is
 *    POSIX-only.
 *
 * The stale-then-retry can itself lose a race to a concurrent starter that
 * binds first; that just yields EADDRINUSE again, so we bounce back to the
 * client path. A small bounded retry keeps a burst of simultaneous starts
 * from spuriously failing.
 */
export async function elect(path = rendezvousPath(), attempts = 3): Promise<Role> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return { role: "owner", server: await listen(path) };
    } catch (e) {
      if (errno(e) !== "EADDRINUSE") throw e;
    }
    try {
      return { role: "client", socket: await connect(path) };
    } catch (e) {
      lastErr = e;
      const code = errno(e);
      const stale = code === "ECONNREFUSED" || code === "ENOENT";
      if (stale && process.platform !== "win32") {
        try {
          unlinkSync(path);
        } catch {
          // already gone, or someone else cleaned it — fine; loop and retry.
        }
        continue; // retry listen
      }
      throw e; // a real connect failure that isn't a stale endpoint
    }
  }
  throw new Error(`elect: could not become owner or client after ${attempts} attempts: ${errno(lastErr) ?? lastErr}`);
}

function listen(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (e: unknown): void => reject(e);
    server.once("error", onError);
    server.listen(path, () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const onError = (e: unknown): void => reject(e);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}
