import { isBuildId, type BuildId } from "./build-id.js";

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

// ---------------------------------------------------------------------------
// Control messages — how instances agree on who owns the endpoint.
//
// A tool request's body is {tool, args}. A control message is a body with a
// reserved `ipc` key, carried in the same frames. See
// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md §6.
//
// An instance that predates these treats any body as a tool call, so a hello
// sent to it comes back as {ok:false, error:"unknown tool: undefined"} — which
// is how a legacy owner is recognised. A legacy CLIENT ignores a frame whose id
// it is not waiting for, so a notice sent with NOTICE_ID is harmless to it.
// ---------------------------------------------------------------------------

/** Frame id of an owner→client notice. Request ids start at 1, so it never matches a reply. */
export const NOTICE_ID = 0;

export interface HelloBody {
  ipc: "hello";
  build: BuildId;
  pid: number;
}

export interface TakeoverBody {
  ipc: "takeover";
  build: BuildId;
  pid: number;
}

export interface SteppingDownBody {
  ipc: "stepping-down";
  successorPid: number;
}

export type TakeoverResult =
  | { ipc: "takeover"; granted: true }
  | { ipc: "takeover"; granted: false; reason: "not-newer" };

const isPid = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;

function identityOf(body: unknown, kind: "hello" | "takeover"): { build: BuildId; pid: number } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b.ipc !== kind || !isBuildId(b.build) || !isPid(b.pid)) return undefined;
  return { build: b.build, pid: b.pid };
}

/** The body as a hello, or undefined if it is not a well-formed one. */
export function asHello(body: unknown): HelloBody | undefined {
  const id = identityOf(body, "hello");
  return id && { ipc: "hello", ...id };
}

/** The body as a takeover request, or undefined if it is not a well-formed one. */
export function asTakeover(body: unknown): TakeoverBody | undefined {
  const id = identityOf(body, "takeover");
  return id && { ipc: "takeover", ...id };
}

export function isSteppingDown(body: unknown): body is SteppingDownBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.ipc === "stepping-down" && isPid(b.successorPid);
}
