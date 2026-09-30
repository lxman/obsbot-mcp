import { networkInterfaces } from "node:os";
import { Tail2Api, Tail2DeviceInfo } from "./api.js";
import { listenForTail2Announcements, type Tail2Announcement } from "./mdns.js";

/**
 * MAC-keyed registry of attached OBSBOT Tail 2 cameras.
 *
 * The Tiny 2's DeviceManager discovers cameras over USB and identifies them
 * by serial; the Tail 2 reports no USB serial number in either of its USB-C
 * modes (MTP or UVC — TAIL2-PROTOCOL.md §1, §11), so a Tail
 * 2's identity is its MAC, exactly as OBSBOT Center treats it. Entries are
 * created by probing a host with the discovery handshake (GET device_info,
 * then WS hello — this module only needs the first half) and can be added
 * four ways:
 *
 *   - the OBSBOT_TAIL2_HOSTS environment variable (comma-separated hosts),
 *     for a stable, known network;
 *   - the obsbot_tail2_scan tool, which listens for the camera's mDNS
 *     announcements (~5s) and falls back to sweeping the local /24(s);
 *   - the camera's own periodic mDNS announcement, which names its MAC, its
 *     name and both its IPs — no probe needed, the camera just said so;
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
   * Register straight from the camera's own mDNS announcement — no probe.
   * The digest carries the MAC, the name and both IPs, and the packet arrived
   * seconds ago, so it is better evidence than a probe that has not run. The
   * API binds to the wired IP first (the wireless IP is often the camera's
   * own AP subnet, 192.168.55.x, unroutable from here).
   */
  addAnnouncement(a: Tail2Announcement): Tail2Entry {
    const mac = a.mac.toLowerCase();
    const existing = this.byMac.get(mac);
    if (existing) {
      for (const h of a.hosts) if (!existing.hosts.includes(h)) existing.hosts.push(h);
      return existing;
    }
    const entry: Tail2Entry = {
      mac,
      name: a.name,
      hosts: [...a.hosts],
      api: this.makeApi(a.hosts[0] ?? mac),
    };
    this.byMac.set(mac, entry);
    return entry;
  }

  /**
   * Discovery: listen for the camera's mDNS announcements (its own control
   * channel — it multicasts a device digest every few seconds), and fall back
   * to the HTTP subnet sweep only when nothing was heard, for networks where
   * multicast is filtered. `OBSBOT_TAIL2_MDNS=0` skips the listen.
   */
  async scan(
    opts: {
      mdnsMs?: number;
      listen?: (ms: number) => Promise<Tail2Announcement[]>;
      sweep?: boolean;
      subnets?: string[];
      concurrency?: number;
    } = {},
  ): Promise<Tail2Entry[]> {
    let heard: Tail2Announcement[] = [];
    // An injected listener (tests) always runs; the env kill-switch governs
    // only the default one.
    const listen =
      opts.listen ?? (process.env.OBSBOT_TAIL2_MDNS === "0" ? null : listenForTail2Announcements);
    if (listen) {
      try {
        heard = await listen(opts.mdnsMs ?? 5000);
      } catch {
        heard = []; // listening is best-effort; the sweep still covers it
      }
    }
    const found = new Map<string, Tail2Entry>();
    for (const a of heard) {
      const e = this.addAnnouncement(a);
      found.set(e.mac, e);
    }
    if (heard.length > 0 || opts.sweep === false) return [...found.values()];
    const swept = await this.scanSubnet({ subnets: opts.subnets, concurrency: opts.concurrency });
    for (const e of swept) found.set(e.mac, e);
    return [...found.values()];
  }

  /**
   * Sweep every IPv4 /24 this machine belongs to (excluding loopback) for
   * Tail 2 cameras, registering what answers. The mDNS listen in scan()
   * covers every network the camera's announcements can reach; this sweep is
   * the fallback for the rest — an HTTP GET of /camera/sdk/device_info per
   * candidate address, the same probe OBSBOT Center's discovery uses, so the
   * traffic pattern is one the camera expects to see. Bounded concurrency
   * keeps the sweep from socket-bombing the host; per-address timeouts keep
   * one slow device from stretching the scan.
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
