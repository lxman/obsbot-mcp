import { describe, expect, it } from "vitest";
import { Tail2Registry } from "../../src/tail2/registry.js";
import type { Tail2Api, Tail2DeviceInfo } from "../../src/tail2/api.js";

/**
 * Registry tests run against stub Tail2Apis injected through the `makeApi`
 * factory — the registry's contract is selector/identity logic, not HTTP
 * (the client against a real fake server is covered in api.test.ts). Stubs
 * are keyed by host so a "scan" can answer on specific addresses only.
 */

const INFO_A: Tail2DeviceInfo = {
  device_name: "Tail 2_aaaa",
  wired_ip: "192.168.0.10",
  wireless_ip: "0.0.0.0",
  mac: "AA:AA:AA:AA:AA:AA",
};
const INFO_B: Tail2DeviceInfo = {
  device_name: "Tail 2_bbbb",
  wired_ip: "192.168.0.20",
  wireless_ip: "192.168.55.20",
  mac: "BB:BB:BB:BB:BB:BB",
};

const registryWith = (
  answers: Record<string, Tail2DeviceInfo | Error>,
): Tail2Registry =>
  new Tail2Registry({
    makeApi: (host) =>
      ({
        info: async () => {
          const a = answers[host];
          if (!a) throw new Error(`nothing at ${host}`);
          if (a instanceof Error) throw a;
          return a;
        },
      }) as unknown as Tail2Api,
  });

describe("Tail2Registry", () => {
  it("addHost registers by lowercased MAC and returns the entry", async () => {
    const reg = registryWith({ "192.168.0.10": INFO_A });
    const e = await reg.addHost("192.168.0.10");
    expect(e?.mac).toBe("aa:aa:aa:aa:aa:aa");
    expect(reg.list()).toHaveLength(1);
  });

  it("addHost merges a second host for the same MAC (wired + wireless)", async () => {
    const reg = registryWith({
      "192.168.0.20": INFO_B,
      "192.168.55.20": INFO_B,
    });
    await reg.addHost("192.168.0.20");
    const e = await reg.addHost("192.168.55.20");
    expect(reg.list()).toHaveLength(1);
    expect(e?.hosts).toEqual(["192.168.0.20", "192.168.55.20"]);
  });

  it("addHost returns null for silence or non-Tail 2 replies", async () => {
    const reg = registryWith({
      "10.0.0.1": new Error("ECONNREFUSED"),
      "10.0.0.2": { ...INFO_A, mac: "", device_name: "" }, // reply with no identity
    });
    expect(await reg.addHost("10.0.0.1")).toBeNull();
    expect(await reg.addHost("10.0.0.2")).toBeNull();
    expect(reg.list()).toHaveLength(0);
  });

  it("resolve() with no selector: none -> actionable hint, one -> it, many -> ambiguous", async () => {
    const empty = registryWith({});
    await expect(empty.resolve()).rejects.toThrow(/obsbot_tail2_scan/);

    const one = registryWith({ "192.168.0.10": INFO_A });
    await one.addHost("192.168.0.10");
    await expect(one.resolve()).resolves.toMatchObject({ mac: "aa:aa:aa:aa:aa:aa" });

    const two = registryWith({ "192.168.0.10": INFO_A, "192.168.0.20": INFO_B });
    await two.addHost("192.168.0.10");
    await two.addHost("192.168.0.20");
    const err = await two.resolve().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("aa:aa:aa:aa:aa:aa");
    expect((err as Error).message).toContain("bb:bb:bb:bb:bb:bb");
  });

  it("resolve(selector) matches MAC, name, or host — case-insensitive", async () => {
    const reg = registryWith({ "192.168.0.10": INFO_A });
    await reg.addHost("192.168.0.10");
    for (const sel of ["AA:AA:AA:AA:AA:AA", "tail 2_aaaa", "192.168.0.10"]) {
      await expect(reg.resolve(sel)).resolves.toMatchObject({ mac: "aa:aa:aa:aa:aa:aa" });
    }
  });

  it("resolve(host-of-an-unregistered-camera) registers it on demand", async () => {
    const reg = registryWith({ "192.168.0.42": INFO_B });
    const e = await reg.resolve("192.168.0.42");
    expect(e.mac).toBe("bb:bb:bb:bb:bb:bb");
    expect(reg.list()).toHaveLength(1);
  });

  it("resolve(unknown) lists what IS available", async () => {
    const reg = registryWith({ "192.168.0.10": INFO_A });
    await reg.addHost("192.168.0.10");
    await expect(reg.resolve("nope")).rejects.toThrow(/aa:aa:aa:aa:aa:aa/);
  });

  it("fromEnv seeds hosts from OBSBOT_TAIL2_HOSTS", async () => {
    const answers: Record<string, Tail2DeviceInfo | Error> = { "192.168.0.10": INFO_A };
    const reg = Tail2Registry.fromEnv(
      { OBSBOT_TAIL2_HOSTS: " , 192.168.0.10 , " } as Record<string, string>,
      {
        makeApi: (host) =>
          ({
            info: async () => {
              const a = answers[host];
              if (!a || a instanceof Error) throw new Error("no camera");
              return a;
            },
          }) as unknown as Tail2Api,
      },
    );
    // fromEnv seeds fire-and-forget; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.list().map((e) => e.hosts)).toContainEqual(["192.168.0.10"]);
  });

  it("scanSubnet finds and registers cameras on the swept subnet", async () => {
    const reg = registryWith({
      "192.168.77.5": INFO_A,
      "192.168.77.9": INFO_B,
    });
    const found = await reg.scanSubnet({ subnets: ["192.168.77"], concurrency: 64 });
    expect(found.map((e) => e.mac).sort()).toEqual(["aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb"]);
    expect(reg.list()).toHaveLength(2);
  });
});
