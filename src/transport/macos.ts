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
// UVC CT_PANTILT_ABSOLUTE (selector 0x0D) is expressed in arc-seconds. The
// helper returns the raw per-axis value; the rest of the codebase works in
// degrees (Windows DirectShow convention), so scale here — the same shape as
// LinuxTransport's millidegree scaling. Hardware-measured range is ±468000
// asec pan / ±324000 asec tilt, resolution 3600 asec = 1°.
const ARCSEC_PER_DEG = 3600;
const CAMCTRL_PAN = 0;
const CAMCTRL_TILT = 1;

function isGimbalAxis(property: number): boolean {
  return property === CAMCTRL_PAN || property === CAMCTRL_TILT;
}

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
    // SET_CUR on CT_PANTILT_ABSOLUTE has never been exercised on this device —
    // absolute moves go through vendor V3 frames instead. Refuse rather than
    // issue an uncharacterized write.
    if (isGimbalAxis(property)) {
      throw new Error(
        "camCtrlSet: pan/tilt writes are not supported on macOS — use gimbalSet (vendor V3 frames)",
      );
    }
    await this.helper.camCtrlSet(property, value, flags);
  }

  async camCtrlRange(property: number): Promise<{ min: number; max: number }> {
    const result = await this.helper.camCtrlRange(property);
    if (isGimbalAxis(property)) {
      result.min = Math.round(result.min / ARCSEC_PER_DEG);
      result.max = Math.round(result.max / ARCSEC_PER_DEG);
    }
    return result;
  }

  /**
   * Read a camera-control property. Pan (0) and tilt (1) come from the standard
   * UVC CT_PANTILT_ABSOLUTE control (selector 0x0D), which this firmware updates
   * live during motion — including motion the host did not command (speed moves,
   * recenter, tracking). Scaled arc-seconds → degrees.
   *
   * Sign convention: UVC pan positive = camera's left (matches our yaw sign);
   * UVC tilt positive = up, which callers negate to get our +pitch = down.
   */
  async camCtrlGet(property: number): Promise<{ value: number; flags: number }> {
    const result = await this.helper.camCtrlGet(property);
    if (isGimbalAxis(property)) {
      result.value = Math.round(result.value / ARCSEC_PER_DEG);
    }
    return result;
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
