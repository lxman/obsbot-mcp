// Pure helpers for the recording/preview subsystem: parse ffmpeg's dshow device
// listing and build the exact ffmpeg/ffplay argv arrays. No side effects.
export type CaptureSource = "device" | "virtual" | "ndi";

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
