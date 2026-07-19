import { defineCheck, TIERS, measurement } from "../harness.mjs";

// ffmpeg is optional. Where it is absent these report SKIPPED rather than
// failing, so a machine without it still produces a clean run.
const ffmpegMissing = (r) => r.ok === false && /ffmpeg/i.test(r.error ?? "");

export const captureChecks = [
  defineCheck({
    id: "capture.snapshot",
    tool: "obsbot_snapshot",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_snapshot", { maxDim: 640, quality: 70 });
      if (ffmpegMissing(r)) return { skip: "ffmpeg absent" };
      if (r.ok === false) throw new Error(r.error);
      if (!r.base64 || r.base64.length < 100) throw new Error("snapshot returned no image data");
      return {
        evidence: { bytes: r.base64.length, width: r.width, height: r.height },
        measurements: [measurement("imageBytes", r.base64.length, "b64chars")],
      };
    },
  }),

  defineCheck({
    id: "capture.record",
    tool: "obsbot_record_start",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 50000,
    run: async (ctx) => {
      const start = await ctx.call("obsbot_record_start", { durationSec: 2, audio: false });
      if (ffmpegMissing(start)) return { skip: "ffmpeg absent" };
      if (start.ok === false) throw new Error(start.error);
      await ctx.sleep(4000);
      const list = await ctx.call("obsbot_capture_list");
      return { evidence: { sessionId: start.sessionId, sessions: list.sessions ?? [] } };
    },
  }),

  // Split into start and stop so BOTH tools are keyed in the coverage manifest.
  // A single combined check exercised capture_stop but left it counted as
  // uncovered — the manifest caught that, which is what it is for.
  defineCheck({
    id: "capture.preview.start",
    tool: "obsbot_preview_start",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 50000,
    run: async (ctx) => {
      const start = await ctx.call("obsbot_preview_start", {});
      if (ffmpegMissing(start)) return { skip: "ffmpeg absent" };
      if (start.ok === false) throw new Error(start.error);
      // Handed to the stop check below, which runs next.
      ctx.previewSessionId = start.sessionId;
      await ctx.sleep(2000);
      const list = await ctx.call("obsbot_capture_list");
      return { evidence: { sessionId: start.sessionId, sessions: list.sessions ?? [] } };
    },
  }),

  defineCheck({
    id: "capture.preview.stop",
    tool: "obsbot_capture_stop",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      const sessionId = ctx.previewSessionId;
      if (!sessionId) return { skip: "no preview session started (ffmpeg absent)" };
      const stop = await ctx.call("obsbot_capture_stop", { sessionId });
      if (stop.ok === false) throw new Error(stop.error);
      const list = await ctx.call("obsbot_capture_list");
      const stillRunning = (list.sessions ?? []).some((s) => s.sessionId === sessionId);
      if (stillRunning) throw new Error(`session ${sessionId} still listed after stop`);
      return { evidence: { stopped: sessionId } };
    },
  }),

  defineCheck({
    id: "capture.list",
    tool: "obsbot_capture_list",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_capture_list");
      if (!Array.isArray(r.sessions)) throw new Error("capture_list did not return a sessions array");
      return { evidence: { sessions: r.sessions.length } };
    },
  }),
];
