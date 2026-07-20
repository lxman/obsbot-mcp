// Render a tool handler's return value into an MCP CallTool result. A handler
// may either return a plain object (serialized to a single text block, the
// default for every control tool) or an object that already carries an MCP
// `content` array (e.g. obsbot_capture_snapshot returning an image block), which is
// passed through untouched.
export function renderToolResult(result: unknown): { content: unknown[] } {
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as { content: unknown[] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
