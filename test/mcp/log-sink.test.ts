import { expect, test } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLogSink } from "../../src/mcp/log-sink.js";

// ---------------------------------------------------------------------------
//  The server's stderr is a unix socket to whatever launched it, not a file —
//  so a console.error nobody can read is not observability. When
//  OBSBOT_LOG_FILE is set, the same lines are appended somewhere greppable
//  after the fact, which is what "watch for the retry during normal use"
//  actually needs.
// ---------------------------------------------------------------------------

const tmp = (): string => join(mkdtempSync(join(tmpdir(), "obsbot-log-")), "server.log");

test("with no path configured, messages still reach the console sink", async () => {
  const seen: string[] = [];
  makeLogSink(undefined, (m) => seen.push(m))("hello");
  expect(seen).toEqual(["hello"]);
});

test("with a path configured, the message is appended to the file", async () => {
  const path = tmp();
  const log = makeLogSink(path, () => {});
  log("first");
  log("second");

  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("first");
  expect(lines[1]).toContain("second");
});

test("each line carries a timestamp, so a retry can be tied to a replug", async () => {
  const path = tmp();
  makeLogSink(path, () => {})("arrival re-bind succeeded on attempt 2");

  // ISO-8601 prefix, e.g. 2026-07-21T14:11:55.123Z
  expect(readFileSync(path, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
});

test("the file sink does not replace the console sink", async () => {
  const path = tmp();
  const seen: string[] = [];
  makeLogSink(path, (m) => seen.push(m))("both");

  expect(seen).toEqual(["both"]);
  expect(readFileSync(path, "utf8")).toContain("both");
});

test("an unwritable path is swallowed — logging must never take down the server", async () => {
  const log = makeLogSink("/nonexistent-dir-xyz/deep/server.log", () => {});
  expect(() => log("still fine")).not.toThrow();
});
