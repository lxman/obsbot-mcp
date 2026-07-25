# obsbot_aim_at_pixel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `obsbot_aim_at_pixel`, the MCP tool that points the camera at a pixel the model saw in a snapshot.

**Architecture:** Two increments. First `decodeStatus()` learns to read the two optics fields the camera already reports — FOV mode and zoom position — which improves `obsbot_status` on its own. Then the tool consumes them, so it takes no optics parameters and cannot be handed a wrong one. Everything unverifiable is a refusal rather than a silent miss.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest, zod.

**Spec:** `docs/superpowers/specs/2026-07-25-aim-at-pixel-tool-design.md`

## Global Constraints

- **Module resolution is NodeNext:** every relative import carries a `.js` extension, even in `.ts` source. Omitting it will not compile.
- **TypeScript is `strict`.**
- **Test style:** `import { expect, test, vi } from "vitest";` with flat `test()` calls. Tool tests live in `test/mcp/tools.test.ts`, codec tests in `test/codec/commands.test.ts`. Match the surrounding style.
- **Status block offsets are named constants.** `codec/commands.ts` already defines `STATUS_OFF_SLEEP = 0x02`, `STATUS_OFF_HDR = 0x06`, `STATUS_OFF_FACE_AE = 0x07`, `STATUS_OFF_AI_MODE_M = 0x18`, `STATUS_OFF_AI_MODE_N = 0x1c`, `STATUS_OFF_TRACK_SPEED = 0x24`. New offsets follow that pattern — no bare hex in `decodeStatus`.
- **Measured hardware values, do not "correct" them.** FOV mode is at block offset **`0x11`**: 0=wide, 1=medium, 2=narrow, **3=custom** (a continuous zoom has overridden the discrete modes). Zoom position is at block offset **`0x04`**: 0–100 across the UVC 1.0–2.0 range.
- **A sleeping camera serves a stale status block.** All status reads happen *after* the readiness gate, never before.
- **The geometry module is already merged and is not to be modified by this plan.** `src/geometry/aim.ts` exports `aimAtPixel`, `pixelToOffset`, `halfAngles`, `HORIZONTAL_FOV_DEG`, `VERTICAL_TANGENT_CORRECTION`, `GIMBAL_YAW_LIMIT_DEG`, `GIMBAL_PITCH_LIMIT_DEG`, and the `Frame`/`Pose`/`Optics`/`Offset`/`Aim` types.
- **Pass `zoom: 1` to the geometry module.** The measured FOV constants were taken in each discrete mode and already include that mode's inherent crop. Passing the mode's zoom again would double-count.

---

### Task 1: Decode FOV mode and zoom position from the status block

Teaches `decodeStatus()` to read the two fields the camera already reports. Independently useful: `obsbot_status` gains them for every caller.

**Files:**
- Modify: `src/codec/commands.ts` (add two offsets, a lookup table, two `CameraStatus` fields, two lines in `decodeStatus`)
- Modify: `test/codec/commands.test.ts` (append)

**Interfaces:**
- Consumes: existing `CameraStatus` interface and `decodeStatus(block: Buffer): CameraStatus` in `src/codec/commands.ts`.
- Produces:
  - `export type FovModeStatus = "wide" | "medium" | "narrow" | "custom" | "unknown"`
  - `CameraStatus` gains `fovMode: FovModeStatus` and `zoomPercent: number`

- [ ] **Step 1: Write the failing test**

Append to `test/codec/commands.test.ts`:

