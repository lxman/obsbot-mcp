import WebSocket from "ws";

/**
 * HTTP/WS client for the OBSBOT Tail 2 control API.
 *
 * The Tail 2's network control plane is a lighttpd REST API plus a WebSocket
 * status push (see TAIL2-PROTOCOL.md). Its USB-C UVC mode has a control
 * surface of its own (§11) that this client does not use.
 * Everything here is plain HTTP and therefore platform-independent: the same
 * code runs on Windows, Linux and macOS with no native helper, which is the
 * whole reason this module exists as a separate family from the Tiny 2's
 * helper-process transports.
 *
 * Identity is the camera's MAC (what OBSBOT Center keys on); device_name and
 * any of its IPs are accepted as selectors one level up, in the registry.
 */

/** `GET /camera/sdk/device_info` — the probe target and identity source. */
export interface Tail2DeviceInfo {
  device_name: string;
  wired_ip: string;
  wireless_ip: string;
  mac: string;
}

/**
 * One push from `ws://<host>/ws/`. The camera sends the FULL status block
 * ~1 Hz with no subscription message. Fields the tools rely on are typed;
 * the block carries more (and firmware may add some) — unknown fields pass
 * through untouched via the index signature.
 *
 * MEASURED 2026-09-26 against firmware 7.2.13.1; see TAIL2-PROTOCOL.md §4.
 */
export interface Tail2Status {
  [key: string]: unknown;
  power_on?: boolean;
  usb_mode?: number;
  rec?: boolean;
  rec_time?: number;
  switch_portrait?: boolean;
  ai_mode?: string;
  zoom_ratio?: number;
  roll_bias?: number;
  focus_mode?: string;
  auto_focus_mode?: string;
  ndi?: { enable?: boolean };
  rtsp?: { enable?: boolean };
  srt?: { enable?: boolean };
  rtmp?: { enable?: boolean };
  preset_info?: Array<{
    id: number;
    pitch: number;
    yaw: number;
    roll: number;
    ratio: number;
    name: string;
  }>;
  device_status?: Record<string, unknown>;
}

/** Successful mutation replies: `{"code": 200, "err_idx": 0}`. */
interface Ack {
  code?: number;
  err_idx?: number;
}

/** A saved gimbal pose: degrees + zoom ratio. Names are base64 on the wire only. */
export interface Preset {
  id: number;
  pitch: number;
  yaw: number;
  roll: number;
  ratio: number;
  name: string;
}

/** A live gimbal pose in degrees, plus the zoom ratio the pose read carries. */
export interface Pose {
  yaw: number;
  pitch: number;
  roll: number;
  ratio: number;
}

// The camera stores preset names as base64 of UTF-8 (decoded from the web
// bundle's own btoa-encoder, hardware-round-tripped 2026-09-26).
const b64encode = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const b64decode = (s: string): string => Buffer.from(s, "base64").toString("utf8");

export class Tail2HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Tail 2 API ${path} failed with HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "Tail2HttpError";
  }
}

/**
 * `{"code":200,"err_idx":0}` means ACKNOWLEDGED, not applied — MEASURED
 * 2026-09-26: a rollbias write returned 200 while the portrait motor was in
 * motion and never landed (TAIL2-PROTOCOL.md §8.1). This is the same failure
 * class as the Tiny 2's post-replug vendor mailbox, so every setter here
 * verifies by readback before reporting success, with a bounded retry ladder
 * sized for the actuator involved (the zoom motor and the portrait rotation
 * take seconds, not milliseconds).
 */
