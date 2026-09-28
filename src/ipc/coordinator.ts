import type net from "node:net";
import { elect as electEndpoint, rendezvousPath, type Role } from "./rendezvous.js";
import { OwnerServer } from "./owner.js";
import { OwnerClient, type Peer } from "./client.js";
import { CallGate, StepDownError } from "./gate.js";
import { buildLabel, compareBuilds, unstampedBuild, type BuildId } from "./build-id.js";
import type { TakeoverResult } from "./protocol.js";

// ---------------------------------------------------------------------------
// Ties election + owner server + client proxy into the one thing startup needs:
// "run this tool call, wherever the camera actually lives."
//
//   - OWNER  → run it locally against the single DeviceManager.
//   - CLIENT → forward it to the owner; if the owner has vanished, RE-ELECT
//              (become the new owner, or reconnect to whoever won) and retry.
//
// The owner is the NEWEST BUILD alive, not whoever started first. Every
// connection opens with an exchange of build identities, and an owner that
// meets a newer build steps down for it: it lets the call in flight finish,
// releases the camera, and gives up the endpoint. See
// docs/superpowers/specs/2026-09-27-newest-build-wins-design.md.
//
// Single-instance is the common case and stays a no-op change: the first
// instance elects owner and runs everything locally, with an idle OwnerServer
// listening for peers that may never come.
// ---------------------------------------------------------------------------

export type RunLocal = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface Timing {
  /** How long a client waits for its hello to be answered. */
  helloTimeoutMs: number;
  /** How long everyone but the successor waits before re-electing after a step-down. */
  stepDownGraceMs: number;
  /** Upper bound of the random delay that spreads simultaneous re-elections. */
  electionJitterMs: number;
  /** Longest a successor waits for the owner's running call and release. */
  stepDownTimeoutMs: number;
  /** Longest a stepping-down owner waits for its own release. Must be under stepDownTimeoutMs. */
  releaseTimeoutMs: number;
  /** How many owners one election will take the endpoint from before settling. */
  maxTakeoverRounds: number;
}

export const DEFAULT_TIMING: Timing = {
  helloTimeoutMs: 2000,
  stepDownGraceMs: 500,
  electionJitterMs: 100,
  stepDownTimeoutMs: 15000,
  releaseTimeoutMs: 10000,
  maxTakeoverRounds: 5,
};

export interface CoordinatorOptions {
  /** Rendezvous endpoint. Default: the one OBSBOT_IPC_NAME selects. */
  path?: string;
  /** What this process loaded. Default: an unstamped build. */
  build?: BuildId;
  /** Reported to peers in the hello. Default: process.pid. */
  pid?: number;
  /** Drop everything that holds the camera. Runs when this instance steps down. */
  release?: () => Promise<void>;
  /** Receives the `obsbot-mcp: ipc …` lines. Default: discard. */
  log?: (line: string) => void;
  timing?: Partial<Timing>;
  /** The election primitive. Injectable so a test can decide who binds first. */
  elect?: (path: string) => Promise<Role>;
}

