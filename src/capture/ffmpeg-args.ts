// Pure helpers for the recording/preview subsystem: parse ffmpeg's dshow
// (Windows) or avfoundation (macOS) device listing and build the exact
// ffmpeg/ffplay argv arrays. No side effects.

export type CaptureSource = "device" | "virtual" | "ndi";

// ── Windows (dshow) ────────────────────────────────────────────────────────

export interface DshowDevices {
  video: string[];
  audio: string[];
}

// ffmpeg -f dshow -list_devices prints one line per device on stderr:
//   [dshow @ ..] "Friendly Name" (video)
// The name is the first quoted span; the trailing "(video)"/"(audio)" is the type.
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
  devices: DshowDevices,
  source: CaptureSource,
): string | undefined {
  if (source === "virtual") return devices.video.find((n) => /OBSBOT Virtual Camera/i.test(n));
  if (source === "ndi") return devices.video.find((n) => /NDI Webcam/i.test(n));
  return devices.video.find((n) => /OBSBOT Tiny 2/i.test(n) && !/Virtual/i.test(n));
}

export function resolveAudioName(devices: DshowDevices): string | undefined {
  return devices.audio.find((n) => /OBSBOT.*Mic/i.test(n));
}

export function buildRecordArgs(o: {
  videoName: string;
  audioName?: string;
  durationSec: number;
  outputPath: string;
}): string[] {
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