```ts
// --- FOV mode and zoom position (status block, measured on hardware 2026-07-25) ---
//
// Diffing the raw 60-byte block across control changes gave:
//   state           block[0x04]   block[0x11]
//   wide, 1x            0             0
//   medium, 1x          5             1
//   narrow, 1x         15             2
//   wide, 1.5x         50             3
//   wide, 2.0x        100             3
// block[0x11] is the FOV mode enum (matching FOV_VALUE), where 3 is the vendor
// SDK's FovTypeNull — reported when a continuous zoom overrides the discrete
// modes. block[0x04] is zoom position, 0-100 across the UVC 1.0-2.0 range.

const statusWith = (fovByte: number, zoomByte: number): Buffer => {
  const b = Buffer.alloc(60);
  b[0x00] = 0x25;
  b[0x04] = zoomByte;
  b[0x11] = fovByte;
  return b;
};

test("status decodes the FOV mode from block[0x11]", () => {
  expect(decodeStatus(statusWith(0, 0)).fovMode).toBe("wide");
  expect(decodeStatus(statusWith(1, 5)).fovMode).toBe("medium");
  expect(decodeStatus(statusWith(2, 15)).fovMode).toBe("narrow");
});

test("FOV mode 3 is 'custom' — a continuous zoom overrode the discrete modes", () => {
  expect(decodeStatus(statusWith(3, 50)).fovMode).toBe("custom");
  expect(decodeStatus(statusWith(3, 100)).fovMode).toBe("custom");
});

test("an unrecognised FOV mode byte decodes to 'unknown', never a guess", () => {
  expect(decodeStatus(statusWith(9, 0)).fovMode).toBe("unknown");
});

test("status decodes zoom position from block[0x04]", () => {
  expect(decodeStatus(statusWith(0, 0)).zoomPercent).toBe(0);
  expect(decodeStatus(statusWith(3, 50)).zoomPercent).toBe(50);
  expect(decodeStatus(statusWith(3, 100)).zoomPercent).toBe(100);
});

test("the discrete FOV modes carry their own inherent zoom", () => {
  // medium and narrow report non-zero zoom position. The measured
  // HORIZONTAL_FOV_DEG constants already include this crop, which is why the
  // aim tool passes zoom:1 rather than deriving a factor from zoomPercent.
  expect(decodeStatus(statusWith(1, 5)).zoomPercent).toBe(5);
  expect(decodeStatus(statusWith(2, 15)).zoomPercent).toBe(15);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/codec/commands.test.ts`

Expected: FAIL — `fovMode` and `zoomPercent` are not on `CameraStatus`, so this will not compile/pass.

- [ ] **Step 3: Write the minimal implementation**

In `src/codec/commands.ts`, add the offsets beside the existing `STATUS_OFF_*` block:

```ts
// Measured on hardware 2026-07-25 by diffing the raw status block across control
// changes. block[0x11] is the FOV mode enum (same values as FOV_VALUE), with 3 =
// the vendor SDK's FovTypeNull, reported when a continuous zoom has overridden
// the discrete modes. block[0x04] is zoom position, 0-100 over the UVC 1.0-2.0
// range. NOTE: a sleeping camera serves a stale block — read these only after
// the readiness gate.
const STATUS_OFF_FOV_MODE = 0x11;
const STATUS_OFF_ZOOM_PCT = 0x04;
```

Add the type and table near the other status tables:

```ts
export type FovModeStatus = "wide" | "medium" | "narrow" | "custom" | "unknown";

const FOV_MODE_TABLE: Record<number, FovModeStatus> = {
  0: "wide",
  1: "medium",
  2: "narrow",
  3: "custom",
};
```

Add both fields to the `CameraStatus` interface:

```ts
  fovMode: FovModeStatus;
  zoomPercent: number;
```

And return them from `decodeStatus`:

```ts
    fovMode: FOV_MODE_TABLE[block[STATUS_OFF_FOV_MODE]] ?? "unknown",
    zoomPercent: block[STATUS_OFF_ZOOM_PCT],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/codec/commands.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full suite — `obsbot_status` callers may assert on its shape**

Run: `npx vitest run`

Expected: PASS. If a test asserts the exact object returned by `obsbot_status`, extend it with the two new fields rather than removing the assertion.

- [ ] **Step 6: Verify it compiles under strict TypeScript**

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/codec/commands.ts test/codec/commands.test.ts
git commit -m "feat(codec): decode FOV mode and zoom position from the status block"
```

---

### Task 2: The `obsbot_aim_at_pixel` tool

Consumes the geometry module and Task 1's decoded fields. Takes no optics parameters — it reads them.

**Files:**
- Modify: `src/mcp/tools.ts` (add an import, a schema, and one tool definition)
- Modify: `test/mcp/tools.test.ts` (append)

**Interfaces:**
- Consumes:
  - From Task 1: `CameraStatus.fovMode: FovModeStatus`, `CameraStatus.zoomPercent: number`.
  - From `src/geometry/aim.ts`: `aimAtPixel(x, y, frame, optics, current): Aim` where `Aim` is `{ target: { yaw, pitch }, offset: { dYaw, dPitch }, clamped: boolean }`.
  - Existing in `src/mcp/tools.ts`: `gate(camera)` returning `{ ok: true, transport, reconnected } | { ok: false, reason, error }`; `withCamera(...)` for schemas; `CAMERA_CONTROL_PAN` / `CAMERA_CONTROL_TILT` for the pose read.
- Produces: a tool named `obsbot_aim_at_pixel`.

- [ ] **Step 1: Write the failing test**

Append to `test/mcp/tools.test.ts`:

