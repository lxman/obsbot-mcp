# Newest build wins — design

**Status:** approved 2026-09-27. Not yet implemented; the plan is
`docs/superpowers/plans/2026-09-27-newest-build-wins.md`.
**Depends on:** the peer-elected owner in `src/ipc/` and its design note `IPC-DESIGN.md`.
**Scope:** which server instance owns the camera endpoint, and how ownership moves to a newer
build. No tool changes, no helper protocol changes, no change to how a lone instance behaves.

## 1. Problem

After a rebuild, tool calls keep running the old code until **every** obsbot-mcp instance on the
machine has been shut down. Restarting the session you are working in is not enough, and nothing
tells you so.

The cause is the ownership rule in `IPC-DESIGN.md`: the first instance to bind the rendezvous
endpoint is the owner, every later instance is a client, and clients forward **whole tool calls** to
the owner (`src/mcp/server.ts` routes every tool through `coordinator.dispatch`). The handshake
carries no build identity, and ownership only moves when the owner goes away. So the oldest live
instance executes everything, for every session, in every project — the server is registered at
user scope, so every Claude session spawns one.

Two consequences follow, and the second is the dangerous one:

- **A rebuild does nothing until the oldest instance dies.** That instance may belong to a session
  in an unrelated project that never touches the camera.
- **A restarted session looks up to date and is not.** Each instance advertises its *own* tool
  list, so a restarted session shows the new tools while its calls execute on the old owner. Tool
  list and tool behaviour come from different builds.

## 2. Measured, 2026-09-27 (macOS, darwin-arm64)

| Time | Event |
|---|---|
| 19:08:37 | Instance **A** starts in another project's session. It binds the endpoint and becomes owner. It has loaded the build made at 18:33. |
| 19:29 | `dist/` is rebuilt with a guard that stops the Tiny 2 bind path from touching a Tail 2. |
| 19:44:41 | Instance **B** starts in this project's session, from the 19:29 build. Its log says `ipc role=client`. |
| 19:48:06 | `obsbot_devices` is called in B's session to confirm the guard. The call is forwarded to A, which runs the 18:33 code, opens the Tail 2 and sends it the Tiny 2 serial query. |

The guard had been built, unit-tested, and checked against the real helper. It was not running,
because the process that executes calls had never loaded it. The helper that touched the camera was
a child of A, not of B — that, and B's `ipc role=client` log line, are what identified the path.

After A was stopped, B's next call re-elected, B bound the endpoint, and the guarded code ran.

## 3. Goal and non-goals

**Goal.** Among the instances alive on a machine, the one built most recently owns the endpoint
and executes every tool call. Starting one instance from a new build is enough to put that build in
charge; no other session has to be closed.

**Also a goal.** A client never silently runs a tool call on a build older than its own. If it
cannot get the newer build into the owner's seat, the call fails and says why.

**Non-goals.**

- Refreshing the tool *list* of sessions that started from an older build. Their calls will run the
  new code; their list stays as it was until they reconnect. See §14.
- Reloading code inside a running process. A process keeps the build it loaded.
- Persisting ownership beyond the last instance. Unchanged from `IPC-DESIGN.md`.

## 4. The rule

1. Every instance has a **build identity**, fixed when the process starts (§5).
2. Builds are totally ordered by when they were built (§5.3).
3. On every connection to an owner, the client and owner exchange identities (§6).
4. If the client's build is newer, the owner **steps down** and the client takes the endpoint (§7).
5. If the builds are the same, or the client's is older, the client forwards as it does today.
6. If the owner is older and cannot step down, the client's tool calls fail (§9).

Ownership still belongs to exactly one process, and the bind is still the lock. What changes is
that the bind is no longer held for the life of the process.

## 5. Build identity

### 5.1 The stamp

`package.json`'s version cannot identify a build: it stays `0.7.0` across every development
rebuild. `src/version.ts` cannot carry a timestamp either — it is a tracked file and
`scripts/sync-version.mjs` is deliberately idempotent so a build does not dirty the tree.

The identity lives in a generated, untracked file, **`dist/build-info.json`**:

```json
{ "version": "0.7.0", "builtAt": 1790551781000, "digest": "<64 hex chars>" }
```

- `version` — from `package.json`. For log lines only; it takes no part in ordering.
- `builtAt` — milliseconds since the epoch, taken when the stamp was written.
- `digest` — SHA-256 over the code an instance can run: every `*.js` file under `dist/` and every
  file under `native/prebuilt/`, visited in sorted order of their POSIX-style relative paths. Each
  file contributes its relative path, a NUL byte, its contents, and a NUL byte.

