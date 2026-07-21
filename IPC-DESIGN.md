# IPC Design — single-owner camera coordination across MCP clients

> Handoff note for whoever (or whichever Claude) picks this up on macOS or Linux.
> Read this before touching code on the `ipc-design` branch. It captures **what
> we're trying to accomplish and why**, and **what to build**. The reasoning
> matters as much as the conclusion — don't re-litigate the parts already
> settled here without new information.

## The problem

`obsbot-mcp` is a **stdio** MCP server (`src/mcp/server.ts` → `StdioServerTransport`;
Claude Code launches it as `node dist/index.js --debug`). Consequences of stdio:

- **Every MCP client spawns its own server subprocess** — its own `DeviceManager`,
  its own registry, its own native helper. This is true for *any* host (Claude
  Code, Cursor, a GLM/Grok-driven agent, a bare script). **The model is
  irrelevant**; MCP is model-agnostic. What differs is only the host process.
- These per-client servers are **blind to each other**. All exclusivity logic
  (the registry, "once bound stay bound", "skip busy") is **in-process only** —
  it can arbitrate cameras *within one server*, never *across instances*.
- Open two clients on one machine → two servers → two+ helpers, all pointed at
  the **one** physical camera, with no coordination.

What actually happens then, by platform:

| Platform | Control open exclusive? | Result with 2 clients |
|---|---|---|
| **Windows** | **No** (DirectShow XU control path) | Both open + control the camera; commands interleave (wake vs sleep, +30° vs −30°); the shared XU **selector-2 reply mailbox** cross-reads, corrupting `readSerial`. Snapshot capture pin *is* exclusive → one wins, other gets "busy". |
| **macOS** | **Yes** (`USBDeviceOpen`) | Second client's helper fails `kIOReturnExclusiveAccess` → accidental fail-safe: one owner, others locked out. |
| **Linux** | v4l2 (effectively non-exclusive for control) | Similar collision risk to Windows. |

The current design's rule — *"busy ⇒ a sibling helper owns it, skip it"* —
silently **assumes open is exclusive**. True on macOS, **false on Windows**. So
on Windows there is no real cross-instance (or cross-process, e.g. vs OBSBOT
Center) arbitration at all.

## The goal (and non-goal)

- **One process owns the camera at a time**; all client servers coordinate
  through it, so commands serialize instead of colliding.
- **Keep it simple**: one npm package, no separately-installed daemon, and — see
  below — **preserve the macOS camera-permission story**.
- **Non-goal: persistence beyond the last client.** When no client is running,
  nothing needs the camera. We are solving *collision*, not *sharing a
  long-lived owner*. This non-goal is what keeps the design cheap.

## The macOS TCC constraint (why NOT a launchd daemon)

Camera permission (TCC) keys to the **responsible process**, which for a
terminal-launched CLI is the **terminal app** (Terminal / iTerm / …). It is
granted **once**, then inherited by **every descendant** — any client, any
model, any terminal window/tab. The bare helper needs **no bundle, no
`NSCameraUsageDescription`, no signing**; it rides the terminal's grant.

The catch: that free grant reaches **descendants of a granted terminal only**. A
detached, persistent broker (e.g. a `launchd` daemon) is **not** a terminal
descendant → it forfeits the inherited grant → it would need its **own** signed
`.app` bundle + `NSCameraUsageDescription` + a user-context first-run prompt.
That is the tax we **avoid**.

**Therefore the camera owner must remain a terminal descendant.**

## Chosen design — peer-elected in-process owner (no daemon)

The **owner** role is assumed by **whichever MCP-server instance starts first**;
later instances attach as **clients** and forward their helper calls to the
owner. Because the owner is just an ordinary server instance (spawned by a
client, spawned by a granted terminal), it **inherits the terminal TCC grant for
free**. When the owner exits, a still-live client **re-elects** and takes over —
also a terminal descendant, so still granted. When the last client exits, the
camera frees (correct).

This is the classic self-electing single-instance server ("peer bootstrap") — how
D-Bus, X11, and single-instance apps bootstrap.

### Mechanism

- **Rendezvous = a well-known name.** Strangers meet via an agreed fixed name; no
  prior knowledge of each other required.
