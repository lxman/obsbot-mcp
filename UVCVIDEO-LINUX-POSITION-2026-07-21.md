# Why Linux can't read live gimbal position — and whether a kernel patch is warranted

Companion to the working notes `GIMBAL-POSITION-USB-2026-07-21.md` (wire
protocol) and `LINUX-HANDOVER-2026-07-21.md`, both of which live in the repo root
but are untracked. This document covers the *Linux platform gap*: why the position feedback that works on macOS is unavailable on
Linux, what was measured against real hardware, and the conclusion reached about
submitting a patch to the `uvcvideo` kernel driver.

**Bottom line: a patch is justified. The first draft was scrapped — it broke
pan/tilt writes and its central justification was wrong. A corrected patch has
since been written, compiled, and verified against hardware; see §9.**

**Sent to `linux-media` 2026-07-25**, Message-ID
`<20260725212332.64927-1-jordan.mymail@gmail.com>`
([lore](https://lore.kernel.org/linux-media/20260725212332.64927-1-jordan.mymail@gmail.com/)).
**Under review**: first response from Ricardo Ribalda 2026-07-31 ("not
against the idea", three questions and an alternative proposal); answered
same day. See §9, "First review".

> **Update 2026-07-25.** Sections 1–4 and 7 stand as written. Section 5's
> "what must be built first" is done (§9). Section 8 contained an error and has
> been corrected. Section 3 has been extended with a finding that materially
> strengthens the case: the staleness is not merely a consequence of this
> device's non-compliance — it bounds *every* UVC PTZ camera.

---

## 1. The situation in one paragraph

`CT_PANTILT_ABSOLUTE_CONTROL` (selector `0x0D`) returns genuine live encoder
position on the Tiny 2 — verified twice, independently, on this hardware. macOS
reads it live during motion, concurrently with video streaming, in production.
On Linux the same read returns a stale cached value forever. This is *not*
because the device behaves differently on Linux. It is the product of two
independent constraints that happen to coincide there, either of which would be
sufficient to fix it.

---

## 2. What was measured

### 2.1 The device returns live position (confirmed)

With `uvcvideo` detached, polling raw `GET_CUR` (`bmRequestType=0xA1`,
`bRequest=0x81`, `wValue=0x0D00`, `wIndex=(1<<8)|0`, `wLength=8`) every 40 ms
while a V4L2-commanded 0° → 90° pan was in flight:

```
t+0ms     pan=0°
t+709ms   pan=3°
t+832ms   pan=10°
t+1913ms  pan=51°
t+3259ms  pan=90°   <- physical arrival
t+3300ms  pan=90°   (steady thereafter)
```

The value tracked the physical slew and settled on arrival. This is encoder
feedback, not an echo of the commanded setpoint. Tilt correctly stayed at 0°
throughout, having never been commanded.

Tool: `scratchpad/libusb_pantilt.c`.

### 2.2 The device never sends Control Change interrupts (confirmed)

`GET_INFO` (`bRequest=0x86`) dumped across five Camera Terminal controls:

| Control | Selector | Raw | D3 (Autoupdate) | D4 (Asynchronous) |
|---|---|---|---|---|
| `CT_PANTILT_ABSOLUTE` | `0x0D` | `0x03` | 0 | 0 |
| `CT_PANTILT_RELATIVE` | `0x0E` | `0x03` | 0 | 0 |
| `CT_ZOOM_ABSOLUTE` | `0x0B` | `0x03` | 0 | 0 |
| `CT_AE_MODE` | `0x02` | `0x03` | 0 | 0 |
| `CT_FOCUS_ABSOLUTE` | `0x06` | `0x03` | 0 | 0 |

Every control returns an identical constant `0x03` (`D0 GET=1, D1 SET=1`,
everything else clear). The firmware is not computing `GET_INFO` per control —
it returns a fixed value for all of them.

Tool: `scratchpad/libusb_getinfo.c` (read-only, reattaches cleanly).

**This is a genuine spec violation.** UVC 1.5 §2.4.4:

> "Any control that requires more than 10ms to respond to a SET_CUR request
> (asynchronous control), or that can change independently of any external
> SET_CUR request (Autoupdate control), must send a Control Change status
> interrupt. These characteristics will be reflected in the GET_INFO response
> for that control."

Pan/tilt on this camera is *both*: moves take seconds, and AI tracking
repositions the gimbal autonomously as a headline product feature. Both D3 and
D4 should be set. Neither is.

---

## 3. Why macOS works and Linux doesn't

This is the crux, and it is **not** a firmware difference.

### macOS

`native/macos/helper.m` (header comment, ~line 21):

> The device itself, however, is *not* locked. `USBDeviceOpen` succeeds, and UVC
> control requests (which are class requests with an interface recipient) can be
> issued on the device's default control endpoint via `DeviceRequest`. That
> gives us XU and standard-control access while UVCAssistant keeps driving the
> stream — the camera keeps working as a normal webcam.

`doCamCtrlGet` (`helper.m:845`) issues a raw `uvcGetCur` → `uvcControl(intf,
0xA1, 0x81, 0x0D, ...)` on **every read**. No caching layer anywhere in the
path. The DriverKit dext (UVCAssistant) owns the UVC *interfaces* exclusively,
but the *device* stays open to userspace, so control transfers coexist with
streaming.

### Linux

Two separate blockers:

1. **`uvcvideo` caches the value.** `__uvc_ctrl_load_cur()`
   (`drivers/media/usb/uvc/uvc_ctrl.c:1467`) short-circuits on `ctrl->loaded`.
   That flag is cleared in only two places: the driver's own `SET_CUR` commit
   (`uvc_ctrl_commit_entity`, for `AUTO_UPDATE` controls), and
   `uvc_ctrl_status_event()` on receipt of a Control Change interrupt — which
   this device never sends (§2.2). So `VIDIOC_G_CTRL` on
   `V4L2_CID_PAN_ABSOLUTE`/`TILT_ABSOLUTE` serves a stale value indefinitely.
   Confirmed independently via `VIDIOC_QUERY_EXT_CTRL` reporting `flags=0x0`
   (no `V4L2_CTRL_FLAG_VOLATILE`).

   **The one-sample ceiling (added 2026-07-25).** The above understates the
   problem, and the understatement matters. Trace `ctrl->loaded` on a
   *fully compliant* PTZ camera — one that does set D3 and does send Control
   Change interrupts:

   1. `S_CTRL(PAN=90)` → `uvc_ctrl_commit_entity()` clears `loaded`
   2. first `G_CTRL` → live `GET_CUR`, sets `loaded = 1`
   3. every subsequent `G_CTRL` → cache hit, same value returned until the
      move ends and an interrupt finally arrives

   So a compliant device yields **exactly one live sample per write**, and
   nothing thereafter. If userspace reads promptly after commanding the move —
   the natural thing to do — that one sample is taken before the actuator has
   appreciably moved, and is therefore the least useful sample available.
   Polling is useless on any UVC PTZ camera, compliant or not.

   The Tiny 2 does not even get that one sample: `uvc_ctrl_get_flags()` clears
   `AUTO_UPDATE` and re-derives it from `GET_INFO`, which on this device is a
   constant `0x03` with D3 (bit 3) clear (§2.2). Step 1 above never fires, so
   the value is stale from the very first read.

   This reframes the argument. The bug is not "OBSBOT is non-compliant, work
   around it" — it is that `uvcvideo`'s caching assumption is wrong for the
   control class, with this device's firmware bug merely making an already
   broken case worse.

2. **Linux won't let userspace bypass it while streaming.** usbfs requires the
   caller to have *claimed* the interface to issue interface-directed control
   requests. Claiming requires detaching `uvcvideo` from the VideoControl
   interface, and `uvcvideo` binds VideoControl + VideoStreaming as one unit —
   so detaching kills `/dev/video*`. This was tested directly and is a hard
   architectural constraint, not a tuning problem. (It also proved fragile in
   practice; see `fact_libusb_uvcvideo_reprobe_fragility` — repeated
   detach/reattach cycles corrupted `uvcvideo`'s reprobe and required manual
   sysfs unbind/bind to recover.)

**Relieving either constraint yields live position.** macOS effectively has
neither.

---

## 4. The patch that was drafted, and why it was scrapped

A 4-line patch was written against mainline (`torvalds/linux` @ `248951dd`),
adding a `UVC_CTRL_FLAG_VOLATILE` bit, setting it on the `PANTILT_ABSOLUTE`
entry in `uvc_ctrls[]`, bypassing the `loaded` cache, and surfacing
`V4L2_CTRL_FLAG_VOLATILE` to userspace. It passed `checkpatch.pl --strict`
cleanly (0 errors, 0 warnings). It was **not sent**, for three reasons.

### 4.1 BLOCKER — it breaks pan/tilt writes

`uvc_ctrl_set()` (`uvc_ctrl.c:2821`):

```c
/* If the mapping doesn't span the whole UVC control, the current value
 * needs to be loaded from the device to perform the read-modify-write */
if ((ctrl->info.size * 8) != mapping->size) {
        ret = __uvc_ctrl_load_cur(chain, ctrl);
```

One UVC control holds **both axes**: `uvc_ctrls[]` gives `PANTILT_ABSOLUTE`
`.size = 8` bytes (64 bits), while the PAN and TILT mappings are `.size = 32`
bits at offsets 0 and 32. `64 != 32`, so this read-modify-write path is taken on
*every* pan or tilt write.

Making the load live breaks it:

1. `S_CTRL(PAN=90)` → commits `SET_CUR(pan=90, tilt=0)`; gimbal starts moving.
2. `S_CTRL(TILT=20)` ~1 ms later → RMW re-reads **live** position. The gimbal
   has not physically moved yet, so it reads `pan=0`.
3. Commits `SET_CUR(pan=0, tilt=20)` → **the pan command is cancelled.**

Because the live readback lags the command, the second write clobbers the first
axis back to its pre-move position. Today this works only because the cache
holds the *commanded setpoint*.

This is not theoretical for this project: `src/transport/linux.ts` `gimbalSet()`
issues pan and tilt as two parallel `camCtrlSet` calls. The patch would have
broken `obsbot_gimbal_move` — the tool this repo ships and hardware-verified —
the moment it merged.

### 4.2 The commit message quoted the spec falsely

The draft asserted:

> Per UVC 1.5 4.2.2.1.14, this control "indicates the pan/tilt actuator's
> current position"

The section number is correct. **The quote is fabricated.** The actual text of
§4.2.2.1.14 (verified against `USB_Video_Class_1_5.zip` in this repo):

> The PanTilt (Absolute) Control is used to specify the pan and tilt settings.
> The dwPanAbsolute is used to specify the pan setting in arc second units.

Table 4-22 describes `dwPanAbsolute` as *"The setting for the attribute of the
addressed Pan (Absolute) Control."* The spec uses **"setting"** throughout —
setpoint language. It nowhere mandates live encoder readback. The quoted phrase
does not exist in the document; it was reconstructed from memory and presented
as verbatim.

### 4.3 It had never been compiled

Only a sparse checkout existed. The patch was never built even once.

---

## 5. Is a patch still justified?

**Yes — on different grounds, and it is a larger patch.**

### The argument that holds up

Not "the spec says it's live" (it doesn't). Not "OBSBOT is non-compliant" (true,
but that justifies nothing general and invites "fix your firmware"). The
defensible argument is **fitness of mechanism**:

The spec's remedy for a control that changes without host action is the Control
Change interrupt. That mechanism is *event-shaped* — appropriate for
"auto-exposure switched modes." It is a poor fit for a value that varies
**continuously for several seconds**. No sane firmware emits interrupts at 25 Hz
for the duration of a pan sweep. So even a perfectly compliant PTZ camera leaves
`G_CTRL` stale for the entire duration of every move. The caching assumption is
wrong for the *control class*, not for one vendor. Polling `GET_CUR` is the
natural fit for mechanical position — which is exactly what macOS does, and why
it works.

Three spec details support this:

- Table 4-22 makes **`GET_CUR` mandatory and `SET_CUR` optional** for this
  control. The spec treats it as fundamentally something you *read*.
- `V4L2_CTRL_FLAG_VOLATILE` already exists in V4L2 for precisely this concept.
  `uvcvideo` simply never applies it here.
- **§4.2.2.1.15 concedes the granularity outright** (found 2026-07-25, quoted
  verbatim from the PDF):

  > If both Relative and Absolute Controls are supported, a SET_CUR to the
  > Relative Control with a value other than 0x00 shall result in a Control
  > Change interrupt for the Absolute Control **at the end of the movement**

  The spec defines notification *at the end* of a move and specifies nothing
  for its duration. This is the single most valuable citation available: it
  turns "the interrupt mechanism is unfit for a continuously-varying quantity"
  from an assertion that has to be argued into a reading of the document. It is
  also, pointedly, the argument the scrapped draft was reaching for when it
  fabricated a quote from §4.2.2.1.14 — the real support was two subsections
  away the whole time.

### Evidence available to support a submission

- Timestamped libusb trace of the value tracking a physical slew (§2.1).
- `GET_INFO` dump showing why the invalidation path never fires (§2.2).
- A second operating system reading this identical control live, concurrently
  with streaming, in production (§3) — an existence proof that the data is real
  and useful, not a theory.

### What must be built first

*All three items below are done. See §9 for the resulting patch.*

1. **Fix the RMW path.** `uvc_ctrl_set()` must keep using the last commanded
   setpoint while `__uvc_ctrl_get()` reads live. That requires a shadow buffer
   separate from `UVC_CTRL_DATA_CURRENT`. Modest, but real kernel design.
2. **Compile it**, and test on hardware — including the two-axis write sequence
   in §4.1, which is the specific regression to prove absent.
3. **State the tradeoff honestly in the commit message:** on devices that merely
   echo the setpoint, this costs a USB round trip per read and gains nothing.
   Burying that is how a patch dies on the second pass.

Item 1 was ultimately solved by *inverting* the prescription rather than
following it. Adding a setpoint shadow means modifying the write path, which is
exactly where the v1 regression lived. Adding a separate **read** buffer instead
leaves `uvc_ctrl_set()` byte-for-byte unchanged, which makes the §4.1 regression
impossible by construction rather than merely avoided — a materially better
thing to be able to tell a reviewer.

### Odds

Genuinely uncertain, better than the scrapped draft. It is a general-correctness
argument, which is the framing maintainers steered the 2024 OBSBOT submitter
toward (§7). Expect scrutiny on the per-read cost for all devices, and possibly
a request to gate it. Worst realistic case: a maintainer explains the shape they
would accept.

---

## 6. Impact on this project

**None — the shipped design is correct as-is and requires no change.**

`obsbot_gimbal_move` / `obsbot_gimbal_recenter` use absolute V4L2 writes, which
are safe because the target is clamped to the mechanical range *before* sending,
independent of current position. `obsbot_gimbal_move_speed` is hidden on Linux
because a speed × duration burst cannot be bounded without live feedback. That
was the right call and remains so; it is not a placeholder awaiting a kernel fix.

`obsbot_gimbal_position` on Linux reports last-commanded position, not live —
correctly documented as such.

### Outstanding correction — resolved in v0.4.1

`README.md` previously stated that a kernel patch **"has been submitted
upstream."** That was false and had been released. It was corrected on its own
merits in v0.4.1, which softened it to a patch "is being worked on," with a CHANGELOG
entry owning the error. The same release removed a second fabrication: the claim
that `UVC_QUIRK_OBSBOT_MIN_SETTINGS` was merged precedent — that macro has never
existed (§7).

The principle stated at the time still holds and is worth restating now that a
patch does exist: fixing the docs and pursuing the patch were independent
decisions, and the README should not run ahead of reality again. It should not
say "submitted" until something has actually been sent, nor "merged" unless it
merges.

---

## 7. Upstream context

The sibling OBSBOT fix is instructive precedent:

- Submitted March 2024 as a device quirk (`UVC_QUIRK_OBSBOT_MIN_SETTINGS`,
  vendor `0x3564`) for misreported minimum relative pan/tilt/zoom speeds.
- Ricardo Ribalda pushed back on the quirk framing, questioning whether it was a
  spec ambiguity that should be fixed generally rather than per-vendor. The
  thread stalled ~20 months.
- Revived and **merged January 2026** as commit
  `f0487a90b2c50d4021c578a809144d800a703676` (author John Bauer, committed by
  Hans Verkuil to `media.git/next`) — as a *general* helper,
  `uvc_ctrl_is_relative_ptz()` (`uvc_ctrl.c:1704`), applying to all UVC devices.
  No vendor quirk bit shipped.

**Lesson: maintainers here prefer the least vendor-specific framing that is
still technically correct.** Note also that this fix postdates the Ubuntu kernel
on this machine (`6.8.0-134-generic`), so it is present in mainline but not
locally.

Recipients per `get_maintainer.pl` for a future submission: Laurent Pinchart,
Hans de Goede, Mauro Carvalho Chehab, `linux-media@vger.kernel.org`,
`linux-kernel@vger.kernel.org`.

---

## 8. Separately: a firmware bug report to OBSBOT is warranted

Independent of any kernel work, and arguably the highest-leverage action: the
Tiny 2 returns a constant `GET_INFO = 0x03` for every Camera Terminal control,
leaving D3/D4 clear on a gimbal that both takes seconds to complete a move and
repositions itself autonomously during AI tracking. Per §2.4.4 both bits are
mandatory, along with Control Change interrupts.

### Correction (2026-07-25) — this section previously overstated the fix

It originally read:

> If OBSBOT fixed this, **live position would work on Linux with an unmodified
> kernel** — `uvc_ctrl_status_event()` already handles the invalidation — and
> `obsbot_gimbal_move_speed` could be re-enabled on Linux for free.

**That is wrong.** Setting D3 would restore only the *first* invalidation path
in §3 — `uvc_ctrl_commit_entity()` clearing `loaded` after a `SET_CUR`. As the
one-sample-ceiling analysis in §3 shows, that yields exactly one live reading
per write and a frozen cache thereafter. It would not give live position, and it
would not be enough to re-enable `obsbot_gimbal_move_speed`, which needs
position sampled *throughout* a burst in order to bound it.

Getting live position from firmware alone would require the camera to emit
Control Change interrupts continuously for the duration of every move — which
§5 argues no reasonable firmware does, and which the spec does not ask for
(§4.2.2.1.15 defines the interrupt at the *end* of the movement).

The firmware bug is real and worth reporting on its own merits: D3/D4 are
mandatory per §2.4.4, the constant `0x03` is plainly a stub, and a compliant
`GET_INFO` would at least restore the one-sample-per-write behaviour that other
PTZ cameras get. But it is **not** an alternative to the kernel patch. The two
are independent, and the kernel patch is the one that actually delivers live
position.

---

## 9. The patch as built (2026-07-25, respun same day)

Developed and hardware-tested on mainline `3dab139d4` (v7.2-rc4 era; the
running kernel). The mailable patch is rebased onto **media.git `next`** @
`a52e6f792` — the tree uvcvideo patches are actually applied to — applies
cleanly there, and `uvc_ctrl.c` compile-checks against it. `base-commit:`
trailer included. **Sent 2026-07-25** to Laurent Pinchart, Hans de Goede,
Mauro Carvalho Chehab, linux-media and linux-kernel via `git send-email`
(SMTP accepted, 250). Message-ID
`<20260725212332.64927-1-jordan.mymail@gmail.com>`, archived at
[lore](https://lore.kernel.org/linux-media/20260725212332.64927-1-jordan.mymail@gmail.com/).
Replies arrive on the thread (author auto-CC'd).

A first version of this section described the pre-respin patch. A self-review
before sending found one real defect and several gaps; the respin fixed:

1. **`V4L2_CTRL_FLAG_VOLATILE` without `V4L2_CTRL_FLAG_EXECUTE_ON_WRITE` was a
   uAPI semantics violation.** `vidioc-queryctrl.rst` is explicit: "Setting a
   new value for a volatile control will be ignored unless
   V4L2_CTRL_FLAG_EXECUTE_ON_WRITE is also set." Pan/tilt writes are decidedly
   not ignored, so the respin reports both flags when the control has
   `SET_CUR`. (`EXECUTE_ON_WRITE`'s definition — every write propagated even if
   unchanged — is already literally true of `uvc_ctrl_set()`, which never
   short-circuits same-value writes. Precedent: manual gain under autogain.)
2. Commit message misattributed the flag's consumer ("the V4L2 control
   framework" — uvcvideo implements these controls itself; only applications
   see the flag).
3. Base moved from Linus' master to media/next, with `--base` trailer.
4. `v4l2-compliance` run (see table), patched-vs-pristine A/B on this device.
5. Paired-read skew disclosed in the tearline (below).
6. Duplicated tail in `__uvc_ctrl_get()` folded into buffer-id selection.

Artifacts at `~/kernel-uvc-work/`:
`0001-media-uvcvideo-query-pan-tilt-position-from-the-devi.patch` (mailable,
reviewer notes below the tearline), `commit-msg.txt`, `tearline-notes.txt`,
`kernel-src/` (mainline clone, commit `64644fc6e`, the tested build), and
`media-next/` (worktree on media/next, commit `5e13d80fc` — the mbox source).

### Shape

55 insertions, 4 deletions across two files; `checkpatch.pl --strict` clean.

- `include/uapi/linux/uvcvideo.h` — new `UVC_CTRL_FLAG_VOLATILE (1 << 9)`
- `uvc_ctrl.c` — new `UVC_CTRL_DATA_LIVE` slot (`UVC_CTRL_DATA_LAST` 6→7); the
  flag set on the `CT_PANTILT_ABSOLUTE_CONTROL` entry in `uvc_ctrls[]`; a new
  `__uvc_ctrl_load_live()`; `__uvc_ctrl_get()` selecting the live buffer when
  the flag is set and `!ctrl->dirty`; `V4L2_CTRL_FLAG_VOLATILE` plus
  `V4L2_CTRL_FLAG_EXECUTE_ON_WRITE` (when writable) surfaced in
  `__uvc_query_v4l2_ctrl()`

The write path is untouched — see §5 for why that inversion matters.

Two invariants were re-verified on the current tree: `UVC_CTRL_DATA_LAST` is
referenced in exactly one place (the `kzalloc` in `uvc_ctrl_add_info()`), so
bumping it is safe; and `uvc_ctrl_get_flags()` clears only
`GET_CUR|SET_CUR|AUTO_UPDATE|ASYNCHRONOUS`, so a statically-set volatile bit
survives device probing.

### Hardware results

Kernel `7.2.0-rc4+`, OBSBOT Tiny 2 (`3564:fef8`) on `/dev/video2`.

| Test | Result |
|---|---|
| **Two-axis write** (the §4.1 regression) | **Pass** — `S_CTRL(pan=90°)` then `S_CTRL(tilt=20°)` as separate ioctls; run on both builds (18 ms gap pre-respin, 21 ms respun); both axes reached target (324000 / 72000). Pan not cancelled. In the 18 ms run, pan still read 0 at the second write — the hazard window was genuinely exercised, not missed by timing luck. |
| **Live position during slew** | **Pass** — 0→5→17→24→36→47→55→66→78→90°, arrival ≈1.6–1.7 s, steady after; re-verified on the respun build |
| **Flags surfaced** | **Pass** — `flags=volatile, execute-on-write` on pan/tilt, neither on zoom |
| **Concurrent streaming** | **Pass** — 100 frames at 30.5 fps while polling position at 5 Hz; no frame loss; re-verified respun |
| **`v4l2-compliance` A/B** | **Identical patched vs pristine** — 45/47 both, the two failures being the camera reporting a Power Line Frequency default outside its own min/max (device quirk, present in both runs, cascades into a second QUERYMENU failure). Integrated webcam 46/47, its own quirk. |
| **No collateral damage** | **Pass** — integrated UVC 1.00 webcam (`1bcf:28cc`) enumerates, all controls read, streams clean |

### Found during the respin retest: the §4.1 hazard fires on stock kernels

The first respun two-axis retest **failed** — pan cancelled back to 0, the
exact v1 signature — and the cause turned out to be worth more than the scare.

The `rmmod`/`insmod` that swapped the module in had re-probed the camera
**while it was asleep** (it auto-stows after idle; the live path dutifully
reported the stow pose, tilt = −302400 = −84°). Asleep, the camera does not
answer `GET_INFO`, so `uvc_ctrl_get_flags()` cannot override the static table
and pan/tilt *keeps* `UVC_CTRL_FLAG_AUTO_UPDATE`. With that flag set,
`uvc_ctrl_commit_entity()` clears `ctrl->loaded` after every commit — so the
second of two single-axis writes finds `loaded == 0`, and its read-modify-write
pulls a **live** `GET_CUR` in which the first axis has not yet moved. The merge
then commits the first axis back to its old position: move cancelled.

Re-probed awake (`GET_INFO` answers `0x03`, `AUTO_UPDATE` cleared), the same
test passes deterministically.

Three implications, in order of importance:

1. **This is a stock-kernel bug on this camera, not a property of the patch.**
   `uvc_ctrl_set()` and the commit path are byte-identical to mainline in both
   builds; the volatile read path is not involved. Any kernel, patched or not,
   that probes this camera while it is asleep will cancel one axis of a
   two-parallel-write `gimbalSet()`. It is the first observed case of the §4.1
   hazard firing on an unmodified kernel — §4.1 called the RMW-from-live
   failure a property of the *drafted* patch; in the asleep-probed flag state,
   mainline does it by itself.
2. **Project exposure exists but is narrow.** `linux.ts` `gimbalSet()` issues
   pan and tilt as parallel single-axis writes, so it is exactly the failing
   shape. The known trigger is a driver re-probe while the camera is asleep
   (module reload; possibly warm reboots that keep USB power). Normal plug-in
   wakes the camera, which is presumably why this has never been seen in the
   field. No project change made — noted here for the day a user reports
   one-axis moves after a driver reload.
3. **It does not belong in this kernel submission.** It is orthogonal to the
   volatile-read change (neither caused nor fixed by it), and bundling a
   second bug story into the commit message would muddy a patch whose merit is
   its narrowness. If it is worth fixing upstream, it is a separate patch —
   plausibly "re-query control flags on resume/wake" or a retry — with its own
   evidence.

One more incidental confirmation: while asleep, V4L2 pan/tilt writes are
accepted silently but move nothing, and the live read faithfully reports the
stowed pose where the old driver would have echoed the stale commanded value —
a small unplanned demonstration of the patch doing its job.

### Build notes, for whoever repeats this

Secure Boot must be off (self-built kernels are unsigned; this also lifts the
lockdown that blocks `usbmon` via debugfs). Seed `.config` from
`/boot/config-$(uname -r)`, blank `CONFIG_SYSTEM_TRUSTED_KEYS` and
`CONFIG_SYSTEM_REVOCATION_KEYS` (they point at Canonical certs that do not exist
outside their build), disable `DEBUG_INFO_BTF` and set `DEBUG_INFO_NONE`, then
`make localmodconfig` — 267 modules instead of ~7000, ~15 min on 12 cores rather
than a couple of hours.

**Do not stage the build tree under `/tmp`.** It is cleared on reboot, and this
work requires a reboot by construction. A 2.1 GB checkout and a completed build
were lost that way; everything now lives under `~/kernel-uvc-work/`.

Iterating without rebooting: `make M=drivers/media/usb/uvc modules` rebuilds
just `uvcvideo.ko` in under a minute (the single-target `make path/to/x.ko`
form fails at modpost — use `M=`), then `rmmod`/`insmod` hot-swaps it; sync the
copy under `/lib/modules/$(uname -r)/` afterwards or a reboot silently reverts
to the previous build. **Reload with the camera awake** — see the asleep-probe
hazard above. One dead end so no one repeats it: `usbmon` cannot be added to
this kernel after the fact. `localmodconfig` dropped `CONFIG_USB_MON`, and the
hooks it needs (`usb_mon_register`) live inside the already-built usbcore, so
enabling it means a full kernel rebuild and reboot, not a module build.

### Open questions carried into the submission

All are raised in the tearline notes rather than defended, on the §7 reasoning
that this list responds better to flexibility than to a dug-in position:

1. **uapi placement.** `UVC_CTRL_FLAG_VOLATILE` sits in the uapi header beside
   the other eight flags, though `struct uvc_xu_control_mapping` has no `flags`
   member and userspace cannot set it. Keeping the namespace in one file avoids
   a silent collision if bit 9 is ever added on the uapi side, but a maintainer
   may prefer it in the driver-private header.
2. **Scope.** Only pan/tilt is flagged. Zoom, focus, roll and iris absolute have
   the same character, and focus-absolute under continuous autofocus is
   arguably the more widespread case — but widening it costs a control transfer
   per read across a great many devices on the strength of one camera's
   evidence.
3. **Paired-read skew.** Reading pan and tilt in one `G_EXT_CTRLS` call now
   issues one `GET_CUR` per mapping — two transfers, values from instants ~1 ms
   apart, where the old cache decoded both axes from a single sample (a
   coherent pair, but a coherently *stale* one). Inherent to polling a moving
   actuator; a shared-transfer scheme would need per-ioctl generation tracking
   and was judged not worth it. Disclosed so the reviewer can weigh it.

A fourth item, noted but not raised: `uvc_mapping_get_xctrl_compound()` still
reads `UVC_CTRL_DATA_CURRENT`. No compound control is flagged volatile, so
there is no bug, but it is the second wiring point if the concept generalises.

### First review (2026-07-31): Ricardo Ribalda

Ricardo Ribalda (Chromium; among the most active uvcvideo maintainers)
replied six days after submission
([his mail](https://lore.kernel.org/linux-media/CANiDSCsyVYanm5MowQv5-rGy1EYs080WRsZYJCT=J=SesPFnjQ@mail.gmail.com/)).
Friendly, opens with "I am not against the idea proposed by this patch."
Substance, and how each point was answered
([our reply](https://lore.kernel.org/linux-media/20260731151509.577383-1-jordan.mymail@gmail.com/),
sent same day, archived copies at `~/kernel-uvc-work/reply-to-ribalda.{txt,eml}`):

1. **Use case: continuous position, or just end-of-move?** Answered: continuous
   — relative framing math needs the current pose, and under on-device AI
   tracking the gimbal moves autonomously for minutes with no SET_CUR in
   flight and no end-of-move at all.
2. **Suggested V4L2 control events instead.** Declined on three levels:
   uvcvideo's only device-originated event source is
   `uvc_ctrl_status_event()`, fed by the Control Change interrupt, which the
   spec promises only "at the end of the movement" (one event per move, not a
   trajectory); this device never emits that interrupt (GET_INFO=0x03, no
   Autoupdate/Asynchronous bits — §2); autonomous tracking has no end of
   movement to signal.
3. **His one technical critique**: a scenario where, after the camera has
   autonomously tracked away from the last commanded pose, a single-axis
   write RMWs from `UVC_CTRL_DATA_CURRENT` (the setpoint) and yanks the
   other axis back, fighting the tracker. **Real, but pre-existing** — the
   patch's write path is byte-identical to mainline. Both merge-source
   behaviours already ship, selected by the device's GET_INFO bits: setpoint
   merge (his scenario, this camera) vs live merge on Autoupdate devices —
   which is exactly the §4.1 user-move cancellation, measured on this
   hardware via the asleep-probe incident. The reply laid out both horns
   with the measurements. Bonus noted: under the patch, reads no longer set
   `ctrl->loaded`, so the write path can never merge against a stale sample
   frozen by an earlier G_CTRL.
4. **His counter-proposal**: ownership-based cache validity (user-commanded
   move in flight → cache valid; device-owned → never cached), with
   pseudo-code. Endorsed as the right frame *for the write path* and as
   composable with (not a replacement for) the read-path patch — he himself
   conceded it "still doesn't support polling the live mid-flight position,"
   which is the entire use case. Two practical flaws flagged: his first hunk
   loads live data into `UVC_CTRL_DATA_CURRENT`, the RMW source, recreating
   the §4.1 cancellation unconditionally on Autoupdate devices (the separate
   `DATA_LIVE` buffer exists precisely to avoid this); and anything keyed on
   `AUTO_UPDATE`/`ASYNCHRONOUS` never triggers on this camera, whose
   GET_INFO reports neither — plus his "until the move completes" ownership
   needs a completion interrupt this firmware never sends.

The reply closed by offering a respin that argues the autonomous-tracking use
case in the commit message itself. Likely next moves from his side: "respin
with that" (easy v2 — the argument is already drafted in the reply), or a
design discussion on ownership as follow-on write-path work. Reply Message-ID
`<20260731151509.577383-1-jordan.mymail@gmail.com>`, threaded correctly under
his mail on lore.

### Second exchange (2026-07-31 → 08-01): deferred to Hans Verkuil

Ricardo came back the same evening, ~8 hours after our reply
([his mail](https://lore.kernel.org/linux-media/CANiDSCsS-JJrGMaoBqR-XX54dtp_uQEVVSct-BWL0gQNL4OfRQ@mail.gmail.com/)),
and **added Hans Verkuil to the To: line**. He did not push back on the patch.
He restated the problem as two separable items — (1) this firmware is broken,
so the general case must be designed for compliant cameras with a quirk added
later for this device; (2) the desired merge source differs by owner (device
tracking → live values; user move finalising → the user's pan/tilt pair) — then
closed with *"Let's wait a bit for Laurent or HansG (or even Hans Verkuil) to
comment"* and *"I am very curious what HansV thinks."* He is OOO the week of
2026-08-03, so replies will be slow.

Four things were aimed at us, and were answered
([our reply](https://lore.kernel.org/linux-media/20260801050049.984234-1-jordan.mymail@gmail.com/),
sent 2026-08-01, archived at `~/kernel-uvc-work/reply-to-ribalda-2.{txt,eml}`):

1. **"How accurate does the frame/position mapping need to be? You may be
   processing frame NOW-4 when you read position NOW."** Conceded and
   clarified: *not accurate at all*. Our first reply answered "the former" to a
   question whose example was frame-tagging, which overstated the case. Nothing
   here correlates a position with a particular frame — the position is a
   control-loop input and a UI number, and the gimbal's own time constants
   (hundreds of ms per move) dwarf a few frames of pipeline skew. Explicitly
   granted that frame-accurate pose would be a per-frame metadata problem for
   which G_CTRL is the wrong instrument.
2. **`VIDIOC_S_EXT_CTRLS` to set both axes at once.** Conceded as a real fix we
   had missed. Verified in source: `uvc_ctrl_set()` still calls
   `__uvc_ctrl_load_cur()` for each partial mapping, but both mappings land in
   `UVC_CTRL_DATA_CURRENT` before the *single* commit, so whatever the load put
   there is fully overwritten and the merge source stops mattering. This
   sidesteps the §4.1 hazard entirely from userspace — see the project action
   item below. It does nothing for the read side, which is what the patch is
   about.
3. **"If AUTO_UPDATE is present you would get fresh data when you poll."**
   Half right, and corrected precisely because it bears on what HansV is being
   asked to weigh: that holds via the *interrupt*, not the poll. `ctrl->loaded`
   is cleared in exactly two places — `uvc_ctrl_status_event()` (uvc_ctrl.c:2201,
   the Control Change interrupt) and `uvc_ctrl_commit_entity()` for AUTO_UPDATE
   controls (~:2480). `__uvc_ctrl_load_cur()` returns early on `loaded` (:1474),
   so polls *between* notifications return the cache. On a compliant autoupdate
   device the refresh rate is therefore the device's signalling rate, and
   §4.2.2.1.15 promises that signal only at end-of-movement: good enough for
   "it stopped, here is where," not for sampling a trajectory.
4. **"Ping the vendor to fix their firmware."** Agreed, with no expectations on
   timeline. (§8 already scopes that report.)

Deliberately **not** re-argued: his items (1) and (2) above. Those are now
addressed to the other maintainers, our position is already on the record in
the first reply, and a long rebuttal would have buried the thread before HansV
read it.

**Status: waiting on Hans Verkuil.** Expect a quiet thread for several days
given the OOO. The v2 shape is no longer predictable — it depends on what HansV
says, not on anything already decided. Do not respin speculatively.

**Project action item arising from point 2 — implemented 2026-08-01.** This
repo's Linux pan/tilt writes now send both axes in a single
`VIDIOC_S_EXT_CTRLS` rather than two sequential single-axis `S_CTRL` calls,
which removes the §4.1 user-move cancellation from our own stack on *stock,
unpatched* kernels, independent of whether the patch ever lands. New helper op
`pantilt_set` (`v4l2_set_pantilt()` in `native/linux/helper.c`, both controls in
one `V4L2_CTRL_CLASS_CAMERA` request), surfaced as `HelperProcess.panTiltSet`,
used by both `gimbalSet` and `gimbalRecenter` in `src/transport/linux.ts`. An
older helper binary that does not know the op falls back to the two-write path
so a package-updated-but-helper-not-rebuilt install degrades rather than losing
gimbal movement.

**Hardware-verified 2026-08-01** on kernel `7.2.0-rc4+`. Four two-axis moves
through `gimbalSet`/`gimbalRecenter` — (20, 10), (−15, −8), the asymmetric
(25, 1), and recenter — each landing within the firmware's whole-degree step on
*both* axes, with a supervisor confirming all four physically moved both axes.
The readback is genuine live position rather than a cache echo, since the box
runs the patched module; on a stock kernel this check would only replay what it
wrote and prove nothing. The asymmetric case is the discriminating one: a
cancelled axis shows up as the small-travel axis failing to move while the
large one succeeds.

Two coverage notes found while verifying, neither fixed here:
`scripts/e2e.mjs` drives the gimbal with vendor frames and never calls
`gimbalSet`, so it does not exercise this path at all; and
`.claude/skills/verify` is written entirely for macOS (`system_profiler`,
`make -C native/macos`, DriverKit) and needs a Linux section. Also note the
Node stack loads `native/prebuilt/<platform>-<arch>/`, NOT the CMake output —
staging the rebuilt binary is a required step, and the stale copy is silent.

---

## Appendix A — the scrapped patch (for reference; do not send)

Applied against `torvalds/linux` @ `248951dd`. Retained here only so the
analysis in §4 is checkable; the mailable `.patch` file was deleted.

```diff
--- a/drivers/media/usb/uvc/uvc_ctrl.c
+++ b/drivers/media/usb/uvc/uvc_ctrl.c
@@ -302,7 +302,8 @@ static const struct uvc_control_info uvc_ctrls[] = {
 		.flags		= UVC_CTRL_FLAG_SET_CUR
 				| UVC_CTRL_FLAG_GET_RANGE
 				| UVC_CTRL_FLAG_RESTORE
-				| UVC_CTRL_FLAG_AUTO_UPDATE,
+				| UVC_CTRL_FLAG_AUTO_UPDATE
+				| UVC_CTRL_FLAG_VOLATILE,
 	},
@@ -1469,7 +1470,7 @@ static int __uvc_ctrl_load_cur(struct uvc_video_chain *chain,
 	u8 *data;
 	int ret;
 
-	if (ctrl->loaded)
+	if (ctrl->loaded && !(ctrl->info.flags & UVC_CTRL_FLAG_VOLATILE))
 		return 0;
 
 	data = uvc_ctrl_data(ctrl, UVC_CTRL_DATA_CURRENT);
@@ -1840,6 +1841,8 @@ static int __uvc_query_v4l2_ctrl(struct uvc_video_chain *chain,
 	if ((ctrl->info.flags & UVC_CTRL_FLAG_GET_MAX) &&
 	    (ctrl->info.flags & UVC_CTRL_FLAG_GET_MIN))
 		v4l2_ctrl->flags |= V4L2_CTRL_FLAG_HAS_WHICH_MIN_MAX;
+	if (ctrl->info.flags & UVC_CTRL_FLAG_VOLATILE)
+		v4l2_ctrl->flags |= V4L2_CTRL_FLAG_VOLATILE;
 
 	if (mapping->master_id)
 		__uvc_find_control(ctrl->entity, mapping->master_id,
--- a/include/uapi/linux/uvcvideo.h
+++ b/include/uapi/linux/uvcvideo.h
@@ -31,6 +31,11 @@
 #define UVC_CTRL_FLAG_AUTO_UPDATE	(1 << 7)
 /* Control supports asynchronous reporting */
 #define UVC_CTRL_FLAG_ASYNCHRONOUS	(1 << 8)
+/*
+ * Control's current value can change outside of a SET_CUR and must never be
+ * served from the driver's cache.
+ */
+#define UVC_CTRL_FLAG_VOLATILE		(1 << 9)
```

One thing that *did* check out: `uvc_ctrl_get_flags()` (`uvc_ctrl.c:2869`) clears
only `GET_CUR`/`SET_CUR`/`AUTO_UPDATE`/`ASYNCHRONOUS` before OR-ing the device's
`GET_INFO` response, so a statically-set flag survives device probing. Any future
attempt can rely on that.

---

## Appendix B — reproduction tooling

Scratchpad artifacts from the original session (**lost** — they lived under
`/tmp` and were cleared by a reboot; rebuild as needed):

- `libusb_pantilt.c` — polls `GET_CUR` on `0x0D`, timestamped. Detaches the
  kernel driver; **incompatible with streaming**.
- `libusb_getinfo.c` — read-only `GET_INFO` dump across CT selectors. Safe,
  reattaches cleanly.
- `kernel-src/` — sparse mainline checkout (`include/uapi/linux`,
  `drivers/media/usb/uvc`, `scripts`) for `checkpatch.pl` / `get_maintainer.pl`.

Surviving artifacts from the patch session live under `~/kernel-uvc-work/`
(§9) and are not ephemeral.

Note that with the patched kernel installed, the libusb tooling is no longer
needed to observe live position — plain `v4l2-ctl --get-ctrl=pan_absolute`
does it, concurrently with streaming, without detaching anything. That also
sidesteps the `uvcvideo` reprobe fragility recorded in
`fact_libusb_uvcvideo_reprobe_fragility`.

The UVC 1.5 specification PDF set (`USB_Video_Class_1_5.zip`, obtained from
USB-IF) is **not** committed — it is third-party copyrighted material. Download
it, extract `UVC 1.5 Class specification.pdf`, and convert with `pdftotext
-layout` to grep it.