```ts
// --- obsbot_aim_at_pixel ---
//
// The tool takes NO optics parameters: it reads the FOV mode from the status
// block instead. An earlier design took `fov` from the caller, which would have
// made a wrong value a silent 36% aiming error (wide vs narrow).
//
// Everything it cannot verify is a refusal, never a silent miss.

// Status block variants. HEALTHY_STATUS_AWAKE already reads wide (block[0x11]=0)
// with no zoom (block[0x04]=0), so it serves as the happy path unmodified.
const statusFov = (fovByte: number, zoomByte = 0): Buffer => {
  const b = Buffer.from(HEALTHY_STATUS_AWAKE);
  b[0x11] = fovByte;
  b[0x04] = zoomByte;
  return b;
};
// AI mode tuple lives at block[0x18] / block[0x1c]; the awake fixture decodes to
// no-tracking. Setting m=2 moves it off no-tracking (see AI_MODE_TABLE).
const statusTracking = (): Buffer => {
  const b = Buffer.from(HEALTHY_STATUS_AWAKE);
  b[0x18] = 2;
  b[0x1c] = 0;
  return b;
};

const HD_FRAME = { frameWidth: 1280, frameHeight: 720 };

test("aiming at the center pixel leaves the pose unchanged", async () => {
  const transport = makeFakeTransport();
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 640, y: 360, ...HD_FRAME })) as {
    ok: boolean; target: { yaw: number; pitch: number }; clamped: boolean; fovMode: string;
  };
  expect(r.ok).toBe(true);
  expect(r.target.yaw).toBeCloseTo(0, 6);
  expect(r.target.pitch).toBeCloseTo(0, 6);
  expect(r.clamped).toBe(false);
  expect(r.fovMode).toBe("wide");
  expect(transport.gimbalSet).toHaveBeenCalled();
});

test("an off-center pixel commands the offset the geometry module computes", async () => {
  const transport = makeFakeTransport();
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  // x=960 is u=0.5 on a 1280-wide frame; on wide (68deg) that is -18.64deg.
  const r = (await tool.handler({ x: 960, y: 360, ...HD_FRAME })) as {
    ok: boolean; target: { yaw: number }; offset: { dYaw: number };
  };
  expect(r.ok).toBe(true);
  expect(r.offset.dYaw).toBeCloseTo(-18.64, 2);
  expect(r.target.yaw).toBeCloseTo(-18.64, 2);
});

test("the FOV mode is READ, not assumed — narrow gives a different angle than wide", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => statusFov(2)); // narrow
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 960, y: 360, ...HD_FRAME })) as {
    ok: boolean; offset: { dYaw: number }; fovMode: string;
  };
  expect(r.ok).toBe(true);
  expect(r.fovMode).toBe("narrow");
  // narrow is 50deg, so u=0.5 gives -13.12deg, NOT wide's -18.64deg. This is the
  // test that would have caught the original parameter-guessing design.
  expect(r.offset.dYaw).toBeCloseTo(-13.12, 2);
  expect(r.offset.dYaw).not.toBeCloseTo(-18.64, 1);
});

test("active AI tracking is refused, naming the mode", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => statusTracking());
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 640, y: 360, ...HD_FRAME })) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/track/i);
  expect(r.error).toMatch(/obsbot_ai_track/);
  expect(transport.gimbalSet).not.toHaveBeenCalled();
});

test("a custom zoom is refused — the magnification mapping is uncalibrated", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => statusFov(3, 100));
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 640, y: 360, ...HD_FRAME })) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/zoom/i);
  expect(transport.gimbalSet).not.toHaveBeenCalled();
});

test("an unrecognised FOV mode is refused rather than guessed", async () => {
  const transport = makeFakeTransport();
  transport.recvStatus = vi.fn(async () => statusFov(9));
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 640, y: 360, ...HD_FRAME })) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(transport.gimbalSet).not.toHaveBeenCalled();
});

test("a non-16:9 frame is refused as a transposition or typo", async () => {
  const transport = makeFakeTransport();
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 100, y: 100, frameWidth: 720, frameHeight: 1280 })) as {
    ok: boolean; error: string;
  };
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/16:9|aspect/i);
  expect(transport.gimbalSet).not.toHaveBeenCalled();
});

test("a pixel outside the frame is refused", async () => {
  const transport = makeFakeTransport();
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 5000, y: 360, ...HD_FRAME })) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(transport.gimbalSet).not.toHaveBeenCalled();
});

test("saturation is reported and never commands an out-of-range pose", async () => {
  const transport = makeFakeTransport();
  // Current yaw 149; the left frame edge adds +34deg, which would be 183.
  transport.camCtrlGet = vi.fn(async (p: number) => ({ value: p === 0 ? 149 : 0, flags: 0 }));
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 0, y: 360, ...HD_FRAME })) as {
    ok: boolean; target: { yaw: number }; clamped: boolean;
  };
  expect(r.ok).toBe(true);
  expect(r.clamped).toBe(true);
  expect(r.target.yaw).toBe(150);
  expect(transport.gimbalSet).toHaveBeenCalledWith(150, expect.any(Number), expect.any(Number));
});

test("a sleeping camera is woken, not refused", async () => {
  const transport = makeFakeTransport();
  let first = true;
  transport.recvStatus = vi.fn(async () => {
    if (first) { first = false; return HEALTHY_STATUS_ASLEEP; }
    return HEALTHY_STATUS_AWAKE;
  });
  const tool = findTool(createTools(makeFakeMgr(transport)), "obsbot_aim_at_pixel");
  const r = (await tool.handler({ x: 640, y: 360, ...HD_FRAME })) as { ok: boolean };
  expect(r.ok).toBe(true);
  expect(transport.gimbalSet).toHaveBeenCalled();
});

test("the tool description warns that the frame size must match the pixel's frame", () => {
  const tool = findTool(createTools(makeFakeMgr()), "obsbot_aim_at_pixel");
  expect(tool.description).toMatch(/same/i);
  expect(tool.description).toMatch(/obsbot_capture_snapshot/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp/tools.test.ts`

