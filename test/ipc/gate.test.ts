import { describe, test, expect } from "vitest";
import { CallGate, StepDownError } from "../../src/ipc/gate.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("call gate", () => {
  test("runs calls one at a time, in the order they were made", async () => {
    const gate = new CallGate();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const call = (name: string, ms: number) =>
      gate.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(ms);
        order.push(name);
        inFlight--;
        return name;
      });

    const results = await Promise.all([call("a", 15), call("b", 1), call("c", 5)]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxInFlight).toBe(1);
  });

  test("a failing call does not stop the ones behind it", async () => {
    const gate = new CallGate();
    const first = gate.run(async () => {
      throw new Error("kaboom");
    });
    const second = gate.run(async () => "fine");

    await expect(first).rejects.toThrow("kaboom");
    expect(await second).toBe("fine");
  });

  test("closing lets the running call finish and refuses the ones that had not started", async () => {
    const gate = new CallGate();
    const events: string[] = [];
    const running = gate.run(async () => {
      await sleep(20);
      events.push("running finished");
      return "ran";
    });
    let queuedStarted = false;
    const queued = gate.run(async () => {
      queuedStarted = true;
      return "must not run";
    });
    const queuedOutcome = queued.then(
      () => "resolved",
      (e: unknown) => e,
    );

    await sleep(5); // the first call is now in flight
    await gate.close().then(() => events.push("close resolved"));

    expect(await running).toBe("ran");
    expect(await queuedOutcome).toBeInstanceOf(StepDownError);
    expect(queuedStarted).toBe(false);
    expect(events).toEqual(["running finished", "close resolved"]);
  });

  test("a call made after the gate closed is refused", async () => {
    const gate = new CallGate();
    await gate.close();
    await expect(gate.run(async () => "no")).rejects.toBeInstanceOf(StepDownError);
  });

  test("closing an idle gate resolves at once", async () => {
    const gate = new CallGate();
    await expect(gate.close()).resolves.toBeUndefined();
  });

  test("an opened gate runs calls again", async () => {
    const gate = new CallGate();
    await gate.close();
    gate.open();
    expect(await gate.run(async () => "back")).toBe("back");
  });
});
