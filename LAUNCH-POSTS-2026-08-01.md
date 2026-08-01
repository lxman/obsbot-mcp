# Launch posts — obsbot-mcp

Drafted 2026-08-01. Untracked working doc, same as the other dated notes at this root.

Repo link to use everywhere: https://github.com/lxman/obsbot-mcp

---

## Venue verdicts

| Venue | Verdict | Notes |
|---|---|---|
| r/OBSBOT_Official | **Post** | Vendor-run, active. Only 2 rules: be civil, be OBSBOT-related. No self-promo ban. |
| r/mcp | **Post** | One of the two largest MCP communities. Tagging mods can get server-author flair. |
| Hacker News (Show HN) | **Post** | Title plain + factual, repo as URL, story in the first comment. |
| r/linux | **Hold** | Permitted (Rule 6: ≤10% self-content, must engage in comments). Wait until the kernel patch resolves. |
| r/obs | Help-first only | Rule 2 allows how-tos, not launch posts. Answer real questions, link as part of the answer. |
| r/streaming | **Do not post** | Rule 3: third-party tools without prior mod consent → removal **and permanent ban**. Modmail first or skip. |
| r/VIDEOENGINEERING | **Do not post** | Bans self-promo, calls consumer tech off-topic, and bans "vibe coded" apps even if open source. |
| r/obsbot (unofficial) | Skip | Dead — 5 posts, newest 4 years old. |

---

## Accuracy guardrails

- The kernel patch is **posted to linux-media and under review**, awaiting Hans Verkuil. **Never say "merged."**
- The root cause is the **camera's non-compliant `GET_INFO`**, not a uvcvideo bug. Do not frame it as a kernel defect — the maintainers are mid-review and it would land badly.
- Platform surface: 35 tools cross-platform (34 on Linux, where `obsbot_gimbal_move_speed` is hidden), 36 with `--debug`.
- `darwin-arm64`, `win32-x64`, `linux-x64` have all driven real hardware. **`darwin-x64` has never been run** — arm64 testing on the Mac mini does not cover it.

---

## 1. r/OBSBOT_Official

Flair: **Discussion**. Post in your evening (≈ their morning, UTC+8).

**Title:** I built a free open-source tool that gives the Tiny 2 full control on Linux — and scriptable control everywhere else

