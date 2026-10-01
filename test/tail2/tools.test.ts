import { describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { createTail2Tools } from "../../src/tail2/tools.js";
import { Tail2Registry } from "../../src/tail2/registry.js";
import type { Tail2Api } from "../../src/tail2/api.js";

/**
 * Tool-layer tests against a state-driven fake Tail2Api: the fake records
 * what it was asked to write and controls whether the readback catches up,
 * so each tool's verify-and-report contract (settled vs throw) is exercised
 * without HTTP at all. The HTTP+WS behaviour itself is pinned in api.test.ts
 * against a real fake server.
 */

interface FakeTail2 {
  api: Tail2Api;
  calls: { zoom?: [number, number]; aiMode?: string; trackSpeed?: string; rollBias?: number; portrait?: boolean; recenter?: boolean; presetSave?: [number, string]; presetCall?: number; presetDelete?: number; presetRename?: [number, string]; srtEnabled?: boolean; ndiEnabled?: boolean; gimbalSpeed?: [number, number, number]; gimbalStop?: boolean; gimbalInvert?: boolean; gimbalPose?: { yaw: number; pitch: number; roll: number; ratio: number }; tapTarget?: [number, number]; zoomType?: string; presetSpeed?: number; usbMode?: string; antiFlicker?: string; afTrack?: string; isoRange?: { isomin: number; isomax: number } };
  /** State for the 2026-09-30 vendor-doc surface (record/focus/exposure/image/stream/audio). */
  st: {
    recording: boolean;
    captures: number;
    focusMode: "afc" | "afs" | "mf";
    focusPosition: number;
    focusWindow: { x: number; y: number };
    exposureMode: "manual" | "auto";
    exposureAutoMode: "global" | "face";
    evbias: number;
    iso: number;
    shutter: string;
    styleMode: string;
    style: Record<string, number>;
    hdr: boolean;
    wbMode: string;
    wbTemp: number;
    stream: "ndi" | "rtsp" | "srt" | "off";
    onlyMe: boolean;
    volume: number;
    audioMute: boolean;
  };
  /** When false, readbacks never reflect writes - everything settles:false. */
  letWritesLand: boolean;
}

const makeFake = (): FakeTail2 => {
  const f: FakeTail2 = {
    calls: {},
    letWritesLand: true,
    api: {} as Tail2Api,
    st: {
      recording: false,
      captures: 0,
    focusMode: "afc",
    focusPosition: 40,
    focusWindow: { x: 0.452, y: 0.616 },
      exposureMode: "auto",
      exposureAutoMode: "global",
      evbias: 0,
      iso: 894,
      shutter: "1/100",
      styleMode: "standard",
      style: { brightness: 50, contrast: 50, hue: 50, saturation: 50, sharpness: 50 },
      hdr: false,
      wbMode: "auto",
      wbTemp: 3000,
      stream: "ndi",
      onlyMe: true,
      volume: 50,
      audioMute: true,
    },
  };
  const landed = <T>(v: T): T => {
    if (!f.letWritesLand) throw new Error("readback frozen");
    return v;
  };
  const saved = (): Array<{ id: number; pitch: number; yaw: number; roll: number; ratio: number; name: string }> => {
    const mk = (id: number, name: string, ratio: number) => ({ id, pitch: -0.96, yaw: 2.57, roll: 0.88, ratio, name });
    const list = [mk(0, "Default", 1.4)];
    if (f.calls.presetSave) list.push(mk(f.calls.presetSave[0], f.calls.presetSave[1], 3.0));
    return list;
  };
  f.api = {
    info: async () => ({ device_name: "Tail 2_test", wired_ip: "h", wireless_ip: "0.0.0.0", mac: "aa:aa:aa:aa:aa:aa" }),
    status: async () =>
      landed({
        power_on: true,
        switch_portrait: f.calls.portrait ?? false,
        zoom_ratio: 2,
        ai_mode: "humanTrackingSingleMode",
        ndi: { enable: f.calls.ndiEnabled ?? true },
        srt: { enable: f.calls.srtEnabled ?? true },
      }),
    ranges: async () => landed({ zoom: { zoom_min: 1, zoom_max: 12 } }),
    networkConfig: async () => landed({ ndi_enable: true }),
    imageState: async () => landed({}),
    zoomGet: async () => landed({ ratio: f.calls.zoom?.[0] ?? 2 }),
    zoomSet: async (ratio: number, speed: number) => {
      f.calls.zoom = [ratio, speed];
      return landed({ settled: true, ratio });
    },
    recenter: async () => {
      f.calls.recenter = true;
    },
    portraitSet: async (enable: boolean) => {
      f.calls.portrait = enable;
      return landed({ settled: true, switch_portrait: enable });
    },
    rollBiasGet: async () => landed({ angle: f.calls.rollBias ?? 0 }),
    rollBiasSet: async (angle: number) => {
      f.calls.rollBias = angle;
      return landed({ settled: true, angle });
    },
    aiModeGet: async () => landed({ mode: f.calls.aiMode ?? "humanTrackingSingleMode" }),
    aiModeSet: async (mode: string) => {
      f.calls.aiMode = mode;
      return landed({ settled: true, mode });
    },
    trackSpeedGet: async () => landed({ speed: f.calls.trackSpeed ?? "slow" }),
    trackSpeedSet: async (speed: string) => {
      f.calls.trackSpeed = speed;
      return landed({ settled: true, speed });
    },
    presetsGet: async () => landed(saved()),
    presetSave: async (id: number, name: string) => {
      f.calls.presetSave = [id, name];
      return landed({ settled: true, presets: saved() });
    },
    presetRecall: async (id: number) => {
      f.calls.presetCall = id;
      return landed({ settled: true, zoom: 3.0 });
    },
    presetDelete: async (id: number) => {
      f.calls.presetDelete = id;
      return landed({ settled: true, presets: saved() });
    },
    presetRename: async (id: number, name: string) => {
      f.calls.presetRename = [id, name];
      return landed({ settled: true, presets: saved() });
    },
    readPose: async () =>
      landed(f.calls.gimbalPose ?? { yaw: 0.4, pitch: 1.6, roll: 0, ratio: 2 }),
    gimbalSpeed: async (yaw: number, pitch: number, roll: number) => {
      f.calls.gimbalSpeed = [yaw, pitch, roll];
    },
    gimbalStop: async () => {
      f.calls.gimbalStop = true;
    },
    gimbalInvertGet: async () => landed({ enable: f.calls.gimbalInvert ?? false }),
    gimbalInvertSet: async (enable: boolean) => {
      f.calls.gimbalInvert = enable;
      return landed({ settled: true, enable });
    },
    // The 2026-09-30 vendor-doc surface: uniform get/set pairs over a state
    // object; capture counts triggers.
    recordGet: async () => landed({ recording: f.st.recording ? "on" : "off" }),    recordSet: async (on: boolean) => {
      f.st.recording = on;
      return landed({ settled: true, recording: on ? "on" : "off" });
    },
    captureTrigger: async () => {
      f.st.captures++;
    },
    // The 2026-10-01 probe batch: get returns current, set records + verifies.
    zoomTypeGet: async () => landed({ type: f.calls.zoomType ?? "shot" }),
    zoomTypeSet: async (type: string) => {
      f.calls.zoomType = type;
      return landed({ settled: true, type });
    },
    presetSpeedGet: async () => landed({ speed: f.calls.presetSpeed ?? 5 }),
    presetSpeedSet: async (speed: number) => {
      f.calls.presetSpeed = speed;
      return landed({ settled: true, speed });
    },
    usbModeGet: async () => landed({ mode: f.calls.usbMode ?? "mtp" }),
    usbModeSet: async (mode: string) => {
      f.calls.usbMode = mode;
      return landed({ settled: true, mode });
    },
    antiFlickerGet: async () => landed({ mode: f.calls.antiFlicker ?? "60hz" }),
    antiFlickerSet: async (mode: "off" | "50hz" | "60hz") => {
      f.calls.antiFlicker = mode;
      return landed({ settled: true, mode });
    },
    afTrackGet: async () => landed({ mode: f.calls.afTrack ?? "face" }),
    afTrackSet: async (mode: string) => {
      f.calls.afTrack = mode;
      return landed({ settled: true, mode });
    },
    isoRangeGet: async () => landed(f.calls.isoRange ?? { isomin: 100, isomax: 6400 }),
    isoRangeSet: async (isomin: number, isomax: number) => {
      f.calls.isoRange = { isomin, isomax };
      return landed({ settled: true, isomin, isomax });
    },
    gestureLockedTargetGet: async () => landed({ enable: true }),
    gestureLockedTargetSet: async (enable: boolean) => landed({ settled: true, enable }),
    gestureRecordingGet: async () => landed({ enable: true }),
    gestureRecordingSet: async (enable: boolean) => landed({ settled: true, enable }),
    gestureZoomGet: async () => landed({ enable: true }),
    gestureZoomSet: async (enable: boolean) => landed({ settled: true, enable }),
    gestureZoomFactorGet: async () => landed({ factor: 2.0 }),
    gestureZoomFactorSet: async (factor: number) => landed({ settled: true, factor }),
    streamEncoderGet: async () => landed({ encoder: "h264" }),
    streamEncoderSet: async (encoder: string) => landed({ settled: true, encoder }),
    streamResolutionGet: async () => landed({ resolution: "1920X1080P30" }),
    streamResolutionSet: async (resolution: string) => landed({ settled: true, resolution }),
    streamBitrateGet: async () => landed({ bitrate: 20.0 }),
    streamBitrateSet: async (bitrate: number) => landed({ settled: true, bitrate }),
    rtspUrlsGet: async () => landed({ wiredNetwork: { mainStreamUrl: "rtsp://x/stream1" } }),
    exportLog: async () => Buffer.from("tarball-bytes"),
    liveStatus: async () =>
      landed({
        status: {
          device: {
            gimbal_status: { status: { x_euler_angle: 0.5, y_euler_angle: 1, z_euler_angle: 2 }, attitude: "REMO_BASE_LANDSCAPE" },
            lens_status: { temperature: 36 },
            battery_status: { capacity: 100, voltage: 8248, temperature: 41, charging: 0 },
          },
          sync_push: {
            media_status: { zoom_infos: { digital_enable: true, zoom_setting_min: 100, zoom_setting_max: 1200, zoom_setting_current: 250, manual_zoom_speed: 7 } },
            iq_status: { exposure_params: { runtime_shutter: "1/40", runtime_iso: 2776 } },
            dev_status: { basepan_status: { basepan_joint_angle: 0 }, remote_status: { charging: false, capacity: 80 } },
          },
          init: { stage: "REMO_INIT_STAGE_DONE", poweron_pts: 26360 },
        },
      }),
    focusModeGet: async () => landed({ mode: f.st.focusMode }),
    focusModeSet: async (mode: "afc" | "afs" | "mf") => {
      f.st.focusMode = mode;
      return landed({ settled: true, mode });
    },
    focusWindowGet: async () => landed({ ...f.st.focusWindow }),
    focusWindowSet: async (x: number, y: number) => {
      if (f.st.focusMode === "mf") throw new Error("HTTP 500 (mode-gated)");
      f.st.focusWindow = { x, y };
      return landed({ settled: true, x, y });
    },
    targetSelect: async (x: number, y: number) => {
      f.calls.tapTarget = [x, y];
      f.calls.aiMode = "humanTrackingSingleMode";
    },
    focusPositionGet: async () => {
      if (f.st.focusMode !== "mf") throw new Error("HTTP 500 (mode-gated)");
      return landed({ position: f.st.focusPosition });
    },
    focusPositionSet: async (position: number) => {
      if (f.st.focusMode !== "mf") throw new Error("HTTP 500 (mode-gated)");
      f.st.focusPosition = position;
      return landed({ settled: true, position });
    },
    exposureModeGet: async () => landed({ mode: f.st.exposureMode }),
    exposureModeSet: async (mode: "manual" | "auto") => {
      f.st.exposureMode = mode;
      return landed({ settled: true, mode });
    },
    exposureAutoModeGet: async () => landed({ mode: f.st.exposureAutoMode }),
    exposureAutoModeSet: async (mode: "global" | "face") => {
      f.st.exposureAutoMode = mode;
      return landed({ settled: true, mode });
    },
    exposureEvbiasGet: async () => landed({ evbias: f.st.evbias }),
    exposureEvbiasSet: async (evbias: number) => {
      f.st.evbias = evbias;
      return landed({ settled: true, evbias });
    },
    exposureIsoGet: async () => {
      if (f.st.exposureMode !== "manual") throw new Error("HTTP 500 (mode-gated)");
      return landed({ iso: f.st.iso });
    },
    exposureIsoSet: async (iso: number) => {
      if (f.st.exposureMode !== "manual") throw new Error("HTTP 500 (mode-gated)");
      f.st.iso = iso;
      return landed({ settled: true, iso });
    },
    exposureShutterGet: async () => {
      if (f.st.exposureMode !== "manual") throw new Error("HTTP 500 (mode-gated)");
      return landed({ shutter: f.st.shutter });
    },
    exposureShutterSet: async (shutter: string) => {
      if (f.st.exposureMode !== "manual") throw new Error("HTTP 500 (mode-gated)");
      f.st.shutter = shutter;
      return landed({ settled: true, shutter });
    },
    styleGet: async () => landed({ mode: f.st.styleMode, ...f.st.style }),
    styleSet: async (control: string, value: number) => {
      f.st.style[control] = value;
      return landed({ settled: true, value, mode: f.st.styleMode });
    },
    styleModeSet: async (mode: "standard" | "outdoor" | "pastel" | "manual") => {
      f.st.styleMode = mode;
      return landed({ settled: true, mode });
    },
    hdrGet: async () => landed({ control: f.st.hdr ? "on" : "off" }),
    hdrSet: async (on: boolean) => {
      f.st.hdr = on;
      return landed({ settled: true, control: on ? "on" : "off" });
    },
    wbConfigGet: async () => landed({ mode: f.st.wbMode, temperature: f.st.wbTemp }),
    wbConfigSet: async (mode: string, temperature: number | undefined) => {
      f.st.wbMode = mode;
      if (temperature !== undefined) f.st.wbTemp = temperature;
      return landed({ settled: true, mode, temperature: f.st.wbTemp });
    },
    streamControlGet: async () => landed({ control: f.st.stream }),
    streamControlSet: async (control: "ndi" | "rtsp" | "srt" | "off") => {
      f.st.stream = control;
      return landed({ settled: true, control });
    },
    onlyMeGet: async () => landed({ enable: f.st.onlyMe }),
    onlyMeSet: async (enable: boolean) => {
      f.st.onlyMe = enable;
      return landed({ settled: true, enable });
    },
    audioVolumeGet: async () => landed({ volume: f.st.volume }),
    audioVolumeSet: async (volume: number) => {
      f.st.volume = volume;
      return landed({ settled: true, volume });
    },
    audioMuteGet: async () => landed({ enable: f.st.audioMute }),
    audioMuteSet: async (enable: boolean) => {
      f.st.audioMute = enable;
      return landed({ settled: true, enable });
    },
  } as unknown as Tail2Api;
  return f;
};

/** Registry pre-seeded with the fake as its only camera. */
const seededRegistry = async (f: FakeTail2): Promise<Tail2Registry> => {
  const reg = new Tail2Registry({
    makeApi: () => f.api,
    probeTimeoutMs: 500,
  });
  // addHost probes via api.info(); the fake answers as a Tail 2.
  await reg.addHost("192.168.0.10");
  return reg;
};

const tool = (tools: ReturnType<typeof createTail2Tools>, name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
};

describe("tail2 tools", () => {
  it("advertises the full family with unique names", async () => {
    const tools = createTail2Tools(await seededRegistry(makeFake()));
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of [
      "obsbot_tail2_devices",
      "obsbot_tail2_scan",
      "obsbot_tail2_status",
      "obsbot_tail2_info",
      "obsbot_tail2_zoom",
      "obsbot_tail2_recenter",
      "obsbot_tail2_portrait",
      "obsbot_tail2_roll_bias",
      "obsbot_tail2_ai_track",
      "obsbot_tail2_track_speed",
      "obsbot_tail2_preset_list",
      "obsbot_tail2_preset_save",
      "obsbot_tail2_preset_recall",
      "obsbot_tail2_preset_delete",
      "obsbot_tail2_preset_rename",
      "obsbot_tail2_gimbal_position",
      "obsbot_tail2_gimbal_speed",
      "obsbot_tail2_gimbal_move",
      "obsbot_tail2_gimbal_invert",
      "obsbot_tail2_record",
      "obsbot_tail2_capture_photo",
      "obsbot_tail2_focus",
      "obsbot_tail2_exposure",
      "obsbot_tail2_image_adjust",
      "obsbot_tail2_hdr",
      "obsbot_tail2_wb",
      "obsbot_tail2_stream",
      "obsbot_tail2_only_me",
      "obsbot_tail2_audio",
      "obsbot_tail2_track_target",
      "obsbot_tail2_focus_point",
      "obsbot_tail2_hybrid_zoom",
      "obsbot_tail2_zoom_type",
      "obsbot_tail2_preset_speed",
      "obsbot_tail2_usb_mode",
      "obsbot_tail2_antiflicker",
      "obsbot_tail2_af_track",
      "obsbot_tail2_iso_range",
      "obsbot_tail2_gesture",
      "obsbot_tail2_stream_config",
      "obsbot_tail2_export_log",
      "obsbot_tail2_live_status",
      "obsbot_tail2_zone_tracking",
      "obsbot_tail2_auto_zoom_speed",
      "obsbot_tail2_track_custom",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("devices lists the registered camera", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_devices").handler({})) as {
      cameras: Array<{ mac: string }>;
    };
    expect(r.cameras).toEqual([
      { mac: "aa:aa:aa:aa:aa:aa", name: "Tail 2_test", hosts: ["192.168.0.10"] },
    ]);
  });

  it("status returns the camera mac plus the status block", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_status").handler({})) as Record<string, unknown>;
    expect(r.camera).toBe("aa:aa:aa:aa:aa:aa");
    expect(r.power_on).toBe(true);
    expect(r.ndi).toEqual({ enable: true });
  });

  it("hybrid zoom synthesizes the frame, sends to the first host, and verifies by digital_enable readback", async () => {
    const f = makeFake();
    const reg = await seededRegistry(f);
    // Readback state the fake serves: starts enabled, flips when written.
    let digitalEnable = true;
    (f.api as { hybridZoomEnabled: () => Promise<boolean | undefined> }).hybridZoomEnabled = async () => digitalEnable;
    const sent: Array<{ host: string; frame: Buffer }> = [];
    const tools = createTail2Tools(reg, undefined, async (host, frame) => {
      sent.push({ host, frame });
      digitalEnable = frame[25] === 0x01;
    });
    const t = tool(tools, "obsbot_tail2_hybrid_zoom");
    const on = (await t.handler({ enabled: true })) as { ok: boolean; enabled: boolean; settled: boolean };
    const off = (await t.handler({ enabled: false, camera: "aa:aa:aa:aa:aa:aa" })) as {
      ok: boolean;
      enabled: boolean;
      settled: boolean;
    };
    expect(on).toMatchObject({ ok: true, enabled: true, settled: true });
    expect(off).toMatchObject({ ok: true, enabled: false, settled: true });
    // Both writes went to the registry entry's first host, frames in order.
    expect(sent.map((s) => s.host)).toEqual(["192.168.0.10", "192.168.0.10"]);
    expect(sent[0]!.frame.subarray(0, 2)).toEqual(Buffer.from([0xaa, 0x25]));
    // ON then OFF differ in the TLV (checksum + boolean), same command path.
    expect(sent[0]!.frame.subarray(8, 12)).toEqual(sent[1]!.frame.subarray(8, 12));
    expect(sent[0]!.frame[25]).toBe(0x01);
    expect(sent[1]!.frame[25]).toBe(0x00);
  });

  it("hybrid zoom reports settled:false when the readback never agrees (write still sent)", async () => {
    const f = makeFake();
    const reg = await seededRegistry(f);
    (f.api as { hybridZoomEnabled: () => Promise<boolean | undefined> }).hybridZoomEnabled = async () => false;
    const sent: Array<{ host: string; frame: Buffer }> = [];
    const tools = createTail2Tools(reg, undefined, async (host, frame) => {
      sent.push({ host, frame });
    });
    const r = (await tool(tools, "obsbot_tail2_hybrid_zoom").handler({ enabled: true })) as {
      ok: boolean;
      settled: boolean;
    };
    expect(r).toMatchObject({ ok: true, settled: false });
    expect(sent).toHaveLength(1); // exactly one write; retries are readback-only
  });

  it("the 2026-10-01 probe-batch tools read bare and write dispatch", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const call = async (name: string, args: unknown) => tool(tools, name).handler(args);

    // Bare reads.
    expect(await call("obsbot_tail2_zoom_type", {})).toEqual({ type: "shot" });
    expect(await call("obsbot_tail2_gesture", {})).toEqual({
      lockedTarget: true, recording: true, zoom: true, zoomFactor: 2.0,
    });
    const sc = (await call("obsbot_tail2_stream_config", {})) as Record<string, unknown>;
    expect(sc.encoder).toBe("h264");
    expect(sc.rtspUrls).toBeDefined();

    // Writes dispatch and verify.
    expect(await call("obsbot_tail2_zoom_type", { type: "P9" })).toMatchObject({ ok: true, type: "P9" });
    expect(f.calls.zoomType).toBe("P9");
    expect(await call("obsbot_tail2_preset_speed", { speed: 3 })).toMatchObject({ ok: true, speed: 3 });
    expect(await call("obsbot_tail2_usb_mode", { mode: "uvc" })).toMatchObject({ ok: true, mode: "uvc" });
    expect(await call("obsbot_tail2_antiflicker", { mode: "50hz" })).toMatchObject({ ok: true, mode: "50hz" });
    expect(await call("obsbot_tail2_af_track", { mode: "front" })).toMatchObject({ ok: true, mode: "front" });
    // ISO range: one-sided writes keep the current other bound.
    await call("obsbot_tail2_iso_range", { min: 200 });
    expect(f.calls.isoRange).toEqual({ isomin: 200, isomax: 6400 });
    // Gesture: per-field writes.
    const g = (await call("obsbot_tail2_gesture", { lockedTarget: false, zoomFactor: 3.5 })) as Record<string, unknown>;
    expect(g.lockedTarget).toMatchObject({ settled: true, enable: false });
    expect(g.zoomFactor).toMatchObject({ settled: true, factor: 3.5 });

    // live_status distills the nested tree.
    const ls = (await call("obsbot_tail2_live_status", {})) as {
      gimbal: { euler: { x?: number } };
      zoom: { hybridDigitalEnable?: boolean; settingMax?: number };
      power: { batteryCapacity?: number; bootStage?: string };
    };
    expect(ls.gimbal.euler.x).toBe(0.5);
    expect(ls.zoom.hybridDigitalEnable).toBe(true);
    expect(ls.zoom.settingMax).toBe(1200);
    expect(ls.power.batteryCapacity).toBe(100);
    expect(ls.power.bootStage).toBe("REMO_INIT_STAGE_DONE");
  });

  it("export_log saves the bundle to the requested path", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const path = pathJoin(tmpdir(), `obsbot-export-test-${Date.now()}.tar.gz`);
    try {
      const r = (await tool(tools, "obsbot_tail2_export_log").handler({ path })) as { ok: boolean; bytes: number };
      expect(r.ok).toBe(true);
      expect(r.bytes).toBeGreaterThan(0);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("the KV tools synthesize 4454 frames with the right keys", async () => {
    const f = makeFake();
    const reg = await seededRegistry(f);
    const sent: Buffer[] = [];
    const tools = createTail2Tools(reg, undefined, async (_host, frame) => {
      sent.push(frame);
    });
    const call = (name: string, args: unknown) => tool(tools, name).handler(args);

    const z = (await call("obsbot_tail2_zone_tracking", { enabled: true })) as { ok: boolean; enabled: boolean };
    expect(z).toMatchObject({ ok: true, enabled: true });
    const s = (await call("obsbot_tail2_auto_zoom_speed", { speed: 6 })) as { ok: boolean; speed: number };
    expect(s).toMatchObject({ ok: true, speed: 6 });
    // zone: key 3 bool4B (36-byte frame); autoZoomSpeed: key 0x17 int (36)
    expect(sent[0]!.length).toBe(36);
    expect(sent[0]!.readUInt32LE(28)).toBe(0x03); // key
    expect(sent[0]!.readUInt32LE(32)).toBe(1); // value
    expect(sent[1]!.readUInt32LE(28)).toBe(0x17);
    expect(sent[1]!.readUInt32LE(32)).toBe(6);

    // track_custom writes: enable + pan (float /10) + tilt + autos (1-byte bools)
    const c = (await call("obsbot_tail2_track_custom", {
      enabled: true, pan: 4, tilt: 6, panAuto: true, tiltAuto: false,
    })) as { ok: boolean; readback?: unknown };
    expect(c.ok).toBe(true);
    expect(c.readback).toBeDefined();
    // frames 2..6: enable(36), pan(36), tilt(36), panAuto(33), tiltAuto(33)
    expect(sent.slice(2).map((b) => b.length)).toEqual([36, 36, 36, 33, 33]);
    expect(sent[3]!.readUInt32LE(28)).toBe(0x07); // pan key
    expect(sent[4]!.readUInt32LE(28)).toBe(0x0a); // tilt key
    // pan float 0.4f lands in the tail
    expect(sent[3]!.subarray(-4).toString("hex")).toBe("cdcccc3e");
  });

  it("zoom writes ratio+speed and reports settled", async () => {    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_zoom").handler({ ratio: "4.5", speed: "3" })) as {
      ok: boolean;
      ratio: number;
      settled: boolean;
    };
    // String-encoded args (defensive coercion) must land as numbers.
    expect(f.calls.zoom).toEqual([4.5, 3]);
    expect(r).toMatchObject({ ok: true, ratio: 4.5, settled: true });
  });

  it("zoom applies the documented default speed when omitted", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await tool(tools, "obsbot_tail2_zoom").handler({ ratio: 2 });
    expect(f.calls.zoom).toEqual([2, 5]);
  });

  it("zoom rejects out-of-range ratios at the schema", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await expect(tool(tools, "obsbot_tail2_zoom").handler({ ratio: 12.5 })).rejects.toThrow();
    await expect(tool(tools, "obsbot_tail2_zoom").handler({ ratio: 0.5 })).rejects.toThrow();
  });

  it("recenter acks open-loop", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = await tool(tools, "obsbot_tail2_recenter").handler({});
    expect(f.calls.recenter).toBe(true);
    expect(r).toEqual({ ok: true });
  });

  it("portrait enable/disable reaches the api and reports orientation", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_portrait").handler({ enable: true })) as {
      portrait: boolean;
      settled: boolean;
    };
    expect(f.calls.portrait).toBe(true);
    expect(r).toMatchObject({ ok: true, portrait: true, settled: true });
  });

  it("roll bias clamps at the schema and reports the readback angle", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_roll_bias").handler({ angle: -30 })) as {
      angle: number;
      settled: boolean;
    };
    expect(r).toMatchObject({ ok: true, angle: -30, settled: true });
    await expect(tool(tools, "obsbot_tail2_roll_bias").handler({ angle: 120 })).rejects.toThrow();
  });

  it("ai_track enabled:true writes the chosen mode; enabled:false writes none", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await tool(tools, "obsbot_tail2_ai_track").handler({
      enabled: true,
      mode: "objectTrackingNormal",
    });
    expect(f.calls.aiMode).toBe("objectTrackingNormal");
    await tool(tools, "obsbot_tail2_ai_track").handler({ enabled: false, mode: "objectTrackingNormal" });
    expect(f.calls.aiMode).toBe("none");
  });

  it("ai_track defaults to single-human mode", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await tool(tools, "obsbot_tail2_ai_track").handler({ enabled: true });
    expect(f.calls.aiMode).toBe("humanTrackingSingleMode");
  });

  it("track_speed accepts only the camera's own enum", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await tool(tools, "obsbot_tail2_track_speed").handler({ speed: "crazy" });
    expect(f.calls.trackSpeed).toBe("crazy");
    await expect(
      tool(tools, "obsbot_tail2_track_speed").handler({ speed: "sport" }),
    ).rejects.toThrow(); // Tiny 2 speed names are NOT Tail 2 speeds
  });

  it("gimbal_position reports the pose from the probe", async () => {
    const f = makeFake();
    f.calls.gimbalPose = { yaw: 10.4, pitch: -21.3, roll: 0.39, ratio: 4 };
    const tools = createTail2Tools(await seededRegistry(f));
    const r = await tool(tools, "obsbot_tail2_gimbal_position").handler({});
    expect(r).toEqual({ yaw: 10.4, pitch: -21.3, roll: 0.39, ratio: 4 });
  });

  it("gimbal_speed drives the given axes and always stops", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_gimbal_speed").handler({
      yaw: -20,
      durationMs: 120,
    })) as { ok: boolean; stopped: boolean };
    expect(r.ok).toBe(true);
    expect(r.stopped).toBe(true);
    expect(f.calls.gimbalSpeed).toEqual([-20, 0, 0]);
    expect(f.calls.gimbalStop).toBe(true);
    await expect(tool(tools, "obsbot_tail2_gimbal_speed").handler({})).rejects.toThrow(
      /at least one of yaw, pitch, roll/,
    );
  });

  it("gimbal_move refuses while AI tracking is active and moves when it is not", async () => {
    const f = makeFake();
    f.calls.aiMode = "humanTrackingSingleMode"; // default fake state
    const tools = createTail2Tools(await seededRegistry(f));
    await expect(tool(tools, "obsbot_tail2_gimbal_move").handler({ yaw: 0 })).rejects.toThrow(
      /ai_track with enabled:false/,
    );

    f.calls.aiMode = "none";
    // Pose already within tolerance of the target: zero iterations, converged.
    f.calls.gimbalPose = { yaw: 1.0, pitch: 0, roll: 0, ratio: 2 };
    const r = (await tool(tools, "obsbot_tail2_gimbal_move").handler({ yaw: 0 })) as {
      converged: boolean;
      iterations: number;
    };
    expect(r.converged).toBe(true);
    expect(r.iterations).toBe(0);
    await expect(tool(tools, "obsbot_tail2_gimbal_move").handler({})).rejects.toThrow(
      /at least one of yaw, pitch/,
    );
  });

  it("gimbal_invert reads bare and writes verified", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    expect(await tool(tools, "obsbot_tail2_gimbal_invert").handler({})).toEqual({ enable: false });
    const r = await tool(tools, "obsbot_tail2_gimbal_invert").handler({ enable: true });
    expect(r).toEqual({ ok: true, settled: true, enable: true });
    expect(f.calls.gimbalInvert).toBe(true);
  });

  it("record reads bare, writes on/off; capture_photo triggers", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    expect(await tool(tools, "obsbot_tail2_record").handler({})).toEqual({ recording: "off" });
    const r = (await tool(tools, "obsbot_tail2_record").handler({ enable: true })) as {
      recording: string;
    };
    expect(r.recording).toBe("on");
    await tool(tools, "obsbot_tail2_capture_photo").handler({});
    expect(f.st.captures).toBe(1);
  });

  it("track_target taps and reports the engaged mode; focus_point reads, refuses mf and mismatched args", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_track_target").handler({ x: 0.5, y: 0.5 })) as {
      aiMode: string;
    };
    expect(r.aiMode).toBe("humanTrackingSingleMode");
    expect(f.calls.tapTarget).toEqual([0.5, 0.5]);

    expect(await tool(tools, "obsbot_tail2_focus_point").handler({})).toEqual({
      x: 0.452,
      y: 0.616,
    });
    await expect(
      tool(tools, "obsbot_tail2_focus_point").handler({ x: 0.5 }),
    ).rejects.toThrow(/x and y go together/);
    const set = (await tool(tools, "obsbot_tail2_focus_point").handler({ x: 0.7, y: 0.3 })) as {
      pointFocusStarted: boolean;
    };
    expect(set.pointFocusStarted).toBe(true);
    f.st.focusMode = "mf";
    await expect(
      tool(tools, "obsbot_tail2_focus_point").handler({ x: 0.5, y: 0.5 }),
    ).rejects.toThrow(/afc\/afs only/);
  });

  it("focus: position refused outside mf, works after mode switch, bare read reports in mf", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await expect(tool(tools, "obsbot_tail2_focus").handler({ position: 80 })).rejects.toThrow(
      /only valid in mf/,
    );
    const r = (await tool(tools, "obsbot_tail2_focus").handler({ mode: "mf", position: 80 })) as {
      mode: string;
      position: number;
    };
    expect(r).toMatchObject({ mode: "mf", position: 80 });
    const bare = (await tool(tools, "obsbot_tail2_focus").handler({})) as { position: number };
    expect(bare.position).toBe(80);
  });

  it("exposure reads mode-appropriate values and writes manual settings", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const auto = (await tool(tools, "obsbot_tail2_exposure").handler({})) as Record<string, unknown>;
    expect(auto).toMatchObject({ mode: "auto", autoMode: "global", evbias: 0 });
    const manual = (await tool(tools, "obsbot_tail2_exposure").handler({
      mode: "manual",
      iso: 800,
      shutter: "1/60",
    })) as Record<string, unknown>;
    expect(manual).toMatchObject({ mode: "manual", iso: 800, shutter: "1/60" });
  });

  it("image_adjust: control+value together, gated to manual style mode, values survive a mode switch", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await expect(
      tool(tools, "obsbot_tail2_image_adjust").handler({ control: "brightness" }),
    ).rejects.toThrow(/control and value go together/);
    await expect(
      tool(tools, "obsbot_tail2_image_adjust").handler({ control: "brightness", value: 70 }),
    ).rejects.toThrow(/styleMode manual/);
    const r = (await tool(tools, "obsbot_tail2_image_adjust").handler({
      control: "brightness",
      value: 70,
      styleMode: "manual",
    })) as Record<string, unknown>;
    expect(r).toMatchObject({ mode: "manual", brightness: 70 });
    const switched = (await tool(tools, "obsbot_tail2_image_adjust").handler({
      styleMode: "outdoor",
    })) as Record<string, unknown>;
    expect(switched).toMatchObject({ mode: "outdoor", brightness: 70 });
  });

  it("stream reads ndi and arms srt; wb, hdr, only_me, audio round-trip", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    expect(await tool(tools, "obsbot_tail2_stream").handler({})).toEqual({ control: "ndi" });
    const srt = (await tool(tools, "obsbot_tail2_stream").handler({ output: "srt" })) as {
      control: string;
    };
    expect(srt.control).toBe("srt");
    expect(f.st.stream).toBe("srt");
    expect(await tool(tools, "obsbot_tail2_wb").handler({})).toEqual({
      mode: "auto",
      temperature: 3000,
    });
    expect(
      await tool(tools, "obsbot_tail2_wb").handler({ mode: "manual", temperature: 5600 }),
    ).toMatchObject({ mode: "manual", temperature: 5600 });
    expect(await tool(tools, "obsbot_tail2_hdr").handler({ enabled: true })).toMatchObject({
      control: "on",
    });
    expect(await tool(tools, "obsbot_tail2_only_me").handler({ enabled: false })).toMatchObject({
      enable: false,
    });
    const audio = (await tool(tools, "obsbot_tail2_audio").handler({ volume: 30, mute: false })) as {
      volume: number;
      enable: boolean;
    };
    expect(audio).toMatchObject({ volume: 30, enable: false });
  });

  it("scan reports what the sweep found", async () => {
    const f = makeFake();
    const reg = await seededRegistry(f);
    (reg as unknown as { scanSubnet: () => Promise<Array<{ mac: string }>> }).scanSubnet =
      async () => reg.list();
    const tools = createTail2Tools(reg);
    const r = (await tool(tools, "obsbot_tail2_scan").handler({})) as {
      found: Array<{ mac: string }>;
      registered: number;
    };
    expect(r.found.map((e) => e.mac)).toEqual(["aa:aa:aa:aa:aa:aa"]);
    expect(r.registered).toBe(1);
  });

  it("status, info, recenter and preset_list honour the camera selector (regression: it was parsed and dropped)", async () => {
    // Two cameras registered: without the selector every one of these is
    // AmbiguousTail2Error — which is exactly how the dropped `camera` bug
    // surfaced (a selector was supplied and still hit "multiple cameras").
    const fakeA = makeFake();
    const fakeB = makeFake();
    fakeB.api = {
      ...fakeB.api,
      info: async () => ({ device_name: "Tail 2_bbbb", wired_ip: "h", wireless_ip: "0.0.0.0", mac: "bb:bb:bb:bb:bb:bb" }),
    } as unknown as Tail2Api;
    const reg = new Tail2Registry({
      makeApi: (host) => (host === "192.168.0.10" ? fakeA.api : fakeB.api),
      probeTimeoutMs: 500,
    });
    await reg.addHost("192.168.0.10");
    await reg.addHost("192.168.0.20");
    const tools = createTail2Tools(reg);

    const status = (await tool(tools, "obsbot_tail2_status").handler({ camera: "bb:bb:bb:bb:bb:bb" })) as {
      camera: string;
    };
    expect(status.camera).toBe("bb:bb:bb:bb:bb:bb");

    const info = (await tool(tools, "obsbot_tail2_info").handler({ camera: "192.168.0.20" })) as {
      device: { mac: string };
    };
    expect(info.device.mac).toBe("bb:bb:bb:bb:bb:bb");

    await expect(
      tool(tools, "obsbot_tail2_recenter").handler({ camera: "tail 2_bbbb" }),
    ).resolves.toEqual({ ok: true });

    const presets = (await tool(tools, "obsbot_tail2_preset_list").handler({ camera: "bb:bb:bb:bb:bb:bb" })) as {
      slots: unknown[];
    };
    expect(presets.slots).toHaveLength(3);

    // And without a selector, ambiguity still names both — the hint is load-bearing.
    await expect(tool(tools, "obsbot_tail2_status").handler({})).rejects.toThrow(/bb:bb:bb:bb:bb:bb/);
  });

  it("tools on an empty registry tell the caller how to add a camera", async () => {
    const reg = new Tail2Registry();
    const tools = createTail2Tools(reg);
    await expect(tool(tools, "obsbot_tail2_status").handler({})).rejects.toThrow(
      /obsbot_tail2_scan/,
    );
  });

  it("snapshot with SRT off returns an options report naming SRT first, not a dead end", async () => {
    const f = makeFake();
    f.calls.srtEnabled = false;
    f.calls.ndiEnabled = true;
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_snapshot").handler({})) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = r.content[0]?.text ?? "";
    expect(r.content[0]?.type).toBe("text");
    expect(text).toMatch(/NDI on/);
    expect(text).toMatch(/1\. Enable SRT/);
    expect(text).toMatch(/autonomously/);
  });

  it("snapshot options report warns against force-killing the Webcam bridge (when NDI Tools present)", async () => {
    const f = makeFake();
    f.calls.srtEnabled = false;
    f.calls.ndiEnabled = false;
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_snapshot").handler({})) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = r.content[0]?.text ?? "";
    if (process.platform === "win32") {
      // On Windows with NDI Tools installed the bridge option and its
      // force-kill warning must both appear.
      expect(text).toMatch(/never force-kill/);
    } else {
      // Without NDI Tools the bridge option (and its warning) are absent;
      // the report still names SRT as the autonomous path.
      expect(text).toMatch(/Enable SRT/);
    }
  });

  it("preset_list maps the camera's 0-based ids to 1-based slots", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_preset_list").handler({})) as {
      slots: Array<{ slot: number; occupied: boolean; name: string | null }>;
    };
    expect(r.slots.map((s) => s.slot)).toEqual([1, 2, 3]);
    expect(r.slots[0]).toMatchObject({ occupied: true, name: "Default" });
    expect(r.slots[1]).toMatchObject({ occupied: false, name: null });
  });

  it("preset_save maps slot 2 to id 1 and defaults the name", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_preset_save").handler({ slot: 2 })) as {
      ok: boolean;
      settled: boolean;
    };
    expect(f.calls.presetSave).toEqual([1, "P2"]);
    expect(r).toMatchObject({ ok: true, settled: true });
  });

  it("preset_recall maps slots and reports the verified zoom; delete reaches the api", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    const r = (await tool(tools, "obsbot_tail2_preset_recall").handler({ slot: 1 })) as {
      zoom: number;
      settled: boolean;
    };
    expect(f.calls.presetCall).toBe(0);
    expect(r).toMatchObject({ ok: true, zoom: 3.0, settled: true });
    await tool(tools, "obsbot_tail2_preset_delete").handler({ slot: 3 });
    expect(f.calls.presetDelete).toBe(2);
  });

  it("preset slots outside 1-3 are rejected at the schema", async () => {
    const f = makeFake();
    const tools = createTail2Tools(await seededRegistry(f));
    await expect(tool(tools, "obsbot_tail2_preset_save").handler({ slot: 4 })).rejects.toThrow();
    await expect(tool(tools, "obsbot_tail2_preset_recall").handler({ slot: 0 })).rejects.toThrow();
  });
});
