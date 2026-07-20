import { defineCheck, TIERS } from "../harness.mjs";

export const aiChecks = [
  defineCheck({
    id: "ai.tracking.enable",
    tool: "obsbot_ai_track",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_ai_track", { enabled: true, mode: "normal" });
      const mode = await ctx.until(async () => {
        const s = await ctx.status();
        return s.aiMode === "normal" ? s.aiMode : null;
      });
      await ctx.call("obsbot_ai_track", { enabled: false });
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
    tool: "obsbot_focus_face",
    profile: "quick",
    // ACCEPTED, not VERIFIED: obsbot_focus_face is face-priority AUTOFOCUS and has
    // no readback on this transport. An earlier draft asserted it against the
    // status block's faceAe field — but faceAe is face-priority auto-EXPOSURE, a
    // different feature (see the note above encodeFaceAe in codec/commands.ts).
    // Toggling one was never going to move the other.
    tier: TIERS.ACCEPTED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_focus_face", { enabled: true });
      if (r.ok === false) throw new Error(r.error);
      await ctx.call("obsbot_focus_face", { enabled: false });
      return {};
    },
  }),

  defineCheck({
    id: "ai.exposure-face-priority",
    tool: "obsbot_image_exposure_auto",
    profile: "quick",
    // This is what the status block's faceAe field actually tracks, so unlike
    // face_focus it can be genuinely verified.
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      const before = (await ctx.status()).faceAe;
      await ctx.call("obsbot_image_exposure_auto", { priority: before ? "global" : "face" });
      const flipped = await ctx.until(async () => {
        const s = await ctx.status();
        return s.faceAe === !before ? s.faceAe : null;
      });
      await ctx.call("obsbot_image_exposure_auto", { priority: before ? "face" : "global" });
      return { evidence: { before, flipped } };
    },
  }),
];
