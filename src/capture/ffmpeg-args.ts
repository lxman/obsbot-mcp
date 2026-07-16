// Pure helpers for the recording/preview subsystem: parse ffmpeg's dshow
// (Windows), v4l2 (Linux), or avfoundation (macOS) device listing and build the
// exact ffmpeg/ffplay argv arrays. No side effects.

export type CaptureSource = "device" | "virtual" | "ndi";

// ── Windows (dshow) ────────────────────────────────────────────────────────

export interface DshowDevices {
  video: string[];
  audio: string[];
}

export interface V4l2DeviceInfo {
  path: string;
  card: string;
}
export interface V4l2Devices {
  video: V4l2DeviceInfo[];
  audio: string[];
}

export type DeviceList = DshowDevices | V4l2Devices;

// ---------- Windows (dshow) helpers ----------

// ffmpeg -f dshow -list_devices prints one line per device on stderr:
//   [dshow @ ..] "Friendly Name" (video)
export function parseDshowDevices(stderr: string): DshowDevices {
  const video: string[] = [];
  const audio: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/"(.+)" \((video|audio)\)\s*$/);
    if (!m) continue;
    if (m[2] === "video") video.push(m[1]);
    else audio.push(m[1]);
  }
  return { video, audio };
}

export function resolveVideoName(
  devices: DeviceList,
  source: CaptureSource,
): string | undefined {
  const isV4l = (d: DeviceList): d is V4l2Devices =>
    "video" in d && d.video.length > 0 && typeof d.video[0] !== "string";
  if (source === "virtual") {
    if (isV4l(devices)) {
      return devices.video.find((n) => /OBSBOT Virtual Camera/i.test(n.card))?.path;
    }
    return (devices as DshowDevices).video.find((n) => /OBSBOT Virtual Camera/i.test(n));
  }
  if (source === "ndi") {
    if (isV4l(devices)) {
      return devices.video.find((n) => /NDI Webcam/i.test(n.card))?.path;
    }
    return (devices as DshowDevices).video.find((n) => /NDI Webcam/i.test(n));
  }
  // Platform-specific device matching
  if (isV4l(devices)) {
    const found = devices.video.find((n) => /OBSBOT/i.test(n.card));
    return found ? found.path : undefined;
  }
  // dshow on Windows
  return (devices as DshowDevices).video.find(
    (n) => /OBSBOT Tiny 2/i.test(n) && !/Virtual/i.test(n),
  );
}

export function resolveAudioName(devices: DeviceList): string | undefined {
  if ("audio" in devices && Array.isArray((devices as DshowDevices).audio)) {
    return (devices as DshowDevices).audio.find((n) => /OBSBOT.*Mic/i.test(n));
  }
  // Linux v4l2 audio is typically a separate ALSA device
  // Return undefined — callers should check and warn
  return undefined;
}

// ---------- Linux (v4l2) helpers ----------
// ffmpeg -f v4l2 -list_formats all -i /dev/videoN lists formats on stderr.

/** Parse the v4l2 device name from `ffmpeg -f v4l2 -i /dev/videoN` stderr. */
export function parseV4l2DeviceName(stderr: string): string | undefined {
  // ffmpeg prints something like:
  //   [video4linux2,v4l2 @ 0x...] VideoDevice: /dev/videoN
  //   [video4linux2,v4l2 @ 0x...] driver       : uvcvideo
  //   [video4linux2,v4l2 @ 0x...] card         : OBSBOT Tiny 2 ...
  const m = stderr.match(/card\s+:\s+(.+)/);
  return m ? m[1].trim() : undefined;
}

export function buildRecordArgs(o: {
  videoName: string;
  audioName?: string;
  durationSec: number;
  outputPath: string;
}): string[] {
  const isV4l2 = o.videoName.startsWith("/dev/");
  if (isV4l2) {
    return [
      "-hide_banner", "-loglevel", "warning",
      "-f", "v4l2",
      "-i", o.videoName,
      ...(o.audioName ? ["-f", "alsa", "-i", o.audioName] : []),
      "-t", String(o.durationSec),
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      ...(o.audioName ? ["-c:a", "aac"] : []),
      "-y", o.outputPath,
    ];
  }
  // dshow path (Windows)
  const input = o.audioName
    ? `video=${o.videoName}:audio=${o.audioName}`
    : `video=${o.videoName}`;
  return [
    "-hide_banner", "-loglevel", "warning", "-f", "dshow",
    "-i", input,
    "-t", String(o.durationSec),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ...(o.audioName ? ["-c:a", "aac"] : []),
    "-y", o.outputPath,
  ];
}

