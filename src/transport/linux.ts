import { HelperProcess } from "./helper-process.js";
import { ObsbotTransport, Snapshot, SnapshotOpts } from "./transport.js";
import { encodePtzMoveSpeed } from "../codec/commands.js";
import { readSerialVia } from "./read-serial.js";

const VENDOR_XU_SELECTOR = 0x02;
// Unproven per-command reply path — reads back zeros. See the WindowsTransport
// comment for the 2026-07-19 hardware sweep: sel 6 returns the status block (not
// a reply), and preset read-back lives on flat selectors 12/13 instead.
const RESPONSE_SELECTOR = 0x02;
const DEFAULT_REPLY_LEN = 60;
const STATUS_SELECTOR = 0x06;
const STATUS_BLOCK_LEN = 60;
// V4L2_CID_PAN_ABSOLUTE/TILT_ABSOLUTE map directly to the UVC CT_PANTILT_ABSOLUTE
// control (Camera Terminal, selector 0x0D), whose unit is arc-seconds per both the
// UVC and V4L2 specs — confirmed on hardware: pan range ±468000 / tilt ±324000,
// step 3600, i.e. exactly ±130°/±90° at 3600 units per degree. A prior version of
// this file divided by 1000 (mislabeled as "millidegrees"), which was wrong by a
// factor of 3.6x on both the read and write side — self-consistently wrong, since
// gimbalSet and camCtrlGet shared the same bad divisor, so a move-then-read check
// always reported 0 error while the true physical angle was ~28% of what was asked
// for.
const ARCSEC_PER_DEG = 3600;

