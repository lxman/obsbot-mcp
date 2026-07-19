import { defineCheck, TIERS } from "../harness.mjs";

export const aiChecks = [
  defineCheck({
    id: "ai.tracking.enable",
    tool: "obsbot_ai_tracking",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_ai_tracking", { enabled: true, mode: "normal" });
      const mode = await ctx.until(async () => {
        const s = await ctx.status();
        return s.aiMode === "normal" ? s.aiMode : null;
      });
      await ctx.call("obsbot_ai_tracking", { enabled: false });
      const off = await ctx.until(async () => {
        const s = await ctx.status();
        return s.aiMode === "no-tracking" ? s.aiMode : null;
      });
      return { evidence: { enabled: mode, disabled: off } };
    },
  }),

  defineCheck({
    id: "ai.track-speed",
    tool: "obsbot_ai_track_speed",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_ai_track_speed", { speed: "sport" });
      const sport = await ctx.until(async () => {
        const s = await ctx.status();
        return s.trackSpeed === "sport" ? s.trackSpeed : null;
      });
      await ctx.call("obsbot_ai_track_speed", { speed: "standard" });
      return { evidence: { trackSpeed: sport } };
    },
  }),

  defineCheck({
    id: "ai.face-focus",
    tool: "obsbot_face_focus",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      const before = (await ctx.status()).faceAe;
      await ctx.call("obsbot_face_focus", { enabled: !before });
      const flipped = await ctx.until(async () => {
        const s = await ctx.status();
        return s.faceAe === !before ? s.faceAe : null;
      });
      await ctx.call("obsbot_face_focus", { enabled: before });
      return { evidence: { before, flipped } };
    },
  }),
];
