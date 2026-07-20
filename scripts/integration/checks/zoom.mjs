import { defineCheck, TIERS } from "../harness.mjs";

export const zoomChecks = [
  defineCheck({
    id: "zoom.absolute",
    tool: "obsbot_zoom_uvc",
    profile: "quick",
    // ACCEPTED by design: the transport has no zoom getter, so nothing can
    // confirm the ratio actually applied. Declaring VERIFIED here would be a lie
    // the runner would catch anyway.
    tier: TIERS.ACCEPTED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_zoom_uvc", { ratio: 2 });
      if (r.ok === false) throw new Error(r.error);
      await ctx.call("obsbot_zoom_uvc", { ratio: 1 });
      return {};
    },
  }),

  defineCheck({
    id: "zoom.speed",
    tool: "obsbot_zoom_vendor",
    profile: "quick",
    tier: TIERS.ACCEPTED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_zoom_vendor", { ratio: 1.5, speed: 1 });
      if (r.ok === false) throw new Error(r.error);
      await ctx.call("obsbot_zoom_uvc", { ratio: 1 });
      return {};
    },
  }),
];