`dist/` is already in `package.json`'s `files`, so the stamp ships in the npm package with no
packaging change.

### 5.2 Writing it

A new script, `scripts/stamp-build.mjs`, computes the digest and compares it with the existing
stamp:

- **Digest and version unchanged** → the file is left alone, `builtAt` included. Rebuilding
  identical code does not make a "newer" build and does not trigger a takeover.
- **Otherwise** → the file is rewritten with `builtAt` set to now.

It runs in three places:

| Where | Why |
|---|---|
| `postbuild` npm script | Every `npm run build` stamps what `tsc` just wrote. |
| End of `scripts/build-helper.mjs`, after staging | A helper-only rebuild changes what an owner would run, so it must change the identity. |
| `release.yml`, after the helpers are downloaded and made executable, before the tarball check | In the release job `npm run build` runs *before* the helpers arrive, so the `postbuild` stamp there covers `dist/` only. |

The release job's tarball check gains one line: `dist/build-info.json` must be in the pack list.

A helper built and copied by hand, without `npm run build:helper`, is not stamped. That is the
same rule the staging script already enforces for a different reason, and it is documented as such.

### 5.3 Reading and ordering it

`src/ipc/build-id.ts` exports `loadBuildId()` and `compareBuilds(a, b)`.

`loadBuildId()` reads `dist/build-info.json`, located relative to its own module URL, **once, at
startup, before the election**. The identity describes what the process loaded, so it must not be
re-read later: a rebuild under a running process changes the file but not the process.

If the file is missing or does not parse, the identity is
`{ version: VERSION, builtAt: 0, digest: "unstamped" }`.

`compareBuilds`:

| Condition | Result |
|---|---|
| Digests equal | Same build. |
| `builtAt` differs | The larger `builtAt` is newer. |
| `builtAt` equal, digests differ | The lexicographically larger digest is newer. Arbitrary but identical on both sides, which is all that matters. |

Two unstamped builds are the same build by this table, whatever code they hold. They behave as
instances do today. An unstamped build is older than any stamped one.

Ordering is by build time alone, not by version. "Newest build wins" then means one thing, and a
development build made today outranks a release made last month, which is what a developer
working on the server needs.

## 6. Protocol

Frames are unchanged: `[uint32 BE length][JSON {id, body}]`. Tool requests keep their body,
`{tool, args}`. Control messages are bodies with a reserved `ipc` key.

| Message | Direction | Body | Reply `result` |
|---|---|---|---|
| hello | client → owner | `{ipc:"hello", build, pid}` | `{ipc:"hello", build, pid}` |
| takeover | client → owner | `{ipc:"takeover", build, pid}` | `{ipc:"takeover", granted:true}` or `{ipc:"takeover", granted:false, reason:"not-newer"}` |
| stepping-down | owner → every client | `{ipc:"stepping-down", successorPid}`, sent with `id: 0` | none |

**A client forwards nothing until its hello has been answered.** The handshake is part of
connecting, so there is no window in which a tool call can reach an owner whose build the client
has not yet compared with its own.

**Control messages bypass the queue.** `OwnerServer` answers them as they arrive instead of
chaining them behind tool calls. A client's startup waits on its hello, and startup must not wait
for someone else's snapshot or gimbal move to finish.

**An instance that predates this design** treats a hello as a tool call and replies
`{ok:false, error:"unknown tool: undefined"}`. That reply is how a legacy owner is recognised. A
legacy *client* ignores a frame whose id it is not waiting for, so the `id: 0` notice is harmless
to it.

**Hello timeout:** 2000 ms. No reply in that time is treated like a legacy owner (§9).

## 7. Takeover

Owner **O**, older. Requester **R**, newer, connected as a client.

1. R sends hello, compares, and finds its build newer. It sends takeover.
2. O re-runs the comparison itself. If R is not newer it refuses with `not-newer` and nothing else
   happens. Otherwise it replies `granted:true` and begins stepping down.
3. **O closes the gate.** Tool calls that have not started will not start. A call already running
   is allowed to finish, and its reply is written.
4. **O releases everything that holds the camera:** `capture.stopAll()`, then
   `await mgr.shutdown()`. This is the cleanup the process already does on exit, without the exit.
   On macOS the control open is exclusive, so R could not open the camera until this completes.
5. O sends `stepping-down` to every client, then closes `OwnerServer`: client sockets are
   destroyed and the listener is closed.
6. **R sees its socket close and binds immediately.** It is now the owner.
7. Every other client, and O itself, waits `STEP_DOWN_GRACE_MS` plus jitter, then re-elects. They
   find R's endpoint, connect, exchange hellos, and forward.

