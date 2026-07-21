import { DeviceInfo } from "../codec/types.js";
import { HelperProcess } from "../transport/helper-process.js";
import { ObsbotTransport } from "../transport/transport.js";
import { WindowsTransport } from "../transport/windows.js";
import { LinuxTransport } from "../transport/linux.js";
import { MacosTransport } from "../transport/macos.js";

// USB vendor ID 0x3564 is registered to **Remo Inc.** — the manufacturer. OBSBOT
// is a Remo product brand, and Remo ships non-OBSBOT (and non-camera) devices
// under the same VID, so candidacy must gate on VID **and** a known model PID —
// never VID alone. Add a PID here (and mirror it in native/macos/helper.m's
// OBSBOT_MODEL_PIDS) when a new OBSBOT camera model is verified on hardware.
const REMO_VID = 0x3564;
const OBSBOT_MODEL_PIDS = new Map<number, Set<number>>([
  [REMO_VID, new Set<number>([0xfef8 /* Tiny 2 */])],
]);

// Legacy name match — used ONLY as a fallback on platforms whose helper does not
// yet report USB vid/pid (Linux today: its /dev/videoN paths carry no USB
// identity). Windows and macOS helpers report vid/pid, so there the gate is
// strict and branded software sources — e.g. the "OBSBOT Virtual Camera"
// DirectShow filter, which matched this regex and poisoned multi-candidate
// binding — are correctly excluded.
const OBSBOT_NAME_RE = /obsbot/i;

/** Message text from an unknown thrown value, for diagnostics. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Is this enumerated device a controllable OBSBOT camera worth binding? On
 * Windows/macOS the helper reports USB vid/pid, so gate strictly on the Remo
 * VID + known-model PID table (a software "OBSBOT Virtual Camera" has no vid/pid
 * and is rejected). On Linux the helper does not report vid/pid yet, so fall
 * back to the name match there until it does.
 */
function isObsbotCamera(d: DeviceInfo): boolean {
  if (process.platform === "linux") return OBSBOT_NAME_RE.test(d.name);
  if (d.vid === undefined || d.pid === undefined) return false;
  return OBSBOT_MODEL_PIDS.get(d.vid)?.has(d.pid) ?? false;
}

/** Thrown by get() with no selector when more than one camera is attached. */
export class AmbiguousCameraError extends Error {
  readonly available: string[];
  constructor(available: string[]) {
    super(`multiple cameras attached; specify one of: ${available.join(", ")}`);
    this.name = "AmbiguousCameraError";
    this.available = available;
  }
}

/** Thrown by get(serial) when no attached, bindable camera has that serial. */
export class UnknownCameraError extends Error {
  readonly available: string[];
  constructor(serial: string, available: string[]) {
    super(
      `unknown camera "${serial}"; available: ${available.length ? available.join(", ") : "(none)"}`,
    );
    this.name = "UnknownCameraError";
    this.available = available;
  }
}

export interface CameraInfo {
  /** Present only for cameras this process could open and identify. */
  serial?: string;
  /** macOS: USB locationID. A handle for correlation/display only — never identity. */
  locationId?: number;
  name: string;
  status: "available" | "bound" | "busy";
  /**
   * Why a `busy` camera could not be identified — the underlying open or
   * readSerial error. Absent on cameras that bound fine. "busy" covers two very
   * different situations (another process holds the device vs. the vendor
   * mailbox went quiet) and without this they are indistinguishable from
   * outside.
   */
  reason?: string;
}

interface RegistryEntry {
  helper: HelperProcess;
  transport: ObsbotTransport;
  locationId?: number;
  /** Device node path, populated on every platform — the cross-platform dedup key. */
  path: string;
  name: string;
}

interface ScanMatch {
  transport: ObsbotTransport;
  serial: string;
  locationId?: number;
  path: string;
  name: string;
}

