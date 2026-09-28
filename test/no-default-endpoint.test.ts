import { test, expect } from "vitest";
import { rendezvousName, rendezvousPath } from "../src/ipc/rendezvous.js";

// ---------------------------------------------------------------------------
// Nothing the test suite starts may meet a live server.
//
// A server that starts on the default rendezvous name joins whatever owner is
// already running on this machine — and if its build is newer, takes the
// endpoint from it, which makes that owner release the camera and stop its
// recordings. A developer running `npm test` with a session open must not do
// that to themselves.
//
// vitest.config.ts gives every test process an OBSBOT_IPC_NAME of its own, and
// a process a test spawns inherits it. This pins that: take the setting out of
// the config and this fails.
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT =
  process.platform === "win32" ? "\\\\.\\pipe\\obsbot-mcp" : "/tmp/obsbot-mcp.sock";

test("the test environment names a rendezvous endpoint of its own", () => {
  expect(process.env.OBSBOT_IPC_NAME).toMatch(/^obsbot-vitest-\d+$/);
});

test("so nothing a test starts by default can reach the live endpoint", () => {
  expect(rendezvousName()).not.toBe("obsbot-mcp");
  expect(rendezvousPath()).not.toBe(DEFAULT_ENDPOINT);
});
