import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { Tail2Api, Tail2HttpError } from "../../src/tail2/api.js";

/**
 * A state-driven fake Tail 2: a real HTTP server implementing the handful of
 * endpoints the client uses, plus a real WebSocket status push — the same
 * "real behaviour, not call-ordinal mocks" discipline as the Tiny 2 suites.
 *
 * Actuator realism matters here because the client exists to ride out lag:
 * PUTs ACKNOWLEDGE immediately but mutate state after a configurable delay
 * (zoom ramps, the portrait motor swings), which is exactly the
 * acknowledged-vs-applied hazard the verify ladder is built for
 * (TAIL2-PROTOCOL.md §8.1).
 */
interface FakeState {
  zoom: number;
  /** Hybrid-zoom unlock, as the RM_TEST live snapshot reports it (§13b). */
  digitalEnable: boolean;
  rollBias: number;
  aiMode: string;
  trackSpeed: string;
  portrait: boolean;
  /** Saved presets, wire shape (name stays base64). */
  presets: Array<{ id: number; pitch: number; yaw: number; roll: number; ratio: number; name: string }>;
  /** Live gimbal pose — preset `set` snapshots it, gimbalcontrol drives it. */
  pose: { yaw: number; pitch: number; roll: number };
  gimbalInvert: boolean;
  /** gimbalcontrol telemetry: non-stop speed POSTs seen, stops seen. */
  speedJogs: number;
  stopCount: number;
  /** The 2026-09-30 vendor-doc surface: record/capture, focus, exposure, image, stream, audio. */
  recording: "on" | "off";  focusMode: "afc" | "afs" | "mf";
  focusPosition: number;
  focusWindow: { x: number; y: number };
  exposureMode: "manual" | "auto";
  exposureAutoMode: "global" | "face";
  evbias: number;
  iso: number;
  shutter: string;
  styleMode: string;
  style: Record<string, number>;
  hdr: "on" | "off";
  wbMode: string;
  wbTemp: number;
  stream: "ndi" | "rtsp" | "srt" | "off";
  onlyMe: boolean;
  volume: number;
  audioMute: boolean;
  captures: number;
  /** Actuation delays in ms - how long an acked write takes to land. */
  delays: { zoom: number; portrait: number; preset: number };
  /** When true, zoom writes NEVER land: the swallowed-write hazard, frozen. */
  swallowZoom: boolean;
  /** The 2026-10-01 probe batch. */
  usbMode: string;
  presetSpeed: number;
  zoomType: string;
  antiFlicker: string;
  afTrack: string;
  isoMin: number;
  isoMax: number;
  gestureLockedTarget: boolean;
  gestureRecording: boolean;
  gestureZoom: boolean;
  gestureZoomFactor: number;
  streamEncoder: string;
  streamResolution: string;
  streamBitrate: number;
}

