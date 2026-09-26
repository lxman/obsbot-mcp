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
  rollBias: number;
  aiMode: string;
  trackSpeed: string;
  portrait: boolean;
  /** Saved presets, wire shape (name stays base64). */
  presets: Array<{ id: number; pitch: number; yaw: number; roll: number; ratio: number; name: string }>;
  /** Actuation delays in ms — how long an acked write takes to land. */
  delays: { zoom: number; portrait: number };
  /** When true, zoom writes NEVER land: the swallowed-write hazard, frozen. */
  swallowZoom: boolean;
}

function makeFakeTail2(): Promise<{ api: Tail2Api; state: FakeState; close: () => Promise<void> }> {
  const state: FakeState = {
    zoom: 2.0,
    rollBias: 0,
    aiMode: "humanTrackingSingleMode",
    trackSpeed: "slow",
    portrait: false,
    presets: [
      // Factory default, matching the real camera's slot 0.
      { id: 0, pitch: -0.96, yaw: 2.57, roll: 0.88, ratio: 1.4, name: Buffer.from("Default").toString("base64") },
    ],
    delays: { zoom: 120, portrait: 250 },
    swallowZoom: false,
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
    });

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
          // "current live pose": fixed pose + zoom AT SAVE TIME.
          pitch: 1.6,
          yaw: 0.4,
          roll: 0,
          ratio: state.zoom,
          name: b.name,
        };
        state.presets = state.presets.filter((p) => p.id !== b.id).concat(entry);
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

  it("unreachable cameras fail with the scan hint", async () => {
    const dead = new Tail2Api({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    await expect(dead.info()).rejects.toThrow(/obsbot_tail2_scan/);
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
