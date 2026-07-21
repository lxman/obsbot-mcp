import { expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HelperProcess } from "../../src/transport/helper-process.js";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-helper.mjs");
const spawnFake = (): HelperProcess => new HelperProcess(["node", fake]);

const rpcOf = (h: HelperProcess) =>
  (h as unknown as {
    rpc: (req: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  }).rpc.bind(h);

const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
//  Unsolicited push events from the helper.
//
//  The helper learns about camera arrival/removal from the OS before any tool
//  call fails, so it needs a way to tell the Node side without being asked.
//  Responses are correlated BY POSITION in a queue, so an unsolicited line that
//  got treated as a response would hand this request's reply to the next waiter
//  and desync every later call. The existing stray-line guard already ignores
//  JSON without a boolean `ok` — these tests pin that events ride that lane.
// ---------------------------------------------------------------------------

test("an event line is delivered to the camera-departed listener", async () => {
  const h = spawnFake();
  await h.start();
  const seen: Array<{ path: string }> = [];
  h.onCameraDeparted((e) => seen.push(e));

  await rpcOf(h)({ op: "version" });                    // prove the link works
  h.send({ op: "emit_event", event: "camera_departed", path: "p1" });
  await settle();

  expect(seen).toHaveLength(1);
  expect(seen[0]!.path).toBe("p1");
  await h.close();
});

test("an arrival event reaches the camera-arrived listener", async () => {
  const h = spawnFake();
  await h.start();
  const seen: Array<{ path: string }> = [];
  h.onCameraArrived((e) => seen.push(e));

  h.send({ op: "emit_event", event: "camera_arrived", path: "p9" });
  await settle();

  expect(seen.map((e) => e.path)).toEqual(["p9"]);
  await h.close();
});

test("an event arriving mid-request does not desync the response queue", async () => {
  // The failure this guards: the event is consumed as a response, so this
  // request's real reply goes to the NEXT caller and every later call is shifted.
  const h = spawnFake();
  await h.start();
  const departed: unknown[] = [];
  h.onCameraDeparted((e) => departed.push(e));

  const first = await rpcOf(h)({ op: "event_then_reply" });
  expect(first.marker).toBe("real-reply");             // got ITS own reply

  const second = await rpcOf(h)({ op: "version" });
  expect(second.version).toBe("fake-1");               // queue still aligned
  expect(departed).toHaveLength(1);                    // and the event surfaced
  await h.close();
});

test("events with no listener attached are harmless", async () => {
  const h = spawnFake();
  await h.start();
  h.send({ op: "emit_event", event: "camera_departed", path: "p1" });
  await settle();
  const resp = await rpcOf(h)({ op: "version" });      // link still usable
  expect(resp.version).toBe("fake-1");
  await h.close();
});