Expected: FAIL — `tool not found: obsbot_aim_at_pixel`.

- [ ] **Step 3: Write the minimal implementation**

In `src/mcp/tools.ts`, there is already an import from the geometry module for the shared gimbal bounds:

```ts
import { GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG } from "../geometry/aim.js";
```

**Extend that existing line** — do not add a second import from the same module:

```ts
import { aimAtPixel, GIMBAL_YAW_LIMIT_DEG, GIMBAL_PITCH_LIMIT_DEG } from "../geometry/aim.js";
```

Add the schema beside the other schemas:

```ts
const aimAtPixelSchema = withCamera({
  x: z.coerce.number().finite(),
  y: z.coerce.number().finite(),
  frameWidth: z.coerce.number().finite().min(1),
  frameHeight: z.coerce.number().finite().min(1),
});
```

Add the tool definition to the `toolDefs` array:

```ts
    {
      name: "obsbot_aim_at_pixel",
      description:
        "Point the camera at a specific pixel in a frame you just captured. Give the pixel's x/y " +
        "and the frameWidth/frameHeight from THE SAME obsbot_capture_snapshot result — mixing a " +
        "pixel from one frame with dimensions from another aims at the wrong place and cannot be " +
        "detected. Takes no field-of-view argument: it reads the camera's actual FOV mode. Refuses " +
        "when AI tracking is active (tracking moves the gimbal itself and would fight the aim) and " +
        "when a custom zoom is set (the zoom magnification is not calibrated), so it never aims on " +
        "an assumption it cannot check. Returns clamped:true if the target was past the gimbal's " +
        "range and the camera landed short.",
      schema: aimAtPixelSchema,
      handler: async (args: unknown) => {
        const { x, y, frameWidth, frameHeight, camera } = aimAtPixelSchema.parse(args);

        // 16:9 is preserved by the capture path at every resolution (verified at
        // 256x144, 1280x720, 1920x1080), so anything else is a transposition or
        // a typo rather than a real frame.
        if (Math.abs(frameWidth / frameHeight - 16 / 9) > 0.02) {
          return {
            ok: false,
            error:
              `frame ${frameWidth}x${frameHeight} is not 16:9. Pass the width and height exactly ` +
              `as obsbot_capture_snapshot reported them.`,
          };
        }
        if (x < 0 || x > frameWidth || y < 0 || y > frameHeight) {
          return { ok: false, error: `pixel (${x},${y}) is outside the ${frameWidth}x${frameHeight} frame` };
        }

        // The gate wakes a sleeping camera and waits for it to settle, so the
        // status read below is never served from a stale block.
        const ready = await gate(camera);
        if (!ready.ok) return ready;
        const t = ready.transport;

        const status = decodeStatus(await t.recvStatus());
        if (status.aiMode !== "no-tracking") {
          return {
            ok: false,
            error:
              `AI tracking is active (${status.aiMode}); it moves the gimbal itself and would ` +
              `fight the aim. Disable it with obsbot_ai_track {enabled:false} first.`,
          };
        }
        if (status.fovMode === "custom") {
          return {
            ok: false,
            error:
              `a custom zoom is active (zoom ${status.zoomPercent}%), and the zoom-to-magnification ` +
              `mapping is not calibrated. Set obsbot_zoom_uvc {ratio:1} first.`,
          };
        }
        if (status.fovMode === "unknown") {
          return { ok: false, error: "could not read the camera's FOV mode; refusing to guess it" };
        }

        // Same read path as obsbot_gimbal_position: UVC pan is degrees with our
        // yaw sign; UVC tilt is degrees but positive = up, so negate it.
        const yaw = (await t.camCtrlGet(CAMERA_CONTROL_PAN)).value;
        const pitch = -(await t.camCtrlGet(CAMERA_CONTROL_TILT)).value;

        // zoom:1 — the measured FOV constants already include each discrete
        // mode's inherent crop, so applying zoomPercent again would double-count.
        const aim = aimAtPixel(
          x, y,
          { width: frameWidth, height: frameHeight },
          { fov: status.fovMode, zoom: 1 },
          { yaw, pitch },
        );

        await t.gimbalSet(aim.target.yaw, aim.target.pitch, 0);
        return {
          ok: true,
          target: aim.target,
          offset: aim.offset,
          clamped: aim.clamped,
          fovMode: status.fovMode,
          current: { yaw, pitch },
          ...(ready.reconnected ? { reconnected: true } : {}),
        };
      },
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mcp/tools.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

Expected: PASS, all files. A new tool changes the tool count, so if any test asserts the number of advertised tools, update that number.

- [ ] **Step 6: Verify it compiles under strict TypeScript**

Run: `npx tsc -p tsconfig.json --noEmit`

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools.ts test/mcp/tools.test.ts
git commit -m "feat(mcp): add obsbot_aim_at_pixel — point the camera at a pixel"
```

