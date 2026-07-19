import { defineCheck, TIERS, measurement } from "../harness.mjs";

export const deviceChecks = [
  defineCheck({
    id: "device.list",
    tool: "obsbot_list_devices",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_list_devices");
      const devices = r.devices ?? [];
      if (devices.length === 0) throw new Error("no OBSBOT device enumerated");
      return {
        evidence: { count: devices.length },
        measurements: [measurement("devices", devices.length, "")],
      };
    },
  }),

  defineCheck({
    id: "device.status",
    tool: "obsbot_get_status",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const s = await ctx.call("obsbot_get_status");
      if (typeof s.awake !== "boolean") throw new Error("status block did not decode an awake flag");
      return { evidence: { awake: s.awake, aiMode: s.aiMode } };
    },
  }),

  defineCheck({
    id: "device.run-status.wake",
    // Observes sleep deliberately: the runner must not keep this one awake.
    managesSleep: true,
    tool: "obsbot_set_run_status",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_set_run_status", { state: "sleep" });
      await ctx.until(async () => (await ctx.status()).awake === false);
      await ctx.call("obsbot_set_run_status", { state: "run" });
      const awake = await ctx.until(async () => (await ctx.status()).awake === true);
      // Independent channel: the status block, not the command's own return value.
      return { evidence: { awake } };
    },
  }),

  defineCheck({
    id: "device.probe",
    tool: "obsbot_probe",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      // probe is an RE instrument, not a feature. Exercised only to prove the raw
      // XU read path is alive; the status block starts 0x25 on this device.
      const r = await ctx.call("obsbot_probe", { mode: "get", selector: 6, length: 60 });
      if (r.ok === false) throw new Error(r.error);
      // mode 'get' returns { selector, len, raw } — the field is `raw`, not `hex`.
      const raw = r.raw ?? "";
      if (!/^25/.test(raw)) throw new Error(`unexpected status block prefix: ${raw.slice(0, 8)}`);
      return { evidence: { prefix: raw.slice(0, 8), len: r.len } };
    },
  }),
];
