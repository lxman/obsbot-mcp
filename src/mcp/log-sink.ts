import { appendFileSync } from "node:fs";

/**
 * Build the server's diagnostic log sink.
 *
 * The MCP server's stderr is a pipe to whatever launched it (Claude Code hands
 * it a socket), so `console.error` alone is write-only in practice — the
 * arrival re-bind ladder could fire and nobody would ever know. Setting
 * `OBSBOT_LOG_FILE` appends the same lines somewhere greppable afterwards,
 * which is what watching for a rare event during ordinary use requires.
 *
 * stdout is never an option: it is the JSON-RPC channel.
 */
export function makeLogSink(
  path: string | undefined,
  console_: (msg: string) => void,
): (msg: string) => void {
  if (!path) return console_;
  return (msg: string): void => {
    console_(msg);
    try {
      appendFileSync(path, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // A bad path, a full disk, a read-only mount — none of that is worth
      // taking the server down for. The console sink already got the message.
    }
  };
}