/**
 * Serial-keyed multi-camera registry. Identity is the serial (read via
 * ObsbotTransport.readSerial() on a freshly-opened device); locationId is
 * only ever a display/correlation hint, never persisted as truth for
 * binding.
 *
 * Steady state is one HelperProcess per bound camera (Map<serial, {helper,
 * transport, locationId}>), spawned lazily — nothing is spawned until a
 * camera is actually needed (get() or listCameras()). While scanning for a
 * camera to bind, candidates are tried on a single scratch helper reused
 * across attempts, mirroring the native helper's own behaviour: `doOpen`
 * unconditionally releases whatever device it previously held before
 * opening the next one, so re-opening a different candidate on the same
 * helper is exactly what one physical device-swap looks like to it. A
 * scratch helper that turns out to be the winning candidate is promoted
 * directly into the registry (no extra spawn); one that never opens a
 * usable camera is kept around for the next scan instead of being spawned
 * again. Consequently DeviceManager never closes a helper it did not spawn
 * itself for a *losing* attempt — ownership of a bound camera's helper
 * transfers to the registry, and callers that hand in an already-started,
 * externally-owned helper (see the .mjs scripts) keep owning its shutdown.
 *
 * USB open is exclusive: a camera another process holds fails `open` with
 * an exclusive-access error. Per multi-camera spec §4.3, ANY open failure
 * during a scan is treated as "not mine, skip" — not fatal — because the
 * helper does not currently surface a clean, stable way to distinguish
 * exclusive-access from other open failures at this layer.
 *
 * invalidate() is the escape hatch out of "once bound, stay bound": it
 * drops a registry entry (best-effort closing its helper first) so the
 * next get()/bind() re-scans through a fresh helper instead of handing back
 * a transport that may be talking to a device that already re-enumerated.
 */
export class DeviceManager {
  private registry = new Map<string, RegistryEntry>();
  /** Lazily spawned, reused across scans until promoted into the registry. */
  private scanHelper?: HelperProcess;
  /**
   * Reconnect tracking, folded in from the retired DeviceSession. `everBound`
   * records every serial this manager has bound at least once — deliberately
   * SEPARATE from the registry Map so it survives invalidate() dropping a
   * registry entry (the registry says "bound right now", this says "bound at
   * some point"). A promote() of a serial already in `everBound` is therefore a
   * RE-bind — a self-heal after a mid-session disconnect — and lands the serial
   * in `reconnectedSerials`, which the readiness gate drains via
   * takeReconnected() to surface `reconnected: true` on the next command.
   */
  private everBound = new Set<string>();
  private reconnectedSerials = new Set<string>();

  /**
   * @param makeHelper Factory for a HelperProcess, invoked whenever a fresh
   *   scratch helper is needed (each scan, and each rebind after
   *   invalidate()). CONTRACT: it MUST return a freshly-started,
   *   exclusively-owned HelperProcess on every call — DeviceManager may call
   *   it repeatedly across a session and always expects a clean handle, not
   *   a shared one. A factory that instead returns the SAME already-started
   *   helper on every call (as the single-camera `.mjs` scripts under
   *   scripts/ do, to keep one native session alive for their whole run)
   *   MUST NOT bind more than one serial through this manager: a second
   *   scan would hand that same shared helper back and silently steal the
   *   first bound camera's native session out from under it. No current
   *   caller does this (all are single-camera); this is latent and not
   *   guarded in code — the proper fix belongs to multi-camera .mjs/CLI
   *   wiring, not to DeviceManager itself.
   */
  constructor(private makeHelper: () => Promise<HelperProcess>) {}

  private createTransport(helper: HelperProcess): ObsbotTransport {
    if (process.platform === "linux") {
      return new LinuxTransport(helper);
    }
    if (process.platform === "darwin") {
      return new MacosTransport(helper);
    }
    return new WindowsTransport(helper);
  }

  private async getScanHelper(): Promise<HelperProcess> {
    // A cached scan helper whose process has died must be discarded, not
    // handed back. invalidate() only drops REGISTRY entries, so a helper that
    // died mid-scan (before promote() moved it into the registry) would
    // otherwise stay cached here and every later scan would talk to a corpse —
    // the one path where failing fast on the transport isn't enough to recover.
    if (this.scanHelper?.isDead) this.scanHelper = undefined;
    if (!this.scanHelper) {
      this.scanHelper = await this.makeHelper();
    }
    return this.scanHelper;
  }

  /**
   * Compat: raw enumerate() pass-through (unfiltered, no serials). Used by
   * obsbot_capture_snapshot's virtual/ndi source lookup, not by obsbot_devices
   * (which reports the identified fleet via listCameras() instead).
   */
  async list(): Promise<DeviceInfo[]> {
    const helper = await this.getScanHelper();
    return helper.enumerate();
  }

