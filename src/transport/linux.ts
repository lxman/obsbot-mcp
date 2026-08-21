import { HelperProcess } from "./helper-process.js";
import { ObsbotTransport, Snapshot, SnapshotOpts, livePoseOverride } from "./transport.js";
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

// Closed-loop move verification (OBSBOT_LIVE_POSE only) — see panTiltAbsolute.
// The device's GET_RES for CT_PANTILT_ABSOLUTE is one degree and it routinely
// lands one step short of a commanded target (measured 2026-08-21: -324000 asec
// commanded, -320400 reached, repeatably), so "on target" is within one step.
const PANTILT_STEP_ASEC = 3600;
// A slew starts within ~150ms of the commit and a 90° pan takes ~1.7s; the first
// settle read waits out the dead zone so two agreeing reads mean "stopped", not
// "not started yet".
const SETTLE_FIRST_READ_MS = 250;
const SETTLE_BEAT_MS = 150;
const SETTLE_TIMEOUT_MS = 3000;

// Read-latency threshold (microseconds) separating a CACHED pan/tilt read from a
// LIVE one. Measured 2026-08-21 on this camera: cached reads are a driver memcpy
// at ~2us and pinned flat; live reads are a USB GET_CUR at ~150us and never below
// ~115us. 40us sits ~20x above the cached ceiling and ~3x below the live floor —
// orders of magnitude of margin either way. See do_read_latency in
// native/linux/helper.c and LinuxTransport.livePoseReads.
const LIVE_READ_THRESHOLD_US = 40;

