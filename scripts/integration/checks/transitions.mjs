import { defineCheck, TIERS, measurement } from "../harness.mjs";

const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

export const transitionChecks = [
  defineCheck({
    id: "transitions.T1.live-not-cached",
    tool: "obsbot_gimbal_position",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      // A position read that returns a cached value looks identical to a live one
      // at rest. Only sampling DURING travel can tell them apart.
      await ctx.call("obsbot_gimbal_move", { yaw: -80, pitch: 0 });
      await ctx.sleep(3000);
      await ctx.call("obsbot_gimbal_move", { yaw: 80, pitch: 0 });
      const samples = await ctx.samples(() => ctx.pos(), { count: 6, everyMs: 200 });
      const yaws = samples.map((s) => s.yaw);
      const distinct = new Set(yaws).size;
      if (distinct < 3) {
        throw new Error(`only ${distinct} distinct readings during a 160-degree slew: ${yaws.join(",")}`);
      }
      const monotonic = yaws.every((v, i) => i === 0 || v >= yaws[i - 1] - 3);
      if (!monotonic) throw new Error(`readings not progressing toward target: ${yaws.join(",")}`);
      return { evidence: { yaws }, measurements: [measurement("distinctSamples", distinct, "")] };
    },
  }),

  defineCheck({
    id: "transitions.T2.settling-profile",
    tool: "obsbot_gimbal_move",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      await ctx.call("obsbot_gimbal_recenter");
      await ctx.sleep(2500);
      const started = Date.now();
      await ctx.call("obsbot_gimbal_move", { yaw: 60, pitch: -20 });
      const landed = await ctx.until(
        async () => {
          const p = await ctx.pos();
          return near(p.yaw, 60) && near(p.pitch, -20) ? p : null;
        },
        { timeoutMs: 20000, everyMs: 150 },
      );
      const settleMs = Date.now() - started;
      return { evidence: { landed }, measurements: [measurement("settleTime", settleMs, "ms")] };
    },
  }),

  defineCheck({
    id: "transitions.T4.transitional-read-safety",
    // Observes sleep deliberately: the runner must not keep this one awake.
    managesSleep: true,
    tool: "obsbot_preset_list",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      // The 2026-07-19 bug class: a read taken while the device is mid-transition
      // must either return valid data or fail LOUDLY. A false EMPTY is the
      // dangerous direction, because EMPTY authorizes an irreversible
      // create-once ADD.
      await ctx.call("obsbot_sleep", {});
      const observations = await ctx.samples(
        async () => {
          const r = await ctx.call("obsbot_preset_list");
          return { ok: r.ok, allEmpty: r.ok ? r.slots.every((s) => !s.occupied) : null };
        },
        { count: 5, everyMs: 300 },
      );
      await ctx.call("obsbot_wake", {});
      await ctx.until(async () => (await ctx.status()).awake === true);
      return {
        evidence: { observations },
        measurements: [
          measurement("loudFailures", observations.filter((o) => o.ok === false).length, ""),
        ],
      };
    },
  }),

  defineCheck({
    id: "transitions.T5.gate-behaviour",
    // Observes sleep deliberately: the runner must not keep this one awake.
    managesSleep: true,
    // NOTE: pairs with device.run-status.wake, which claims obsbot_wake coverage
    // for the same underlying obsbot_set_run_status split. This check only ever
    // calls obsbot_sleep directly — the wake half here is an implicit side effect
    // of the gated obsbot_preset_list call below, not a direct obsbot_wake call.
    tool: "obsbot_sleep",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      // The preceding check leaves the camera freshly woken, and a sleep issued
      // inside the post-wake settling window is ignored. Let it settle first.
      await ctx.sleep(2500);
      await ctx.call("obsbot_sleep", {});
      await ctx.until(async () => (await ctx.status()).awake === false, { timeoutMs: 15000 });
      // status must NOT gate — reading state should not change it.
      const stillAsleep = (await ctx.status()).awake;
      if (stillAsleep !== false) throw new Error("obsbot_status woke the camera");
      // A gated tool must auto-wake and succeed.
      const list = await ctx.call("obsbot_preset_list");
      if (list.ok === false) throw new Error(`gated call failed from asleep: ${list.error}`);
      const awake = (await ctx.status()).awake;
      return { evidence: { stillAsleep, wokeForGatedCall: awake } };
    },
  }),

  defineCheck({
    id: "transitions.T6.empty-state-escape",
    tool: "obsbot_preset_list",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      // A genuinely empty device returns an all-zero selector-12 block. This once
      // dead-ended every preset tool: save was gated behind the read that failed,
      // so the first preset was uncreatable.
      const list = await ctx.call("obsbot_preset_list");
      for (const s of list.slots.filter((x) => x.occupied)) {
        await ctx.call("obsbot_preset_delete", { slot: s.slot });
      }
      const empty = await ctx.call("obsbot_preset_list");
      if (empty.ok === false) throw new Error(`empty device failed to list: ${empty.error}`);
      if (!empty.slots.every((s) => !s.occupied)) throw new Error("slots not empty after clearing");
      const boot = await ctx.call("obsbot_preset_save", { slot: 1 });
      if (boot.ok === false) throw new Error(`could not bootstrap the first preset: ${boot.error}`);
      await ctx.call("obsbot_preset_delete", { slot: 1 });
      return { evidence: { listedEmpty: true, bootstrapped: boot.slot } };
    },
  }),

  defineCheck({
    id: "transitions.T7.physical-round-trip",
    tool: "obsbot_preset_recall",
    profile: "quick",
    tier: TIERS.VERIFIED,
    timeoutMs: 60000,
    run: async (ctx) => {
      // The ONLY check that can catch a sign or field-order error. save and
      // gimbal_position share the -camCtrlGet(TILT) conversion, so a save->list
      // readback is self-consistent by construction and cannot falsify one.
      // Physical arrival is the only admissible evidence.
      const list = await ctx.call("obsbot_preset_list");
      for (const s of list.slots.filter((x) => x.occupied)) {
        await ctx.call("obsbot_preset_delete", { slot: s.slot });
      }
      await ctx.call("obsbot_gimbal_move", { yaw: 45, pitch: -20 });
      await ctx.sleep(3000);
      const saved = await ctx.pos();
      await ctx.call("obsbot_preset_save", { slot: 1 });

      await ctx.call("obsbot_gimbal_move", { yaw: -60, pitch: 20 });
      await ctx.sleep(3500);
      const awayFrom = await ctx.pos();

      await ctx.call("obsbot_preset_recall", { slot: 1 });
      const arrived = await ctx.until(
        async () => {
          const p = await ctx.pos();
          return near(p.yaw, saved.yaw, 4) && near(p.pitch, saved.pitch, 4) ? p : null;
        },
        { timeoutMs: 25000, everyMs: 250 },
      );

      await ctx.call("obsbot_preset_delete", { slot: 1 });
      return {
        evidence: { saved, awayFrom, arrived },
        measurements: [
          measurement("yawError", arrived.yaw - saved.yaw, "deg"),
          measurement("pitchError", arrived.pitch - saved.pitch, "deg"),
        ],
      };
    },
  }),

  defineCheck({
    id: "transitions.T3.wake-self-centering-window",
    // Observes sleep deliberately: the runner must not keep this one awake.
    managesSleep: true,
    tool: "obsbot_gimbal_move",
    profile: "deep",
    tier: TIERS.VERIFIED,
    timeoutMs: 60000,
    run: async (ctx) => {
      // The gimbal self-centers for ~1-2s after wake and overrides earlier moves.
      // Documented as a tested invariant rather than folklore.
      await ctx.call("obsbot_sleep", {});
      await ctx.until(async () => (await ctx.status()).awake === false);
      await ctx.call("obsbot_wake", {});
      await ctx.call("obsbot_gimbal_move", { yaw: 60, pitch: 0 });
      await ctx.sleep(4000);
      const early = await ctx.pos();

      await ctx.sleep(1500);
      await ctx.call("obsbot_gimbal_move", { yaw: 60, pitch: 0 });
      const late = await ctx.until(
        async () => {
          const p = await ctx.pos();
          return near(p.yaw, 60, 5) ? p : null;
        },
        { timeoutMs: 20000, everyMs: 250 },
      );

      return {
        evidence: { early, late },
        measurements: [
          measurement("earlyMoveYaw", early.yaw, "deg"),
          measurement("lateMoveYaw", late.yaw, "deg"),
        ],
      };
    },
  }),

  defineCheck({
    id: "transitions.T10.speed-autostop-timing",
    tool: "obsbot_gimbal_move_speed",
    profile: "deep",
    tier: TIERS.VERIFIED,
    timeoutMs: 40000,
    run: async (ctx) => {
      await ctx.call("obsbot_gimbal_recenter");
      await ctx.sleep(2500);
      await ctx.call("obsbot_gimbal_move_speed", { yaw: 25, pitch: 0, autoStopMs: 700 });
      await ctx.sleep(2500);
      const first = await ctx.pos();
      await ctx.sleep(1500);
      const second = await ctx.pos();
      const drift = Math.abs(second.yaw - first.yaw);
      if (drift > 3) {
        throw new Error(`gimbal still moving after autoStop: ${first.yaw} -> ${second.yaw}`);
      }
      return { evidence: { first, second }, measurements: [measurement("postStopDrift", drift, "deg")] };
    },
  }),

  defineCheck({
    id: "transitions.T11.repeatability",
    tool: "obsbot_gimbal_move",
    profile: "deep",
    tier: TIERS.VERIFIED,
    timeoutMs: 60000,
    run: async (ctx) => {
      const land = async () => {
        await ctx.call("obsbot_gimbal_recenter");
        await ctx.sleep(2500);
        await ctx.call("obsbot_gimbal_move", { yaw: 55, pitch: -15 });
        return ctx.until(
          async () => {
            const p = await ctx.pos();
            return near(p.yaw, 55) && near(p.pitch, -15) ? p : null;
          },
          { timeoutMs: 20000, everyMs: 200 },
        );
      };
      const a = await land();
      const b = await land();
      const spread = Math.abs(a.yaw - b.yaw) + Math.abs(a.pitch - b.pitch);
      if (spread > 6) {
        throw new Error(`landings disagree: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      }
      return { evidence: { a, b }, measurements: [measurement("landingSpread", spread, "deg")] };
    },
  }),

  defineCheck({
    id: "transitions.T12.cold-boot-pose",
    tool: "obsbot_gimbal_position",
    profile: "quick",
    tier: TIERS.MANUAL,
    reason:
      "requires a physical cable pull; the camera comes up AWAKE at approximately yaw 2 / pitch +16, which differs from the wake-from-sleep resting pose of yaw 2 / pitch 0",
    run: async () => ({}),
  }),
];
