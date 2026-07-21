import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DeviceManager } from "../device/manager.js";
import { helperFactory } from "../device/helper-factory.js";
import { createTools, ToolDef } from "./tools.js";
import { renderToolResult } from "./render.js";
import { CaptureManager } from "../capture/manager.js";
import { Coordinator, serialize } from "../ipc/coordinator.js";

export async function startServer(opts: { debug?: boolean } = {}): Promise<void> {
  // helperFactory subscribes every helper it spawns to the OS bus events, so
  // the manager hears about a camera arriving or leaving instead of finding
  // out by failing a call. See src/device/helper-factory.ts.
  const mgr: DeviceManager = new DeviceManager(helperFactory(() => mgr));

  // DeviceManager now owns the connection lifecycle: lazy bind, invalidate +
  // re-bind on a mid-session disconnect (self-heal), and per-camera reconnect
  // tracking. createTools derives per-camera resolution (getTransport / reconnect
  // / readiness gate) from the manager itself, keyed by each tool's optional
  // `camera` selector — so nothing per-camera is wired up out here anymore.
  const capture = new CaptureManager();
  // --debug exposes the RE/diagnostics surface (obsbot_debug_probe tool + status raw block).
  const tools: ToolDef[] = createTools(mgr, capture, opts.debug ?? false);

  // Single-owner camera coordination across concurrent MCP clients (see
  // IPC-DESIGN.md). Every instance elects: the owner runs tool calls locally
  // against the one DeviceManager; clients forward theirs to the owner and
  // re-elect if it dies. runLocal is the tool dispatch, serialize()-wrapped so
  // it is the single-camera lock — covering both this instance's own calls and
  // any forwarded from clients (the local path bypasses OwnerServer's queue). A
  // lone instance is simply the owner with no peers: it behaves exactly as
  // before, plus an idle listener.
  const runLocal = serialize(async (name, args) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.handler(args);
  });
  const coordinator = new Coordinator(runLocal);
  await coordinator.start();
  // Report the coordination role on STDERR (never stdout — that's the JSON-RPC
  // channel). Useful for ops ("am I the owner or a client?") and observed by the
  // ipc-hw-smoke harness to confirm a client really forwards to the owner.
  console.error(`obsbot-mcp: ipc role=${coordinator.roleName}`);

  // Kill any recording/preview child processes when the server exits, so nothing
  // orphans, and drop the IPC endpoint / owner connection.
  const shutdown = (): void => {
    capture.stopAll();
    void coordinator.close();
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });

  const server = new Server(
    // Must match package.json's version; test/version-sync.test.ts enforces it.
    { name: "obsbot-mcp", version: "0.4.0" },
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
    const name = request.params.name;
    if (!tools.find((t) => t.name === name)) {
      throw new Error(`unknown tool: ${name}`);
    }
    // Route through the coordinator: run locally if we own the camera, else
    // forward to whoever does. renderToolResult runs here at the MCP boundary,
    // on the raw tool result either way.
    const result = await coordinator.dispatch(name, request.params.arguments ?? {});
    return renderToolResult(result);
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
