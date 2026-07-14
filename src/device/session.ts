import { DeviceManager } from "./manager.js";
import { ObsbotTransport } from "../transport/transport.js";

/**
 * Owns the device connection lifecycle: lazily opens the first OBSBOT, caches
 * the transport, and supports invalidation + re-open for self-healing across a
 * mid-session disconnect. A re-open after a prior open is flagged as a
 * "reconnect" so callers can surface `reconnected: true` and re-read state
 * (the device power-cycles on unplug — prior assumptions are void).
 */
export class DeviceSession {
  private transport?: ObsbotTransport;
  private opened = false;
  private reconnected = false;

  constructor(private mgr: DeviceManager) {}

  /** Return the cached transport, opening (or re-opening) the device if needed. */
  async get(): Promise<ObsbotTransport> {
    if (!this.transport) {
      this.transport = await this.mgr.openFirstObsbot();
      if (this.opened) this.reconnected = true; // this is a RE-open, not the first
      this.opened = true;
    }
    return this.transport;
  }

  /** Drop the cached transport (e.g. after a device error) so the next get() re-opens. */
  invalidate(): void {
    this.transport = undefined;
  }

  /** True once if the transport was re-opened after an invalidate; clears on read. */
  takeReconnected(): boolean {
    const r = this.reconnected;
    this.reconnected = false;
    return r;
  }
}
