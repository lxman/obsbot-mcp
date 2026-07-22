# Why Linux can't read live gimbal position — and whether a kernel patch is warranted

Companion to the working notes `GIMBAL-POSITION-USB-2026-07-21.md` (wire
protocol) and `LINUX-HANDOVER-2026-07-21.md`, both of which live in the repo root
but are untracked. This document covers the *Linux platform gap*: why the position feedback that works on macOS is unavailable on
Linux, what was measured against real hardware, and the conclusion reached about
submitting a patch to the `uvcvideo` kernel driver.

**Bottom line: a patch is justified, but not the one that was drafted. The draft
was scrapped — it broke pan/tilt writes and its central justification was
wrong. A corrected patch requires real design work and has not been written.**

Nothing was ever sent to the `linux-media` mailing list.

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

Two spec details support this:

- Table 4-22 makes **`GET_CUR` mandatory and `SET_CUR` optional** for this
  control. The spec treats it as fundamentally something you *read*.
- `V4L2_CTRL_FLAG_VOLATILE` already exists in V4L2 for precisely this concept.
  `uvcvideo` simply never applies it here.

### Evidence available to support a submission

- Timestamped libusb trace of the value tracking a physical slew (§2.1).
- `GET_INFO` dump showing why the invalidation path never fires (§2.2).
- A second operating system reading this identical control live, concurrently
  with streaming, in production (§3) — an existence proof that the data is real
  and useful, not a theory.

### What must be built first

1. **Fix the RMW path.** `uvc_ctrl_set()` must keep using the last commanded
   setpoint while `__uvc_ctrl_get()` reads live. That requires a shadow buffer
   separate from `UVC_CTRL_DATA_CURRENT`. Modest, but real kernel design.
2. **Compile it**, and test on hardware — including the two-axis write sequence
   in §4.1, which is the specific regression to prove absent.
3. **State the tradeoff honestly in the commit message:** on devices that merely
   echo the setpoint, this costs a USB round trip per read and gains nothing.
   Burying that is how a patch dies on the second pass.

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

### Outstanding correction

`README.md` currently states that a kernel patch **"has been submitted
upstream."** That is false and was released. It should be corrected on its own
merits, with a CHANGELOG entry owning the error. Do **not** submit a patch in
order to make the README retroactively true — fixing the docs and pursuing the
patch are independent decisions.

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

If OBSBOT fixed this, **live position would work on Linux with an unmodified
kernel** — `uvc_ctrl_status_event()` already handles the invalidation — and
`obsbot_gimbal_move_speed` could be re-enabled on Linux for free.

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

Scratchpad artifacts from this session (ephemeral; rebuild as needed):

- `libusb_pantilt.c` — polls `GET_CUR` on `0x0D`, timestamped. Detaches the
  kernel driver; **incompatible with streaming**.
- `libusb_getinfo.c` — read-only `GET_INFO` dump across CT selectors. Safe,
  reattaches cleanly.
- `kernel-src/` — sparse mainline checkout (`include/uapi/linux`,
  `drivers/media/usb/uvc`, `scripts`) for `checkpatch.pl` / `get_maintainer.pl`.

The UVC 1.5 specification PDF set (`USB_Video_Class_1_5.zip`, obtained from
USB-IF) is **not** committed — it is third-party copyrighted material. Download
it, extract `UVC 1.5 Class specification.pdf`, and convert with `pdftotext
-layout` to grep it.