export function buildPreviewArgs(o: { videoName: string }): string[] {
  const isV4l2 = o.videoName.startsWith("/dev/");
  if (isV4l2) {
    return [
      "-hide_banner", "-loglevel", "warning",
      "-f", "v4l2",
      "-input_format", "mjpeg",
      "-video_size", "1920x1080",
      "-i", o.videoName,
      "-window_title", "OBSBOT preview",
    ];
  }
  // dshow path
  return [
    "-hide_banner", "-loglevel", "warning", "-f", "dshow",
    "-i", `video=${o.videoName}`,
    "-window_title", "OBSBOT preview",
  ];
}

// ── macOS (avfoundation) ───────────────────────────────────────────────────

export interface AvfDevices {
  /** Device indices, keyed by display name (the name shown by ffmpeg). */
  video: Record<string, number>;
  audio: Record<string, number>;
}

// ffmpeg -f avfoundation -list_devices true -i ""  prints on stderr:
//   [AVFoundation indev @ 0x...] AVFoundation video devices:
//   [AVFoundation indev @ 0x...] [0] FaceTime HD Camera
//   [AVFoundation indev @ 0x...] [1] OBSBOT Tiny 2
//   [AVFoundation indev @ 0x...] AVFoundation audio devices:
//   [AVFoundation indev @ 0x...] [0] Built-in Microphone
//   [AVFoundation indev @ 0x...] [1] OBSBOT Tiny 2 Microphone
export function parseAvfDevices(stderr: string): AvfDevices {
  const video: Record<string, number> = {};
  const audio: Record<string, number> = {};
  let section: "video" | "audio" | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) { section = "video"; continue; }
    if (/AVFoundation audio devices/i.test(line)) { section = "audio"; continue; }
    if (!section) continue;
    const m = line.match(/\[\s*(\d+)\]\s+(.+)/);
    if (m) {
      const idx = parseInt(m[1], 10);
      const name = m[2].trim();
      if (section === "video") video[name] = idx;
      else audio[name] = idx;
    }
  }
  return { video, audio };
}

export function resolveAvfVideoName(
  devices: AvfDevices,
  source: CaptureSource,
): { name: string; index: number } | undefined {
  const names = Object.keys(devices.video);
  let match: string | undefined;
  if (source === "virtual") match = names.find((n) => /OBSBOT Virtual Camera/i.test(n));
  else if (source === "ndi") match = names.find((n) => /NDI Webcam/i.test(n));
  else match = names.find((n) => /OBSBOT/i.test(n) && !/Virtual/i.test(n));
  if (!match) return undefined;
  return { name: match, index: devices.video[match] };
}

export function resolveAvfAudioName(
  devices: AvfDevices,
): { name: string; index: number } | undefined {
  const entry = Object.entries(devices.audio).find(([name]) => /OBSBOT.*Mic/i.test(name));
  if (!entry) return undefined;
  return { name: entry[0], index: entry[1] };
}

export function buildAvfRecordArgs(o: {
  videoIndex: number;
  audioIndex?: number;
  durationSec: number;
  outputPath: string;
}): string[] {
  const input = o.audioIndex !== undefined
    ? `${o.videoIndex}:${o.audioIndex}`
    : `${o.videoIndex}`;
  return [
    "-hide_banner", "-loglevel", "warning", "-f", "avfoundation",
    "-i", input,
    "-t", String(o.durationSec),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ...(o.audioIndex !== undefined ? ["-c:a", "aac"] : []),
    "-y", o.outputPath,
  ];
}

export function buildAvfPreviewArgs(o: { videoIndex: number }): string[] {
  return [
    "-hide_banner", "-loglevel", "warning", "-f", "avfoundation",
    "-i", `${o.videoIndex}`,
    "-window_title", "OBSBOT preview",
  ];
}