> I own a Tiny 2 and wrote this for myself, so upfront: I'm the author, it's free, MIT-licensed, and I'm not selling anything.
>
> OBSBOT have been clear that they don't plan to build Center for Linux, which is fair enough — but it does leave Linux owners with a camera whose gimbal, zoom and AI tracking they can't reach. That's what pushed me to start this. On Linux you now get pan/tilt in real degrees, zoom, AI tracking modes, FOV, HDR, focus, exposure, white balance, presets, snapshots and recording.
>
> On Windows and macOS it's less about filling a gap and more about scripting — anything above can be driven from a script or from an AI assistant, rather than clicking through a GUI.
>
> The part I like most: you can hand it a photo the camera just took, point at something in the frame, and it aims there. Same with a region — give it a box around a whiteboard or a face and it centres and zooms to fit, working out the maths from the camera's actual zoom level.
>
> It talks to the camera through the standard UVC driver stack your OS already uses, so **the camera keeps working as a normal webcam at the same time** — Zoom, OBS and Center all keep running while commands go through.
>
> Honest limits: **Tiny 2 only** right now. On Linux, position readback reports the last commanded angle rather than live in-flight position (a firmware quirk I'm working on upstream). And AI tracking will override manual gimbal moves while it's active — turn it off first if you're positioning by hand.
>
> Repo: https://github.com/lxman/obsbot-mcp — happy to answer anything.

---

## 2. r/mcp

**Title:** I reverse-engineered a webcam's USB protocol to build an MCP server that physically moves it

> I built [obsbot-mcp](https://github.com/lxman/obsbot-mcp) — an MCP server that controls an OBSBOT Tiny 2, a motorised PTZ webcam, over plain UVC/USB. No vendor SDK, no cloud, no vendor app running in the background.
>
> Most MCP servers I see wrap an HTTP API. This one drives hardware, which turned out to be a different class of problem: the control surface is split between standard UVC controls and a vendor Extension Unit speaking an undocumented framed protocol, so a lot of this was staring at USB captures and guessing at a command table.
>
> The part I think is actually interesting is closing the loop between seeing and moving. The model takes a snapshot, picks a pixel, and the camera aims there. Extended to regions: hand it a bounding box and it centres and zooms to fit. It reads the camera's real magnification to do the geometry, so it works at any zoom level, and it refuses rather than guessing when the state it needs is unreliable.
>
> 35 tools. Native helpers in C, Objective-C and C++ for Linux, macOS and Windows — all verified against a physical camera, not mocks.
>
> Two caveats worth stating up front. On Linux, gimbal *position* readback isn't live: the camera's firmware returns a non-compliant `GET_INFO` that makes uvcvideo cache the value. I wrote a kernel patch for it — **posted to linux-media and under review, not merged**. And multi-camera works against the test fakes but I only own one Tiny 2, so it's unverified on real hardware.
>
> Happy to go into the protocol RE if anyone's interested.

---

## 3. Show HN

**Title:** `Show HN: Obsbot-mcp – control a PTZ webcam's gimbal over USB, no vendor SDK`

**URL:** `https://github.com/lxman/obsbot-mcp`

**First comment — post immediately after submitting:**

> I have an OBSBOT Tiny 2 — a webcam on a motorised gimbal that pans, tilts and zooms. The vendor ships a GUI for Windows and macOS and has said they don't intend to build one for Linux. I wanted the camera scriptable, and on Linux, so I went looking for the protocol.
>
> There isn't a public one. The control surface turned out to be split in two: the ordinary things (zoom, focus, exposure, white balance, pan/tilt) are standard UVC controls, and everything interesting (gimbal wake/sleep, AI tracking modes, HDR, FOV, presets) rides a vendor Extension Unit speaking an undocumented framed protocol with a CRC-16/USB checksum. Most of this was USB captures and guessing at a command table.
>
> Three native helpers behind one JSON-RPC-over-stdio contract: V4L2 + `UVCIOC_CTRL_QUERY` on Linux, IOKit control transfers + AVFoundation on macOS, DirectShow + `IKsControl::KsProperty` on Windows. Everything goes through the OS's normal UVC stack, so the camera stays usable as a webcam while you're driving it.
>
> Two things that cost me the most time, in case they save someone else:
>
> On Linux, writing pan and tilt as two separate `VIDIOC_S_EXT_CTRLS` calls silently cancels one axis — they have to commit in a single ioctl or the gimbal moves on one axis only. That one looked like a hardware fault for a while.
>
> And gimbal position readback isn't live on Linux. The camera's firmware answers `GET_INFO` non-compliantly, so uvcvideo marks pan/tilt as not auto-updating and serves a cached value forever. I wrote a kernel patch; it's posted to linux-media and under review — not merged, and it may well end up as a device quirk rather than the general fix I argued for.
>
> The part I actually use: it takes a snapshot, I point at something in the frame, and it aims there — or give it a bounding box and it centres and zooms to fit, computing the geometry from the camera's real magnification.
>
> Caveats: Tiny 2 only, one physical camera tested, and the x86-64 build has only ever run on Apple Silicon — no Intel Mac has touched it. Happy to go into the protocol or the kernel side.

---

## 4. r/linux — HOLD until the patch resolves

Self-post (text), not a link post. Check your post history first: Rule 6 caps self-content at 10% and requires you to engage with comments; Rule 4 wants you to reply to someone else's story before posting your own.

**Title:** Getting a PTZ webcam's gimbal working on Linux, and the uvcvideo quirk I hit doing it

> The OBSBOT Tiny 2 is a webcam on a motorised gimbal. The vendor ships control software for Windows and macOS and has stated they don't intend to build a Linux version, so on Linux you get a working video device and no way to reach the motors, AI tracking or image controls. I wanted it scriptable, so I wrote the userspace side myself — MIT licensed, no vendor SDK, no blobs.
>
> Standard things go through V4L2. The vendor-specific ones (gimbal wake/sleep, AI tracking modes, HDR, FOV, presets) ride a UVC Extension Unit via `UVCIOC_CTRL_QUERY`, speaking an undocumented framed protocol I worked out from USB captures. Snapshots come off V4L2 mmap streaming, encoded with libjpeg.
>
> Two things worth writing down for anyone doing V4L2 PTZ work:
>
> **Pan and tilt must commit in one ioctl.** Writing them as two separate `VIDIOC_S_EXT_CTRLS` calls silently cancels one axis — the gimbal moves on a single axis and the other write evaporates. It looked like a hardware fault for quite a while.
>
> **Position readback doesn't work, and the camera is at fault.** The Tiny 2 answers `GET_INFO` for pan/tilt in a way the UVC spec doesn't allow. uvcvideo reads that answer, correctly concludes the control doesn't auto-update, and serves a cached value — so `v4l2-ctl` returns the last value you wrote rather than where the gimbal actually is. That's the driver doing the right thing with a device that lies to it. I've sent a patch to linux-media proposing how to handle this case; it's **under review and not merged**, and the maintainers may reasonably prefer a per-device quirk over touching the general path. Either outcome fixes it for this camera.
>
> Code, and the protocol notes, are here: https://github.com/lxman/obsbot-mcp — the interface on top happens to be an MCP server, but the transport and protocol work is independent of that.
>
> Happy to answer V4L2 or UVC questions.

**Optional:** linking the lore.kernel.org thread is strong evidence, but the message-ID embeds your email address. Already public, but make it a deliberate choice.

---

## Timing

You are in `America/New_York`, so HN's prime window is your local clock.

| When | Where |
|---|---|
| Tue 8–10am ET | Show HN |
| Wed or Thu 9–11am ET | r/mcp |
| Any weekday **evening** | r/OBSBOT_Official (≈ REMO TECH's morning, UTC+8) |
| After the patch resolves | r/linux |

- Never two posts on the same day — it reads as a campaign and defeats the separate framings.
- Only post when you can sit with the thread for 3–4 hours. An unanswered technical question is what kills these.
- If the slot turns out to be busy, move the post rather than posting and going quiet.

## Pre-flight

- [ ] Set up F5Bot **before** posting (it only catches mentions going forward). Free tier: 5 keywords, 10/day per keyword, 20/day total. Use `obsbot-mcp` and `obsbot mcp` only — bare `obsbot` will burn the cap on retail chatter.
- [ ] Enable Reddit mobile push; it's the only notification fast enough for the first hours.
- [ ] Remember Reddit only notifies you about replies to *you*. Open each thread sorted by **new** to catch subthreads.
- [ ] HN has no notifications at all — bookmark the item page and check `news.ycombinator.com/threads?id=<username>`.
- [ ] Don't ask anyone for upvotes. It's the one thing that reliably buries a Show HN.
