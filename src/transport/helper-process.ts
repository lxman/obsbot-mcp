import { spawn, ChildProcessByStdio } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Writable, Readable } from "node:stream";
import { DeviceInfo } from "../codec/types.js";
import { CameraBusyError, Snapshot, SnapshotOpts } from "./transport.js";

interface RpcResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

const SUPPORTED: Record<string, string> = {
  win32: "obsbot-helper.exe",
  darwin: "obsbot-helper",
  linux: "obsbot-helper",
};

// A request has two ways to never come back, and they need different guards:
//
//   the helper DIES   -> 'exit'/'error' fires; pending requests are failed at once
//   the helper WEDGES -> process stays alive and silent; only a timeout settles it
//
// The second is the likelier shape of a real hardware fault (a driver-level
// stall), and no death handler can catch it. Both must fail rather than hang:
// ensureReady() self-heals on a THROW (invalidate -> re-bind -> fresh helper),
// so a request that hangs doesn't just block one call, it silently disables the
// respawn path that already exists.
//
// The default budget is generous because these are USB control transfers, not
// network calls — it exists to break a wedge, not to police latency. `snapshot`
// gets its own budget: it captures a real frame after an explicit settle delay
// (settleMs is caller-supplied, capped at 5000 by the tool schema), so its
// timeout is computed per-call from that delay rather than fixed.
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const SNAPSHOT_RPC_TIMEOUT_MS = 30_000;

// Errors that mean "the camera is no longer attached", as opposed to any other
// operation failure. A helper stays ALIVE when its device is unplugged — only
// the USB handle dies — so process death cannot detect this, and without a
// separate signal the binding is stranded until the process is killed.
//
// Deliberately NARROW. Condemning a binding on any random error would be worse
// than the bug it fixes: one bad argument would drop a healthy camera. Anything
// not listed here leaves the binding alone.
//
//  - darwin: kIOReturnNoDevice. Hardware-observed 2026-07-21 on an unplug —
//    every op returned "USB control request failed (0xe00002c0)". The adjacent
//    0xe00002c5 is kIOReturnExclusiveAccess, already referenced elsewhere in
//    this repo, which anchors the numbering.
//  - linux: the helper formats errno via strerror(), so ENODEV is exactly
//    "No such device".
//
// Windows is deliberately ABSENT: its helper reports DirectShow HRESULTs and
// the device-removal code has not been observed on hardware. Guessing one risks
// matching an unrelated failure and dropping a working binding, which is the
// one outcome this list must never cause. Add it once it has been seen.
const DEVICE_LOST_SIGNATURES = [/0xe00002c0/i, /No such device/i];

export class HelperProcess {
  private proc?: ChildProcessByStdio<Writable, Readable, null>;
  private rl?: Interface;
  private queue: Array<{ resolve: (r: RpcResponse) => void; reject: (e: Error) => void }> = [];
  /** Set once the child is gone; every later request fails with this. */
  private dead?: Error;
  /** Set once an op reports the DEVICE gone, even though the process lives on. */
  private lostDevice = false;

  constructor(private commandOverride?: string[]) {}

  /**
   * Fail the helper permanently and settle everything waiting on it. Mirrors
   * IpcClient's failAll() on socket close/error — same queue-of-waiters shape,
   * same requirement that no caller be left pending.
   */
  private failAll(err: Error): void {
    this.dead ??= err;
    const waiting = this.queue;
    this.queue = [];
    for (const w of waiting) w.reject(err);
  }