  /**
   * Scan attached candidates on the scratch helper for a camera to bind.
   *
   * - `wantSerial` given: stop at the first candidate whose serial matches;
   *   throws UnknownCameraError (listing every identifiable serial seen)
   *   if the scan exhausts without a match.
   * - `wantSerial` omitted: every candidate must be probed so the full
   *   fleet is known — a partial scan could under-report ambiguity or
   *   silently pick the wrong "only" camera. Binds if exactly one distinct
   *   serial turns up; throws AmbiguousCameraError (all distinct serials)
   *   if more than one does; throws if none do.
   */
  private async bind(wantSerial?: string): Promise<{ transport: ObsbotTransport; serial: string }> {
    const helper = await this.getScanHelper();
    const devices = await helper.enumerate();
    const candidates = devices.filter(isObsbotCamera);

    const found = new Map<string, { locationId?: number; name: string }>();
    let matched: ScanMatch | undefined;
    // Why each candidate was passed over. Every `continue` below is a silent
    // rejection, and when they ALL reject the caller used to get a bare "no
    // OBSBOT camera found" — the same message it gets with nothing plugged in.
    // Carrying the reasons into the error is the difference between "no camera"
    // and "the camera is right there but wouldn't answer".
    const rejected: string[] = [];

    for (const d of candidates) {
      let xuNode: number;
      try {
        xuNode = await helper.open(d.path);
      } catch (e) {
        // ANY open failure (exclusive access or otherwise) — skip, not
        // fatal. The next candidate's open() releases this attempt.
        rejected.push(`${d.path}: open failed: ${errText(e)}`);
        continue;
      }
      if (xuNode < 0) {
        // Opened, but this node has no XU unit (e.g. the metadata/ISP node
        // the Tiny 2 also exposes) — not a usable candidate.
        rejected.push(`${d.path}: opened but has no XU unit`);
        continue;
      }

      const transport = this.createTransport(helper);
      let serial: string;
      try {
        serial = await transport.readSerial();
      } catch (e) {
        rejected.push(`${d.path}: ${errText(e)}`);
        continue;
      }

      if (!found.has(serial)) found.set(serial, { locationId: d.locationId, name: d.name });
      matched = { transport, serial, locationId: d.locationId, path: d.path, name: d.name };
      if (wantSerial && serial === wantSerial) break;
    }

    if (wantSerial) {
      if (matched && matched.serial === wantSerial) {
        this.promote(matched);
        return { transport: matched.transport, serial: matched.serial };
      }
      throw new UnknownCameraError(wantSerial, [...found.keys()]);
    }
    if (found.size === 0) {
      // With nothing attached there is nothing to explain, so that message
      // stays exactly as it was.
      throw new Error(
        rejected.length === 0
          ? "no OBSBOT camera found"
          : `no OBSBOT camera found — ${rejected.length} candidate(s) rejected: ${rejected.join("; ")}`,
      );
    }
    if (found.size > 1) {
      throw new AmbiguousCameraError([...found.keys()]);
    }
    // Exactly one distinct serial: `matched` is guaranteed bound to it
    // (every successful candidate shared that one serial).
    this.promote(matched!);
    return { transport: matched!.transport, serial: matched!.serial };
  }

  /** Move the current scratch helper into the registry under `m.serial`. */
  private promote(m: ScanMatch): void {
    // Reconnect bookkeeping BEFORE recording the bind: if we've bound this
    // serial before, this promote is a re-bind (self-heal after a disconnect),
    // so flag it reconnected. The very first bind of a serial is never a
    // reconnect. everBound must NOT be gated on the registry (invalidate drops
    // registry entries) — that's the whole point of tracking it separately.
    if (this.everBound.has(m.serial)) this.reconnectedSerials.add(m.serial);
    this.everBound.add(m.serial);

    this.registry.set(m.serial, {
      helper: this.scanHelper!,
      transport: m.transport,
      locationId: m.locationId,
      path: m.path,
      name: m.name,
    });
    // This helper now belongs to the registry entry; the next scan needs
    // its own (lazily spawned on next use).
    this.scanHelper = undefined;
  }

  /**
   * Whether the camera identified by `serial` (or, with no arg, the single
   * bound camera) was RE-bound after a prior bind — i.e. self-healed across a
   * mid-session disconnect — clearing that flag on read. Single-camera
   * semantics (no serial): return true if ANY serial is pending-reconnected,
   * draining them all. Preserves the exact contract the retired
   * DeviceSession.takeReconnected() had.
   */
  takeReconnected(serial?: string): boolean {
    if (serial !== undefined) {
      const r = this.reconnectedSerials.has(serial);
      this.reconnectedSerials.delete(serial);
      return r;
    }
    if (this.reconnectedSerials.size === 0) return false;
    this.reconnectedSerials.clear();
    return true;
  }

  /**
   * Drop bound camera(s) from the registry so the next get()/bind() spawns a
   * fresh scratch helper and re-scans from scratch — the correct move after
   * a device has re-enumerated (e.g. unplug/replug), since a stale cached
   * transport talks to a helper that may no longer own a live handle.
   * Closing each dropped helper is best-effort: a helper whose native
   * session already died (the common case right after a disconnect) can
   * throw on close(), and that must not stop the entry from being dropped.
   *
   *   serial given -> drop just that camera (no-op if it isn't bound)
   *   no serial    -> drop every bound camera
   */
  async invalidate(serial?: string): Promise<void> {
    const drop = async (s: string, entry: RegistryEntry): Promise<void> => {
      try {
        await entry.helper.close();
      } catch {
        // best-effort — a dead/disconnected helper's close() may itself throw
      }
      this.registry.delete(s);
    };

    if (serial) {
      const entry = this.registry.get(serial);
      if (entry) await drop(serial, entry);
      return;
    }
    await Promise.all([...this.registry].map(([s, entry]) => drop(s, entry)));
  }

