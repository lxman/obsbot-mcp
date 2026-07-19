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

export const imagingChecks = [
  defineCheck({
    id: "imaging.hdr",
    tool: "obsbot_hdr",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      const before = (await ctx.status()).hdr;
      await ctx.call("obsbot_hdr", { enabled: !before });
      const flipped = await ctx.until(async () => {
        const s = await ctx.status();
        return s.hdr === !before ? s.hdr : null;
      });
      await ctx.call("obsbot_hdr", { enabled: before });
      return { evidence: { before, flipped } };
    },
  }),

  acceptedWrite("imaging.fov", "obsbot_fov", { fov: "medium" }, { fov: "wide" }),
  acceptedWrite("imaging.focus", "obsbot_focus", { mode: "manual", position: 60 }, { mode: "auto" }),
  acceptedWrite(
    "imaging.white-balance",
    "obsbot_white_balance",
    { mode: "manual", temperature: 4000 },
    { mode: "auto" },
  ),
  acceptedWrite(
    "imaging.image-control",
    "obsbot_image_control",
    { control: "saturation", level: 60 },
    { control: "saturation", level: 50 },
  ),
  acceptedWrite("imaging.exposure", "obsbot_exposure", { mode: "manual", level: 60 }, { mode: "auto" }),
];
