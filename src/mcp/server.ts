import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DeviceManager } from "../device/manager.js";
import { HelperProcess } from "../transport/helper-process.js";
import { ObsbotTransport } from "../transport/transport.js";
import { createTools, ToolDef } from "./tools.js";
import type { ReconnectCtl } from "./ready.js";
import { renderToolResult } from "./render.js";
import { CaptureManager } from "../capture/manager.js";

export async function startServer(opts: { debug?: boolean } = {}): Promise<void> {
  const mgr = new DeviceManager(async () => {
    const helper = new HelperProcess();
    await helper.start();
    return helper;
  });

  // DeviceManager now owns the connection lifecycle: lazy bind, invalidate +
  // re-bind on a mid-session disconnect (self-heal), and per-camera reconnect
  // tracking. Single camera, no selector yet (that's B1b) — every resolution is
  // the single bound camera, so getTransport/reconnect target it with no serial.
  const getTransport = (): Promise<ObsbotTransport> => mgr.get();
  const reconnect: ReconnectCtl = {
    invalidate: () => mgr.invalidate(),
    takeReconnected: () => mgr.takeReconnected(),
  };

  const capture = new CaptureManager();
  // --debug exposes the RE/diagnostics surface (obsbot_probe tool + get_status raw block).
  const tools: ToolDef[] = createTools(getTransport, mgr, capture, reconnect, opts.debug ?? false);

  // Kill any recording/preview child processes when the server exits, so nothing orphans.
  const shutdown = (): void => capture.stopAll();
  process.on("exit", shutdown);
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });

  const server = new Server(
    { name: "obsbot-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Advertise a real JSON Schema (types, enums, defaults, required) derived
      // from each tool's zod schema. Without typed properties, clients serialize
      // numbers/booleans as strings and strict validation rejects them.
      inputSchema: zodToJsonSchema(tool.schema, { target: "jsonSchema7" }) as {
        type: "object";
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new Error(`unknown tool: ${request.params.name}`);
    }
    const result = await tool.handler(request.params.arguments ?? {});
    return renderToolResult(result);
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
