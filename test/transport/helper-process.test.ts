import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HelperProcess } from "../../src/transport/helper-process.js";
import { CameraBusyError } from "../../src/transport/transport.js";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-helper.mjs");

test("resolveBinaryPath throws for unsupported platforms", () => {
  expect(() => HelperProcess.resolveBinaryPath("sunos", "x64")).toThrow(
    /transport not yet implemented for sunos/,
  );
});

test("RPC round-trips through the fake helper", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();

  expect(await h.version()).toBe("fake-1");

  const devices = await h.enumerate();
  expect(devices[0].name).toContain("OBSBOT");

  const xuNode = await h.open("p1");
  expect(xuNode).toBe(1);

  await h.xuSet(2, Buffer.from([0x0a, 0x0b]));

  expect(await h.zoomRange()).toEqual({ min: 0, max: 100 });

  await h.zoomSet(50);

  await h.close();
});

test("stray non-JSON stdout line is ignored and does not desync the RPC queue", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();

  // Directly invoke the private rpc() with an op that makes the fake helper
  // emit a stray non-JSON line before its real JSON response.
  const rpc = (
    h as unknown as {
      rpc: (req: Record<string, unknown>) => Promise<{ ok: boolean; version?: string }>;
    }
  ).rpc.bind(h);

  const resp = await rpc({ op: "version_noisy" });
  expect(resp.ok).toBe(true);
  expect(resp.version).toBe("fake-1");

  // A subsequent, unrelated request must still resolve correctly, proving
  // the stray line did not shift an extra callback off the queue.
  expect(await h.version()).toBe("fake-1");
  const devices = await h.enumerate();
  expect(devices[0].name).toContain("OBSBOT");

  await h.close();
});

test("snapshot returns the decoded frame from the helper", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  const snap = await h.snapshot({ maxDim: 640, quality: 70, settleMs: 100 });
  expect(snap).toEqual({ mime: "image/jpeg", width: 640, height: 360, base64: "QUJD" });
  await h.close();
});

// Frame rate selects the field of view on this camera (1080p30 and 1080p60 are
// different windows onto the sensor), so the negotiated format is part of what a
// snapshot pixel means to the aiming geometry. It has to survive the trip from
// the helper rather than being dropped on the floor here.
test("snapshot surfaces the helper's negotiated source format", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  const snap = await h.snapshot({ path: "withformat" });
  expect(snap.sourceFormat).toBe("MJPG 1920x1080@30.00");
  await h.close();
});

// A helper that cannot determine the format sends an empty string. That means
// "unknown", and unknown must not masquerade as a real answer -- a caller
// checking `if (snap.sourceFormat)` would otherwise see a falsy-but-present
// field, and one serializing it would publish an empty format as fact.
test("snapshot omits an empty source format rather than reporting it", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  const snap = await h.snapshot({ path: "blankformat" });
  expect(snap).not.toHaveProperty("sourceFormat");
  await h.close();
});

test("snapshot throws CameraBusyError when the helper reports busy", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  await expect(h.snapshot({ path: "busy" })).rejects.toBeInstanceOf(CameraBusyError);
  await h.close();
});

test("xu_get round-trips: returns the reply bytes as a Buffer", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  const buf = await h.xuGet(2, 60);
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.length).toBe(60);
  expect(buf[0]).toBe(0xaa);
  await h.close();
});

test("camctrl_get round-trips value and flags", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  expect(await h.camCtrlGet(0)).toEqual({ value: 300, flags: 2 });
  await h.close();
});

test("enumerate surfaces locationId from the helper", async () => {
  const h = new HelperProcess(["node", fake]);
  await h.start();
  const devs = await h.enumerate();
  expect(devs[0].locationId).toBe(51511296);
  expect(devs[0].serial).toBeUndefined(); // serial is read later, not at enumerate
  await h.close();
});
