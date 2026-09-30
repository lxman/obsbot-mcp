import { describe, expect, it } from "vitest";
import { moveAbsolute, type MoveDeps } from "../../src/tail2/move.js";
import type { Pose } from "../../src/tail2/api.js";

/**
 * The closed-loop mover against a simulated camera: commanded speeds integrate
 * into the recorded pose using the MEASURED conversion (0.39 °/s per unit) and
 * a command-sign convention. The loop's contract with the simulator is one
 * speedCmd → one sleep(jogDuration) → one stop, so each sleep integrates the
 * active jog over exactly the time slept. No real waiting — behaviour, not
 * wall time, is what's pinned.
 */

const DEG_PER_S_PER_UNIT = 0.39;

function makeSim(start: Pose, cmdSign = { yaw: -1, pitch: -1 }) {
  const sim = {
    pose: { ...start },
    clock: 0,
    jogs: [] as Array<{ yaw: number; pitch: number; ms: number }>,
    stopCount: 0,
    drift: { yaw: 0, pitch: 0 },
    active: null as { yaw: number; pitch: number } | null,
    async readPose() {
      return { ...sim.pose };
    },
    async speedCmd(yaw: number, pitch: number) {
      sim.active = { yaw, pitch };
    },
    async stop() {
      sim.active = null;
      sim.stopCount++;
    },
    async sleep(ms: number) {
      if (sim.active) {
        const s = ms / 1000;
        sim.pose.yaw += (cmdSign.yaw * sim.active.yaw * DEG_PER_S_PER_UNIT + sim.drift.yaw) * s;
        sim.pose.pitch += (cmdSign.pitch * sim.active.pitch * DEG_PER_S_PER_UNIT + sim.drift.pitch) * s;
        sim.jogs.push({ ...sim.active, ms });
      }
      sim.clock += ms;
    },
  };
  return sim satisfies MoveDeps & typeof sim;
}

describe("moveAbsolute", () => {
  it("converges on a yaw-only move with the measured sign convention", async () => {
    const sim = makeSim({ yaw: 10, pitch: -20, roll: 0, ratio: 4 });
    const r = await moveAbsolute(sim, { yaw: 0 });
    expect(r.converged).toBe(true);
    expect(Math.abs(r.pose.yaw)).toBeLessThanOrEqual(1.5);
    expect(r.pose.pitch).toBe(-20); // untouched axis untouched
    expect(r.signFlipped).toEqual([]);
    // Every jog was followed by a stop — the camera never left running.
    expect(sim.stopCount).toBeGreaterThanOrEqual(sim.jogs.length);
  });

  it("moves both axes together", async () => {
    const sim = makeSim({ yaw: 10, pitch: -10, roll: 0, ratio: 1 });
    const r = await moveAbsolute(sim, { yaw: 0, pitch: 0 });
    expect(r.converged).toBe(true);
    expect(Math.abs(r.pose.yaw)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(r.pose.pitch)).toBeLessThanOrEqual(1.5);
  });

  it("self-corrects when the assumed command sign is wrong", async () => {
    // Simulator INVERTED from our assumption on yaw: a positive command
    // INCREASES the record. The loop must notice the first jog went the
    // wrong way, flip, and still converge.
    const sim = makeSim({ yaw: 0, pitch: -20, roll: 0, ratio: 1 }, { yaw: 1, pitch: -1 });
    const r = await moveAbsolute(sim, { yaw: 10 });
    expect(r.converged).toBe(true);
    expect(r.signFlipped).toEqual(["yaw"]);
  });

  it("is already-at-target a zero-iteration success", async () => {
    const sim = makeSim({ yaw: 1, pitch: -1, roll: 0, ratio: 1 });
    const r = await moveAbsolute(sim, { yaw: 0, pitch: 0 });
    expect(r.converged).toBe(true);
    expect(r.iterations).toBe(0);
    expect(sim.jogs).toHaveLength(0);
  });

  it("reports non-convergence honestly against a fighting actuator", async () => {
    const sim = makeSim({ yaw: 0, pitch: -20, roll: 0, ratio: 1 });
    // Drift faster than the loop's max speed: yaw can never close.
    sim.drift = { yaw: 40, pitch: 0 };
    const r = await moveAbsolute(sim, { yaw: 30 });
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(5);
    expect(Math.abs(r.error.yaw)).toBeGreaterThan(1.5);
  });

  it("stops the camera even when a jog throws", async () => {
    const sim = makeSim({ yaw: 10, pitch: -20, roll: 0, ratio: 1 });
    const failing = {
      ...sim,
      speedCmd: () => {
        throw new Error("camera went away");
      },
    };
    await expect(moveAbsolute(failing, { yaw: 0 })).rejects.toThrow("camera went away");
    // The finally in the jog block ran stop() before the throw escaped.
    expect(sim.stopCount).toBe(1);
  });
});
