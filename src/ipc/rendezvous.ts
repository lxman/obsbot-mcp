import net from "node:net";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";

// ---------------------------------------------------------------------------
// Peer election over a well-known local endpoint.
//
// Every obsbot-mcp instance calls elect() on startup. Exactly one wins the
// bind and becomes the OWNER (it will run the single DeviceManager + native
// helper and serve everyone else); the rest get EADDRINUSE and attach as
// CLIENTS that forward their helper ops to the owner. The bind is the lock —
// there is no check-then-create step to race (see IPC-DESIGN.md). Clearing a
// name that nobody holds is the one step that is not atomic; see elect().
//
// Transport is a named pipe (Windows) / Unix-domain socket (macOS, Linux),
// NOT shared memory: it gives atomic election, framing, wakeup, and clean
// crash-detection for free.
// ---------------------------------------------------------------------------

const DEFAULT_NAME = "obsbot-mcp";
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The rendezvous name: OBSBOT_IPC_NAME, or the well-known default.
 *
 * Every instance that should share one camera owner must use the same name, so
 * the default is right for normal use. The variable exists for test harnesses
 * — which would otherwise take the endpoint away from a developer's live
 * session — and for deliberately isolating one session on its own build.
 *
 * The name becomes part of a filesystem path or pipe name, so anything outside
 * a conservative character set is refused rather than sanitised. Unset and
 * empty both mean the default: an MCP client config that declares the variable
 * with no value should not be a startup error.
 */
export function rendezvousName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OBSBOT_IPC_NAME;
  if (raw === undefined || raw === "") return DEFAULT_NAME;
  if (!NAME_RE.test(raw)) {
    throw new Error(
      `OBSBOT_IPC_NAME must be 1-64 characters from A-Z a-z 0-9 . _ - (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

/** Rendezvous name → platform endpoint. */
export function rendezvousPath(name: string = rendezvousName()): string {
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
 * The bind is the lock: exactly one process can hold the name. What needs care
 * is the name that is held by NOBODY — the socket file an owner leaves behind
 * when it is killed outright (POSIX only; a Windows pipe is kernel-refcounted
 * and vanishes with its owner).
 *
 * Clearing a stale file means unlinking it, and unlink cannot tell a stale
 * file from a live one. If two callers both find the name taken and the
 * connection refused, and each unlinks and binds, the second unlinks the
 * FIRST one's live socket: two owners, and the first never finds out. That is
 * no longer a corner case — every client of a killed owner re-elects at once.
 *
 * So on POSIX the unlink, and every bind, happens under a lock file taken with
 * an exclusive create:
 *
 * 1. Connect. Someone answers → CLIENT.
 * 2. Nobody answers → take the lock, and look again: another caller may have
 *    bound while we waited. Someone answers → CLIENT.
 * 3. Still nobody → unlink whatever is there, bind → OWNER.
 *
 * On Windows nothing is ever stale and nothing is unlinked, so there is no
 * lock: bind → OWNER, else connect → CLIENT. A name that is taken and then
 * refuses the connection means the owner went away in between, which is a
 * reason to go round again, not to fail.
 */
export async function elect(path = rendezvousPath(), attempts = 5): Promise<Role> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const r = process.platform === "win32" ? await electPipe(path) : await electSocket(path);
    if (r.role !== "retry") return r;
    lastErr = r.because;
    await sleep(RETRY_MS);
  }
  throw new Error(
    `elect: could not become owner or client after ${attempts} attempts: ${errno(lastErr) ?? lastErr}`,
  );
}

type Attempt = Role | { role: "retry"; because: unknown };

const RETRY_MS = 10;
/** A lock older than this was left by a holder that died. The lock is held for milliseconds. */
const LOCK_STALE_MS = 5000;
/** Longest one caller waits for the lock. */
const LOCK_WAIT_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nobodyThere = (e: unknown): boolean => {
  const code = errno(e);
  return code === "ECONNREFUSED" || code === "ENOENT";
};

async function electPipe(path: string): Promise<Attempt> {
  try {
    return { role: "owner", server: await listen(path) };
  } catch (e) {
    if (errno(e) !== "EADDRINUSE") throw e;
  }
  try {
    return { role: "client", socket: await connect(path) };
  } catch (e) {
    if (!nobodyThere(e)) throw e;
    return { role: "retry", because: e };
  }
}

async function electSocket(path: string): Promise<Attempt> {
  try {
    return { role: "client", socket: await connect(path) };
  } catch (e) {
    if (!nobodyThere(e)) throw e;
  }
  return withLock(`${path}.lock`, async () => {
    try {
      return { role: "client", socket: await connect(path) }; // someone bound while we waited
    } catch (e) {
      if (!nobodyThere(e)) throw e;
    }
    try {
      unlinkSync(path);
    } catch {
      // nothing there to clear
    }
    try {
      return { role: "owner", server: await listen(path) };
    } catch (e) {
      // An instance that predates the lock can still bind between our unlink
      // and our bind. It is there now; go round and connect to it.
      if (errno(e) !== "EADDRINUSE") throw e;
      return { role: "retry", because: e };
    }
  });
}

/** Run `fn` holding `lock`, a file taken with an exclusive create and removed afterwards. */
async function withLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx")); // fails if it exists: that is the lock
      break;
    } catch (e) {
      if (errno(e) !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
    } catch {
      // released, or cleared by someone else, since we looked
    }
    if (Date.now() > deadline) throw new Error(`elect: could not take ${lock} in ${LOCK_WAIT_MS} ms`);
    await sleep(5 + Math.random() * 10);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
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
