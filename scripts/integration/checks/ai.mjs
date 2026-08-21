import { defineCheck, TIERS } from "../harness.mjs";

export const aiChecks = [
  defineCheck({
    id: "ai.tracking.enable",
    tool: "obsbot_ai_track",
    profile: "quick",
    // MANUAL, not VERIFIED: the firmware only latches into tracking when it has a
    // subject. Verified 2026-08-21 on hardware by reading the status block around
    // the write — with nobody in frame the AI-mode byte goes 00->06 (mid-switch
    // transient) and reverts to 00 within ~400ms, LED stays green; with a person
    // centred in frame it goes straight to 02 in 2ms, LED goes blue, and the
    // gimbal starts following. The July reports' 6 fail / 5 pass record is
    // whether someone was sitting at the desk, not a property of the software.
    // The tool's own `matched:false` is the correct report for "no subject".
    tier: TIERS.MANUAL,
    reason:
      "requires a person centred in frame; with no subject the firmware attempts tracking and reverts within ~400ms (status 0x18: 00->06->00), so an automated pass/fail measures room occupancy, not the tool",
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_ai_track", { enabled: true, mode: "normal" });
      let mode;
      try {
        mode = await ctx.until(async () => {
          const s = await ctx.status();
          return s.aiMode === "normal" ? s.aiMode : null;
        }, { probe: () => ctx.status() });
      } finally {
        // The enable has been sent whether or not it was observed to take.
        // Without this, a timeout here left tracking armed for every later
        // check and for whoever used the camera next.
        await ctx.call("obsbot_ai_track", { enabled: false });
      }
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
