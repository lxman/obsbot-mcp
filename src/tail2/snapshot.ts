import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Pull one still frame from a Tail 2's video output with ffmpeg.
 *
 * Primary source: the camera's SRT listener (the one streaming output this
 * firmware actually serves; TAIL2-PROTOCOL.md §9) — requires Center's SRT
 * toggle, exclusive with NDI. Because that toggle is a human-in-the-GUI step
 * and this server is driven by AI agents that should stay autonomous, the
 * fallback layer grabs from the NDI Tools "NDI Webcam" DirectShow device
 * instead (Windows only): if the bridge is running and pointed at the
 * camera's NDI feed, ffmpeg can read it directly and no Center trip is
 * needed. When neither source is live, `snapshotOptions()` reports what it
 * found and what each path costs, so the calling agent can pick.
 *
 * Note Center only allows changing streaming settings while the output is
 * OFF, so probes landing in a configuration window see a dead port — not a
 * startup delay (an earlier "minutes to bind" claim here was wrong and is
 * retracted).
 */
export interface SrtSnapshotOpts {
  maxDim?: number;
  quality?: number;
  port?: number;
  streamId?: string;
  /** Socket I/O budget for ffmpeg, ms. Generous: SRT handshake + first keyframe. */
  timeoutMs?: number;
}

export interface SrtSnapshot {
  mime: string;
  width: number;
  height: number;
  base64: string;
}

export class SrtNotEnabledError extends Error {
  constructor() {
    super(
      "the Tail 2's SRT output is not enabled. In OBSBOT Center switch the " +
        "camera's streaming output to SRT (listener mode) first — note this " +
        "disables NDI while active and does not survive a camera reboot. The " +
        "listener serves immediately once enabled.",
    );
    this.name = "SrtNotEnabledError";
  }
}

const JPEG_SOI = 0xffd8;

/** Parse width/height out of a JPEG's SOF0/SOF2 marker (avoids a second ffprobe). */
const jpegDims = (buf: Buffer): { width: number; height: number } | null => {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
};

export async function srtSnapshot(
  host: string,
  opts: SrtSnapshotOpts = {},
  spawnImpl: typeof spawn = spawn,
): Promise<SrtSnapshot> {
  const maxDim = Math.round(opts.maxDim ?? 640);
  const quality = Math.round(opts.quality ?? 80);
  const port = opts.port ?? 5000;
  const streamId = opts.streamId ?? "mainstream";
  const timeoutMs = opts.timeoutMs ?? 20000;

  const url = `srt://${host}:${port}?mode=caller&latency=120&streamid=${streamId}`;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-rw_timeout", String(timeoutMs * 1000),
    "-i", url,
    "-frames:v", "1",
    "-vf", `scale='min(${maxDim},iw)':-2`,
    "-q:v", String(Math.max(2, Math.min(31, Math.round(31 - (quality * 29) / 100)))),
    "-f", "image2", "-",
  ];
  return new Promise<SrtSnapshot>((resolve, reject) => {
    const child = spawnImpl("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`SRT snapshot timed out after ${timeoutMs + 5000}ms — SRT is likely off or mid-configuration in Center (settings changes require the output to be off). Re-enable it and retry.`));
    }, timeoutMs + 5000);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg is required for Tail 2 snapshots and failed to run: ${e.message}. Install it (winget install Gyan.FFmpeg) and retry.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const jpg = Buffer.concat(chunks);
      if (code !== 0 || jpg.length < 4 || jpg.readUInt16BE(0) !== JPEG_SOI) {
        reject(new Error(`SRT snapshot failed (ffmpeg exit ${code}): ${stderr.slice(0, 300) || "no frame"}`));
        return;
      }
      const dims = jpegDims(jpg);
      resolve({
        mime: "image/jpeg",
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
        base64: jpg.toString("base64"),
      });
    });
  });
}

/**
 * Grab a frame from the NDI Tools "NDI Webcam" DirectShow device (Windows
 * only). NOT used by the snapshot tool automatically: on the reference
 * machine (2026-09-26) the bridge's user-configured output slots delivered
 * uniformly black frames to ffmpeg (YAVG=YMAX=16) while other slots hung,
 * and probing the devices disrupts the app. Kept for manual/verified use —
 * if a slot is confirmed live (e.g. previews correctly in OBS), this works.
 * Never force-kill the Webcam app: that corrupts its output-slot config.
 */
export async function ndiWebcamSnapshot(
  opts: { maxDim?: number; quality?: number; timeoutMs?: number } = {},
  spawnImpl: typeof spawn = spawn,
): Promise<SrtSnapshot | null> {
  if (process.platform !== "win32") return null;
  // The virtual devices stay registered even when the bridge app is closed
  // (and list four slots whose signal-bearing one varies across restarts —
  // measured 2026-09-26), so without the app running an attempt is just a
  // guaranteed hang. Guard on the process first.
  const running = await new Promise<boolean>((resolve) => {
    const child = spawnImpl("tasklist", ["/FI", "IMAGENAME eq Webcam.exe", "/NH"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", () => { clearTimeout(timer); resolve(/webcam\.exe/i.test(out)); });
  });
  if (!running) return null;
  const maxDim = Math.round(opts.maxDim ?? 640);
  const quality = Math.round(opts.quality ?? 80);
  const timeoutMs = opts.timeoutMs ?? 15000;

  // Enumerate DirectShow video devices; find the NDI Webcam bridge.
  const listed = await new Promise<string>((resolve) => {
    let out = "";
    const child = spawnImpl("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill(); resolve(""); }, 10000);
    child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
  const m = /"([^"]*NDI Webcam[^"]*)"/i.exec(listed);
  if (!m) return null;
  const device = m[1]!;

  return new Promise<SrtSnapshot | null>((resolve) => {
    const child = spawnImpl("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-rtbufsize", "100M",
      "-f", "dshow", "-i", `video=${device}`,
      "-frames:v", "1",
      "-vf", `scale='min(${maxDim},iw)':-2`,
      "-q:v", String(Math.max(2, Math.min(31, Math.round(31 - (quality * 29) / 100)))),
      "-f", "image2", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const jpg = Buffer.concat(chunks);
      if (jpg.length < 4 || jpg.readUInt16BE(0) !== JPEG_SOI) {
        resolve(null);
        return;
      }
      const dims = jpegDims(jpg);
      resolve({
        mime: "image/jpeg",
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
        base64: jpg.toString("base64"),
      });
    });
  });
}

/** Standard NDI Tools install location, for the options report. */
export const NDI_WEBCAM_EXE = "C:\\Program Files\\NDI\\NDI 6 Tools\\Webcam\\Webcam.exe";

export const ndiToolsInstalled = (): boolean => existsSync(NDI_WEBCAM_EXE);
