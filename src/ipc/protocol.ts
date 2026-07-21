// ---------------------------------------------------------------------------
// Length-prefixed JSON framing for the client↔owner control channel.
//
// A named pipe / Unix-domain socket is a byte STREAM: writes coalesce and reads
// split at arbitrary boundaries, so message edges are not preserved. Each
// message is framed as [uint32 BE body length][UTF-8 JSON body]. FrameDecoder
// buffers partial reads and emits one parsed message per complete frame.
//
// This is the transport envelope only; `body` is an opaque helper request
// (client→owner) or helper reply (owner→client). `id` correlates concurrent
// requests multiplexed over the one connection.
// ---------------------------------------------------------------------------

const HEADER = 4; // bytes: uint32 BE body length
/** Upper bound on a single frame. Snapshots (base64 JPEG) are the large case. */
export const MAX_FRAME = 16 * 1024 * 1024; // 16 MiB

export interface RpcMessage {
  id: number;
  body: unknown;
}

/** Serialize a message to a length-prefixed frame. Throws if it exceeds MAX_FRAME. */
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_FRAME) {
    throw new Error(`ipc frame too large to send: ${body.length} bytes`);
  }
  const header = Buffer.allocUnsafe(HEADER);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Stateful stream splitter — one per connection. Feed it raw chunks as they
 * arrive; it returns the complete messages now decodable (0 or more), keeping
 * any trailing partial frame buffered for the next push.
 *
 * Throws on a frame whose declared length exceeds MAX_FRAME (a corrupt or
 * hostile peer) — the caller should treat that as a fatal protocol error and
 * drop the connection rather than keep reading.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RpcMessage[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: RpcMessage[] = [];
    for (;;) {
      if (this.buf.length < HEADER) break; // not even a full length header yet
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        throw new Error(`ipc frame too large to receive: ${len} bytes`);
      }
      if (this.buf.length < HEADER + len) break; // body not fully arrived
      const body = this.buf.subarray(HEADER, HEADER + len);
      out.push(JSON.parse(body.toString("utf8")) as RpcMessage);
      this.buf = this.buf.subarray(HEADER + len);
    }
    return out;
  }
}
