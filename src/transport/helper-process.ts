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
  linux: "obsbot-helper",
};

export class HelperProcess {
  private proc?: ChildProcessByStdio<Writable, Readable, null>;
  private rl?: Interface;
  private queue: Array<(resp: RpcResponse) => void> = [];

  constructor(private commandOverride?: string[]) {}

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
      if (cb) cb(parsed as RpcResponse);
    });
  }

  // Send a request and resolve with the raw response, whatever `ok` is.
  private rpcRaw(req: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.proc!.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private async rpc(req: Record<string, unknown>): Promise<RpcResponse> {
    const resp = await this.rpcRaw(req);
    if (!resp.ok) throw new Error(resp.error ?? "helper error (no message)");
    return resp;
  }

  async version(): Promise<string> {
    const resp = await this.rpc({ op: "version" });
    return resp.version as string;
  }

  async enumerate(): Promise<DeviceInfo[]> {
    const resp = await this.rpc({ op: "enumerate" });
    return resp.devices as DeviceInfo[];
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
    const resp = await this.rpcRaw(req);
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

  async close(): Promise<void> {
    this.rl?.close();
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
