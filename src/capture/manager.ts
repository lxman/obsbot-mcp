import { spawn as realSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import {
  parseDshowDevices, resolveVideoName, resolveAudioName,
  buildRecordArgs, buildPreviewArgs,
  parseAvfDevices, resolveAvfVideoName, resolveAvfAudioName,
  buildAvfRecordArgs, buildAvfPreviewArgs,
  type CaptureSource, type DshowDevices, type AvfDevices,
} from "./ffmpeg-args.js";

export interface CaptureSession {
  id: string;
  kind: "record" | "preview";
  pid: number;
  source: CaptureSource;
  outputPath?: string;
  durationSec?: number;
  startedAtIso: string;
}

/** Expected operational failure (surfaced to the user as text, not thrown to the client). */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export class FfmpegMissingError extends CaptureError {
  constructor() {
    super(
      "Recording/preview needs ffmpeg and ffplay, which aren't installed. " +
        "Install with: winget install Gyan.FFmpeg (Windows) / brew install ffmpeg (mac) / " +
        "apt install ffmpeg (Linux).",
    );
    this.name = "FfmpegMissingError";
  }
}

const OPEN_ENDED_CAP_SEC = 3600;
const GRACEFUL_STOP_MS = 5000;
const IS_MAC = platform() === "darwin";

function defaultHasBinary(name: string): boolean {
  const r = spawnSync(name, ["-version"], { stdio: "ignore" });
  return !r.error;
}

interface FsLike {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
}

interface Deps {
  spawn?: typeof realSpawn;
  clock?: () => string;
  hasBinary?: (name: string) => boolean;
  fs?: FsLike;
  /** Override platform detection for testing. */
  platform?: "darwin" | "win32" | "linux";
}

type PlatformDevices = DshowDevices | AvfDevices;

function isAvfDevices(d: PlatformDevices): d is AvfDevices {
  return "video" in d && typeof d.video === "object" && !Array.isArray(d.video);
}

export class CaptureManager {
  private readonly spawn: typeof realSpawn;
  private readonly clock: () => string;
  private readonly hasBinary: (name: string) => boolean;
  private readonly fs: FsLike;
  private readonly platform: string;
  private readonly sessions = new Map<string, { session: CaptureSession; child: ChildProcess }>();
  private devices?: PlatformDevices;
  private seq = 0;

  constructor(deps: Deps = {}) {
    this.spawn = deps.spawn ?? realSpawn;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.hasBinary = deps.hasBinary ?? defaultHasBinary;
    this.fs = deps.fs ?? { existsSync, mkdirSync };
    this.platform = deps.platform ?? platform();
  }

  private ensureFfmpeg(): void {
    if (!this.hasBinary("ffmpeg") || !this.hasBinary("ffplay")) {
      throw new FfmpegMissingError();
    }
  }

  private probeDevices(): Promise<PlatformDevices> {
    if (this.devices) return Promise.resolve(this.devices);
    return new Promise((resolve, reject) => {
      const isMac = this.platform === "darwin";
      const args = isMac
        ? ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
        : ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"];
      const child = this.spawn("ffmpeg", args);
      let err = "";
      child.stderr?.on("data", (d) => { err += d.toString(); });
      child.on("error", (e) => reject(new CaptureError(`failed to run ffmpeg for device probe: ${e.message}`)));
      child.on("close", () => {
        this.devices = isMac ? parseAvfDevices(err) : parseDshowDevices(err);
        resolve(this.devices);
      });
    });
  }

  private timestampName(): string {
    const iso = this.clock();
    const compact = iso.replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "");
    return `obsbot-${compact}.mp4`;
  }

  async startRecord(o: {
    source: CaptureSource; durationSec?: number; audio: boolean; outputPath?: string;
  }): Promise<CaptureSession> {
    this.ensureFfmpeg();
    const devices = await this.probeDevices();

    if (isAvfDevices(devices)) {
      const videoInfo = resolveAvfVideoName(devices, o.source);
      if (!videoInfo) throw new CaptureError(`no '${o.source}' video source found (is OBSBOT Center / NDI running?)`);
      let audioIndex: number | undefined;
      if (o.audio) {
        const audioInfo = resolveAvfAudioName(devices);
        if (!audioInfo) throw new CaptureError("OBSBOT microphone not found; retry with audio:false for a silent clip");
        audioIndex = audioInfo.index;
      }
      const outputPath = o.outputPath ?? join(homedir(), "Videos", "OBSBOT", this.timestampName());
      if (o.outputPath && this.fs.existsSync(o.outputPath)) {
        throw new CaptureError(`output file already exists: ${o.outputPath}`);
      }
      this.fs.mkdirSync(dirname(outputPath), { recursive: true });
      const durationSec = o.durationSec ?? OPEN_ENDED_CAP_SEC;
      const args = buildAvfRecordArgs({ videoIndex: videoInfo.index, audioIndex, durationSec, outputPath });
      const child = this.spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "ignore"] });
      const session: CaptureSession = {
        id: `cap${++this.seq}`, kind: "record", pid: child.pid ?? -1,
        source: o.source, outputPath, durationSec, startedAtIso: this.clock(),
      };
      this.sessions.set(session.id, { session, child });
      child.once("exit", () => this.sessions.delete(session.id));
      child.on("error", () => this.sessions.delete(session.id));
      return session;
    }

    // Windows (dshow) path
    const dshowDev = devices as DshowDevices;
    const videoName = resolveVideoName(dshowDev, o.source);
    if (!videoName) throw new CaptureError(`no '${o.source}' video source found (is OBSBOT Center / NDI running?)`);
    let audioName: string | undefined;
    if (o.audio) {
      audioName = resolveAudioName(dshowDev);
      if (!audioName) throw new CaptureError("OBSBOT microphone not found; retry with audio:false for a silent clip");
    }
    const outputPath = o.outputPath ?? join(homedir(), "Videos", "OBSBOT", this.timestampName());
    if (o.outputPath && this.fs.existsSync(o.outputPath)) {
      throw new CaptureError(`output file already exists: ${o.outputPath}`);
    }
    this.fs.mkdirSync(dirname(outputPath), { recursive: true });
    const durationSec = o.durationSec ?? OPEN_ENDED_CAP_SEC;
    const args = buildRecordArgs({ videoName, audioName, durationSec, outputPath });
    const child = this.spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "ignore"] });
    const session: CaptureSession = {
      id: `cap${++this.seq}`, kind: "record", pid: child.pid ?? -1,
      source: o.source, outputPath, durationSec, startedAtIso: this.clock(),
    };
    this.sessions.set(session.id, { session, child });
    child.once("exit", () => this.sessions.delete(session.id));
    child.on("error", () => this.sessions.delete(session.id));
    return session;
  }

  async startPreview(o: { source: CaptureSource }): Promise<CaptureSession> {
    this.ensureFfmpeg();
    const devices = await this.probeDevices();

    if (isAvfDevices(devices)) {
      const videoInfo = resolveAvfVideoName(devices, o.source);
      if (!videoInfo) throw new CaptureError(`no '${o.source}' video source found (is OBSBOT Center / NDI running?)`);
      const args = buildAvfPreviewArgs({ videoIndex: videoInfo.index });
      const child = this.spawn("ffplay", args, { stdio: "ignore" });
      const session: CaptureSession = {
        id: `cap${++this.seq}`, kind: "preview", pid: child.pid ?? -1,
        source: o.source, startedAtIso: this.clock(),
      };
      this.sessions.set(session.id, { session, child });
      child.once("exit", () => this.sessions.delete(session.id));
      child.on("error", () => this.sessions.delete(session.id));
      return session;
    }

    // Windows (dshow) path
    const dshowDev = devices as DshowDevices;
    const videoName = resolveVideoName(dshowDev, o.source);
    if (!videoName) throw new CaptureError(`no '${o.source}' video source found (is OBSBOT Center / NDI running?)`);
    const args = buildPreviewArgs({ videoName });
    const child = this.spawn("ffplay", args, { stdio: "ignore" });
    const session: CaptureSession = {
      id: `cap${++this.seq}`, kind: "preview", pid: child.pid ?? -1,
      source: o.source, startedAtIso: this.clock(),
    };
    this.sessions.set(session.id, { session, child });
    child.once("exit", () => this.sessions.delete(session.id));
    child.on("error", () => this.sessions.delete(session.id));
    return session;
  }

  async stop(id: string): Promise<{ kind: "record" | "preview"; outputPath?: string; graceful: boolean }> {
    const entry = this.sessions.get(id);
    if (!entry) throw new CaptureError(`no such capture session: ${id}`);
    const { session, child } = entry;
    let graceful = true;
    if (session.kind === "record") {
      graceful = await new Promise<boolean>((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve(false); } }, GRACEFUL_STOP_MS);
        child.once("exit", () => { if (!done) { done = true; clearTimeout(timer); resolve(true); } });
        try { child.stdin?.write("q"); } catch { /* already gone */ }
      });
    } else {
      child.kill();
    }
    this.sessions.delete(id);
    return { kind: session.kind, outputPath: session.outputPath, graceful };
  }

  list(): CaptureSession[] {
    return [...this.sessions.values()].map((e) => e.session);
  }

  // Hard-kill every child. Wired to server shutdown so nothing orphans; this is
  // last-resort cleanup, not a graceful stop.
  stopAll(): void {
    for (const { child } of this.sessions.values()) {
      try { child.kill(); } catch { /* ignore */ }
    }
    this.sessions.clear();
  }
}
