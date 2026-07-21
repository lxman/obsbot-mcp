import { describe, test, expect } from "vitest";
import { encodeFrame, FrameDecoder, MAX_FRAME } from "../../src/ipc/protocol.js";

describe("frame protocol", () => {
  test("round-trips a single message", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame({ id: 1, body: { op: "enumerate" } }))).toEqual([
      { id: 1, body: { op: "enumerate" } },
    ]);
  });

  test("emits two messages coalesced into one chunk", () => {
    const d = new FrameDecoder();
    const chunk = Buffer.concat([encodeFrame({ id: 1, body: null }), encodeFrame({ id: 2, body: null })]);
    expect(d.push(chunk)).toEqual([{ id: 1, body: null }, { id: 2, body: null }]);
  });

  test("waits for the rest when the body is split across chunks", () => {
    const d = new FrameDecoder();
    const f = encodeFrame({ id: 7, body: "hello" });
    expect(d.push(f.subarray(0, 6))).toEqual([]); // header + 2 body bytes
    expect(d.push(f.subarray(6))).toEqual([{ id: 7, body: "hello" }]);
  });

  test("survives a split inside the 4-byte length header", () => {
    const d = new FrameDecoder();
    const f = encodeFrame({ id: 9, body: null });
    expect(d.push(f.subarray(0, 2))).toEqual([]); // only 2 of 4 header bytes
    expect(d.push(f.subarray(2))).toEqual([{ id: 9, body: null }]);
  });

  test("carries leftover bytes across pushes (one full frame + partial next)", () => {
    const d = new FrameDecoder();
    const f1 = encodeFrame({ id: 1, body: null });
    const f2 = encodeFrame({ id: 2, body: null });
    const combined = Buffer.concat([f1, f2]);
    expect(d.push(combined.subarray(0, f1.length + 3))).toEqual([{ id: 1, body: null }]);
    expect(d.push(combined.subarray(f1.length + 3))).toEqual([{ id: 2, body: null }]);
  });

  test("rejects an oversized declared length on receive", () => {
    const d = new FrameDecoder();
    const bad = Buffer.allocUnsafe(4);
    bad.writeUInt32BE(MAX_FRAME + 1, 0);
    expect(() => d.push(bad)).toThrow(/too large/);
  });

  test("rejects an oversized body on send", () => {
    expect(() => encodeFrame("x".repeat(MAX_FRAME + 1))).toThrow(/too large/);
  });
});
