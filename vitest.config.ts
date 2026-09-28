import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test process, and every process a test spawns, gets a rendezvous
    // endpoint of its own. Without this a server started by a test joins the
    // owner of the developer's live session — and takes the endpoint from it
    // if the build under test is newer. See test/no-default-endpoint.test.ts.
    env: { OBSBOT_IPC_NAME: `obsbot-vitest-${process.pid}` },
  },
});
