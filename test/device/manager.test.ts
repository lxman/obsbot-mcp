import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HelperProcess } from "../../src/transport/helper-process.js";
import { DeviceManager } from "../../src/device/manager.js";

const fake = join(
  dirname(fileURLToPath(import.meta.url)),
  "../transport/fake-helper.mjs",
);
const fakeNoObsbot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-helper-no-obsbot.mjs",
);

test("list() returns a device whose name includes OBSBOT", async () => {
  const helper = new HelperProcess(["node", fake]);
  await helper.start();
  const manager = new DeviceManager(helper);

  const devices = await manager.list();

  expect(devices.some((d) => d.name.includes("OBSBOT"))).toBe(true);

  await helper.close();
});

test("openFirstObsbot() returns a working transport", async () => {
  const helper = new HelperProcess(["node", fake]);
  await helper.start();
  const manager = new DeviceManager(helper);

  const transport = await manager.openFirstObsbot();

  expect(transport.nextSeq()).toBe(1);
  expect(transport.nextSeq()).toBe(2);

  expect(await transport.zoomRange()).toEqual({ min: 0, max: 100 });

  await expect(transport.sendVendor(Buffer.from([0]))).resolves.toBeUndefined();

  await expect(transport.close()).resolves.toBeUndefined();
});

test("openFirstObsbot() throws when no OBSBOT device is present", async () => {
  const helper = new HelperProcess(["node", fakeNoObsbot]);
  await helper.start();
  const manager = new DeviceManager(helper);

  await expect(manager.openFirstObsbot()).rejects.toThrow(
    /no OBSBOT Tiny 2 found/,
  );

  await helper.close();
});