A takeover request that arrives while O is already stepping down is granted with no further
action. Two instances of the same new build that start together both get `granted:true`, race for
the bind, and the loser connects to the winner as a same-build client.

### 7.1 Calls caught in the middle

| Call | What happens |
|---|---|
| Running on O when the gate closes | Finishes on O's code. Its reply is delivered before the socket closes. |
| Queued on O, from a client | Never starts and gets **no reply**. The socket then closes, and the client's existing retry-once sends it to the new owner. An error reply would be wrong here: the client would surface it instead of retrying. |
| Queued on O, from O's own session | Rejected internally, held until O has re-elected as a client, then forwarded. |
| Sent by any client during the grace period | Held until that client's re-election completes, then forwarded. |

A call is therefore executed once, by whichever build owned the endpoint when it started. The
existing retry-once after an owner *crash* can still run a call twice; that is unchanged.

### 7.2 Races and convergence

Closing a listener and binding it again is not atomic, so someone other than R can win step 6 —
most plausibly a legacy client, which re-elects lazily and knows nothing about grace periods.

R handles that the way it handles any owner: connect, hello, compare, request takeover. Each round
removes one older owner from the seat. R stops after `MAX_TAKEOVER_ROUNDS`, settles as a client,
and logs that it could not take the endpoint.

The comparison cannot disagree with itself — both sides compute the same total order — so two
instances can never each believe they should take over from the other.

### 7.3 Constants

| Name | Value | Why |
|---|---|---|
| `HELLO_TIMEOUT_MS` | 2000 | Bounds startup when the owner is a busy legacy instance. |
| `STEP_DOWN_GRACE_MS` | 500 | Long enough for R to bind before anyone else tries. |
| `ELECTION_JITTER_MS` | 0–100, uniform | Spreads clients that all lost the same owner at once. |
| `STEP_DOWN_TIMEOUT_MS` | 15000 | Longest R waits for O's running call and release. |
| `MAX_TAKEOVER_ROUNDS` | 5 | Bounds the loop in §7.2. |

If `STEP_DOWN_TIMEOUT_MS` passes without the socket closing, R stays a client of an owner it knows
to be older. §9 applies to its calls, and it requests takeover again before each one.

## 8. When the owner goes away

Today a client notices a lost owner only on its next tool call. That is not enough here. With
instances old, middle and new, where new owns and then exits: if old makes the next call, old
becomes owner and runs old code while middle sits idle, still disconnected.

**Clients re-elect when the connection closes, not when they next have something to send.**

| How the owner went | Delay before re-electing |
|---|---|
| `stepping-down` notice received, and this client is the requester | none |
| `stepping-down` notice received, otherwise | `STEP_DOWN_GRACE_MS` + jitter |
| No notice (exit or crash) | jitter only |

Whoever binds first owns the endpoint; everyone else connects and says hello; the newest of them
takes over. The endpoint settles on the newest live build without anyone making a tool call.

An instance that re-elects and binds does not open the camera. Binding the endpoint and binding a
camera are separate, and the camera is still opened lazily by the first tool call that needs it.

## 9. When the newer build cannot take over

The owner is older than the client, the client has tried to take over, and the owner is still the
owner. There are three ways to get here:

- the owner predates this design and has no way to step down;
- the owner granted a takeover and did not finish within `STEP_DOWN_TIMEOUT_MS`;
- the client used up `MAX_TAKEOVER_ROUNDS` losing the bind to older instances.

**The client does not forward.** Before each tool call it tries once more — hello, then takeover
if the owner can grant one — and if the owner is still older, the call fails with an error that
names the situation:

> obsbot-mcp: an older instance owns the camera endpoint and cannot hand it over. This instance
> will not run calls on older code. Stop the process listening on `<endpoint path>`; the next call
> will take over.

This is a deliberate reversal of today's behaviour, where the call would succeed on old code. §2
is the reason: a call that succeeds on code the caller did not expect is worse than one that fails
and explains itself. The rule applies to every tool, including the network-only `obsbot_tail2_*`
tools, because they are dispatched the same way and the same reasoning holds.

Because the attempt is repeated per call, the first call after the old owner exits re-elects and
succeeds. A hello sent to a legacy owner costs it one rejected "unknown tool" call and nothing
else.

## 10. Isolation: `OBSBOT_IPC_NAME`

The rendezvous name is fixed at `obsbot-mcp`. It becomes configurable:

- `OBSBOT_IPC_NAME` sets the name passed to `rendezvousPath()`. Default `obsbot-mcp`.
- It must match `^[A-Za-z0-9._-]{1,64}$`. Anything else is a startup error, because the name
  becomes part of a filesystem path or pipe name.

This is in scope because the tests need it. A harness that launches real servers on the default
name would, under this design, take the endpoint away from the developer's live session. Every
harness sets its own name.

It also gives a development session a way to run entirely on its own build. Two owners on one
machine can then contend for the camera: on macOS the second open fails as busy, and on Windows
and Linux both succeed and commands interleave. That is the collision `IPC-DESIGN.md` exists to
prevent, so the variable is for tests and deliberate isolation, not for everyday use.

## 11. What you can see

All on stderr, which Claude Code records in the server's MCP log. These lines are a contract: the
harnesses match on them.

A **build label** is `<version>/<builtAt as ISO 8601>/<first 8 characters of digest>`, for
example `0.7.0/2026-09-27T23:29:41Z/3f9a1c07`. An unstamped build's label is
`<version>/unstamped`.

| Line | When |
|---|---|
| `obsbot-mcp: build <build label>` | Startup, before the election. |
| `obsbot-mcp: ipc role=owner` | Bound the endpoint. Unchanged. |
| `obsbot-mcp: ipc role=client owner-pid=<pid> owner-build=<build label>` | Connected. The existing `ipc role=client` prefix is kept so `scripts/ipc-hw-smoke.mjs` still matches. For a legacy owner: `owner-pid=unknown owner-build=legacy`. |
| `obsbot-mcp: ipc takeover requested from pid <pid>` | R, step 1. |
| `obsbot-mcp: ipc stepping down for pid <pid>` | O, step 3. |
| `obsbot-mcp: ipc owner is older and cannot hand over; tool calls will fail until it exits` | §9, once per connection. |

To answer "which build will run my next call", read the newest file in the session's
`mcp-logs-obsbot` directory. The last `ipc role=` line says whether this instance owns the
endpoint, and if not, which process and build does.

## 12. Code changes

| File | Change |
|---|---|
| `scripts/stamp-build.mjs` | New. §5.2. |
| `scripts/build-helper.mjs` | Runs the stamp after staging. |
| `package.json` | `postbuild` script. |
| `.github/workflows/release.yml` | Stamp step after the helpers are staged; pack-list check for the stamp. |
| `src/ipc/build-id.ts` | New. `BuildId`, `loadBuildId()`, `compareBuilds()`. |
| `src/ipc/rendezvous.ts` | `rendezvousPath()` reads `OBSBOT_IPC_NAME` and validates it. |
| `src/ipc/owner.ts` | Answers control messages outside the queue. Sends the notice. Leaves calls rejected by the closed gate unanswered. |
| `src/ipc/client.ts` | `hello()` and `takeover()`. Surfaces the notice to the coordinator. |
| `src/ipc/coordinator.ts` | Handshake on every connect, the takeover loop, stepping down, re-election on close with the delays in §8, the refusal in §9. Owns the call gate. |
| `src/mcp/server.ts` | Loads the build identity before the election, passes the coordinator its identity, a logger, and a `release` function that does §7 step 4. |
| `IPC-DESIGN.md` | The "first instance owns" rule is replaced by a pointer to this document. |

`Coordinator`'s second constructor parameter changes from a path to an options object
(`path`, `build`, `release`, `log`). The existing coordinator tests pass a path and are updated.

The single-camera lock moves from a free function in `coordinator.ts` into the coordinator,
because stepping down needs two things the current `serialize()` cannot do: refuse calls that
have not started, and report when the running one has finished.

## 13. Testing

### 13.1 Unit, real sockets on temporary paths

These follow the existing pattern in `test/ipc/`, with the build identity injected through the
constructor.

| Scenario | Expected |
|---|---|
| Newer instance connects to an older owner | Owner steps down, `release` runs once, newer instance owns, the older forwards to it. |
| Same build connects | No takeover. `release` never runs. |
| Older instance connects to a newer owner | Stays a client. Its call runs on the owner. |
| Call running during a takeover | Completes on the old owner, and its reply arrives. |
| Client call queued behind it | Runs exactly once, on the new owner. |
| Old owner's own call queued behind it | Runs exactly once, on the new owner. |
| Two instances of the same newer build connect together | Exactly one owns. The other is its client. `release` ran once. |
| Third instance wins the bind during a takeover | Requester takes over from it on the next round. |
| Requester exhausts `MAX_TAKEOVER_ROUNDS` | Settles as a client, logs it, and its calls fail per §9. |
| Owner exits, clients old and middle remain, old binds first | Middle takes over without a tool call being made. |
| Legacy owner (replies `unknown tool: undefined` to hello) | Client's calls fail with the §9 error. None is forwarded. |
| Legacy owner exits | The next call re-elects and succeeds. |
| Hello unanswered for `HELLO_TIMEOUT_MS` | Treated as a legacy owner. |
| Legacy client connects to a new owner and sends a tool call with no hello | Served as today. |
| `stepping-down` notice delivered to a legacy client | Ignored; no error. |
| Owner is mid-call when a hello arrives | Hello is answered before the call finishes. |