/**
 * Linux V4L2 transport — functionally identical to {@link WindowsTransport}
 * because both delegate to the native helper process over the same JSON-RPC
 * stdio protocol. The selector constants are camera-side constants (the UVC
 * Extension Unit), not OS constants, so they are shared.
 *
 * Key difference: gimbal absolute movement uses V4L2 pan_absolute/tilt_absolute
 * (hardware-verified to physically move the gimbal, repeatedly, 2026-07-21),
 * NOT vendor V3 frames. camCtrlGet for pan/tilt reads back the same V4L2
 * controls — this is the last-*commanded* value, not a live in-flight
 * reading: VIDIOC_QUERY_EXT_CTRL reports these controls as non-volatile on
 * this kernel, so V4L2 core serves its own cache rather than re-querying the
 * device. Getting a genuinely live reading requires a raw USB read with the
 * kernel driver briefly detached, which conflicts with any concurrent video
 * capture (preview/recording) and was deliberately dropped from the shipped
 * transport for that reason — see README's Linux limitations section. A
 * kernel patch marking these controls volatile would fix this at the source;
 * until then, gimbal moves on Linux are open-loop, same as the position read.
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
    // Convert V4L2 arc-seconds → degrees for pan/tilt to match Windows convention
    if (property === 0 || property === 1) {
      result.min = Math.round(result.min / ARCSEC_PER_DEG);
      result.max = Math.round(result.max / ARCSEC_PER_DEG);
    }
    return result;
  }

  async camCtrlGet(property: number): Promise<{ value: number; flags: number }> {
    const result = await this.helper.camCtrlGet(property);
    // V4L2 pan_absolute/tilt_absolute return arc-seconds, but the rest of
    // the codebase expects degrees (Windows DirectShow convention). This is
    // the last-commanded value, not a live reading — see the class comment.
    //
    // Degrees as a float, NOT rounded. UVC specifies CT_PANTILT_ABSOLUTE in
    // arc-seconds, but this device's GET_RES is 3600 asec = 1 degree
    // (PROTOCOL.md's CT_PANTILT_ABSOLUTE table, tiny2_specification.md
    // section 2.1) and the firmware streams whole-degree steps — the device
    // never emits a fraction, so rounding here would not recover any
    // precision the hardware actually has. What NOT rounding preserves is
    // precision on Linux SPECIFICALLY: uvcvideo caches this control and
    // returns the value our own gimbalSet last wrote (round(deg *
    // ARCSEC_PER_DEG)), so a fractional COMMANDED pose (e.g. from
    // aimAtPixel's composed target) survives this round trip instead of being
    // flattened to an integer here. It costs nothing either way, and avoids
    // re-introducing a lossy step if a future device or firmware reports
    // finer than a degree. The RANGE above still rounds: min/max are
    // advertised bounds, not a live pose, and no arithmetic accumulates on
    // them.
    if (property === 0 || property === 1) {
      result.value = result.value / ARCSEC_PER_DEG;
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
   * Move the gimbal using V4L2 pan_absolute/tilt_absolute (arc-seconds).
   * Hardware-verified to physically move the gimbal (2026-07-21, repeated
   * across many absolute targets). Unlike vendor V3 frames, V4L2 writes keep
   * camCtrlGet's echo in sync with what was actually commanded.
   *
   * Sign convention: V4L2 pan_absolute + = camera's left (matches our yaw sign).
   * V4L2 tilt_absolute + = tilt up (opposite of our +pitch = down convention).
   */
  async gimbalSet(yawDeg: number, pitchDeg: number, _rollDeg?: number): Promise<void> {
    await this.panTiltAbsolute(
      Math.round(yawDeg * ARCSEC_PER_DEG),
      Math.round(-pitchDeg * ARCSEC_PER_DEG),
    );
  }

  /**
   * Commit an absolute pan+tilt pose (V4L2 arc-seconds) in a single ioctl.
   *
   * The two axes are ONE UVC control (CT_PANTILT_ABSOLUTE, 8 bytes) that
   * uvcvideo exposes as two V4L2 controls, so a write naming a single axis
   * read-modify-writes the other from a source chosen by the device's GET_INFO
   * bits. When that source is a live GET_CUR, it is sampled while the first
   * axis is still travelling and commits that axis back to where it started —
   * the move is silently half-cancelled. This code used to issue two parallel
   * `camCtrlSet` calls and hit exactly that: measured on this camera whenever
   * uvcvideo probed it asleep and pan/tilt kept UVC_CTRL_FLAG_AUTO_UPDATE.
   * Full writeup in UVCVIDEO-LINUX-POSITION-2026-07-21.md sections 4.1 and 9.
   *
   * Sending both axes together makes the hazard unreachable rather than
   * unlikely, and needs nothing from the pending kernel patch — it is a fix on
   * stock kernels.
   *
   * The fallback keeps older helper binaries working: `pantilt_set` is newer
   * than the rest of the stdio surface, and a user whose npm package updated
   * without the native helper being rebuilt would otherwise lose gimbal
   * movement entirely. Degraded, not broken — the old path still moves the
   * gimbal, it just carries the cancellation risk it always did.
   */
  private async panTiltAbsolute(panAsec: number, tiltAsec: number): Promise<void> {
    try {
      await this.helper.panTiltSet(panAsec, tiltAsec);
    } catch (err) {
      if (!/unknown op/i.test(err instanceof Error ? err.message : String(err))) throw err;
      await Promise.all([this.camCtrlSet(0, panAsec, 2), this.camCtrlSet(1, tiltAsec, 2)]);
    }
  }

  /**
   * Drive the gimbal at a speed for a duration, using vendor-frame velocity
   * protocol (fire-and-forget, no position readback). Not reachable from the
   * Linux tool surface (obsbot_gimbal_move_speed is hidden on this platform):
   * without a live position reading there is no way to confirm a speed burst
   * stays within the gimbal's mechanical range before it gets there, unlike
   * gimbalSet's absolute target, which can be clamped up front regardless of
   * current position. Kept implemented here for ObsbotTransport conformance
   * and for any future internal use once live feedback exists.
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
   * Hardware-verified to physically recenter the gimbal (2026-07-21).
   */
  async gimbalRecenter(): Promise<void> {
    // Same single-ioctl path as gimbalSet — recentring is two axes moving at
    // once, which is precisely the shape the read-modify-write can cancel.
    await this.panTiltAbsolute(0, 0);
  }

  async readSerial(): Promise<string> {
    return readSerialVia(this);
  }

  nextSeq(): number {
    this.seq = this.seq >= 0xffff ? 1 : this.seq + 1;
    return this.seq;
  }

  async close(): Promise<void> {
    await this.helper.close();
  }
}
