import { defineCheck, TIERS, measurement } from "../harness.mjs";

// Presets are create-once with no device-side history. Free rein is an explicit
// owner decision for this test camera; the run still records state either side.
const clearAll = async (ctx) => {
  const list = await ctx.call("obsbot_preset_list");
  if (list.ok === false) throw new Error(list.error);
  for (const slot of list.slots.filter((s) => s.occupied)) {
    await ctx.call("obsbot_preset_delete", { slot: slot.slot });
  }
};

export const presetChecks = [
  defineCheck({
    id: "presets.list",
    tool: "obsbot_preset_list",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_preset_list");
      if (r.ok === false) throw new Error(r.error);
      if (r.slots.length !== 3) throw new Error(`expected 3 slots, got ${r.slots.length}`);
      return { evidence: { slots: r.slots } };
    },
  }),

  defineCheck({
    id: "presets.save",
    tool: "obsbot_preset_save",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      await clearAll(ctx);
      await ctx.call("obsbot_ptz_move_angle", { yaw: 35, pitch: -18 });
      await ctx.sleep(3000);
      const live = await ctx.pos();
      const r = await ctx.call("obsbot_preset_save", { slot: 1 });
      if (r.ok === false) throw new Error(r.error);
      const list = await ctx.call("obsbot_preset_list");
      const slot = list.slots[0];
      if (!slot.occupied) throw new Error("slot 1 empty after save");
      return {
        evidence: { stored: slot.pose, live },
        measurements: [measurement("panDelta", slot.pose.pan - live.yaw, "deg")],
      };
    },
  }),

  defineCheck({
    id: "presets.save.create-once",
    tool: "obsbot_preset_save",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      // Slot 1 is occupied from the previous check. Saving again must be
      // REJECTED: an ADD into an occupied create-once slot is the one write that
      // could destroy a customer's preset.
      const r = await ctx.call("obsbot_preset_save", { slot: 1 });
      if (r.ok !== false) throw new Error("save into an occupied slot was not rejected");
      return { evidence: { rejected: r.error } };
    },
  }),

  defineCheck({
    id: "presets.rename",
    tool: "obsbot_preset_rename",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const name = "IntegrationTest";
      await ctx.call("obsbot_preset_rename", { slot: 1, name });
      const list = await ctx.call("obsbot_preset_list");
      if (list.slots[0].name !== name) {
        throw new Error(`rename did not persist: ${list.slots[0].name}`);
      }
      return { evidence: { name: list.slots[0].name } };
    },
  }),

  defineCheck({
    id: "presets.update",
    tool: "obsbot_preset_update",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      await ctx.call("obsbot_ptz_move_angle", { yaw: -30, pitch: 12 });
      await ctx.sleep(3000);
      const r = await ctx.call("obsbot_preset_update", { slot: 1 });
      if (r.ok === false) throw new Error(r.error);
      // The restore payload is the caller's only route back for a create-once
      // resource with no device-side history.
      if (!r.previous) throw new Error("update did not return the pose it overwrote");
      const list = await ctx.call("obsbot_preset_list");
      return { evidence: { previous: r.previous, now: list.slots[0].pose } };
    },
  }),

  defineCheck({
    id: "presets.delete",
    tool: "obsbot_preset_delete",
    profile: "quick",
    tier: TIERS.VERIFIED,
    run: async (ctx) => {
      const r = await ctx.call("obsbot_preset_delete", { slot: 1 });
      if (r.ok === false) throw new Error(r.error);
      if (!r.deleted) throw new Error("delete did not return the preset it destroyed");
      const list = await ctx.call("obsbot_preset_list");
      if (list.slots[0].occupied) throw new Error("slot 1 still occupied after delete");
      return { evidence: { deleted: r.deleted } };
    },
  }),
];
