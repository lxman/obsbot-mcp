import { HelperProcess } from "./helper-process.js";
import { ObsbotTransport, Snapshot, SnapshotOpts } from "./transport.js";
import { encodePtzMoveSpeed } from "../codec/commands.js";

const VENDOR_XU_SELECTOR = 0x02;
// Unproven per-command reply path — reads back zeros. See the WindowsTransport
// comment for the 2026-07-19 hardware sweep: sel 6 returns the status block (not
// a reply), and preset read-back lives on flat selectors 12/13 instead.
const RESPONSE_SELECTOR = 0x02;
const DEFAULT_REPLY_LEN = 60;
const STATUS_SELECTOR = 0x06;
const STATUS_BLOCK_LEN = 60;
// V4L2 pan_absolute/tilt_absolute step is 3600 millidegrees = 1 degree
const DEG_TO_MDEG = 1000;

/**
 * Linux V4L2 transport — functionally identical to {@link WindowsTransport}
 * because both delegate to the native helper process over the same JSON-RPC
 * stdio protocol. The selector constants are camera-side constants (the UVC
 * Extension Unit), not OS constants, so they are shared.
 *
 * Key difference: gimbal movement uses V4L2 pan_absolute/tilt_absolute
 * (hardware-proven to physically move the gimbal), NOT vendor V3 frames,
 * because vendor frames break V4L2 position readback on this device.
 * camCtrlGet for pan/tilt converts V4L2 millidegrees to degrees to match
 * the Windows DirectShow convention used by the rest of the codebase.
 */
export class LinuxTransport implements ObsbotTransport {
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
    const result = await this.helper.camCtrlRange(property);
    // Convert V4L2 millidegrees → degrees for pan/tilt to match Windows convention
    if (property === 0 || property === 1) {
      result.min = Math.round(result.min / DEG_TO_MDEG);
      result.max = Math.round(result.max / DEG_TO_MDEG);
    }
    return result;
  }

  async camCtrlGet(property: number): Promise<{ value: number; flags: number }> {
    const result = await this.helper.camCtrlGet(property);
    // V4L2 pan_absolute/tilt_absolute return millidegrees, but the rest of
    // the codebase expects degrees (Windows DirectShow convention).
    if (property === 0 || property === 1) {
      result.value = Math.round(result.value / DEG_TO_MDEG);
    }
    return result;
  }

  async procAmpSet(property: number, value: number, flags: number): Promise<void> {
    await this.helper.procAmpSet(property, value, flags);
  }

  async procAmpRange(property: number): Promise<{ min: number; max: number }> {
    return this.helper.procAmpRange(property);
  }

  /**
   * Move the gimbal using V4L2 pan_absolute/tilt_absolute (millidegrees).
   * Unlike vendor V3 frames, V4L2 writes keep the position readback working
   * (VIDIOC_G_CTRL returns the last-set value, which physically moved the gimbal
   * — proven by snapshot MD5 comparison 2026-07-19).
   *
   * Sign convention: V4L2 pan_absolute + = camera's left (matches our yaw sign).
   * V4L2 tilt_absolute + = tilt up (opposite of our +pitch = down convention).
   */
  async gimbalSet(yawDeg: number, pitchDeg: number, _rollDeg?: number): Promise<void> {
    // V4L2 pan/tilt drives in parallel — both are independent controls.
    await Promise.all([
      this.camCtrlSet(0, Math.round(yawDeg * DEG_TO_MDEG), 2),
      this.camCtrlSet(1, Math.round(-pitchDeg * DEG_TO_MDEG), 2),
    ]);
  }

  /**
   * Drive the gimbal at a speed for a duration, using vendor-frame velocity
   * protocol (fire-and-forget, no position readback).
   * gimbalSet (V4L2) handles position-based movement where readback matters.
   */
  async gimbalSpeed(yaw: number, pitch: number, roll: number, autoStopMs: number): Promise<void> {
    // Firmware velocity-yaw is inverted relative to position-yaw (same vendor
    // AI_SET_GIM_SPEED opcode as Windows/macOS) — negate so +yaw pans camera-left
    // for both move-speed and move-angle.
    await this.sendVendor(encodePtzMoveSpeed(-yaw, pitch, roll).buildFrame(this.nextSeq()));
    if (autoStopMs > 0) {
      await new Promise((r) => setTimeout(r, autoStopMs));
      await this.sendVendor(encodePtzMoveSpeed(0, 0, 0).buildFrame(this.nextSeq()));
    }
  }

  /**
   * Recenter the gimbal via V4L2 pan_absolute=0, tilt_absolute=0.
   * Proven to physically recenter the gimbal (HW-verified 2026-07-19).
   */
  async gimbalRecenter(): Promise<void> {
    await Promise.all([
      this.camCtrlSet(0, 0, 2),
      this.camCtrlSet(1, 0, 2),
    ]);
  }

  nextSeq(): number {
    this.seq = this.seq >= 0xffff ? 1 : this.seq + 1;
    return this.seq;
  }

  async close(): Promise<void> {
    await this.helper.close();
  }
}
