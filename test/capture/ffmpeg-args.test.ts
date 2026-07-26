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

// The mjpeg/60 pin above is a fact about the Tiny 2's own capture pin, NOT about
// video sources in general. Neither alternative feed offers mjpeg at all — OBSBOT
// Center's virtual camera advertises nv12/yuv420p/yuyv422, and the NDI Webcam
// devices advertise UYVY only — so pinning it there does not merely fail to buy
// 60fps, it fails to open the device: ffmpeg reports "Could not set video
// options" and the preview never starts. Verified against both on 2026-07-25.
// Let those negotiate instead; smooth motion is worth pinning for only when the
// pin is achievable.
test("preview does not pin the Tiny 2's codec onto sources that cannot offer it", () => {
  for (const source of ["virtual", "ndi"] as const) {
    const args = buildPreviewArgs({ videoName: "OBSBOT Virtual Camera", source });
    expect(args).not.toContain("mjpeg");
    expect(args).not.toContain("-vcodec");
    // The device must still be opened, and the window still labelled.
    expect(args).toContain("video=OBSBOT Virtual Camera");
    expect(args).toContain("-window_title");
  }
});

test("preview still pins mjpeg/60 for the device source, including by default", () => {
  const explicit = buildPreviewArgs({ videoName: "OBSBOT Tiny 2 StreamCamera", source: "device" });
  const defaulted = buildPreviewArgs({ videoName: "OBSBOT Tiny 2 StreamCamera" });
  expect(explicit).toEqual(defaulted);
  expect(defaulted).toContain("mjpeg");
  expect(defaulted[defaulted.indexOf("-framerate") + 1]).toBe("60");
});