/**
 * Linux V4L2 transport — functionally identical to {@link WindowsTransport}
 * because both delegate to the native helper process over the same JSON-RPC
 * stdio protocol. The selector constants are camera-side constants (the UVC
 * Extension Unit), not OS constants, so they are shared.
 *
 * Key difference: gimbal absolute movement uses V4L2 pan_absolute/tilt_absolute
 * (hardware-verified to physically move the gimbal, repeatedly, 2026-07-21),
 * NOT vendor V3 frames. camCtrlGet for pan/tilt reads back the same V4L2
 * controls.
 *
 * WHAT THAT READ MEANS DEPENDS ON THE KERNEL, and callers must tolerate both:
 *
 *   - Stock uvcvideo: the last-*commanded* value. This camera's GET_INFO is a
 *     stub reporting GET|SET only, which strips the UVC_CTRL_FLAG_AUTO_UPDATE
 *     that uvcvideo's own control table sets for CT_PANTILT_ABSOLUTE. Nothing
 *     then clears ctrl->loaded, so the cache is served forever. Verified
 *     2026-08-21: with the camera physically moved by hand, an unpatched driver
 *     kept reporting the stale pose indefinitely.
 *   - uvcvideo carrying the AUTO_UPDATE fixup for 3564:fef8, or the pending
 *     volatile patch: a genuinely LIVE position, tracking motion the host never
 *     commanded. Verified the same day against hand-moved poses on both axes.
 *
 * Neither is detectable from userspace: the fixup restores AUTO_UPDATE without
 * advertising V4L2_CTRL_FLAG_VOLATILE, so QUERY_EXT_CTRL reports these controls
 * as non-volatile in BOTH cases. Do not branch on that flag. Code that composes
 * a new absolute target from the current pose must instead settle first — see
 * readSteadyPose in mcp/tools.ts — which is correct under either kernel. Moves
 * themselves are closed-loop when OBSBOT_LIVE_POSE is set: see panTiltAbsolute.
 *
 * The old raw-USB alternative (detach the driver, read directly) is still
 * unnecessary and still conflicts with concurrent capture; see README's Linux
 * limitations section.
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
    // the codebase expects degrees (Windows DirectShow convention). Whether
    // this is a commanded echo or a live position depends on the kernel — see
    // the class comment.
    //
    // Degrees as a float, NOT rounded. UVC specifies CT_PANTILT_ABSOLUTE in
    // arc-seconds, but this device's GET_RES is 3600 asec = 1 degree
    // (PROTOCOL.md's CT_PANTILT_ABSOLUTE table, tiny2_specification.md
    // section 2.1) and the firmware streams whole-degree steps — the device
    // never emits a fraction, so rounding here would not recover any
    // precision the hardware actually has.
    //
    // On a stock kernel this additionally preserves a fractional COMMANDED
    // pose: the read is an echo of what gimbalSet last wrote (round(deg *
    // ARCSEC_PER_DEG)), so e.g. aimAtPixel's composed target survives the round
    // trip instead of being flattened here. On a kernel that reports live
    // position that benefit is gone — the device answers in whole degrees — but
    // not rounding is still the right default: it costs nothing, and it avoids
    // re-introducing a lossy step if a future device or firmware reports finer
    // than a degree. Callers must not read sub-degree agreement between a
    // commanded pose and a subsequent read as meaningful; the hardware readout
    // is ±1° and, live, lands up to a full step short (measured 2026-08-21:
    // commanding -108000 asec settled at -104400).
    //
    // The RANGE above still rounds: min/max are advertised bounds, not a live
    // pose, and no arithmetic accumulates on them.
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
    await this.commitPanTilt(panAsec, tiltAsec);
    if (!(await this.livePoseReads())) return;

    /*
     * Closed loop, Linux only, behind OBSBOT_LIVE_POSE.
     *
     * This camera intermittently moves ONE axis to a previously commanded pose
     * instead of the one just sent. Observed eight times on 2026-08-21, never
     * with a host-side cause: the kernel-traced SET_CUR payload was correct on
     * every occurrence, the helper's pan/tilt repair path never fired, and
     * uvcvideo's restore-on-resume never ran (it is reset-resume only). The
     * trigger was not found — 5/5 in one soak, then 0/54 across every variant
     * isolated from it (zero-delta, post-wake, interrupted slew, USB autosuspend
     * on/off). It lands on a previously commanded value, and re-sending the
     * target corrects it (15/15 when provoked).
     *
     * On a stock kernel this is invisible: the read echoes the command while the
     * gimbal sits elsewhere, so there is nothing to act on and this is gated
     * off. With live reads it is detectable, so: settle, compare, re-send ONCE.
     * Once, not a loop — a firmware that keeps fighting should lose loudly, via
     * the caller's own settle (readSteadyPose) reporting where it really is.
     * The retry is also not pre-emptive (no blind 1° nudge on every move): the
     * fault fires a few times an hour at most, and an honest miss is better
     * than a permanent tax on every move.
     */
    const landed = await this.settlePanTilt();
    if (landed && this.onTarget(landed, panAsec, tiltAsec)) return;
    this.moveRetryCount++;
    await this.commitPanTilt(panAsec, tiltAsec);
    await this.settlePanTilt();
  }

  /** Number of closed-loop re-sends this transport has issued. Diagnostics/tests. */
  get moveRetries(): number {
    return this.moveRetryCount;
  }
  private moveRetryCount = 0;

  /**
   * Whether this kernel's uvcvideo serves pan/tilt reads LIVE from the device
   * rather than from its own cache — the condition under which the pose-settle
   * and move-retry paths are correct and useful.
   *
   * OBSBOT_LIVE_POSE forces the answer either way. Unset, we PROBE: time a batch
   * of GET_CUR reads in the helper and compare the mean to LIVE_READ_THRESHOLD_US.
   * This detects the actual behaviour (are reads live) rather than a flag or a
   * kernel version, so it fires for Ricardo's AUTO_UPDATE quirk (which advertises
   * nothing), for the volatile patch, and for any future fix alike — and it is
   * immune to the stable-backport and distro-versioning traps that make a
   * uname-based gate wrong on exactly the kernels most users run.
   *
   * Cached for the transport's lifetime: the kernel does not change under us, and
   * the probe reads the device a few dozen times. A probe failure (an older
   * helper with no read_latency op, or an unreadable control) resolves to the
   * override, or false — degrading to today's shipped behaviour, never throwing.
   */
  livePoseReads(): Promise<boolean> {
    return (this.livePoseReadsCache ??= this.detectLivePoseReads());
  }
  private livePoseReadsCache?: Promise<boolean>;

  private async detectLivePoseReads(): Promise<boolean> {
    const override = livePoseOverride();
    if (override !== undefined) return override;
    try {
      const { meanUs } = await this.helper.readLatency(0);
      return meanUs >= LIVE_READ_THRESHOLD_US;
    } catch {
      return false;
    }
  }

  private async commitPanTilt(panAsec: number, tiltAsec: number): Promise<void> {
    try {
      await this.helper.panTiltSet(panAsec, tiltAsec);
    } catch (err) {
      if (!/unknown op/i.test(err instanceof Error ? err.message : String(err))) throw err;
      await Promise.all([this.camCtrlSet(0, panAsec, 2), this.camCtrlSet(1, tiltAsec, 2)]);
    }
  }

  private onTarget([pan, tilt]: [number, number], panAsec: number, tiltAsec: number): boolean {
    return Math.abs(pan - panAsec) <= PANTILT_STEP_ASEC && Math.abs(tilt - tiltAsec) <= PANTILT_STEP_ASEC;
  }

  /** Raw arc-seconds straight from the helper — no degree conversion, no rounding. */
  private async readPanTilt(): Promise<[number, number]> {
    const [p, t] = await Promise.all([this.helper.camCtrlGet(0), this.helper.camCtrlGet(1)]);
    return [p.value, t.value];
  }

  /**
   * Wait until two consecutive pan/tilt reads agree within one step on both
   * axes, i.e. the gimbal has stopped. Returns the settled pose, or null if it
   * was still moving at the deadline. Read failures propagate: a move we cannot
   * verify should surface, not be silently declared done.
   */
  private async settlePanTilt(): Promise<[number, number] | null> {
    const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    await nap(SETTLE_FIRST_READ_MS);
    let last = await this.readPanTilt();
    for (;;) {
      await nap(SETTLE_BEAT_MS);
      const next = await this.readPanTilt();
      if (this.onTarget(next, last[0], last[1])) return next;
      last = next;
      if (Date.now() >= deadline) return null;
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
