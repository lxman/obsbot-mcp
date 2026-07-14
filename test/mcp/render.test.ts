import { expect, test } from "vitest";
import { renderToolResult } from "../../src/mcp/render.js";

test("wraps a plain object as a single JSON text block", () => {
  expect(renderToolResult({ ok: true, ratio: 1.5 })).toEqual({
    content: [{ type: "text", text: JSON.stringify({ ok: true, ratio: 1.5 }) }],
  });
});

test("passes through a result that already carries a content array", () => {
  const img = {
    content: [
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "text", text: "{\"width\":1280}" },
    ],
  };
  expect(renderToolResult(img)).toBe(img);
});

test("wraps null/undefined as text without throwing", () => {
  expect(renderToolResult(undefined)).toEqual({
    content: [{ type: "text", text: undefined as unknown as string }],
  });
});
