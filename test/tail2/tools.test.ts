import { describe, expect, it } from "vitest";
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
  calls: { zoom?: [number, number]; aiMode?: string; trackSpeed?: string; rollBias?: number; portrait?: boolean; recenter?: boolean; presetSave?: [number, string]; presetCall?: number; presetDelete?: number; presetRename?: [number, string]; srtEnabled?: boolean; ndiEnabled?: boolean; gimbalSpeed?: [number, number, number]; gimbalStop?: boolean; gimbalInvert?: boolean; gimbalPose?: { yaw: number; pitch: number; roll: number; ratio: number } };
  /** When false, readbacks never reflect writes - everything settles:false. */
  letWritesLand: boolean;
}

const makeFake = (): FakeTail2 => {
  const f: FakeTail2 = {
    calls: {},
    letWritesLand: true,
    api: {} as Tail2Api,
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

  it("zoom writes ratio+speed and reports settled", async () => {
    const f = makeFake();
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