type RoleName = "none" | "owner" | "client";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Coordinator {
  private role: RoleName = "none";
  private client?: OwnerClient;
  private ownerServer?: OwnerServer;
  private steppingDown = false;
  private closing = false;
  /** A role change in progress — an election, or stepping down. Never rejects. */
  private pending?: Promise<void>;
  /** THE single-camera lock: the owner's own calls and the ones forwarded to it. */
  private readonly gate = new CallGate();

  private readonly path: string;
  private readonly build: BuildId;
  private readonly pid: number;
  private readonly release: () => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly t: Timing;
  private readonly elect: (path: string) => Promise<Role>;

  constructor(
    private readonly runLocal: RunLocal,
    opts: CoordinatorOptions = {},
  ) {
    this.path = opts.path ?? rendezvousPath();
    this.build = opts.build ?? unstampedBuild();
    this.pid = opts.pid ?? process.pid;
    this.release = opts.release ?? (async (): Promise<void> => {});
    this.log = opts.log ?? ((): void => {});
    this.t = { ...DEFAULT_TIMING, ...opts.timing };
    this.elect = opts.elect ?? electEndpoint;
  }

  /** Establish the initial role eagerly at startup. */
  start(): Promise<void> {
    return this.ensureRole();
  }

  get roleName(): RoleName {
    return this.role;
  }

  async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    let failure: unknown;
    // Twice at most: a call that lost its owner is retried exactly once.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureRole();
      const client = this.client;
      try {
        return this.role === "owner"
          ? await this.gate.run(() => this.runLocal(tool, args))
          : await client!.request({ tool, args });
      } catch (e) {
        if (e instanceof StepDownError) {
          // We were the owner and are handing over; this call had not started.
          // ensureRole() waits the handover out, and the retry forwards it.
          failure = e;
          continue;
        }
        if (client?.closed) {
          failure = e;
          this.ownerLost(client);
          continue;
        }
        throw e; // a genuine owner-side error → surface it unchanged
      }
    }
    throw failure;
  }

  async close(): Promise<void> {
    this.closing = true;
    const server = this.ownerServer;
    const client = this.client;
    this.reset();
    client?.close();
    if (server) await server.close();
    // A role change that was under way sees `closing` and cleans up after itself.
    while (this.pending) await this.pending;
  }

  private reset(): void {
    this.role = "none";
    this.client = undefined;
    this.ownerServer = undefined;
    this.steppingDown = false;
  }

  private jitter(): number {
    return Math.floor(Math.random() * (this.t.electionJitterMs + 1));
  }

  /** Queue a role change behind any already under way. The result never rejects. */
  private begin(work: () => Promise<void>): Promise<void> {
    const prev = this.pending ?? Promise.resolve();
    const p: Promise<void> = prev
      .then(work)
      .catch((e: unknown) => this.log(`obsbot-mcp: ipc role change failed: ${errText(e)}`))
      .finally(() => {
        if (this.pending === p) this.pending = undefined;
      });
    this.pending = p;
    return p;
  }

  private async ensureRole(): Promise<void> {
    while (this.pending) await this.pending;
    if (this.role !== "none") return;
    if (this.closing) throw new Error("obsbot-mcp: ipc coordinator is closed");
    let failed = false;
    let failure: unknown;
    await this.begin(async () => {
      try {
        await this.doElect();
      } catch (e) {
        failed = true;
        failure = e;
      }
    });
    if (failed) throw failure;
  }

  /**
   * Settle on a role: bind the endpoint, or connect to whoever holds it and
   * compare builds. If ours is newer, ask for the endpoint and go round again.
   */
  private async doElect(): Promise<void> {
    let takeovers = 0;
    for (let attempt = 0; attempt < this.t.maxTakeoverRounds + 3; attempt++) {
      if (this.closing || this.role !== "none") return;
      const r = await this.elect(this.path);
      if (r.role === "owner") return this.becomeOwner(r.server);

      const client = OwnerClient.adopt(r.socket);
      let peer: Peer;
      try {
        peer = await client.hello(this.build, this.pid, this.t.helloTimeoutMs);
      } catch {
        client.close(); // the owner went away between connect and hello
        continue;
      }

      if (
        peer.kind !== "peer" ||
        compareBuilds(this.build, peer.build) <= 0 ||
        takeovers >= this.t.maxTakeoverRounds
      ) {
        return this.becomeClient(client, peer);
      }

      takeovers++;
      this.log(`obsbot-mcp: ipc takeover requested from pid ${peer.pid}`);
      let granted: boolean;
      try {
        granted = await client.takeover(this.build, this.pid);
      } catch {
        granted = true; // closed before it could answer: the endpoint is free either way
      }
      if (!granted || !(await client.waitClosed(this.t.stepDownTimeoutMs))) {
        return this.becomeClient(client, peer);
      }
      // The old owner has let go. Go round again and bind.
    }
    throw new Error(`obsbot-mcp: ipc could not settle on an owner for ${this.path}`);
  }

  private becomeOwner(server: net.Server): void {
    if (this.closing) {
      server.close();
      return;
    }
    this.ownerServer = new OwnerServer(
      server,
      (body) => {
        const { tool, args } = body as { tool: string; args: Record<string, unknown> };
        return this.gate.run(() => this.runLocal(tool, args));
      },
      {
        identity: () => ({ build: this.build, pid: this.pid }),
        takeover: (build, pid) => this.onTakeover(build, pid),
      },
    );
    this.role = "owner";
    this.log("obsbot-mcp: ipc role=owner");
  }

  private becomeClient(client: OwnerClient, peer: Peer): void {
    if (this.closing) {
      client.close();
      return;
    }
    this.client = client;
    this.role = "client";
    // Re-elect when the connection closes, not when we next have something to
    // send: an idle newer build must not sit disconnected while an older one
    // takes the endpoint and runs calls.
    client.onClose(() => this.ownerLost(client));
    const owner =
      peer.kind === "peer"
        ? `owner-pid=${peer.pid} owner-build=${buildLabel(peer.build)}`
        : "owner-pid=unknown owner-build=legacy";
    this.log(`obsbot-mcp: ipc role=client ${owner}`);
  }

  /**
   * The owner has gone. Re-elect — after the grace period if it stepped down
   * for someone, so the successor binds first; after jitter alone if it simply
   * went, so clients that all lost it at once do not stampede.
   */
  private ownerLost(client: OwnerClient): void {
    if (this.client !== client || this.closing) return;
    const delay = (client.noticed ? this.t.stepDownGraceMs : 0) + this.jitter();
    this.reset();
    void this.begin(async () => {
      await sleep(delay);
      await this.doElect();
    });
  }

  /** A client asks for the endpoint. Both sides run the same comparison, so this cannot disagree with it. */
  private onTakeover(build: BuildId, pid: number): TakeoverResult {
    if (compareBuilds(build, this.build) <= 0) {
      return { ipc: "takeover", granted: false, reason: "not-newer" };
    }
    this.stepDown(pid);
    return { ipc: "takeover", granted: true };
  }

  private stepDown(successorPid: number): void {
    if (this.steppingDown) return; // a second request while stepping down needs nothing more
    this.steppingDown = true;
    const server = this.ownerServer!;
    this.log(`obsbot-mcp: ipc stepping down for pid ${successorPid}`);
    void this.begin(async () => {
      await this.gate.close(); // the call in flight finishes; nothing else starts
      await server.idle(); // …and its reply has been written
      await this.releaseBounded(); // the successor cannot open the camera until this is done
      await server.stepDown({ ipc: "stepping-down", successorPid });
      this.reset();
      this.gate.open();
      // Let the successor bind before we look for an owner to be a client of.
      await sleep(this.t.stepDownGraceMs + this.jitter());
      await this.doElect();
    });
  }

  /** A release that throws or never settles must not stop the handover. */
  private async releaseBounded(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`release did not finish in ${this.t.releaseTimeoutMs} ms`)),
        this.t.releaseTimeoutMs,
      );
    });
    try {
      await Promise.race([this.release(), timeout]);
    } catch (e) {
      this.log(`obsbot-mcp: ipc release failed while stepping down: ${errText(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
