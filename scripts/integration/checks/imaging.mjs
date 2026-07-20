import { defineCheck, TIERS } from "../harness.mjs";

// Write-only controls: the device accepts them but exposes no readback on this
// transport. They are declared ACCEPTED so the report never implies more than
// was actually established.
const acceptedWrite = (id, tool, args, restore) =>
  defineCheck({
    id,
    tool,
    profile: "quick",
    tier: TIERS.ACCEPTED,
    run: async (ctx) => {
      const r = await ctx.call(tool, args);
      if (r.ok === false) throw new Error(r.error);
      if (restore) await ctx.call(tool, restore);
      return {};
    },
  });

// Write-only controls split across two tools (manual vs. auto), where the
// restore call targets a DIFFERENT tool name than the primary call. acceptedWrite
// can't cover this shape (it reuses one `tool` for both calls), so these are
// declared inline.
const acceptedSplitWrite = (id, tool, args, restoreTool, restoreArgs = {}) =>
  defineCheck({
    id,
    tool,
    profile: "quick",
    tier: TIERS.ACCEPTED,
    run: async (ctx) => {
      const r = await ctx.call(tool, args);
      if (r.ok === false) throw new Error(r.error);
      await ctx.call(restoreTool, restoreArgs);
      return {};
    },
  });

export const imagingChecks = [
  defineCheck({
    id: "imaging.hdr",
    tool: "obsbot_image_hdr",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      const before = (await ctx.status()).hdr;
      await ctx.call("obsbot_image_hdr", { enabled: !before });
      const flipped = await ctx.until(async () => {
        const s = await ctx.status();
        return s.hdr === !before ? s.hdr : null;
      });
      await ctx.call("obsbot_image_hdr", { enabled: before });
      return { evidence: { before, flipped } };
    },
  }),

  acceptedWrite("imaging.fov", "obsbot_image_fov", { fov: "medium" }, { fov: "wide" }),
  acceptedSplitWrite("imaging.focus", "obsbot_focus_manual", { position: 60 }, "obsbot_focus_auto"),
  acceptedSplitWrite(
    "imaging.white-balance",
    "obsbot_image_wb_manual",
    { temperature: 4000 },
    "obsbot_image_wb_auto",
  ),
  acceptedWrite(
    "imaging.image-control",
    "obsbot_image_adjust",
    { control: "saturation", level: 60 },
    { control: "saturation", level: 50 },
  ),
  acceptedSplitWrite("imaging.exposure", "obsbot_image_exposure_manual", { level: 60 }, "obsbot_image_exposure_auto"),
];
