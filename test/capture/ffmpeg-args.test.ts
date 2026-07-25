import { expect, test } from "vitest";
import {
  parseDshowDevices, resolveVideoName, resolveAudioName,
  buildRecordArgs, buildPreviewArgs,
} from "../../src/capture/ffmpeg-args.js";

const SAMPLE = `
[dshow @ 000] "NDI Webcam Video 1" (video)
[dshow @ 000]   Alternative name "@device:pnp:\\\\?\\..."
[dshow @ 000] "OBSBOT Tiny 2 StreamCamera" (video)
[dshow @ 000] "OBSBOT Virtual Camera" (video)
[dshow @ 000] "OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)" (audio)
`;

test("parseDshowDevices splits video and audio names (name may contain parens)", () => {
  const d = parseDshowDevices(SAMPLE);
  expect(d.video).toEqual([
    "NDI Webcam Video 1", "OBSBOT Tiny 2 StreamCamera", "OBSBOT Virtual Camera",
  ]);
  expect(d.audio).toEqual(["OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)"]);
});

test("resolveVideoName picks the right source and excludes Virtual for 'device'", () => {
  const d = parseDshowDevices(SAMPLE);
  expect(resolveVideoName(d, "device")).toBe("OBSBOT Tiny 2 StreamCamera");
  expect(resolveVideoName(d, "virtual")).toBe("OBSBOT Virtual Camera");
  expect(resolveVideoName(d, "ndi")).toBe("NDI Webcam Video 1");
});

test("resolveAudioName finds the OBSBOT mic", () => {
  const d = parseDshowDevices(SAMPLE);
  expect(resolveAudioName(d)).toBe("OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)");
});

test("buildRecordArgs: video+audio, with duration and codecs", () => {
  expect(buildRecordArgs({
    videoName: "OBSBOT Tiny 2 StreamCamera",
    audioName: "OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)",
    durationSec: 10,
    outputPath: "C:\\Videos\\OBSBOT\\clip.mp4",
  })).toEqual([
    "-hide_banner", "-loglevel", "warning", "-f", "dshow",
    "-i", "video=OBSBOT Tiny 2 StreamCamera:audio=OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)",
    "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-y", "C:\\Videos\\OBSBOT\\clip.mp4",
  ]);
});

test("buildRecordArgs: video only omits audio input and audio codec", () => {
  expect(buildRecordArgs({
    videoName: "OBSBOT Tiny 2 StreamCamera", durationSec: 3600,
    outputPath: "out.mp4",
  })).toEqual([
    "-hide_banner", "-loglevel", "warning", "-f", "dshow",
    "-i", "video=OBSBOT Tiny 2 StreamCamera",
    "-t", "3600", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", "out.mp4",
  ]);
});

// The preview exists for a human to watch the gimbal move, so smooth motion is
// its whole point. Left to negotiate, dshow picks 1080p30 — but the Tiny 2
// advertises mjpeg 1920x1080 up to 60fps (confirmed 2026-07-25 via
// `ffmpeg -list_options`, and the 60fps stream verified to actually sustain 60).
// Pinning the codec is what makes 60 reachable: yuyv422 caps at 30 for 1080p, so
// without -vcodec the negotiation can land on a format that cannot do 60.
test("buildPreviewArgs asks for 1080p60 mjpeg, not the negotiated 30fps default", () => {
  expect(buildPreviewArgs({ videoName: "OBSBOT Tiny 2 StreamCamera" })).toEqual([
    "-hide_banner", "-loglevel", "warning", "-f", "dshow",
    "-framerate", "60", "-video_size", "1920x1080", "-vcodec", "mjpeg",
    "-i", "video=OBSBOT Tiny 2 StreamCamera", "-window_title", "OBSBOT preview",
  ]);
});

test("the v4l2 preview asks for 60fps too", () => {
  const args = buildPreviewArgs({ videoName: "/dev/video0" });
  expect(args).toContain("-framerate");
  expect(args[args.indexOf("-framerate") + 1]).toBe("60");
  // v4l2 already pinned the codec and size; framerate was the one missing piece.
  expect(args).toContain("mjpeg");
  expect(args).toContain("1920x1080");
});
