import { elect, rendezvousPath } from "./rendezvous.js";
import { OwnerServer } from "./owner.js";
import { OwnerClient } from "./client.js";

// ---------------------------------------------------------------------------
// Ties election + owner server + client proxy into the one thing startup needs:
// "run this tool call, wherever the camera actually lives."
//
//   - OWNER  → run it locally against the single DeviceManager.
//   - CLIENT → forward it to the owner; if the owner has vanished, RE-ELECT
//              (become the new owner, or reconnect to whoever won) and retry.
//
// Single-instance is the common case and stays a no-op change: the first
// instance elects owner and runs everything locally, with an idle OwnerServer
// listening for peers that may never come.
// ---------------------------------------------------------------------------

export type RunLocal = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Wrap a tool runner so calls execute strictly one-at-a-time. This is THE
 * single-camera lock: it must guard both the owner's own MCP calls AND the
 * calls forwarded from clients, because the owner's local path does not pass
 * through OwnerServer's queue. Errors don't break the chain.
 */
export function serialize(fn: RunLocal): RunLocal {
  let tail: Promise<unknown> = Promise.resolve();
  return (tool, args) => {
    const run = tail.then(() => fn(tool, args));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

type RoleName = "none" | "owner" | "client";

export class Coordinator {
  private role: RoleName = "none";
  private client?: OwnerClient;
  private ownerServer?: OwnerServer;
  private electing?: Promise<void>;

  /** `runLocal` should already be serialize()-wrapped by the caller. */
  constructor(
    private readonly runLocal: RunLocal,
    private readonly path: string = rendezvousPath(),
  ) {}

  /** Establish the initial role eagerly at startup. */
  start(): Promise<void> {
    return this.ensureRole();
  }

  get roleName(): RoleName {
    return this.role;
  }

  async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureRole();
    try {
      return await this.runByRole(tool, args);
    } catch (e) {
      if (this.role === "client" && this.client?.closed) {
        // The owner went away mid-call → re-elect and retry exactly once.
        this.reset();
        await this.ensureRole();
        return this.runByRole(tool, args);
      }
      throw e; // a genuine owner-side error → surface it unchanged
    }
  }

  private runByRole(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.role === "owner"
      ? this.runLocal(tool, args)
      : this.client!.request({ tool, args });
  }

  async close(): Promise<void> {
    if (this.ownerServer) await this.ownerServer.close();
    this.client?.close();
    this.reset();
  }

  private reset(): void {
    this.role = "none";
    this.client = undefined;
    this.ownerServer = undefined;
  }

  private ensureRole(): Promise<void> {
    if (this.role !== "none") return Promise.resolve();
    // Collapse concurrent callers onto one election.
    if (!this.electing) {
      this.electing = this.doElect().finally(() => {
        this.electing = undefined;
      });
    }
    return this.electing;
  }

  private async doElect(): Promise<void> {
    const r = await elect(this.path);
    if (r.role === "owner") {
      this.ownerServer = new OwnerServer(r.server, (body) => {
        const { tool, args } = body as { tool: string; args: Record<string, unknown> };
        return this.runLocal(tool, args);
      });
      this.role = "owner";
    } else {
      this.client = OwnerClient.adopt(r.socket);
      this.role = "client";
    }
  }
}
