import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { srtSnapshot, SrtNotEnabledError } from "../../src/tail2/snapshot.js";
import type { SrtSnapshot } from "../../src/tail2/snapshot.js";

/**
 * The snapshot module is a disciplined ffmpeg wrapper: tests fake the child
 * process (happy path emits a minimal JPEG, failure paths exercise the error
 * contracts callers rely on), because the SRT negotiation itself was
 * hardware-verified separately (2026-09-26, TAIL2-PROTOCOL.md §9).
 */

// Minimal valid JPEG: SOI + SOF0 (w x h) + EOI.
const miniJpeg = (w: number, h: number): Buffer => {
  const sof = Buffer.alloc(17);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(15, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
};

interface FakeOpts {
  code: number;
  stdout: Buffer;
  stderr?: string;
  onSpawn?: (args: string[]) => void;
}

/** A spawn() double producing a scriptable child. */
const fakeSpawn =
  (o: FakeOpts) =>
  ((_cmd: string, args: string[]) => {
    o.onSpawn?.(args);
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as Record<string, unknown>).stdout = stdout;
    (child as unknown as Record<string, unknown>).stderr = stderr;
    child.kill = (): boolean => true;
    process.nextTick(() => {
      stdout.emit("data", o.stdout);
      if (o.stderr) stderr.emit("data", Buffer.from(o.stderr));
      child.emit("close", o.code);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

describe("srtSnapshot", () => {
  it("returns mime/dims/base64 and builds the right ffmpeg args", async () => {
    let seen: string[] = [];
    const spawnFake = fakeSpawn({
      code: 0,
      stdout: miniJpeg(640, 360),
      onSpawn: (a) => (seen = a),
    });
    const r = await srtSnapshot("192.168.0.132", { maxDim: 640, quality: 80 }, spawnFake);
    expect(r.mime).toBe("image/jpeg");
    expect(r).toMatchObject({ width: 640, height: 360 });
    expect(r.base64.length).toBeGreaterThan(10);
    expect(seen.find((a) => a.startsWith("srt://"))).toBe(
      "srt://192.168.0.132:5000?mode=caller&latency=120&streamid=mainstream",
    );
    expect(seen).toContain("-frames:v");
  });

  it("rejects with stderr detail when ffmpeg exits non-zero (listener not up)", async () => {
    const spawnFake = fakeSpawn({ code: 1, stdout: Buffer.alloc(0), stderr: "Connection refused" });
    await expect(srtSnapshot("h", {}, spawnFake)).rejects.toThrow(/Connection refused/);
  });

  it("rejects non-JPEG output (garbage guard)", async () => {
    const spawnFake = fakeSpawn({ code: 0, stdout: Buffer.from("not a jpeg at all") });
    await expect(srtSnapshot("h", {}, spawnFake)).rejects.toThrow(/snapshot failed/);
  });

  it("SrtNotEnabledError carries the Center-toggle instructions", () => {
    const e = new SrtNotEnabledError();
    expect(e.message).toMatch(/OBSBOT Center/);
    expect(e.message).toMatch(/NDI/);
  });
});

describe("SrtSnapshot type surface", () => {
  it("shape is stable", () => {
    const s: SrtSnapshot = { mime: "image/jpeg", width: 1, height: 1, base64: "" };
    expect(s.mime).toBe("image/jpeg");
  });
});
