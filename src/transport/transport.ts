export interface Snapshot {
  mime: string;
  width: number;
  height: number;
  base64: string;
}

export interface SnapshotOpts {
  path?: string;
  maxDim?: number;
  quality?: number;
  settleMs?: number;
}

/** Thrown when a snapshot fails because another app holds the capture pin. */
export class CameraBusyError extends Error {
  constructor(message = "camera in use by another application") {
    super(message);
    this.name = "CameraBusyError";
  }
}

export interface ObsbotTransport {
  sendVendor(frame: Buffer): Promise<void>;
  /**
   * Send a vendor request frame (SET_CUR on the vendor selector) and read the
   * reply frame back (GET_CUR on the response selector). Returns the raw reply
   * bytes; callers parse with parseFrame.
   */
  recvVendor(frame: Buffer, length?: number): Promise<Buffer>;
  /**
   * Read the camera's flat status block via GET_CUR on the status selector
   * (no request frame is sent). Returns the raw block; callers use decodeStatus.
   */
  recvStatus(length?: number): Promise<Buffer>;
  /** Send a raw payload to an arbitrary UVC extension-unit selector (e.g. FOV/HDR on selector 6). */
  xuRaw(selector: number, data: Buffer): Promise<void>;
  /** RE/diagnostics: GET_CUR read `length` bytes from an arbitrary XU selector (no request frame sent). */
  xuGetRaw(selector: number, length: number): Promise<Buffer>;
  zoomRange(): Promise<{ min: number; max: number }>;
  zoomSet(units: number): Promise<void>;
  /** Grab one still frame (grab-and-release). Throws CameraBusyError if the pin is busy. */
  snapshot(opts: SnapshotOpts): Promise<Snapshot>;
  /** IAMCameraControl::Set(property, value, flags) — used for focus. */
  camCtrlSet(property: number, value: number, flags: number): Promise<void>;
  /** IAMCameraControl::GetRange(property) → device-unit min/max. */
  camCtrlRange(property: number): Promise<{ min: number; max: number }>;
  /** Read the current value + flags of an IAMCameraControl property (GET_CUR). */
  camCtrlGet(property: number): Promise<{ value: number; flags: number }>;
  /** IAMVideoProcAmp::Set(property, value, flags) — used for white balance. */
  procAmpSet(property: number, value: number, flags: number): Promise<void>;
  /** IAMVideoProcAmp::GetRange(property) → device-unit min/max. */
  procAmpRange(property: number): Promise<{ min: number; max: number }>;
  /**
   * Move the gimbal to an absolute yaw/pitch angle in degrees. Positive yaw =
   * camera's left; positive pitch = tilt down.
   * Platform note: Linux uses V4L2 pan_absolute/tilt_absolute (proven to move
   * the physical gimbal and keep V4L2 readback working). Windows/macOS use
   * vendor V3 frames (AI_SET_GIM_MOTOR_DEG).
   */
  gimbalSet(yawDeg: number, pitchDeg: number, rollDeg?: number): Promise<void>;
  /**
   * Drive the gimbal at a yaw/pitch speed (platform-specific units), then
   * automatically stop after autoStopMs. Positive yaw = camera's left.
   * Platform note: Linux approximates by converting speed × duration to an
   * absolute V4L2 pan_absolute/tilt_absolute move. Windows/macOS use vendor
   * V3 frames (AI_SET_GIM_SPEED).
   */
  gimbalSpeed(yaw: number, pitch: number, roll: number, autoStopMs: number): Promise<void>;
  /** Recenter the gimbal to yaw=0, pitch=0. */
  gimbalRecenter(): Promise<void>;
  nextSeq(): number;
  close(): Promise<void>;
}