- **Transport + election = a named pipe / Unix-domain socket — NOT raw SHMEM.**
  - Election is **atomic** via `net.createServer(path)`: exactly one bind
    succeeds → **owner**; everyone else gets `EADDRINUSE` → connect as **client**.
    This avoids the **check-then-create TOCTOU race** (two instances both seeing
    "not set up" and both becoming owner) — the reason raw "check the SHMEM flag,
    else create it" is unsafe.
  - A stream socket gives **framing, wakeup, backpressure, and clean
    crash-detection** (EOF / `ECONNRESET`) for free — all of which raw shared
    memory lacks.
  - Paths: `\\.\pipe\obsbot-mcp` (Windows), `/tmp/obsbot-mcp.sock` or Linux
    abstract `@obsbot-mcp` (POSIX).
- **SHMEM is rejected for the control channel** (no notification → busy-poll; no
  framing; no disconnect signal; hand-rolled sync). Reserve it *only* if we later
  need zero-copy transfer of **bulk video frames**; camera control is low-rate
  request/response where a socket is strictly better.
- **Client → owner protocol** forwards the existing helper RPC ops
  (`enumerate`/`open`/`xu_set`/`xu_get`/`snapshot`/…). The owner runs the single
  `DeviceManager` + helper and **serializes** requests so ops don't interleave on
  the wire (critical for the XU selector-2 reply mailbox).

### Where it plugs into the current code

The seam is at the **tool-dispatch** level, NOT at `HelperProcess`. (Correction
found during implementation: forwarding raw helper ops would leave each client
with its own `DeviceManager` driving the owner's single native helper, and two
managers clobber the helper's one open-device session — client opens camera X
while the owner's manager still believes it holds Y.) So the **owner holds the
single `DeviceManager` + native helper**, and clients forward whole tool calls.

On start (`src/mcp/server.ts`):

- `elect()` the rendezvous endpoint.
- **Owner:** build the real `DeviceManager` + helper + tool handlers as today;
  additionally run `OwnerServer` (`src/ipc/owner.ts`), whose injected handler is
  the same tool dispatch (`{tool, args} → result`), **serialized** across all
  clients so camera ops never interleave on the wire.
- **Client:** register MCP tool handlers that forward `{tool, args}` over the
  socket to the owner and return its result — the client has NO `DeviceManager`
  and never touches the device.

Single-client behaviour is **identical to today** (first instance = owner, runs
tools locally against its own helper; `OwnerServer` sits idle with no clients).

## Sharp edges = acceptance criteria

1. **Atomic single-winner election** — two simultaneous starts elect exactly one owner.
2. **Re-election + camera handoff** on owner exit/crash — live clients detect the
   closed socket, race to re-bind, winner re-opens the camera, others reconnect.
3. **Stale-endpoint cleanup (POSIX only)** — a crashed owner can leave a UDS file;
   next `bind()` gets `EADDRINUSE` with nobody listening → try-connect, and if
   refused, unlink + rebind. Windows named pipes (kernel-refcounted) and Linux
   abstract sockets don't have this; macOS filesystem UDS does.
4. **Same-user restriction** on the endpoint (pipe SD / UDS fs perms /
   `SO_PEERCRED`). Local only — no network port, no firewall prompt.
5. **Serialization at the owner** so concurrent client requests can't interleave.
6. **Single-client regression** — behaves exactly as today.

## Test plan

- Two clients: A (owner) + B (client) → B's ops succeed via A; no collision;
  `readSerial` stable under interleaving.
- Kill A while B alive → B re-elects, re-opens the camera, continues.
- Kill all → endpoint cleaned up; next start elects fresh.
- Single client → identical to today (regression).
- Platforms: **Windows** is where the collision is real (primary target).
  **macOS** — verify the owner, spawned from a granted terminal, still inherits
  the camera grant (no bundle/launchd). **Linux** later.

## Picking this up on macOS / Linux

- Branch: **`ipc-design`**. Base includes the VID/PID candidacy fix already on
  master (commit `ebc4f8f`) — `bind()`/`listCameras()` now filter by hardware
  identity, which this design relies on.
- **macOS first step:** `native/macos/helper.m` was edited **blind on Windows**
  (introduced `REMO_VID` + `OBSBOT_MODEL_PIDS[]` table, emits `vid`/`pid` from
  IORegistry `idProduct`, replacing the hardcoded `OBSBOT_VID`/`TINY2_PID`).
  **Build it and run one `{"op":"enumerate"}` to confirm it still finds the Tiny 2
  with `vid`/`pid` before trusting it.** (See the memory `obsbot-multicam-candidacy`.)
- **Keep the owner a terminal descendant** — no `launchd`, no detach — or you
  forfeit the free camera TCC grant and inherit the signed-bundle tax.