---

### Task 3: Document the tool

The README's tool tables are the user-facing surface. A tool that is not in them is undiscoverable.

**Files:**
- Modify: `README.md` (tool table + a note on the aim loop)

**Interfaces:**
- Consumes: the tool shipped in Task 2.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Find the table the tool belongs in**

Run: `grep -n "obsbot_gimbal_position\|### Gimbal (PTZ)" README.md`

The gimbal table is the right home — the tool is a gimbal move whose target is computed from a pixel.

- [ ] **Step 2: Add the row**

Add to the Gimbal (PTZ) table, after the `obsbot_gimbal_position` row:

```markdown
| `obsbot_aim_at_pixel` | `x`, `y`, `frameWidth`, `frameHeight`, `camera`? | Point the camera at a pixel from a frame you just captured. Reads the camera's own FOV mode rather than taking one. Refuses while AI tracking or a custom zoom is active. Returns `clamped:true` if the target was out of range and the camera landed short. |
```

- [ ] **Step 3: Add a short section explaining the loop**

Add after the Gimbal (PTZ) table:

```markdown
#### Aiming at what you can see

`obsbot_capture_snapshot` returns the frame as an image plus its `width`/`height`, so a model can
locate something in the picture and then point the camera at it:

1. `obsbot_capture_snapshot` — look at the frame
2. `obsbot_aim_at_pixel` — pass the target's pixel and that frame's dimensions
3. `obsbot_capture_snapshot` again — confirm it landed, and repeat if needed

Pass the `frameWidth`/`frameHeight` from the same snapshot the pixel came from. Mixing a pixel from
one frame with dimensions from another aims at the wrong place, and nothing can detect it.

The tool reads the camera's field-of-view mode itself, so there is no FOV argument to get wrong. It
refuses rather than guessing when AI tracking is on (tracking drives the gimbal and would fight the
aim) or when a custom zoom is set (the zoom magnification is not calibrated).
```

- [ ] **Step 4: Verify the README claims match the code**

Run: `npx vitest run && grep -n "obsbot_aim_at_pixel" README.md`

Expected: suite passes, and the tool name appears in the README.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document obsbot_aim_at_pixel and the aim loop"
```

---

## Out of Scope

Named so an implementer does not helpfully add them:

- **Any change to `src/geometry/aim.ts`.** It is merged and verified against hardware. If a constant looks wrong, that is a measurement question, not a code change.
- **Auto-disabling AI tracking**, or auto-resetting zoom. Both refusals are deliberate — see the spec's §4.
- **Calibrating the zoom-to-magnification mapping.** One point is known (UVC ratio 2.0 gives 4x linear). Until more exist, custom zoom stays refused.
- **A tool that iterates until centered.** The verify step needs the model's vision; the server cannot see.
- **Zoom-to-fit / frame-a-region.**
- **Hardware verification.** A separate step after this plan: point the camera at a target, aim at its pixel, confirm it centers.