  static resolveBinaryPath(
    platform: string = process.platform,
    arch: string = process.arch,
  ): string {
    const bin = SUPPORTED[platform];
    if (!bin) {
      throw new Error(`transport not yet implemented for ${platform}`);
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    return join(root, "native", "prebuilt", `${platform}-${arch}`, bin);
  }

  async start(): Promise<void> {
    const [cmd, ...args] = this.commandOverride ?? [
      HelperProcess.resolveBinaryPath(),
    ];
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

    // Without these, a dead child leaves every caller pending forever.
    // Error text is API surface here: the caller is an LLM, so each message says
    // what happened AND what to do next. "helper process exited (code 1)" is an
    // implementation detail that prescribes nothing; a model reading it tends to
    // either retry blindly forever or tell the human the camera is broken — when
    // in fact the next call re-binds automatically (DeviceManager.pruneDeadEntries).
    this.proc.on("exit", (code, signal) =>
      this.failAll(
        new Error(
          `camera link lost: the helper process exited (code ${code ?? "null"}, ` +
            `signal ${signal ?? "none"}). The connection resets automatically — retry this call.`,
        ),
      ),
    );
    this.proc.on("error", (e) =>
      this.failAll(
        new Error(
          `camera link lost: the helper process failed to run (${e.message}). ` +
            `Retry this call; if it repeats, the helper binary may be missing or blocked.`,
        ),
      ),
    );
    // Writing to a dead child's stdin emits EPIPE on the stream; an 'error'
    // event with no listener is rethrown by Node and would take the server down.
    this.proc.stdin.on("error", (e) =>
      this.failAll(new Error(`helper stdin error: ${e.message}`)),
    );

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Not JSON at all — likely a stray log/diagnostic line the helper
        // wrote to stdout. Ignore it without shifting the queue so it
        // can't desync request/response correlation.
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { ok?: unknown }).ok !== "boolean"
      ) {
        // Valid JSON but not a recognizable RPC response (missing/invalid
        // `ok` field). Treat as noise rather than desyncing the queue.
        return;
      }
      const cb = this.queue.shift();
      if (cb) cb.resolve(parsed as RpcResponse);
    });
  }

  // Send a request and resolve with the raw response, whatever `ok` is.
  private rpcRaw(req: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<RpcResponse> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      // A wedged helper never answers and never exits, so the timeout is the
      // only thing that settles this. It fails just this request rather than
      // condemning the helper: one slow op shouldn't tear down a working
      // session. A genuinely dead helper is caught by the exit handler instead.
      //
      // On timeout the slot STAYS in the queue as a tombstone. Responses are
      // correlated by position, so removing it would hand this request's late
      // reply to the next waiter and desync every subsequent call — the exact
      // failure the stray-line guard in start() exists to prevent. The tombstone
      // absorbs that one late reply and discards it.
      const entry = {
        resolve: (r: RpcResponse): void => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error): void => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        entry.resolve = (): void => {}; // tombstone: swallow the late reply
        entry.reject = (): void => {};
        reject(
          new Error(
            `helper request "${String(req.op)}" timed out after ${timeoutMs}ms — the camera ` +
              `did not respond. Retry this call; if it repeats, check that no other ` +
              `application is using the camera.`,
          ),
        );
      }, timeoutMs);

      this.queue.push({
        resolve: (r) => entry.resolve(r),
        reject: (e) => entry.reject(e),
      });
      this.proc!.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private async rpc(req: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse> {
    const resp = await this.rpcRaw(req, timeoutMs);
    if (!resp.ok) {
      const message = resp.error ?? "helper error (no message)";
      // Flag BEFORE throwing, so this is recorded even for callers that swallow
      // the error into their own { ok: false } result (obsbot_status does), and
      // for every tool regardless of whether it routes through the readiness
      // gate. DeviceManager drops flagged helpers on the next resolve.
      if (DEVICE_LOST_SIGNATURES.some((re) => re.test(message))) this.lostDevice = true;
      throw new Error(message);
    }
    return resp;
  }

  async version(): Promise<string> {
    const resp = await this.rpc({ op: "version" });
    return resp.version as string;
  }

  async enumerate(): Promise<DeviceInfo[]> {
    const resp = await this.rpc({ op: "enumerate" });
    return (resp.devices as Array<Record<string, unknown>>).map((d) => ({
      path: String(d.path ?? ""),
      name: String(d.name ?? ""),
      locationId: typeof d.locationId === "number" ? d.locationId : undefined,
      vid: typeof d.vid === "number" ? d.vid : undefined,
      pid: typeof d.pid === "number" ? d.pid : undefined,
    }));
  }

  async open(path: string): Promise<number> {
    const resp = await this.rpc({ op: "open", path });
    return resp.xuNode as number;
  }

  async xuSet(selector: number, data: Buffer): Promise<void> {
    await this.rpc({ op: "xu_set", selector, hex: data.toString("hex") });
  }

  async xuGet(selector: number, length: number): Promise<Buffer> {
    const resp = await this.rpc({ op: "xu_get", selector, length });
    return Buffer.from(resp.hex as string, "hex");
  }

  async zoomRange(): Promise<{ min: number; max: number }> {
    const resp = await this.rpc({ op: "zoom_range" });
    return { min: resp.min as number, max: resp.max as number };
  }

  async zoomSet(units: number): Promise<void> {
    await this.rpc({ op: "zoom_set", units });
  }

  async snapshot(opts: SnapshotOpts): Promise<Snapshot> {
    const req: Record<string, unknown> = { op: "snapshot" };
    if (opts.path !== undefined) req.path = opts.path;
    if (opts.maxDim !== undefined) req.maxDim = opts.maxDim;
    if (opts.quality !== undefined) req.quality = opts.quality;
    if (opts.settleMs !== undefined) req.settleMs = opts.settleMs;
    // Snapshot waits out a caller-supplied settle delay and then captures a real
    // frame, so it gets its own budget on top of that delay rather than the
    // default. Without this a legitimate slow capture would look like a wedge.
    const resp = await this.rpcRaw(req, SNAPSHOT_RPC_TIMEOUT_MS + (opts.settleMs ?? 0));
    if (!resp.ok) {
      if (resp.busy) throw new CameraBusyError((resp.error as string) ?? undefined);
      throw new Error((resp.error as string) ?? "snapshot failed");
    }
    return {
      mime: resp.mime as string,
      width: resp.width as number,
      height: resp.height as number,
      base64: resp.base64 as string,
    };
  }

  async camCtrlSet(property: number, value: number, flags: number): Promise<void> {
    await this.rpc({ op: "camctrl_set", property, value, flags });
  }

  async camCtrlRange(property: number): Promise<{ min: number; max: number }> {
    const resp = await this.rpc({ op: "camctrl_range", property });
    return { min: resp.min as number, max: resp.max as number };
  }

  async camCtrlGet(property: number): Promise<{ value: number; flags: number }> {
    const resp = await this.rpc({ op: "camctrl_get", property });
    return { value: resp.value as number, flags: resp.flags as number };
  }

  async procAmpSet(property: number, value: number, flags: number): Promise<void> {
    await this.rpc({ op: "procamp_set", property, value, flags });
  }

  async procAmpRange(property: number): Promise<{ min: number; max: number }> {
    const resp = await this.rpc({ op: "procamp_range", property });
    return { min: resp.min as number, max: resp.max as number };
  }

  /** True once the child has died (or close() was called) — see getScanHelper(). */
  get isDead(): boolean {
    return this.dead !== undefined;
  }

  /**
   * True once an operation reported the camera as no longer attached, while
   * this helper's PROCESS is still perfectly alive — the unplug case. Callers
   * treat it exactly like isDead: the handle is unusable and the binding must
   * be re-established, even though there is no corpse to notice.
   */
  get deviceLost(): boolean {
    return this.lostDevice;
  }

  async close(): Promise<void> {
    // Mark dead BEFORE tearing down, so anything still queued fails with an
    // intentional-shutdown reason rather than racing the 'exit' handler.
    this.failAll(new Error("helper process closed"));
    this.rl?.close();
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