export interface VerifyOpts {
  attempts?: number;
  delayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Tail2Api {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly wsUrl: string;

  constructor(opts: { baseUrl: string; timeoutMs?: number }) {
    // Accept a bare host too — the common case is "192.168.0.132".
    this.baseUrl = opts.baseUrl.startsWith("http") ? opts.baseUrl : `http://${opts.baseUrl}`;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws/`;
  }

  private async req<T>(method: string, path: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(
        `Tail 2 at ${this.baseUrl} is unreachable (${e instanceof Error ? e.message : String(e)}). ` +
          `Check the camera is powered and on the network; if it changed IP, re-run obsbot_tail2_scan.`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Tail2HttpError(res.status, path, text.slice(0, 300));
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      // HTTP-level success but a body that isn't JSON: this is some OTHER
      // device's web server on that address, not a Tail 2. Same actionable
      // shape as unreachable — the fix is a different address, not a retry.
      throw new Error(
        `Tail 2 at ${this.baseUrl} did not reply with JSON for ${path} ` +
          `(${e instanceof Error ? e.message : String(e)}) — the address is probably another ` +
          `device, not a Tail 2. Re-run obsbot_tail2_scan to find the camera.`,
      );
    }
  }

  private async send(method: "PUT" | "POST", path: string, body: object): Promise<void> {
    const ack = await this.req<Ack>(method, path, body);
    // Every confirmed endpoint replies {"code":200,"err_idx":0}; a non-200
    // code with HTTP 200 has not been observed, but checking it is free and
    // makes an err_idx≠0 reply loud instead of silent.
    if (typeof ack.code === "number" && ack.code !== 200) {
      throw new Error(`${path} rejected: code=${ack.code} err_idx=${ack.err_idx ?? "?"}`);
    }
  }

  /**
   * Read `read()` until `match()` holds, on a bounded ladder. Returns
   * `settled:false` (NOT a throw) when the ladder runs out — the command was
   * sent and acknowledged, so the caller decides whether that is failure.
   * Mirrors `obsbot_zoom_uvc`'s `settled` contract.
   */
  async verified<T>(
    read: () => Promise<T>,
    match: (v: T) => boolean,
    opts: VerifyOpts = {},
  ): Promise<{ settled: boolean; value: T }> {
    const attempts = opts.attempts ?? 6;
    const delayMs = opts.delayMs ?? 400;
    let value = await read();
    for (let i = 1; i < attempts && !match(value); i++) {
      await sleep(delayMs);
      value = await read();
    }
    return { settled: match(value), value };
  }

  // ---- reads ---------------------------------------------------------------

  info(): Promise<Tail2DeviceInfo> {
    return this.req<Tail2DeviceInfo>("GET", "/camera/sdk/device_info");
  }

  /** One-shot status: connect, take the first push, close. No persistent socket. */
  status(): Promise<Tail2Status> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { handshakeTimeout: this.timeoutMs });
      // One winner across message/error/close/timer. NOT removeAllListeners():
      // the camera keeps pushing its ~1 Hz status while our close handshake is
      // in flight, and a late teardown frame can raise 'error' AFTER we've
      // stripped the handler — an unhandled 'error' on a WebSocket kills the
      // process (measured on live hardware 2026-09-26: "Invalid WebSocket
      // frame: invalid status code 12592"). The settled flag makes stray
      // events no-ops; success tears the socket down with terminate() so no
      // further frames are parsed at all.
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () =>
          settle(() => {
            ws.terminate();
            reject(new Error(`Tail 2 status channel (${this.wsUrl}) timed out. Retry this call.`));
          }),
        this.timeoutMs + 2000,
      );
      ws.on("error", (e: Error) =>
        settle(() => reject(new Error(`Tail 2 status channel failed: ${e.message}`))),
      );
      ws.on("close", () =>
        settle(() => reject(new Error("status channel closed before a push arrived"))),
      );
      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(data.toString()) as Tail2Status;
          settle(() => {
            ws.terminate();
            resolve(parsed);
          });
        } catch (e) {
          settle(() => reject(e instanceof Error ? e : new Error(String(e))));
        }
      });
    });
  }

  ranges(): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>("GET", "/camera/sdk/range");
  }

  networkConfig(): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>("GET", "/camera/sdk/networkconfig");
  }

  imageState(): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>("GET", "/camera/sdk/image");
  }

  // ---- PTZ -----------------------------------------------------------------

  zoomGet(): Promise<{ ratio: number }> {
    return this.req<{ ratio: number }>("GET", "/camera/sdk/ptz/zoom");
  }

  /**
   * Absolute zoom ratio on the Tail 2's own 1.0–12.0 scale (`GET range`).
   * `speed` is REQUIRED by the firmware (a ratio-only PUT is a 400) — both
   * fields MEASURED 2026-09-26.
   */
  async zoomSet(
    ratio: number,
    speed: number,
    verify: VerifyOpts = {},
  ): Promise<{ settled: boolean; ratio: number }> {
    await this.send("PUT", "/camera/sdk/ptz/zoom", { ratio, speed });
    // The zoom motor ramps; 4.5s of polling covers a full 1x→12x sweep at
    // default speed without hanging the call on a wedged motor.
    const v = await this.verified(
      () => this.zoomGet(),
      (r) => Math.abs(r.ratio - ratio) <= 0.01,
      { attempts: 10, delayMs: 500, ...verify },
    );
    return { settled: v.settled, ratio: v.value.ratio };
  }

  /** Gimbal recenter (`POST ptz/reset`). Open-loop: the Tail 2 reports no live pose. */
  async recenter(): Promise<void> {
    await this.send("POST", "/camera/sdk/ptz/reset", {});
  }

  // ---- gimbal speed control (the joystick primitive) -------------------------
  //
  // POST /camera/sdk/ptz/gimbalcontrol {stop, pitch, roll, yaw} — from the
  // vendor REST doc (SDKs/obsbot_tail_2_res_tful.zip), hardware-verified
  // 2026-09-30: each axis −178..178, sign = direction, magnitude = SPEED.
  // stop:true halts. This is a continuous speed command with no endpoint of
  // its own — the camera keeps moving until stopped.

  gimbalSpeed(yaw: number, pitch: number, roll: number): Promise<void> {
    return this.send("POST", "/camera/sdk/ptz/gimbalcontrol", {
      stop: false,
      pitch,
      roll,
      yaw,
    });
  }

  gimbalStop(): Promise<void> {
    return this.send("POST", "/camera/sdk/ptz/gimbalcontrol", {
      stop: true,
      pitch: 0,
      roll: 0,
      yaw: 0,
    });
  }

  gimbalInvertGet(): Promise<{ enable: boolean }> {
    return this.req<{ enable: boolean }>("GET", "/camera/sdk/ptz/gimbalinvert");
  }

  /** Reverse (invert) control directions. Readback-verified like every write. */
  async gimbalInvertSet(
    enable: boolean,
    verify: VerifyOpts = {},
  ): Promise<{ settled: boolean; enable: boolean }> {
    await this.send("PUT", "/camera/sdk/ptz/gimbalinvert", { enable });
    const v = await this.verified(
      () => this.gimbalInvertGet(),
      (r) => r.enable === enable,
      verify,
    );
    return { settled: v.settled, enable: v.value.enable };
  }

  // ---- pose readback via the preset API ----------------------------------------
  //
  // The API reports no live pose directly, but `preset set` captures the LIVE
  // pose into a slot and `GET preset` returns it in degrees. Save-to-scratch
  // → read → delete is therefore a pose sensor (measured 2026-09-30: it
  // caught a 7.9° yaw move exactly). The scratch slot must be EMPTY — save
  // overwrites and there is no pose-by-value write to restore a clobbered
  // preset, so a full preset bank is a hard error, not a guess.

  /** Marker name for pose-probe scratch slots, so crashed probes are reusable. */
  static readonly POSE_PROBE_NAME = "pose-probe";

  async readPose(verify: VerifyOpts = {}): Promise<Pose> {
    let scratch: number | undefined;
    const list = await this.presetsGet();
    // A leftover probe slot from a crashed run is ours by name — delete it
    // first and wait for it to be GONE, so the freshness check below (slot
    // APPEARS after our save) cannot match its stale contents.
    const leftover = list.find((p) => p.name === Tail2Api.POSE_PROBE_NAME);
    if (leftover) {
      await this.presetOp("delete", leftover.id);
      await this.verified(
        () => this.presetsGet(),
        (l) => !l.some((x) => x.id === leftover.id),
        { attempts: 6, delayMs: 350, ...verify },
      );
    }
    const fresh = await this.presetsGet();
    const used = new Set(fresh.map((p) => p.id));
    scratch = [0, 1, 2].find((id) => !used.has(id));
    if (scratch === undefined) {
      throw new Error(
        "all three preset slots are occupied — the pose read needs an empty scratch slot. " +
          "Delete one preset (obsbot_tail2_preset_delete) and retry.",
      );
    }
    try {
      await this.presetOp("set", scratch, Tail2Api.POSE_PROBE_NAME);
      const v = await this.verified(
        () => this.presetsGet(),
        (l) => {
          const p = l.find((x) => x.id === scratch);
          return p !== undefined && p.name === Tail2Api.POSE_PROBE_NAME;
        },
        { attempts: 8, delayMs: 350, ...verify },
      );
      const p = v.value.find((x) => x.id === scratch);
      if (!p) throw new Error("pose probe: the scratch slot vanished before it could be read");
      return { yaw: p.yaw, pitch: p.pitch, roll: p.roll, ratio: p.ratio };
    } finally {
      // Best-effort cleanup; must not mask the pose result.
      await this.presetOp("delete", scratch).catch(() => {});
    }
  }

  // ---- rotation (no Tiny 2 equivalent) --------------------------------------

  /**
   * Motorized 90° barrel rotation. Verified against the WS push rather than a
   * REST readback (none exists) — and the readback MUST be tolerant of the
   * motor taking ~1.5s, plus the swallowed-write hazard during motion.
   */
  async portraitSet(
    enable: boolean,
    verify: VerifyOpts = {},
  ): Promise<{ settled: boolean; switch_portrait: boolean }> {
    await this.send("POST", "/camera/sdk/switch_portrait", { enable });
    const v = await this.verified(
      () => this.status(),
      (s) => s.switch_portrait === enable,
      { attempts: 12, delayMs: 450, ...verify },
    );
    return { settled: v.settled, switch_portrait: v.value.switch_portrait === true };
  }

  rollBiasGet(): Promise<{ angle: number }> {
    return this.req<{ angle: number }>("GET", "/camera/sdk/ptz/rollbias");
  }

  /** Roll trim in degrees. MEASURED write + readback 2026-09-26. */
  async rollBiasSet(
    angle: number,
    verify: VerifyOpts = {},
  ): Promise<{ settled: boolean; angle: number }> {
    await this.send("PUT", "/camera/sdk/ptz/rollbias", { angle });
    const v = await this.verified(
      () => this.rollBiasGet(),
      (r) => Math.abs(r.angle - angle) <= 0.01,
      verify,
    );
    return { settled: v.settled, angle: v.value.angle };
  }

  // ---- AI tracking -----------------------------------------------------------

  aiModeGet(): Promise<{ mode: string }> {
    return this.req<{ mode: string }>("GET", "/camera/sdk/ai/workmode");
  }

  /**
   * `mode` strings are the camera's own enum (bundle-verified, TAIL2-PROTOCOL
   * §3): none | humanTrackingSingleMode | humanTrackingGroupMode |
   * animalTrackingNormal | animalTrackingCloseUp | objectTracking |
   * objectTrackingNormal | objectTrackingCloseUp.
   */
  async aiModeSet(
    mode: string,
    verify: VerifyOpts = {},
  ): Promise<{ settled: boolean; mode: string }> {
    await this.send("PUT", "/camera/sdk/ai/workmode", { mode });
    const v = await this.verified(() => this.aiModeGet(), (r) => r.mode === mode, verify);
    return { settled: v.settled, mode: v.value.mode };
  }

  trackSpeedGet(): Promise<{ speed: string }> {
    return this.req<{ speed: string }>("GET", "/camera/sdk/ai/trackspeed");
  }

  /**
   * The Tail 2's own six-speed enum (bundle-verified): superLazy | lazy |
   * slow | fast | crazy | customized. NOT the Tiny 2's standard/sport pair.
   */
  async trackSpeedSet(
    speed: string,
    verify: VerifyOpts = {},
  ): Promise<{ settled: boolean; speed: string }> {
    await this.send("PUT", "/camera/sdk/ai/trackspeed", { speed });
    const v = await this.verified(() => this.trackSpeedGet(), (r) => r.speed === speed, verify);
    return { settled: v.settled, speed: v.value.speed };
  }

  // ---- presets ----------------------------------------------------------------

  /**
   * A saved pose: angles in DEGREES plus zoom ratio — the same units the
   * tools speak. `name` is base64 on the wire; encode/decode lives here so
   * callers never see it raw.
   */
  async presetsGet(): Promise<Preset[]> {
    const r = await this.req<{ presetList?: Array<{ id: number; pitch: number; yaw: number; roll: number; ratio: number; name: string }> }>(
      "GET",
      "/camera/sdk/ptz/preset",
    );
    return (r.presetList ?? []).map((p) => ({ ...p, name: b64decode(p.name) }));
  }

  /**
   * `PUT ptz/preset {"operation": ..., "id": ..., "name": base64}` — one
   * endpoint, four operations (grammar decoded from the camera's own web
   * bundle and hardware-verified 2026-09-26; see TAIL2-PROTOCOL.md §3).
   * IDs are 0-based (0–2); the tools expose 1-based slots for consistency
   * with the Tiny 2's preset tools.
   *
   * `set` saves the CURRENT live pose — there is NO explicit-pose write
   * anywhere in this API (measured), and `set` on an occupied slot
   * OVERWRITES it (unlike the Tiny 2's create-once slots).
   */
  private async presetOp(
    operation: "set" | "call" | "delete" | "rename",
    id: number,
    name?: string,
  ): Promise<void> {
    await this.send("PUT", "/camera/sdk/ptz/preset", {
      operation,
      id,
      ...(name !== undefined ? { name: b64encode(name) } : {}),
    });
  }

  /**
   * Save the current live pose into slot `id`. The preset LIST lags the
   * write by up to ~1s (measured), so verification is a ladder, and the
   * pose itself can't be verified at all — the camera reports no live pose,
   * so "the slot exists afterwards" is the honest success criterion.
   */
  async presetSave(id: number, name: string, verify: VerifyOpts = {}): Promise<{ settled: boolean; presets: Preset[] }> {
    await this.presetOp("set", id, name);
    const v = await this.verified(
      () => this.presetsGet(),
      (list) => list.some((p) => p.id === id),
      { attempts: 6, delayMs: 350, ...verify },
    );
    return { settled: v.settled, presets: v.value };
  }

  /**
   * Recall slot `id`. Physical arrival is verifiable through exactly one
   * observable: the preset's zoom ratio landing in the live zoom_ratio (the
   * WS push carries it). The gimbal axes themselves are open-loop.
   */
  async presetRecall(id: number, verify: VerifyOpts = {}): Promise<{ settled: boolean; zoom: number }> {
    const target = (await this.presetsGet()).find((p) => p.id === id);
    if (!target) throw new Error(`preset slot ${id} is empty — nothing to recall`);
    await this.presetOp("call", id);
    const v = await this.verified(
      () => this.zoomGet(),
      (r) => Math.abs(r.ratio - target.ratio) <= 0.05,
      { attempts: 14, delayMs: 450, ...verify },
    );
    return { settled: v.settled, zoom: v.value.ratio };
  }

  async presetDelete(id: number, verify: VerifyOpts = {}): Promise<{ settled: boolean; presets: Preset[] }> {
    await this.presetOp("delete", id);
    const v = await this.verified(
      () => this.presetsGet(),
      (list) => !list.some((p) => p.id === id),
      { attempts: 6, delayMs: 350, ...verify },
    );
    return { settled: v.settled, presets: v.value };
  }

  async presetRename(id: number, name: string, verify: VerifyOpts = {}): Promise<{ settled: boolean; presets: Preset[] }> {
    await this.presetOp("rename", id, name);
    const v = await this.verified(
      () => this.presetsGet(),
      (list) => (list.find((p) => p.id === id)?.name ?? null) === name,
      { attempts: 6, delayMs: 350, ...verify },
    );
    return { settled: v.settled, presets: v.value };
  }
}
