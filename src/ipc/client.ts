import net from "node:net";
import { encodeFrame, FrameDecoder, RpcMessage } from "./protocol.js";
import type { ReplyBody } from "./owner.js";

// ---------------------------------------------------------------------------
// Client-side proxy to the owner.
//
// A non-owner instance connects here and forwards each request (a tool call) to
// the owner, which runs it against the single DeviceManager + helper and frames
// the reply back. Requests are correlated by `id`, so many can be in flight at
// once and replies may arrive in any order. If the connection drops (the owner
// exited/crashed), every pending request rejects and the proxy is marked
// closed — the startup layer (brick 5) treats that as the signal to re-elect.
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (r: ReplyBody) => void;
  reject: (e: Error) => void;
}

export class OwnerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Waiter>();
  private readonly dec = new FrameDecoder();
  private closedErr?: Error;

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

  get closed(): boolean {
    return this.closedErr !== undefined;
  }

  close(): void {
    this.socket.destroy();
    this.failAll(new Error("owner connection closed by client"));
  }

  private send(body: unknown): Promise<ReplyBody> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const id = this.nextId++;
    return new Promise<ReplyBody>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
  }
}
