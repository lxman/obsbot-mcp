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

test("buildPreviewArgs opens a titled ffplay window", () => {
  expect(buildPreviewArgs({ videoName: "OBSBOT Tiny 2 StreamCamera" })).toEqual([
    "-hide_banner", "-loglevel", "warning", "-f", "dshow",
    "-i", "video=OBSBOT Tiny 2 StreamCamera", "-window_title", "OBSBOT preview",
  ]);
});
