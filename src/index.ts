#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { startServer } from "./mcp/server.js";

export const NAME = "obsbot-mcp";

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const debug = process.argv.includes("--debug");
  startServer({ debug }).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
