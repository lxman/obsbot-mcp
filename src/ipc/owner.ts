import net from "node:net";
import { encodeFrame, FrameDecoder, RpcMessage } from "./protocol.js";

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
// ---------------------------------------------------------------------------

export type Handler = (body: unknown) => Promise<unknown>;

export type ReplyBody =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export class OwnerServer {
  /** Single promise chain → exactly one handler call runs at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly server: net.Server,
    private readonly handle: Handler,
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
      for (const msg of msgs) this.enqueue(sock, msg);
    });
    const drop = (): void => {
      this.sockets.delete(sock);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  }

  private enqueue(sock: net.Socket, msg: RpcMessage): void {
    // Chain onto the shared queue so requests run one-at-a-time across all
    // clients. The chain never rejects (errors become error replies), so one
    // failing op can't stall the rest.
    this.queue = this.queue.then(async () => {
      const body = await this.run(msg.body);
      if (!sock.destroyed) sock.write(encodeFrame({ id: msg.id, body }));
    });
  }

  private async run(reqBody: unknown): Promise<ReplyBody> {
    try {
      return { ok: true, result: await this.handle(reqBody) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