  /**
   * Drop registry entries whose helper process has died, so the next resolve
   * re-binds instead of handing back a transport that can only ever fail.
   *
   * "Once bound, stay bound" is the right default, but a bound entry whose
   * helper is GONE isn't a binding — it's a corpse. Without this, only the
   * tools that route through ensureReady() (which calls invalidate()) could
   * recover; every other tool resolved straight through get() and returned the
   * same dead transport forever. Recovery then required the caller to happen to
   * invoke a different tool — and the caller here is an LLM, which will instead
   * retry the failing tool or report broken hardware that is actually fine.
   *
   * Deliberately a `dead` check and not a liveness probe: it costs a boolean,
   * adds no round trip to the hot path, and leaves a LIVE binding untouched (a
   * guard that re-scanned every call would spawn a helper per tool call).
   *
   * A wedged-but-alive helper is intentionally NOT caught here — that is the
   * per-request timeout's job, and condemning a session for one slow op would
   * throw away a working binding.
   */
  private pruneDeadEntries(): void {
    for (const [serial, entry] of this.registry) {
      if (entry.helper.isDead) this.registry.delete(serial);
    }
  }

  /**
   * Resolve to a bound transport.
   *   no serial + one camera attached  -> bind & return it
   *   no serial + several attached     -> AmbiguousCameraError
   *   serial given + match             -> bind (lazily) & return
   *   serial given + no match          -> UnknownCameraError
   * Already-bound cameras are returned directly from the registry without
   * rescanning — "bind lazily" means once bound, stay bound.
   */
  async get(serial?: string): Promise<ObsbotTransport> {
    this.pruneDeadEntries();

    if (serial) {
      const existing = this.registry.get(serial);
      if (existing) return existing.transport;
      const { transport } = await this.bind(serial);
      return transport;
    }

    if (this.registry.size === 1) {
      return [...this.registry.values()][0]!.transport;
    }
    if (this.registry.size > 1) {
      throw new AmbiguousCameraError([...this.registry.keys()]);
    }
    const { transport } = await this.bind();
    return transport;
  }

  /** Compat shim for the single-camera API B1 retires. */
  async openFirstObsbot(): Promise<ObsbotTransport> {
    return this.get();
  }

  /**
   * Per attached camera: serial (where obtainable), locationId, name, and
   * status. A camera this process cannot open is reported `busy` WITHOUT a
   * serial rather than omitted — it is enumerable but not identifiable.
   * Already-bound cameras are reported from the registry without
   * re-opening (avoids a pointless self-conflict against our own handle).
   */
  async listCameras(): Promise<CameraInfo[]> {
    const results: CameraInfo[] = [];
    const seenSerials = new Set<string>();
    const boundLocationIds = new Set<number>();
    const boundPaths = new Set<string>();
    for (const [serial, entry] of this.registry) {
      results.push({ serial, locationId: entry.locationId, name: entry.name, status: "bound" });
      seenSerials.add(serial);
      if (entry.locationId !== undefined) boundLocationIds.add(entry.locationId);
      boundPaths.add(entry.path);
    }

    const helper = await this.getScanHelper();
    const devices = await helper.enumerate();
    const candidates = devices.filter(isObsbotCamera);

    for (const d of candidates) {
      // locationId is macOS-only (undefined on Linux/Windows); `path` is
      // populated on every platform, so it's the dedup key that actually
      // works cross-platform. Without it, a bound camera off-macOS gets
      // re-opened here, collides with the registry helper's own held-open
      // handle, and is double-reported a second time as a serial-less
      // "busy" entry alongside its correct "bound" one.
      if (boundPaths.has(d.path)) {
        continue; // already reported as bound above
      }
      if (d.locationId !== undefined && boundLocationIds.has(d.locationId)) {
        continue; // already reported as bound above
      }
      try {
        const xuNode = await helper.open(d.path);
        if (xuNode < 0) continue;
        const transport = this.createTransport(helper);
        const serial = await transport.readSerial();
        if (seenSerials.has(serial)) continue; // duplicate node of an already-listed camera
        seenSerials.add(serial);
        results.push({ serial, locationId: d.locationId, name: d.name, status: "available" });
      } catch (e) {
        results.push({
          locationId: d.locationId,
          name: d.name,
          status: "busy",
          reason: errText(e),
        });
      }
    }

    return results;
  }
}
