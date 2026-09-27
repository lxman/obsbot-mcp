import { networkInterfaces } from "node:os";
import { Tail2Api, Tail2DeviceInfo } from "./api.js";

/**
 * MAC-keyed registry of attached OBSBOT Tail 2 cameras.
 *
 * The Tiny 2's DeviceManager discovers cameras over USB and identifies them
 * by serial; the Tail 2 reports no USB serial number in either of its USB-C
 * modes (MTP or UVC — TAIL2-PROTOCOL.md §1, §11), so a Tail
 * 2's identity is its MAC, exactly as OBSBOT Center treats it. Entries are
 * created by probing a host with the discovery handshake (GET device_info,
 * then WS hello — this module only needs the first half) and can be added
 * three ways:
 *
 *   - the OBSBOT_TAIL2_HOSTS environment variable (comma-separated hosts),
 *     for a stable, known network;
 *   - the obsbot_tail2_scan tool, which sweeps the local /24(s);
 *   - resolve()/get() with an explicit host, which registers on first use.
 *
 * "Registered" does NOT mean "verified reachable right now" — entries persist
 * across a camera going offline, and the next operation against its API fails
 * with the actionable unreachable error rather than a mystery. Re-registration
 * by MAC is idempotent and merges new candidate hosts into the entry.
 */

export interface Tail2Entry {
  mac: string;
  name: string;
  /** Every host this camera has answered on (wired and wireless IPs). */
  hosts: string[];
  api: Tail2Api;
}

/** Mirrors DeviceManager's contract: same shapes, same caller expectations. */
export class AmbiguousTail2Error extends Error {
  readonly available: string[];
  constructor(available: string[]) {
    super(`multiple Tail 2 cameras registered; specify one of: ${available.join(", ")}`);
    this.name = "AmbiguousTail2Error";
    this.available = available;
  }
}

const NO_CAMERA_HINT =
  `no Tail 2 camera is registered. Add one via the obsbot_tail2_scan tool (sweeps the ` +
  `local network), or set OBSBOT_TAIL2_HOSTS to its address(es), or pass its host as the ` +
  `camera parameter on any Tail 2 tool`;

export class Tail2Registry {
  private readonly byMac = new Map<string, Tail2Entry>();
  private readonly probeTimeoutMs: number;
  private readonly makeApi: (host: string) => Tail2Api;

  constructor(opts: { probeTimeoutMs?: number; makeApi?: (host: string) => Tail2Api } = {}) {
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2500;
    this.makeApi =
      opts.makeApi ?? ((host) => new Tail2Api({ baseUrl: host, timeoutMs: this.probeTimeoutMs }));
  }

  /**
   * Seed from `OBSBOT_TAIL2_HOSTS` (comma-separated; blank entries ignored).
   * The opts passthrough exists for tests; production calls it bare.
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    opts: { probeTimeoutMs?: number; makeApi?: (host: string) => Tail2Api } = {},
  ): Tail2Registry {
    const reg = new Tail2Registry(opts);
    const hosts = (env.OBSBOT_TAIL2_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h !== "");
    for (const h of hosts) void reg.addHost(h);
    // addHost is async; seeding is best-effort and races first use harmlessly
    // (resolve() re-probes nothing, but a tool call coming in before the probe
    // finishes simply doesn't see the entry yet and reports "not registered").
    return reg;
  }

  /**
   * Probe one host; register it if it answers as a Tail 2. Returns the entry,
   * or null when nothing Tail-2-shaped answers there (wrong device, plain
   * HTTP server, or silence) — a scan probes hundreds of addresses and
   * "not here" is the normal outcome, not an error.
   */
  async addHost(host: string): Promise<Tail2Entry | null> {
    const api = this.makeApi(host);
    let info: Tail2DeviceInfo;
    try {
      info = await api.info();
    } catch {
      return null;
    }
    if (typeof info.mac !== "string" || info.mac === "" || !info.device_name) return null;
    const mac = info.mac.toLowerCase();
    const existing = this.byMac.get(mac);
    if (existing) {
      // Same camera reachable at another address (wired + wireless): keep both.
      if (!existing.hosts.includes(host)) existing.hosts.push(host);
      return existing;
    }
    const entry: Tail2Entry = { mac, name: info.device_name, hosts: [host], api };
    this.byMac.set(mac, entry);
    return entry;
  }

  /** Resolve the `camera` selector: MAC, device_name, or host — case-insensitive. */
  async resolve(camera?: string): Promise<Tail2Entry> {
    if (camera === undefined || camera === "") {
      const all = [...this.byMac.values()];
      if (all.length === 1) return all[0]!;
      if (all.length > 1) throw new AmbiguousTail2Error(all.map((e) => e.mac));
      throw new Error(NO_CAMERA_HINT);
    }
    const want = camera.toLowerCase();
    for (const e of this.byMac.values()) {
      if (e.mac === want || e.name.toLowerCase() === want) return e;
      if (e.hosts.some((h) => h.toLowerCase() === want)) return e;
    }
    // Not registered — but if the selector IS a reachable host, register it.
    // This makes "camera: 192.168.0.132" work on a cold server with no env
    // config and no scan, which is the fastest path from install to control.
    const byHost = await this.addHost(camera);
    if (byHost) return byHost;
    const available = [...this.byMac.values()].map((e) => e.mac);
    throw new Error(
      `unknown Tail 2 camera "${camera}"; available: ` +
        (available.length ? available.join(", ") : "(none registered — run obsbot_tail2_scan)") +
        `. If "${camera}" is a host, nothing Tail 2 answered there.`,
    );
  }

  list(): Tail2Entry[] {
    return [...this.byMac.values()];
  }

  /**
   * Sweep every IPv4 /24 this machine belongs to (excluding loopback) for
   * Tail 2 cameras, registering what answers. This is exactly what OBSBOT
   * Center's own discovery does — an HTTP GET of /camera/sdk/device_info per
   * candidate address — so the traffic pattern is one the camera expects to
   * see. Bounded concurrency keeps the sweep from socket-bombing the host;
   * per-address timeouts keep one slow device from stretching the scan.
   */
  async scanSubnet(
    opts: { concurrency?: number; subnets?: string[] } = {},
  ): Promise<Tail2Entry[]> {
    const concurrency = opts.concurrency ?? 32;
    // Overridable for tests (and for pinning a scan to one network when this
    // machine straddles several); default is every non-internal IPv4 /24.
    const subnets = new Set<string>(opts.subnets ?? []);
    if (subnets.size === 0) {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family !== "IPv4" || a.internal) continue;
          subnets.add(a.address.split(".").slice(0, 3).join("."));
        }
      }
    }
    const candidates: string[] = [];
    for (const s of subnets) {
      for (let i = 1; i <= 254; i++) candidates.push(`${s}.${i}`);
    }
    // addHost returns the entry for every host that ANSWERED as a Tail 2 —
    // including already-registered cameras — so the result is "reachable on
    // this sweep", not "new since last time".
    const found = new Map<string, Tail2Entry>();
    for (let i = 0; i < candidates.length; i += concurrency) {
      const results = await Promise.all(
        candidates.slice(i, i + concurrency).map((h) => this.addHost(h)),
      );
      for (const e of results) if (e) found.set(e.mac, e);
    }
    return [...found.values()];
  }
}
