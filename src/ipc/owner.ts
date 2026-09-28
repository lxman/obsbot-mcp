import net from "node:net";
import type { BuildId } from "./build-id.js";
import { StepDownError } from "./gate.js";
import {
  encodeFrame,
  FrameDecoder,
  NOTICE_ID,
  asHello,
  asTakeover,
  type RpcMessage,
  type SteppingDownBody,
  type TakeoverResult,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Owner-side IPC server.
//
// The elected owner accepts client connections over the rendezvous endpoint,
// decodes framed requests, and runs each through an injected `handle` —
// SERIALIZED across every client. Serialization is not optional: the camera is
// one device and the XU selector-2 reply mailbox is a single shared slot, so
// two requests in flight at once would interleave on the wire and cross-read
// each other's replies. Replies are framed back with the request's `id`.
//
// `handle` is intentionally opaque here (it's wired to the real tool dispatch
// at startup). The owner holds the ONE DeviceManager + native helper; clients
// never touch the device directly — they forward whole requests to this server.
//
// Control messages (hello, takeover) are NOT tool calls and do not wait in that
// queue. A client's startup waits on its hello, and startup must not wait for
// someone else's snapshot or gimbal move to finish.
// ---------------------------------------------------------------------------

export type Handler = (body: unknown) => Promise<unknown>;

export type ReplyBody =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface ControlHandlers {
  /** This instance's identity, for the hello reply. */
  identity: () => { build: BuildId; pid: number };
  /** A client asks for the endpoint. Decide; if granted, the caller starts stepping down. */
  takeover: (build: BuildId, pid: number) => TakeoverResult;
}

/** How long a client gets to close its end after we have ended ours. */
const STRAGGLER_MS = 1000;

export class OwnerServer {
  /** Single promise chain → exactly one handler call runs at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly server: net.Server,
    private readonly handle: Handler,
    private readonly control: ControlHandlers,
  ) {
    this.server.on("connection", (sock) => this.accept(sock));
  }

  private accept(sock: net.Socket): void {
    this.sockets.add(sock);
    const dec = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      let msgs: RpcMessage[];
      try {
        msgs = dec.push(chunk);
      } catch {
        sock.destroy(); // unrecoverable framing error → drop this client
        return;
      }
      for (const msg of msgs) {
        if (!this.answerControl(sock, msg)) this.enqueue(sock, msg);
      }
    });
    const drop = (): void => {
      this.sockets.delete(sock);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  }

  /** Answer a control message at once, outside the queue. False if `msg` is not one. */
  private answerControl(sock: net.Socket, msg: RpcMessage): boolean {
    const reply = (result: unknown): void => {
      if (!sock.destroyed) sock.write(encodeFrame({ id: msg.id, body: { ok: true, result } }));
    };
    if (asHello(msg.body)) {
      reply({ ipc: "hello", ...this.control.identity() });
      return true;
    }
    const takeover = asTakeover(msg.body);
    if (takeover) {
      // Written before anything the grant sets in motion can close this socket.
      reply(this.control.takeover(takeover.build, takeover.pid));
      return true;
    }
    return false;
  }

  private enqueue(sock: net.Socket, msg: RpcMessage): void {
    // Chain onto the shared queue so requests run one-at-a-time across all
    // clients. The chain never rejects (errors become error replies), so one
    // failing op can't stall the rest.
    this.queue = this.queue.then(async () => {
      const body = await this.run(msg.body);
      if (body === undefined) return;
      if (!sock.destroyed) sock.write(encodeFrame({ id: msg.id, body }));
    });
  }

  /** The reply for a request, or undefined when the request must go unanswered. */
  private async run(reqBody: unknown): Promise<ReplyBody | undefined> {
    try {
      return { ok: true, result: await this.handle(reqBody) };
    } catch (e) {
      // The gate closed before this call started: it belongs to the next owner.
      // An error reply would be wrong — the client would surface it. Left
      // unanswered, the closing socket makes the client retry it there.
      if (e instanceof StepDownError) return undefined;
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Resolves once every request received so far has been answered or dropped. */
  idle(): Promise<void> {
    return this.queue;
  }

  /**
   * Give up the endpoint in an orderly way: free the name, tell every client
   * why, and let what is already written reach them.
   *
   * end(), not destroy(): destroy() discards whatever is still buffered, which
   * would lose the notice and could truncate the reply to the call that just
   * finished — a snapshot is megabytes.
   */
  async stepDown(notice: SteppingDownBody): Promise<void> {
    // Stops listening now, which frees the endpoint for the successor; the
    // callback waits for the connections below to finish closing.
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const s of this.sockets) {
      if (s.destroyed) continue;
      s.write(encodeFrame({ id: NOTICE_ID, body: notice }));
      s.end();
    }
    const stragglers = setTimeout(() => {
      for (const s of this.sockets) s.destroy();
    }, STRAGGLER_MS);
    await closed;
    clearTimeout(stragglers);
    this.sockets.clear();
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
