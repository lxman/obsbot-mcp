import { HelperProcess } from "./helper-process.js";
import { ObsbotTransport, Snapshot, SnapshotOpts } from "./transport.js";
import { encodeRecenter, encodePtzMoveAngle, encodePtzMoveSpeed } from "../codec/commands.js";

// Same XU selector constants as WindowsTransport — they're defined by the
// OBSBOT protocol, not the OS:
const VENDOR_XU_SELECTOR = 0x02;
// Unproven per-command reply path — reads back zeros. See the WindowsTransport
// comment for the 2026-07-19 hardware sweep: sel 6 returns the status block (not
// a reply), and preset read-back lives on flat selectors 12/13 instead.
const RESPONSE_SELECTOR = 0x02;
const DEFAULT_REPLY_LEN = 60;
const STATUS_SELECTOR = 0x06;
const STATUS_BLOCK_LEN = 60;

export class MacosTransport implements ObsbotTransport {
  private seq = 0;

  constructor(private helper: HelperProcess) {}

  async sendVendor(frame: Buffer): Promise<void> {
    await this.helper.xuSet(VENDOR_XU_SELECTOR, frame);
  }

  async recvVendor(frame: Buffer, length = DEFAULT_REPLY_LEN): Promise<Buffer> {
    await this.helper.xuSet(VENDOR_XU_SELECTOR, frame);
    return this.helper.xuGet(RESPONSE_SELECTOR, length);
  }

  async recvStatus(length = STATUS_BLOCK_LEN): Promise<Buffer> {
    return this.helper.xuGet(STATUS_SELECTOR, length);
  }

  async xuRaw(selector: number, data: Buffer): Promise<void> {
    await this.helper.xuSet(selector, data);
  }

  async xuGetRaw(selector: number, length: number): Promise<Buffer> {
    return this.helper.xuGet(selector, length);
  }

  async zoomRange(): Promise<{ min: number; max: number }> {
    return this.helper.zoomRange();
  }

  async zoomSet(units: number): Promise<void> {
    await this.helper.zoomSet(units);
  }

  async snapshot(opts: SnapshotOpts): Promise<Snapshot> {
    return this.helper.snapshot(opts);
  }

  async camCtrlSet(property: number, value: number, flags: number): Promise<void> {
    await this.helper.camCtrlSet(property, value, flags);
  }

  async camCtrlRange(property: number): Promise<{ min: number; max: number }> {
    return this.helper.camCtrlRange(property);
  }

  async camCtrlGet(property: number): Promise<{ value: number; flags: number }> {
    return this.helper.camCtrlGet(property);
  }

  async procAmpSet(property: number, value: number, flags: number): Promise<void> {
    await this.helper.procAmpSet(property, value, flags);
  }

  async procAmpRange(property: number): Promise<{ min: number; max: number }> {
    return this.helper.procAmpRange(property);
  }

  async gimbalSet(yawDeg: number, pitchDeg: number, rollDeg = 0): Promise<void> {
    await this.sendVendor(encodePtzMoveAngle(yawDeg, pitchDeg, rollDeg).buildFrame(this.nextSeq()));
  }

  async gimbalSpeed(yaw: number, pitch: number, roll: number, autoStopMs: number): Promise<void> {
    await this.sendVendor(encodePtzMoveSpeed(-yaw, pitch, roll).buildFrame(this.nextSeq()));
    if (autoStopMs > 0) {
      await new Promise((r) => setTimeout(r, autoStopMs));
      await this.sendVendor(encodePtzMoveSpeed(0, 0, 0).buildFrame(this.nextSeq()));
    }
  }

  async gimbalRecenter(): Promise<void> {
    await this.sendVendor(encodeRecenter().buildFrame(this.nextSeq()));
  }

  nextSeq(): number {
    this.seq = this.seq >= 0xffff ? 1 : this.seq + 1;
    return this.seq;
  }

  async close(): Promise<void> {
    await this.helper.close();
  }
}