`compareBuilds` and the stamp script get table tests of their own: every row of §5.3, a missing
and a malformed stamp file, and the digest being unchanged by a rebuild of identical sources.

### 13.2 Process level, no hardware

`scripts/ipc-smoke.mjs` gains a takeover case. It copies `dist/` into two directories under
`artifacts/ipc-builds/` (already ignored), writes a different stamp into each, and launches a
real server from each. Both use one `OBSBOT_IPC_NAME`, unique to the run, so they meet each other
and nobody else. It asserts the role lines of §11 and that a
call made through the older instance is answered by the newer one. The only tool it calls is
`obsbot_tail2_devices`, which reads an in-memory registry and touches no hardware.

Copies inside the repository resolve `node_modules` and `"type": "module"` by walking up to the
repository root, so they run without an install of their own.

### 13.3 Hardware

**Tiny 2 only.** A Tail 2 must not be the subject of any step here, and with one attached the
candidacy gate keeps the Tiny 2 path away from it.

`scripts/ipc-hw-smoke.mjs` gains a takeover case on its own rendezvous name: the older instance
binds the camera and reads `obsbot_status`; the newer instance starts; `obsbot_status` through
both must succeed and must be served by the newer one. On macOS this also proves §7 step 4
finishes before the new owner opens the camera, since the open is exclusive there. The test
reads status only and never moves the gimbal.

Any instance of the server running in an editor or a Claude session uses the default name and is
not disturbed.

## 14. Known limitations

- **Tool lists are not refreshed.** A session that started on an older build keeps its older tool
  list and schemas. Its calls run the newer code, so a tool whose arguments changed is validated
  against the new schema and may be rejected. That session needs a fresh server process to get
  the new list: restart the session, or reconnect the server from `/mcp` — if that re-spawns a
  stdio process, which the Claude Code documentation does not say and which has not been tested
  here.
- **A takeover ends recordings and previews** started through the old owner, because §7 step 4
  stops them. The recording file is closed properly and is shorter than asked for. Takeovers
  happen when a newer build starts, which in practice means during development or straight after
  an upgrade.
- **The first deployment needs one last full restart.** Instances running today's code cannot
  step down. Until they exit, newer instances refuse to run calls (§9).
- **Camera state in the old owner is not carried over.** The new owner binds on its first call,
  as a freshly started server does.
- **A hand-copied helper is not stamped** (§5.2).
- **Build time comes from the clock of the machine that built it.** A release built by CI and a
  local build are ordered by two different clocks. An error of minutes does not matter; a CI clock
  wrong by days would make a release outrank later local builds.

## 15. Alternatives considered

| Alternative | Why not |
|---|---|
| **Newest process wins.** Order by start time, no stamp. | Every new session would take the endpoint from a same-build owner, releasing and rebinding the camera each time. A session started from an older install would outrank newer code. |
| **Order by version, then build time.** | A development build could never outrank an installed release with a higher version number, which defeats the purpose for the person developing the server. |
| **Ask the old owner to exit.** | Its session loses the server, and Claude Code does not restart a stdio server that exits. It trades one restart for another. |
| **Keep the old owner as a router and execute on the newest client.** | No re-election and no race, but every call would still pass through the oldest code, and a fault in the routing layer would need the same full restart this design exists to avoid. |
| **Defer the takeover while a recording is running.** | Old code would keep executing for the length of the recording, and `obsbot_capture_stop` from the newer session would have to be forwarded to the older owner — an exception to §9 in the one place it matters most. |
| **Forward to an owner that cannot step down, and log a warning.** | This is today's behaviour with a log line added. §2 happened with the evidence already in the log. |

## 16. Out of scope

- Clients taking their tool list from the owner and announcing `tools/list_changed`, which would
  remove the first limitation in §14.
- A tool that reports the role and the owner's build. The log lines in §11 carry the same facts.
- Watching `dist/` and reloading or exiting when it changes.
- Any Tail 2 USB transport.
