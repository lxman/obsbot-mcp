// Pure helpers for the recording/preview subsystem: parse the platform's device
// listing and build the exact ffmpeg/ffplay argv arrays. No side effects.
export type CaptureSource = "device" | "virtual" | "ndi";

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