function makeFakeTail2(): Promise<{ api: Tail2Api; state: FakeState; close: () => Promise<void> }> {
  const state: FakeState = {
    zoom: 2.0,
    digitalEnable: true,
    rollBias: 0,
    aiMode: "humanTrackingSingleMode",
    trackSpeed: "slow",
    portrait: false,
    presets: [
      // Factory default, matching the real camera's slot 0.
      { id: 0, pitch: 1.6, yaw: 0.4, roll: 0, ratio: 1.4, name: Buffer.from("Default").toString("base64") },
    ],
    pose: { yaw: 0.4, pitch: 1.6, roll: 0 },
    gimbalInvert: false,
    speedJogs: 0,
    stopCount: 0,
    recording: "off",
    focusMode: "afc",
    focusPosition: 40,
    focusWindow: { x: 0.452, y: 0.616 },
    exposureMode: "auto",
    exposureAutoMode: "global",
    evbias: 0,
    iso: 894, // the live-AE-inherited value the real camera reported
    shutter: "1/100",
    styleMode: "standard",
    style: { brightness: 50, contrast: 50, hue: 50, saturation: 50, sharpness: 50 },
    hdr: "off",
    wbMode: "auto",
    wbTemp: 3000,
    stream: "ndi",
    onlyMe: true,
    volume: 50,
    audioMute: true,
    captures: 0,
    delays: { zoom: 120, portrait: 250, preset: 100 },
    swallowZoom: false,
    usbMode: "mtp",
    presetSpeed: 5,
    zoomType: "shot",
    antiFlicker: "60hz",
    afTrack: "face",
    isoMin: 100,
    isoMax: 6400,
    gestureLockedTarget: true,
    gestureRecording: true,
    gestureZoom: true,
    gestureZoomFactor: 2.0,
    streamEncoder: "h264",
    streamResolution: "1920X1080P30",
    streamBitrate: 20.0,
  };

  // gimbalcontrol: speeds integrate into the pose at the MEASURED rate
  // (0.39 °/s per unit) and the MEASURED sign (positive command yaw DECREASES
  // recorded yaw) until a stop:true arrives — the joystick primitive.
  let driveTimer: ReturnType<typeof setInterval> | null = null;
  let speeds = { yaw: 0, pitch: 0, roll: 0 };
  const stopDrive = (): void => {
    if (driveTimer) clearInterval(driveTimer);
    driveTimer = null;
    speeds = { yaw: 0, pitch: 0, roll: 0 };
  };
  const startDrive = (): void => {
    if (driveTimer) clearInterval(driveTimer);
    driveTimer = setInterval(() => {
      const dt = 0.05;
      state.pose.yaw -= speeds.yaw * 0.39 * dt;
      state.pose.pitch -= speeds.pitch * 0.39 * dt;
      state.pose.roll -= speeds.roll * 0.39 * dt;
    }, 50);
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRawBody = raw;
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      });
    });
  /** The raw text of the most recent request body — wire-format checks. */
  let lastRawBody = "";

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/camera/sdk/device_info") {
      return json(res, 200, {
        device_name: "Tail 2_test",
        wired_ip: "127.0.0.1",
        wireless_ip: "0.0.0.0",
        mac: "AA:BB:CC:00:11:22",
      });
    }
    if (req.method === "GET" && url === "/camera/sdk/ptz/zoom") {
      return json(res, 200, { ratio: state.zoom });
    }
    if (req.method === "GET" && url === "/camera/test/status") {
      // The RM_TEST live snapshot (§13b) — only the field the client reads.
      return json(res, 200, {
        status: { sync_push: { media_status: { zoom_infos: { digital_enable: state.digitalEnable } } } },
      });
    }
    // ---- the 2026-10-01 probe batch: uniform GET/PUT key-value endpoints ----
    {
      const kv: Record<string, { get: () => unknown; put: (b: Record<string, unknown>) => unknown }> = {
        "/camera/sdk/usb/mode": {
          get: () => ({ mode: state.usbMode }),
          put: (b) => (state.usbMode = String(b.mode)),
        },
        "/camera/sdk/ptz/presetspeed": {
          get: () => ({ speed: state.presetSpeed }),
          put: (b) => (state.presetSpeed = Number(b.speed)),
        },
        "/camera/sdk/ai/human/zoomtype": {
          get: () => ({ type: state.zoomType }),
          put: (b) => (state.zoomType = String(b.type)),
        },
        "/camera/sdk/image/exposure/antiflick/mode": {
          get: () => ({ mode: state.antiFlicker }),
          put: (b) => (state.antiFlicker = String(b.mode)),
        },
        "/camera/sdk/image/af/trackmode": {
          get: () => ({ mode: state.afTrack }),
          put: (b) => (state.afTrack = String(b.mode)),
        },
        "/camera/sdk/image/exposure/auto/isorange": {
          get: () => ({ isomin: state.isoMin, isomax: state.isoMax }),
          put: (b) => ((state.isoMin = Number(b.isomin)), (state.isoMax = Number(b.isomax))),
        },
        "/camera/sdk/ai/gesturecontrol/lockedtarget": {
          get: () => ({ enable: state.gestureLockedTarget }),
          put: (b) => (state.gestureLockedTarget = Boolean(b.enable)),
        },
        "/camera/sdk/ai/gesturecontrol/recording": {
          get: () => ({ enable: state.gestureRecording }),
          put: (b) => (state.gestureRecording = Boolean(b.enable)),
        },
        "/camera/sdk/ai/gesturecontrol/zoom": {
          get: () => ({ enable: state.gestureZoom }),
          put: (b) => (state.gestureZoom = Boolean(b.enable)),
        },
        "/camera/sdk/ai/gesturecontrol/zoomfactor": {
          get: () => ({ factor: state.gestureZoomFactor }),
          put: (b) => (state.gestureZoomFactor = Number(b.factor)),
        },
        "/camera/sdk/ndi-rtsp-srt/bitrate": {
          get: () => ({ bitrate: state.streamBitrate }),
          // Reject integer JSON like the real firmware does (the client
          // must send decimal-point float literals) — checked against the
          // RAW wire body, since parsing erases the distinction.
          put: () => {
            if (!/"bitrate":\d+\.\d/.test(lastRawBody)) {
              return new Error("Invalid value type");
            }
            state.streamBitrate = Number(JSON.parse(lastRawBody).bitrate);
            return undefined;
          },
        },
        "/camera/sdk/ndi-rtsp-srt/encoder": {
          get: () => ({ encoder: state.streamEncoder }),
          put: (b) => (state.streamEncoder = String(b.encoder)),
        },
        "/camera/sdk/ndi-rtsp-srt/resolution": {
          get: () => ({ resolution: state.streamResolution }),
          put: (b) => (state.streamResolution = String(b.resolution)),
        },
      };
      const route = kv[url];
      if (route && req.method === "GET") return json(res, 200, route.get());
      if (route && req.method === "PUT") {
        const b = await readBody(req);
        const err = route.put(b);
        if (err instanceof Error) return json(res, 400, { code: 400, err_idx: 0, detail: err.message });
        return json(res, 200, { code: 200, err_idx: 0 });
      }
    }
    if (req.method === "GET" && url === "/camera/sdk/ndi-rtsp-srt/rtspurl") {
      return json(res, 200, {
        wiredNetwork: { mainStreamUrl: "rtsp://127.0.0.1/stream1", subStreamUrl: "rtsp://127.0.0.1/stream2" },
        wirelessNetwork: { mainStreamUrl: "rtsp://127.0.0.2/stream1", subStreamUrl: "rtsp://127.0.0.2/stream2" },
      });
    }
    if (req.method === "GET" && url === "/camera/test/log") {
      // A tiny stand-in for the ~12 MB diagnostic bundle.
      const body = Buffer.from("fake-diagnostic-tarball");
      res.writeHead(200, { "Content-Length": String(body.length) });
      return res.end(body);
    }
    if (req.method === "PUT" && url === "/camera/sdk/ptz/zoom") {
      const b = await readBody(req);
      // Firmware shape: BOTH fields required (MEASURED 400 otherwise).
      if (typeof b.ratio !== "number" || typeof b.speed !== "number") {
        return json(res, 400, {});
      }
      if (!state.swallowZoom) {
        const target = b.ratio;
        setTimeout(() => (state.zoom = target), state.delays.zoom);
      }
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "POST" && url === "/camera/sdk/ptz/reset") {
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "POST" && url === "/camera/sdk/ptz/gimbalcontrol") {
      const b = await readBody(req);
      if (typeof b.stop !== "boolean") return json(res, 400, {});
      if (b.stop) {
        stopDrive();
        state.stopCount++;
        return json(res, 200, { code: 200, err_idx: 0 });
      }
      if (
        typeof b.yaw !== "number" || typeof b.pitch !== "number" || typeof b.roll !== "number"
      ) {
        return json(res, 400, {});
      }
      speeds = { yaw: b.yaw, pitch: b.pitch, roll: b.roll };
      startDrive();
      state.speedJogs++;
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "GET" && url === "/camera/sdk/ptz/gimbalinvert") {
      return json(res, 200, { enable: state.gimbalInvert });
    }
    if (req.method === "PUT" && url === "/camera/sdk/ptz/gimbalinvert") {
      const b = await readBody(req);
      if (typeof b.enable !== "boolean") return json(res, 400, {});
      state.gimbalInvert = b.enable;
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "GET" && url === "/camera/sdk/ptz/rollbias") {
      return json(res, 200, { angle: state.rollBias });
    }
    if (req.method === "PUT" && url === "/camera/sdk/ptz/rollbias") {
      const b = await readBody(req);
      if (typeof b.angle !== "number") return json(res, 400, {});
      state.rollBias = b.angle; // immediate on this fake
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "POST" && url === "/camera/sdk/switch_portrait") {
      const b = await readBody(req);
      if (typeof b.enable !== "boolean") return json(res, 400, {});
      const target = b.enable;
      setTimeout(() => (state.portrait = target), state.delays.portrait);
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "GET" && url === "/camera/sdk/ai/workmode") {
      return json(res, 200, { mode: state.aiMode });
    }
    if (req.method === "PUT" && url === "/camera/sdk/ai/workmode") {
      const b = await readBody(req);
      if (typeof b.mode !== "string" || b.mode === "") return json(res, 400, {});
      state.aiMode = b.mode;
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    if (req.method === "GET" && url === "/camera/sdk/ai/trackspeed") {
      return json(res, 200, { speed: state.trackSpeed });
    }
    if (req.method === "PUT" && url === "/camera/sdk/ai/trackspeed") {
      const b = await readBody(req);
      if (typeof b.speed !== "string") return json(res, 400, {});
      state.trackSpeed = b.speed;
      return json(res, 200, { code: 200, err_idx: 0 });
    }
    // Presets: one endpoint, four operations — the grammar decoded from the
    // camera's own web bundle (set captures CURRENT pose; call drives zoom to
    // the saved ratio after the actuation delay, mirroring measured behavior).
    if (req.method === "GET" && url === "/camera/sdk/ptz/preset") {
      return json(res, 200, { presetList: state.presets });
    }
    if (req.method === "PUT" && url === "/camera/sdk/ptz/preset") {
      const b = await readBody(req);
      if (typeof b.operation !== "string" || typeof b.id !== "number") {
        return json(res, 400, {});
      }
      if (b.operation === "set") {
        if (typeof b.name !== "string") return json(res, 400, {});
        const entry = {
          id: b.id,
          // "current live pose": the pose + zoom AT SAVE TIME, after the
          // preset-list lag the real camera exhibits.
          pitch: state.pose.pitch,
          yaw: state.pose.yaw,
          roll: state.pose.roll,
          ratio: state.zoom,
          name: b.name,
        };
        setTimeout(
          () => (state.presets = state.presets.filter((p) => p.id !== b.id).concat(entry)),
          state.delays.preset,
        );
        return json(res, 200, { code: 200, err_idx: 0 });
      }
      if (b.operation === "call") {
        const target = state.presets.find((p) => p.id === b.id);
        if (!target) return json(res, 200, { code: 200, err_idx: 0 }); // camera acks anyway
        if (!state.swallowZoom) {
          setTimeout(() => (state.zoom = target.ratio), state.delays.zoom);
        }
        return json(res, 200, { code: 200, err_idx: 0 });
      }
      if (b.operation === "delete") {
        state.presets = state.presets.filter((p) => p.id !== b.id);
        return json(res, 200, { code: 200, err_idx: 0 });
      }
      if (b.operation === "rename") {
        const t = state.presets.find((p) => p.id === b.id);
        if (t && typeof b.name === "string") t.name = b.name;
        return json(res, 200, { code: 200, err_idx: 0 });
      }
      return json(res, 400, {});
    }
  // ---- the 2026-09-30 vendor-doc surface ----------------------------------
  // Uniform shape: GET returns {key: value}, PUT {key: value} mutates.
  // Mode-gated endpoints 500 while their mode is wrong (measured on hardware:
  // motorposition outside mf, manual iso/shutter outside manual exposure).
  const pair = async (
    path: string,
    key: string,
    get: () => unknown,
    set: (v: unknown) => void,
    gate?: () => boolean,
  ): Promise<boolean> => {
    if (req.method === "GET" && url === path) {
      if (gate?.()) {
        json(res, 500, {});
        return true;
      }
      json(res, 200, typeof get() === "object" ? get() : { [key]: get() });
      return true;
    }
    if (req.method === "PUT" && url === path) {
      if (gate?.()) {
        json(res, 500, {});
        return true;
      }
      const b = await readBody(req);
      if (b[key] === undefined) {
        json(res, 400, {});
        return true;
      }
      set(b[key]);
      json(res, 200, { code: 200, err_idx: 0 });
      return true;
    }
    return false;
  };
  const p = "/camera/sdk";
  if (await pair(`${p}/record/control`, "recording", () => state.recording, (v) => (state.recording = v as "on" | "off"))) return;
  if (req.method === "POST" && url === `${p}/capture/trigger`) {
    state.captures++;
    return json(res, 200, { code: 200, err_idx: 0 });
  }
  if (await pair(`${p}/image/af/mode`, "mode", () => state.focusMode, (v) => (state.focusMode = v as "afc"))) return;
  if (
    await pair(
      `${p}/image/af/motorposition`, "position", () => state.focusPosition,
      (v) => (state.focusPosition = v as number), () => state.focusMode !== "mf",
    )
  )
    return;
  if (req.method === "GET" && url === `${p}/image/af/windowcenter`) {
    return json(res, 200, { x: state.focusWindow.x, y: state.focusWindow.y });
  }
  if (req.method === "PUT" && url === `${p}/image/af/windowcenter`) {
    if (state.focusMode === "mf") return json(res, 500, {});
    const b = await readBody(req);
    state.focusWindow = { x: b.x as number, y: b.y as number };
    return json(res, 200, { code: 200, err_idx: 0 });
  }
  if (req.method === "POST" && url === `${p}/ai/workmode/normaltrack/targetselect`) {
    const b = await readBody(req);
    if (typeof b.x !== "number" || typeof b.y !== "number") return json(res, 400, {});
    // Measured: a tap engages single-human tracking when a subject is there.
    state.aiMode = "humanTrackingSingleMode";
    return json(res, 200, { code: 200, err_idx: 0 });
  }
  if (await pair(`${p}/image/exposure/mode`, "mode", () => state.exposureMode, (v) => (state.exposureMode = v as "auto"))) return;
  if (await pair(`${p}/image/exposure/auto/mode`, "mode", () => state.exposureAutoMode, (v) => (state.exposureAutoMode = v as "global"))) return;
  if (await pair(`${p}/image/exposure/auto/compensation`, "evbias", () => state.evbias, (v) => (state.evbias = v as number))) return;
  if (
    await pair(
      `${p}/image/exposure/manual/iso`, "iso", () => state.iso,
      (v) => (state.iso = v as number), () => state.exposureMode !== "manual",
    )
  )
    return;
  if (
    await pair(
      `${p}/image/exposure/manual/shuttertime`, "shutter", () => state.shutter,
      (v) => (state.shutter = v as string), () => state.exposureMode !== "manual",
    )
  )
    return;
  // style/<control> GETs carry the mode alongside (measured); PUTs are gated
  // to manual style mode (measured: HTTP 500 "style mode is not manual").
  for (const c of ["brightness", "contrast", "hue", "saturation", "sharpness"] as const) {
    if (req.method === "GET" && url === `${p}/image/style/${c}`) {
      return json(res, 200, { mode: state.styleMode, [c]: state.style[c] });
    }
    if (req.method === "PUT" && url === `${p}/image/style/${c}`) {
      if (state.styleMode !== "manual") {
        return json(res, 500, { code: 500, err_idx: 0, detail: "style mode is not manual" });
      }
      const b = await readBody(req);
      state.style[c] = b[c] as number;
      return json(res, 200, { code: 200, err_idx: 0 });
    }
  }
  if (req.method === "GET" && url === `${p}/image/style/mode`) {
    return json(res, 200, { mode: state.styleMode, ...state.style });
  }
  if (req.method === "PUT" && url === `${p}/image/style/mode`) {
    const b = await readBody(req);
    state.styleMode = b.mode as string;
    for (const c of Object.keys(state.style)) {
      if (typeof b[c] === "number") state.style[c] = b[c] as number;
    }
    return json(res, 200, { code: 200, err_idx: 0 });
  }
  if (await pair(`${p}/image/hdr/control`, "control", () => state.hdr, (v) => (state.hdr = v as "on" | "off"))) return;
  if (req.method === "GET" && url === `${p}/image/whitebalance/config`) {
    return json(res, 200, { mode: state.wbMode, temperature: state.wbTemp });
  }
  if (req.method === "PUT" && url === `${p}/image/whitebalance/config`) {
    const b = await readBody(req);
    state.wbMode = b.mode as string;
    state.wbTemp = b.temperature as number;
    return json(res, 200, { code: 200, err_idx: 0 });
  }
  if (await pair(`${p}/ndi-rtsp-srt/control`, "control", () => state.stream, (v) => (state.stream = v as "ndi"))) return;
  if (await pair(`${p}/ai/human/onlyme`, "enable", () => state.onlyMe, (v) => (state.onlyMe = v as boolean))) return;
  if (await pair(`${p}/audio/input/volume`, "volume", () => state.volume, (v) => (state.volume = v as number))) return;
  if (await pair(`${p}/audio/input/mute`, "enable", () => state.audioMute, (v) => (state.audioMute = v as boolean))) return;

    json(res, 404, {});
  });

  // The status push: full block on connect, then every 100ms (the real one is
  // ~1Hz; faster here keeps one-shot reads snappy).
  const wss = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  const push = (): void => {
    const block = JSON.stringify({
      power_on: true,
      switch_portrait: state.portrait,
      zoom_ratio: state.zoom,
      roll_bias: state.rollBias,
      ai_mode: state.aiMode,
      ndi: { enable: true },
    });
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(block);
  };
  const timer = setInterval(push, 100);
  wss.on("connection", (ws) => {
    sockets.add(ws);
    push();
    ws.on("close", () => sockets.delete(ws));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const api = new Tail2Api({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
      resolve({
        api,
        state,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(timer);
            stopDrive();
            for (const ws of sockets) ws.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

describe("Tail2Api", () => {
  let fake: Awaited<ReturnType<typeof makeFakeTail2>>;

  beforeEach(async () => {
    fake = await makeFakeTail2();
  });

  afterEach(async () => {
    await fake.close();
  });

  const fastVerify = { attempts: 10, delayMs: 30 };

  it("reads device_info", async () => {
    const info = await fake.api.info();
    expect(info.mac).toBe("AA:BB:CC:00:11:22");
    expect(info.device_name).toBe("Tail 2_test");
  });

  it("reads one status push and closes the socket", async () => {
    const status = await fake.api.status();
    expect(status.ai_mode).toBe("humanTrackingSingleMode");
    expect(status.ndi).toEqual({ enable: true });
  });

  it("survives rapid consecutive status reads (teardown race)", async () => {
    // Regression shape for the live-hardware crash of 2026-09-26: stripping
    // listeners at settle left an unhandled 'error' when the camera's next
    // ~1 Hz push raced the close handshake, killing the process. Rapid reads
    // maximize overlap between one read's teardown and the next's traffic;
    // an unhandled error anywhere fails the vitest run.
    const reads = await Promise.all(
      Array.from({ length: 8 }, () => fake.api.status().catch((e: unknown) => e)),
    );
    for (const r of reads) expect(r).not.toBeInstanceOf(Error);
  });

  it("zoom: acknowledges, then verifies through the ramp", async () => {
    const r = await fake.api.zoomSet(5.5, 5, fastVerify);
    // The fake acks immediately but lands the zoom after delays.zoom — the
    // ladder must still be polling when it does.
    expect(r.settled).toBe(true);
    expect(r.ratio).toBe(5.5);
    expect(fake.state.zoom).toBe(5.5);
  });

  it("zoom without speed is a 400, exactly like the firmware", async () => {
    // Raw fetch, bypassing our own client's always-sends-both fields, to pin
    // what the camera itself demands (and what the fake reproduces).
    const res = await fetch(`${fake.api.baseUrl}/camera/sdk/ptz/zoom`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratio: 3 }),
    });
    expect(res.status).toBe(400);
  });

  it("zoom that never lands reports settled:false, not a throw", async () => {
    fake.state.swallowZoom = true;
    const r = await fake.api.zoomSet(8, 5, { attempts: 2, delayMs: 20 });
    expect(r.settled).toBe(false);
    expect(r.ratio).toBe(2.0); // last read value, still the old one
  });

  it("rollBias: write then immediate readback settles", async () => {
    const r = await fake.api.rollBiasSet(-12.5, fastVerify);
    expect(r.settled).toBe(true);
    expect(r.angle).toBe(-12.5);
  });

  it("portrait: verifies through the motor swing on the WS push", async () => {
    const r = await fake.api.portraitSet(true, fastVerify);
    expect(r.settled).toBe(true);
    expect(r.switch_portrait).toBe(true);
  });

  it("aiMode and trackSpeed round-trip", async () => {
    expect((await fake.api.aiModeSet("objectTrackingNormal", fastVerify)).settled).toBe(true);
    expect(fake.state.aiMode).toBe("objectTrackingNormal");
    expect((await fake.api.trackSpeedSet("crazy", fastVerify)).settled).toBe(true);
    expect(fake.state.trackSpeed).toBe("crazy");
  });

  it("recenter acks without readback (open-loop by design)", async () => {
    await expect(fake.api.recenter()).resolves.not.toThrow();
  });

  it("preset save captures the current zoom into the named slot", async () => {
    fake.state.zoom = 3.0;
    const r = await fake.api.presetSave(1, "test", fastVerify);
    expect(r.settled).toBe(true);
    const saved = fake.state.presets.find((p) => p.id === 1);
    expect(saved?.ratio).toBe(3.0); // pose-at-save-time semantics
    expect(Buffer.from(saved?.name ?? "", "base64").toString("utf8")).toBe("test");
  });

  it("preset recall drives zoom to the saved ratio (verified arrival)", async () => {
    fake.state.zoom = 3.0;
    await fake.api.presetSave(1, "zoom3", fastVerify);
    fake.state.presets.find((p) => p.id === 1)!.ratio = 3.0;
    fake.state.zoom = 1.5;
    const r = await fake.api.presetRecall(1, fastVerify);
    expect(r.settled).toBe(true);
    expect(r.zoom).toBe(3.0);
  });

  it("preset recall of an empty slot refuses before sending anything", async () => {
    await expect(fake.api.presetRecall(2)).rejects.toThrow(/empty/);
    expect(fake.state.presets.find((p) => p.id === 2)).toBeUndefined();
  });

  it("preset rename and delete verify through the list", async () => {
    await fake.api.presetSave(1, "before", fastVerify);
    const rn = await fake.api.presetRename(1, "after", fastVerify);
    expect(rn.settled).toBe(true);
    const list = await fake.api.presetsGet();
    expect(list.find((p) => p.id === 1)?.name).toBe("after"); // decoded
    const del = await fake.api.presetDelete(1, fastVerify);
    expect(del.settled).toBe(true);
    expect((await fake.api.presetsGet()).find((p) => p.id === 1)).toBeUndefined();
    // Factory preset untouched by any of this.
    expect((await fake.api.presetsGet()).find((p) => p.id === 0)?.name).toBe("Default");
  });

  it("HTTP errors surface as Tail2HttpError with status and path", async () => {
    // /camera/sdk/range exists on a real camera but not on this fake, so the
    // request itself is well-formed while the reply is a 404 — the cleanest
    // public path to the error branch.
    const err = await fake.api.ranges().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Tail2HttpError);
    expect((err as Tail2HttpError).status).toBe(404);
    expect((err as Tail2HttpError).path).toBe("/camera/sdk/range");
  });

  it("hybridZoomEnabled reads digital_enable from the RM_TEST live snapshot", async () => {
    expect(await fake.api.hybridZoomEnabled()).toBe(true);
    fake.state.digitalEnable = false;
    expect(await fake.api.hybridZoomEnabled()).toBe(false);
    // The live snapshot is a plain GET on the undocumented endpoint.
    const live = (await fake.api.liveStatus()) as { status?: { sync_push?: unknown } };
    expect(live.status).toBeDefined();
  });

  it("the 2026-10-01 probe batch: writes verify by readback", async () => {
    const fast = { attempts: 2, delayMs: 10 };
    expect((await fake.api.zoomTypeSet("halfBody", fast)).type).toBe("halfBody");
    expect((await fake.api.presetSpeedSet(3, fast)).speed).toBe(3);
    expect((await fake.api.usbModeSet("uvc", fast)).mode).toBe("uvc");
    expect((await fake.api.antiFlickerSet("50hz", fast)).mode).toBe("50hz");
    expect((await fake.api.afTrackSet("front", fast)).mode).toBe("front");
    expect(await fake.api.isoRangeSet(200, 3200, fast)).toMatchObject({ isomin: 200, isomax: 3200 });
    expect((await fake.api.gestureLockedTargetSet(false, fast)).enable).toBe(false);
    expect((await fake.api.gestureZoomFactorSet(3.5, fast)).factor).toBe(3.5);
    expect((await fake.api.streamEncoderSet("h265", fast)).encoder).toBe("h265");
    expect((await fake.api.streamBitrateSet(40, fast)).bitrate).toBe(40);
    expect((await fake.api.streamResolutionSet("3840X2160P30", fast)).resolution).toBe("3840X2160P30");
    // Reads see the mutated state.
    expect(await fake.api.zoomTypeGet()).toEqual({ type: "halfBody" });
    expect(await fake.api.isoRangeGet()).toEqual({ isomin: 200, isomax: 3200 });
    const urls = (await fake.api.rtspUrlsGet()) as { wiredNetwork?: { mainStreamUrl?: string } };
    expect(urls.wiredNetwork?.mainStreamUrl).toContain("rtsp://");
  });

  it("exportLog downloads the binary bundle", async () => {
    const buf = await fake.api.exportLog(2000);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe("fake-diagnostic-tarball");
  });

  it("unreachable cameras fail with the scan hint", async () => {
    const dead = new Tail2Api({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    await expect(dead.info()).rejects.toThrow(/obsbot_tail2_scan/);
  });

  // ---- gimbal speed control + pose probe (the 2026-09-30 primitives) ------

  it("gimbalSpeed posts the vendor shape and gimbalStop halts the drive", async () => {
    await fake.api.gimbalSpeed(20, 0, 0);
    await new Promise((r) => setTimeout(r, 250));
    await fake.api.gimbalStop();
    expect(fake.state.speedJogs).toBe(1);
    expect(fake.state.stopCount).toBe(1);
    // Measured convention: positive yaw command DECREASES recorded yaw.
    expect(fake.state.pose.yaw).toBeLessThan(0.4);
    expect(fake.state.pose.pitch).toBe(1.6);
  });

  it("gimbalInvertSet writes and verifies by readback", async () => {
    const r = await fake.api.gimbalInvertSet(true);
    expect(r).toMatchObject({ settled: true, enable: true });
    expect(fake.state.gimbalInvert).toBe(true);
    expect(await fake.api.gimbalInvertGet()).toEqual({ enable: true });
  });

  it("readPose snapshots the live pose and leaves the preset bank clean", async () => {
    fake.state.pose = { yaw: 12.5, pitch: -3.25, roll: 0.5 };
    const pose = await fake.api.readPose();
    expect(pose).toEqual({ yaw: 12.5, pitch: -3.25, roll: 0.5, ratio: fake.state.zoom });
    // The scratch slot is gone afterwards — only the factory preset remains.
    expect(fake.state.presets.map((p) => p.id)).toEqual([0]);
  });

  it("readPose reuses a leftover probe slot instead of duplicating or clobbering", async () => {
    // A crashed probe left its slot behind.
    fake.state.presets.push({
      id: 1,
      pitch: 0,
      yaw: 0,
      roll: 0,
      ratio: 1,
      name: Buffer.from("pose-probe").toString("base64"),
    });
    fake.state.pose = { yaw: -8, pitch: 2, roll: 0 };
    const pose = await fake.api.readPose();
    expect(pose.yaw).toBe(-8);
    const names = fake.state.presets.map((p) => p.id);
    expect(names).toEqual([0]); // probe slot consumed and deleted again
  });

  it("readPose refuses when every slot holds a user preset", async () => {
    fake.state.presets = [0, 1, 2].map((id) => ({
      id,
      pitch: 0,
      yaw: 0,
      roll: 0,
      ratio: 1,
      name: Buffer.from(`user-${id}`).toString("base64"),
    }));
    await expect(fake.api.readPose()).rejects.toThrow(/all three preset slots are occupied/);
  });

  // ---- the 2026-09-30 vendor-doc surface -----------------------------------

  it("recordSet writes and verifies; captureTrigger lands", async () => {
    const r = await fake.api.recordSet(true);
    expect(r).toMatchObject({ settled: true, recording: "on" });
    await fake.api.captureTrigger();
    expect(fake.state.captures).toBe(1);
    await fake.api.recordSet(false);
  });

  it("focus position is mode-gated: 500 outside mf, readable and writable in mf", async () => {
    await expect(fake.api.focusPositionGet()).rejects.toMatchObject({ status: 500 });
    await fake.api.focusModeSet("mf");
    expect(await fake.api.focusPositionGet()).toEqual({ position: 40 });
    const r = await fake.api.focusPositionSet(80);
    expect(r).toMatchObject({ settled: true, position: 80 });
    await fake.api.focusModeSet("afc"); // restore
  });

  it("tap-to-focus moves the window (afc/afs gated) and tap-to-track engages tracking", async () => {
    const w = await fake.api.focusWindowSet(0.7, 0.3);
    expect(w).toMatchObject({ settled: true, x: 0.7, y: 0.3 });
    await fake.api.focusModeSet("mf");
    await expect(fake.api.focusWindowSet(0.5, 0.5)).rejects.toMatchObject({ status: 500 });
    await fake.api.focusModeSet("afc");
    await fake.api.aiModeSet("none");
    await fake.api.targetSelect(0.5, 0.5);
    expect((await fake.api.aiModeGet()).mode).toBe("humanTrackingSingleMode");
  });

  it("manual exposure values are gated by exposure mode", async () => {
    await expect(fake.api.exposureIsoGet()).rejects.toMatchObject({ status: 500 });
    await fake.api.exposureModeSet("manual");
    expect(await fake.api.exposureIsoGet()).toEqual({ iso: 894 });
    const r = await fake.api.exposureIsoSet(800);
    expect(r).toMatchObject({ settled: true, iso: 800 });
    await fake.api.exposureModeSet("auto"); // restore
  });

  it("stream control, style, wb, hdr, onlyme, audio all round-trip verified", async () => {
    expect(await fake.api.streamControlSet("srt")).toMatchObject({ settled: true, control: "srt" });
    expect(fake.state.stream).toBe("srt");
    // Style control writes are gated to manual mode (measured on hardware).
    await fake.api.styleModeSet("manual");
    expect(await fake.api.styleSet("brightness", 70)).toMatchObject({ settled: true, value: 70 });
    await expect(fake.api.styleSet("contrast", 80)).resolves.toBeDefined();
    await fake.api.styleModeSet("standard");
    await expect(fake.api.styleSet("contrast", 80)).rejects.toMatchObject({ status: 500 });
    expect(await fake.api.wbConfigSet("manual", 5600)).toMatchObject({
      settled: true,
      mode: "manual",
      temperature: 5600,
    });
    expect(await fake.api.hdrSet(true)).toMatchObject({ settled: true, control: "on" });
    expect(await fake.api.onlyMeSet(false)).toMatchObject({ settled: true, enable: false });
    expect(await fake.api.audioVolumeSet(30)).toMatchObject({ settled: true, volume: 30 });
    expect(await fake.api.audioMuteSet(false)).toMatchObject({ settled: true, enable: false });
  });

  it("moveAbsolute closes the loop end to end through the HTTP client", async () => {    // Small move so the loop converges in one or two rounds of REAL time.
    fake.state.pose = { yaw: 0.4, pitch: 1.6, roll: 0 };
    const { moveAbsolute } = await import("../../src/tail2/move.js");
    const r = await moveAbsolute(
      {
        readPose: () => fake.api.readPose(),
        speedCmd: (y, p) => fake.api.gimbalSpeed(y, p, 0),
        stop: () => fake.api.gimbalStop(),
        sleep: (ms) => new Promise<void>((res) => setTimeout(res, ms)),
      },
      { yaw: 4.5 }, // ~4° away: one undershooting jog + one correction at most
    );
    expect(r.converged).toBe(true);
    expect(Math.abs(r.pose.yaw - 4.5)).toBeLessThanOrEqual(1.5);
    // Never left running: every jog was stopped.
    expect(fake.state.stopCount).toBeGreaterThanOrEqual(r.iterations);
    expect(fake.state.presets.map((p) => p.id)).toEqual([0]);
  });

  it("a non-JSON reply (some other device on that IP) fails loudly", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not a tail 2</html>");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    const api = new Tail2Api({ baseUrl: `http://127.0.0.1:${port}` });
    // Must surface as an actionable "wrong device" error carrying the scan
    // hint — not as a raw SyntaxError from res.json().
    await expect(api.info()).rejects.toThrow(/another device.*obsbot_tail2_scan/s);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});
