import { describe, it, expect } from "vitest";
import { OPCODES, OP_BY_NAME, SENDABLE } from "../../src/codec/opcodes.js";

describe("opcodes table", () => {
  it("holds the full reverse-engineered command surface", () => {
    expect(OPCODES.length).toBe(444);
    expect(SENDABLE.length).toBe(437);
    expect(SENDABLE.every((o) => o.wireCmd !== null && o.receiver !== null)).toBe(true);
  });

  it("matches the hardware-verified codec opcodes exactly", () => {
    // These five are the commands the v1 codec sends and were confirmed on
    // real hardware; the whole table is derived by the same proven formula.
    const cases: Array<[string, number, number, number]> = [
      // name, set, wireCmd, receiver
      ["AI_SET_GIM_SPEED", 0x03, 0x6484, 0x04], // PTZ speed
      ["AI_SET_GIM_MOTOR_DEG", 0x03, 0x6444, 0x04], // PTZ move-to-angle
      ["AI_SET_GIM_EULER_DEG", 0x03, 0x6404, 0x04], // euler angle
      ["CAM_SET_DEV_STATUS", 0x01, 0xa0c2, 0x02], // wake/sleep
      ["GIM_SET_MOTOR", 0x02, 0x00c3, 0x03], // recenter
    ];
    for (const [name, set, wireCmd, receiver] of cases) {
      const op = OP_BY_NAME.get(name);
      expect(op, name).toBeDefined();
      expect(op!.set).toBe(set);
      expect(op!.wireCmd).toBe(wireCmd);
      expect(op!.receiver).toBe(receiver);
    }
  });

  it("has a unique lookup entry per command name", () => {
    expect(OP_BY_NAME.size).toBe(OPCODES.length);
  });

  it("keeps every wire cmd within 16 bits", () => {
    for (const o of SENDABLE) {
      expect(o.wireCmd!).toBeGreaterThanOrEqual(0);
      expect(o.wireCmd!).toBeLessThanOrEqual(0xffff);
    }
  });
});
