import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ ok: false, error: "invalid json" });
  }
  switch (req.op) {
    case "version":
      return send({ ok: true, version: "fake-1" });
    case "version_noisy":
      // Simulate a stray non-JSON diagnostic/log line the native helper
      // might emit on stdout before the real JSON response.
      process.stdout.write("this is not json, just a stray log line\n");
      return send({ ok: true, version: "fake-1" });
    case "die":
      // Exit without answering, simulating a helper that crashes (or is killed)
      // with a request in flight — the shape that wedged the MCP server when a
      // helper was killed to replace its locked binary.
      return process.exit(1);
    case "hang":
      // Stay alive and never answer, simulating a helper wedged in the driver.
      // No 'exit' fires for this one, so only a timeout can unstick it.
      return;
    case "device_gone":
      // Stay ALIVE but report the device as no longer attached — the exact
      // shape of an unplugged camera on macOS (kIOReturnNoDevice, 0xe00002c0).
      // Hardware-observed 2026-07-21 after a cable pull.
      return send({ ok: false, error: "xu_get: USB control request failed (0xe00002c0)" });
    case "some_other_error":
      // An ordinary failure that says nothing about the device being attached.
      // Must NOT condemn a working binding.
      return send({ ok: false, error: "xu_get: invalid hex" });
    case "enumerate":
      return send({
        ok: true,
        devices: [{ path: "p1", name: "OBSBOT Tiny 2", locationId: 51511296 }],
      });
    case "open":
      return send({ ok: true, xuNode: 1 });
    case "xu_set":
      return send({ ok: true });
    case "xu_get":
      // Echo a deterministic 60-byte reply (hex) so the RPC round-trip is
      // testable without hardware. Content is opaque at this layer.
      return send({ ok: true, hex: "aa" + "00".repeat(req.length ? req.length - 1 : 59) });
    case "zoom_range":
      return send({ ok: true, min: 0, max: 100 });
    case "zoom_set":
      return send({ ok: true });
    case "snapshot":
      if (req.path === "busy") {
        return send({ ok: false, busy: true, error: "camera in use by another application" });
      }
      return send({ ok: true, mime: "image/jpeg", width: 640, height: 360, base64: "QUJD" });
    case "camctrl_get":
      return send({ ok: true, value: 300, flags: 2 });
    default:
      return send({ ok: false, error: `unknown op: ${req.op}` });
  }
});
