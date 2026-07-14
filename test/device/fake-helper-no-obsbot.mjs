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
    case "enumerate":
      return send({
        ok: true,
        devices: [{ path: "p1", name: "Generic Webcam" }],
      });
    case "open":
      return send({ ok: true, xuNode: 1 });
    case "xu_set":
      return send({ ok: true });
    case "zoom_range":
      return send({ ok: true, min: 0, max: 100 });
    case "zoom_set":
      return send({ ok: true });
    default:
      return send({ ok: false, error: `unknown op: ${req.op}` });
  }
});
