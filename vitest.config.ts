import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test process, and every process a test spawns, gets a rendezvous
    // endpoint of its own. Without this a server started by a test joins the
    // owner of the developer's live session — and takes the endpoint from it
    // if the build under test is newer. See test/no-default-endpoint.test.ts.
    //
    // And no test binds UDP 5353: Tail 2 mDNS discovery falls back to the
    // (stubbed) sweep under this flag, exactly as on a multicast-filtered
    // network. The listener is covered by injected-listen tests and verified
    // against real hardware.
    env: {
      OBSBOT_IPC_NAME: `obsbot-vitest-${process.pid}`,
      OBSBOT_TAIL2_MDNS: "0",
    },
  },
});
