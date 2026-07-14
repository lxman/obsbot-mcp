import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { CaptureManager, CaptureError, FfmpegMissingError } from "../../src/capture/manager.js";

const DEVICE_LIST = `
[dshow @ 0] "OBSBOT Tiny 2 StreamCamera" (video)
[dshow @ 0] "OBSBOT Virtual Camera" (video)
[dshow @ 0] "OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)" (audio)
`;

// A fake child process: EventEmitter with a writable stdin, a pid, a stderr
// stream (for the device probe), and a kill() that ends the process.
function makeFakeChild(pid: number) {
  const child: any = new EventEmitter();
  child.pid = pid;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); });
  return child;
}

// Fake spawn: the first ffmpeg -list_devices call emits the device list on
// stderr then exits; subsequent calls return a long-lived child.
function makeFakeSpawn() {
  const children: any[] = [];
  let pid = 1000;
  const spawn = vi.fn((cmd: string, args: string[]) => {
    const child = makeFakeChild(++pid);
    (child as any).spawnCmd = cmd;
    (child as any).spawnArgs = args;
    children.push(child);
    if (args.includes("-list_devices")) {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from(DEVICE_LIST));
        child.emit("close", 1);
      });
    }
    return child;
  });
  return { spawn, children };
}

function mkManager(over: Partial<{ hasBinary: (n: string) => boolean; existsSync: (p: string) => boolean }> = {}) {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new CaptureManager({
    spawn: spawn as any,
    clock: () => "2026-07-13T00:00:00.000Z",
    hasBinary: over.hasBinary ?? (() => true),
    fs: { existsSync: over.existsSync ?? (() => false), mkdirSync: vi.fn() },
  });
  return { mgr, spawn, children };
}

test("startRecord builds the ffmpeg command with the 60-min cap when no duration", async () => {
  const { mgr, spawn } = mkManager();
  const s = await mgr.startRecord({ source: "device", audio: true, outputPath: "C:\\x\\a.mp4" });
  expect(s.kind).toBe("record");
  expect(s.durationSec).toBe(3600);
  // 2 spawns: the probe, then ffmpeg.
  const ffmpegCall = spawn.mock.calls.find((c) => !c[1].includes("-list_devices"));
  expect(ffmpegCall![0]).toBe("ffmpeg");
  expect(ffmpegCall![1]).toContain("-t");
  expect(ffmpegCall![1][ffmpegCall![1].indexOf("-t") + 1]).toBe("3600");
  expect(ffmpegCall![1]).toContain("video=OBSBOT Tiny 2 StreamCamera:audio=OBSBOT Tiny2 Microphone (2- OBSBOT Tiny2 Audio)");
});

test("startRecord audio:false omits the audio input", async () => {
  const { mgr, spawn } = mkManager();
  await mgr.startRecord({ source: "device", audio: false, durationSec: 5, outputPath: "C:\\x\\b.mp4" });
  const ffmpegCall = spawn.mock.calls.find((c) => !c[1].includes("-list_devices"));
  expect(ffmpegCall![1]).toContain("video=OBSBOT Tiny 2 StreamCamera");
  expect(ffmpegCall![1].join(" ")).not.toContain("audio=");
});

test("startRecord throws CaptureError when the output file already exists", async () => {
  const { mgr } = mkManager({ existsSync: () => true });
  await expect(
    mgr.startRecord({ source: "device", audio: false, outputPath: "C:\\x\\exists.mp4" }),
  ).rejects.toBeInstanceOf(CaptureError);
});

test("startPreview spawns ffplay and tracks a preview session", async () => {
  const { mgr, spawn } = mkManager();
  const s = await mgr.startPreview({ source: "device" });
  expect(s.kind).toBe("preview");
  const playCall = spawn.mock.calls.find((c) => c[0] === "ffplay");
  expect(playCall![1]).toContain("-window_title");
  expect(mgr.list().map((x) => x.id)).toContain(s.id);
});

test("stop on a recording writes 'q' to ffmpeg stdin (graceful) and removes it", async () => {
  const { mgr, children } = mkManager();
  const s = await mgr.startRecord({ source: "device", audio: false, durationSec: 5, outputPath: "C:\\x\\c.mp4" });
  const ffmpeg = children.find((c) => c.spawnCmd === "ffmpeg" && !c.spawnArgs.includes("-list_devices"));
  // ffmpeg exits promptly after 'q'.
  queueMicrotask(() => ffmpeg.emit("exit", 0, null));
  const r = await mgr.stop(s.id);
  expect(ffmpeg.stdin.write).toHaveBeenCalledWith("q");
  expect(r).toMatchObject({ kind: "record", graceful: true });
  expect(mgr.list()).toHaveLength(0);
});

test("stop on a preview kills the process", async () => {
  const { mgr, children } = mkManager();
  const s = await mgr.startPreview({ source: "device" });
  const ffplay = children.find((c) => c.spawnCmd === "ffplay");
  const r = await mgr.stop(s.id);
  expect(ffplay.kill).toHaveBeenCalled();
  expect(r.kind).toBe("preview");
});

test("stop on an unknown id throws CaptureError", async () => {
  const { mgr } = mkManager();
  await expect(mgr.stop("nope")).rejects.toBeInstanceOf(CaptureError);
});

test("stopAll kills every tracked child", async () => {
  const { mgr, children } = mkManager();
  await mgr.startRecord({ source: "device", audio: false, durationSec: 5, outputPath: "C:\\x\\d.mp4" });
  await mgr.startPreview({ source: "device" });
  mgr.stopAll();
  const spawned = children.filter(
    (c) => (c.spawnCmd === "ffmpeg" || c.spawnCmd === "ffplay") && !c.spawnArgs.includes("-list_devices"),
  );
  for (const c of spawned) expect(c.kill).toHaveBeenCalled();
  expect(mgr.list()).toHaveLength(0);
});

test("missing ffmpeg throws FfmpegMissingError with install guidance", async () => {
  const { mgr } = mkManager({ hasBinary: () => false });
  await expect(
    mgr.startPreview({ source: "device" }),
  ).rejects.toBeInstanceOf(FfmpegMissingError);
});

test("a session is evicted from the list when its child exits on its own", async () => {
  const { mgr, children } = mkManager();
  const s = await mgr.startRecord({ source: "device", audio: false, durationSec: 5, outputPath: "C:\\x\\e.mp4" });
  expect(mgr.list().map((x) => x.id)).toContain(s.id);
  const ffmpeg = children.find((c) => c.spawnCmd === "ffmpeg" && !c.spawnArgs.includes("-list_devices"));
  ffmpeg.emit("exit", 0, null);
  await Promise.resolve(); // let the exit handler run
  expect(mgr.list()).toHaveLength(0);
});

test("a child 'error' evicts the session without throwing", async () => {
  const { mgr, children } = mkManager();
  const s = await mgr.startPreview({ source: "device" });
  const ffplay = children.find((c) => c.spawnCmd === "ffplay");
  expect(() => ffplay.emit("error", new Error("EACCES"))).not.toThrow();
  await Promise.resolve();
  expect(mgr.list().some((x) => x.id === s.id)).toBe(false);
});
