import type { Pose } from "./api.js";

/**
 * Absolute gimbal positioning for the Tail 2, built out of the two primitives
 * the HTTP API actually offers: continuous speed moves (POST ptz/gimbalcontrol)
 * and a slow pose readback (save-scratch-preset → GET). There is no
 * move-to-angle endpoint, so this is a closed loop with a very sluggish
 * sensor — a pose read costs ~1.5 s and the preset list lags the save by up
 * to ~1 s. The loop is therefore deliberately conservative: undershoot each
 * jog, re-read, correct; never let a jog run longer than a few seconds.
 *
 * Two facts from the 2026-09-30 hardware session shape it:
 *   - SPEED: yaw command 20 for 1 s moved the recorded pose 7.86°, so roughly
 *     0.39 °/s per command unit (ramps included in that one sample).
 *   - SIGN: a POSITIVE yaw command DECREASED the recorded yaw. The command
 *     sign per axis is a convention we have measured for yaw only; the loop
 *     assumes the same for pitch and self-corrects per axis on contradiction
 *     (first jog too far away → flip that axis and continue).
 */

export interface MoveDeps {
  readPose(): Promise<Pose>;
  speedCmd(yawUnits: number, pitchUnits: number): Promise<void>;
  stop(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface MoveTarget {
  yaw?: number;
  pitch?: number;
}

export interface MoveResult {
  pose: Pose;
  /** Axis error in degrees when the loop finished, by axis. */
  error: { yaw: number; pitch: number };
  iterations: number;
  converged: boolean;
  /** Axes whose command sign had to be flipped after the first jog. */
  signFlipped: string[];
}

/** Rough °/s per command unit at the speeds this loop uses (measured once, ramps included). */
const EST_DEG_PER_S_PER_UNIT = 0.39;
/** Aim to cover this fraction of the remaining error per jog: undershoot, then correct. */
const COVER_FRACTION = 0.75;
/** Stop when an axis is within this many degrees. */
const TOLERANCE_DEG = 1.5;
const MAX_ITERATIONS = 5;
const MAX_JOG_MS = 3500;
const MIN_SPEED_UNITS = 8;
const MAX_SPEED_UNITS = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export async function moveAbsolute(
  deps: MoveDeps,
  target: MoveTarget,
): Promise<MoveResult> {
  // Command sign per axis: measured, a positive yaw command decreased the
  // recorded yaw — so to move the record toward +, command −.
  const sign = { yaw: -1, pitch: -1 };
  const signFlipped: string[] = [];
  let pose = await deps.readPose();

  const errOf = (p: Pose): { yaw: number; pitch: number } => ({
    yaw: target.yaw !== undefined ? target.yaw - p.yaw : 0,
    pitch: target.pitch !== undefined ? target.pitch - p.pitch : 0,
  });
  const err = errOf(pose);
  const prevErr = { ...err };

  let iterations = 0;
  let lastCmd: { yaw: number; pitch: number } | null = null;

  while (iterations < MAX_ITERATIONS) {
    const errNow = errOf(pose);
    if (Math.abs(errNow.yaw) <= TOLERANCE_DEG && Math.abs(errNow.pitch) <= TOLERANCE_DEG) break;

    if (iterations > 0 && lastCmd) {
      // Self-calibration: if an axis we drove got FARTHER away, our assumed
      // command sign for that axis is wrong. Flip it and continue.
      for (const axis of ["yaw", "pitch"] as const) {
        if (lastCmd[axis] === 0) continue;
        if (Math.abs(errNow[axis]) > Math.abs(prevErr[axis]) + 0.5) {
          sign[axis] = -sign[axis] as 1 | -1;
          if (!signFlipped.includes(axis)) signFlipped.push(axis);
        }
      }
    }

    // Speed from the larger remaining error, undershooting on purpose.
    const worst = Math.max(Math.abs(errNow.yaw), Math.abs(errNow.pitch));
    const units = clamp(worst / EST_DEG_PER_S_PER_UNIT, MIN_SPEED_UNITS, MAX_SPEED_UNITS);
    const duration = clamp(
      (worst * COVER_FRACTION) / (units * EST_DEG_PER_S_PER_UNIT) * 1000,
      250,
      MAX_JOG_MS,
    );

    const cmd = {
      // Command direction: the axis sign convention (Δpose = sign × cmd × k)
      // applied to the error's own sign — toward the target, whichever side
      // of it we are on.
      yaw:
        Math.abs(errNow.yaw) > TOLERANCE_DEG ? sign.yaw * Math.sign(errNow.yaw) * units : 0,
      pitch:
        Math.abs(errNow.pitch) > TOLERANCE_DEG
          ? sign.pitch * Math.sign(errNow.pitch) * units
          : 0,
    };
    if (cmd.yaw === 0 && cmd.pitch === 0) break;

    try {
      await deps.speedCmd(cmd.yaw, cmd.pitch);
      lastCmd = cmd;
      Object.assign(prevErr, errNow);
      await deps.sleep(duration);
    } finally {
      await deps.stop();
    }

    iterations++;
    pose = await deps.readPose();
  }

  const errFinal = errOf(pose);
  return {
    pose,
    error: errFinal,
    iterations,
    converged: Math.abs(errFinal.yaw) <= TOLERANCE_DEG && Math.abs(errFinal.pitch) <= TOLERANCE_DEG,
    signFlipped,
  };
}
