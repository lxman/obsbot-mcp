import { defineCheck, TIERS, measurement } from "../harness.mjs";

const TOLERANCE_DEG = 3;
const near = (a, b, tol = TOLERANCE_DEG) => Math.abs(a - b) <= tol;

export const gimbalChecks = [
  defineCheck({
    id: "gimbal.position.read",
    tool: "obsbot_gimbal_position",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const p = await ctx.pos();
      if (typeof p.yaw !== "number" || typeof p.pitch !== "number") {
        throw new Error("gimbal position did not decode numeric yaw/pitch");
      }
      return { evidence: { yaw: p.yaw, pitch: p.pitch } };
    },
  }),

  defineCheck({
    id: "gimbal.move.absolute",
    tool: "obsbot_ptz_move_angle",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      const target = { yaw: 40, pitch: -15 };
      await ctx.call("obsbot_ptz_move_angle", target);
      const landed = await ctx.until(
        async () => {
          const p = await ctx.pos();
          return near(p.yaw, target.yaw) && near(p.pitch, target.pitch) ? p : null;
        },
        { timeoutMs: 20000, everyMs: 250 },
      );
      return {
        evidence: { landed },
        measurements: [
          measurement("yawError", landed.yaw - target.yaw, "deg"),
          measurement("pitchError", landed.pitch - target.pitch, "deg"),
        ],
      };
    },
  }),

  defineCheck({
    id: "gimbal.recenter",
    tool: "obsbot_gimbal_recenter",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_ptz_move_angle", { yaw: 50, pitch: 20 });
      await ctx.sleep(2500);
      await ctx.call("obsbot_gimbal_recenter");
      const centered = await ctx.until(
        async () => {
          const p = await ctx.pos();
          return near(p.yaw, 0, 5) && near(p.pitch, 0, 5) ? p : null;
        },
        { timeoutMs: 20000, everyMs: 250 },
      );
      return { evidence: { centered } };
    },
  }),

  defineCheck({
    id: "gimbal.move.speed",
    tool: "obsbot_ptz_move_speed",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 30000,
    run: async (ctx) => {
      await ctx.call("obsbot_gimbal_recenter");
      await ctx.sleep(2500);
      const before = await ctx.pos();
      await ctx.call("obsbot_ptz_move_speed", { yaw: 20, pitch: 0, autoStopMs: 800 });
      await ctx.sleep(2000);
      const after = await ctx.pos();
      const moved = Math.abs(after.yaw - before.yaw);
      if (moved < 2) throw new Error(`speed move produced no motion (${before.yaw} -> ${after.yaw})`);
      return { evidence: { before, after }, measurements: [measurement("yawTravel", moved, "deg")] };
    },
  }),
];
