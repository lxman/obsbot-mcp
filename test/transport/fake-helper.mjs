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
    case "enumerate":
      return send({
        ok: true,
        devices: [{ path: "p1", name: "OBSBOT Tiny 2" }],
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
