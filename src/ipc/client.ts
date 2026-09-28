import net from "node:net";
import type { BuildId } from "./build-id.js";
import { isBuildId } from "./build-id.js";
import { encodeFrame, FrameDecoder, NOTICE_ID, isSteppingDown, type RpcMessage } from "./protocol.js";
import type { ReplyBody } from "./owner.js";

// ---------------------------------------------------------------------------
// Client-side proxy to the owner.
//
// A non-owner instance connects here and forwards each request (a tool call) to
// the owner, which runs it against the single DeviceManager + helper and frames
// the reply back. Requests are correlated by `id`, so many can be in flight at
// once and replies may arrive in any order. If the connection drops (the owner
// exited, crashed, or stepped down), every pending request rejects and the
// proxy is marked closed — the coordinator treats that as the signal to
// re-elect.
//
// It also speaks the control messages: hello, to learn the owner's build, and
// takeover, to ask an older owner for the endpoint.
// ---------------------------------------------------------------------------

/** What is on the other end of the connection. */
export type Peer =
  | { kind: "peer"; build: BuildId; pid: number }
  /** An instance that predates the handshake, or one that did not answer it. */
  | { kind: "legacy" };

interface Waiter {
  resolve: (r: ReplyBody) => void;
  reject: (e: Error) => void;
}

class ReplyTimeout extends Error {}

export class OwnerClient {
  private nextId = NOTICE_ID + 1;
  private readonly pending = new Map<number, Waiter>();
  private readonly dec = new FrameDecoder();
  private readonly closeListeners: Array<() => void> = [];
  private closedErr?: Error;
  private gotNotice = false;

  private constructor(private readonly socket: net.Socket) {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("close", () => this.failAll(new Error("owner connection closed")));
    this.socket.on("error", (e: Error) => this.failAll(e));
  }

  /** Wrap an already-connected socket (e.g. the one elect() returned). */
  static adopt(socket: net.Socket): OwnerClient {
    return new OwnerClient(socket);
  }

  static connect(path: string): Promise<OwnerClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      const onError = (e: unknown): void => reject(e);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        resolve(new OwnerClient(socket));
      });
    });
  }

  /** Forward a request to the owner; resolve with its result or throw its error. */
  async request(body: unknown): Promise<unknown> {
    const reply = await this.send(body);
    if (reply.ok) return reply.result;
    throw new Error(reply.error);
  }

  /**
   * Exchange identities with the owner.
   *
   * Anything other than a well-formed hello back means the owner cannot take
   * part in a handover: an error reply (a legacy owner rejecting what it takes
   * for a tool call), a reply that is not a hello, or no reply in `timeoutMs`.
   * Throws only if the connection itself closes first.
   */
  async hello(build: BuildId, pid: number, timeoutMs: number): Promise<Peer> {
    let reply: ReplyBody;
    try {
      reply = await this.send({ ipc: "hello", build, pid }, timeoutMs);
    } catch (e) {
      if (e instanceof ReplyTimeout) return { kind: "legacy" };
      throw e;
    }
    if (!reply.ok) return { kind: "legacy" };
    const r = reply.result as Record<string, unknown> | null;
    if (
      typeof r === "object" &&
      r !== null &&
      r.ipc === "hello" &&
      isBuildId(r.build) &&
      typeof r.pid === "number" &&
      Number.isInteger(r.pid) &&
      r.pid > 0
    ) {
      return { kind: "peer", build: r.build, pid: r.pid };
    }
    return { kind: "legacy" };
  }

  /** Ask the owner for the endpoint. True if it agreed to step down. */
  async takeover(build: BuildId, pid: number): Promise<boolean> {
    const reply = await this.send({ ipc: "takeover", build, pid });
    if (!reply.ok) return false;
    const r = reply.result as Record<string, unknown> | null;
    return typeof r === "object" && r !== null && r.ipc === "takeover" && r.granted === true;
  }

  get closed(): boolean {
    return this.closedErr !== undefined;
  }

  /** True once the owner has said it is stepping down for a newer build. */
  get noticed(): boolean {
    return this.gotNotice;
  }

  /** Call `fn` once, when the connection closes for any reason. */
  onClose(fn: () => void): void {
    if (this.closedErr) queueMicrotask(fn);
    else this.closeListeners.push(fn);
  }

  /** Resolve true when the connection closes, or false if it is still open after `timeoutMs`. */
  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closedErr) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeListeners.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): void {
    this.socket.destroy();
    this.failAll(new Error("owner connection closed by client"));
  }

  private send(body: unknown, timeoutMs?: number): Promise<ReplyBody> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const id = this.nextId++;
    return new Promise<ReplyBody>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = <T>(fn: (v: T) => void) => (v: T): void => {
        if (timer) clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // Forget the request: a reply that turns up later matches no waiter.
          this.pending.delete(id);
          reject(new ReplyTimeout(`no reply within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.socket.write(encodeFrame({ id, body }));
    });
  }

  private onData(chunk: Buffer): void {
    let msgs: RpcMessage[];
    try {
      msgs = this.dec.push(chunk);
    } catch (e) {
      this.failAll(e instanceof Error ? e : new Error(String(e)));
      this.socket.destroy();
      return;
    }
    for (const m of msgs) {
      if (m.id === NOTICE_ID) {
        if (isSteppingDown(m.body)) this.gotNotice = true;
        continue;
      }
      const w = this.pending.get(m.id);
      if (w) {
        this.pending.delete(m.id);
        w.resolve(m.body as ReplyBody);
      }
      // Unknown id (late reply after timeout, or a duplicate) → ignore.
    }
  }

  private failAll(err: Error): void {
    if (this.closedErr) return; // already failed; keep the first cause
    this.closedErr = err;
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
    for (const fn of this.closeListeners.splice(0)) fn();
  }
}
