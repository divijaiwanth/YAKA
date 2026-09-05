// File-based diagnostic logging.
//
// stdout is the MCP protocol channel and stderr disappears into whatever
// spawned us (Claude Desktop doesn't surface it), so when something fails
// inside a client-spawned server the only way to see it is to write to a
// file. Every tool call, result, and crash lands here.

import fs from "node:fs";
import path from "node:path";

function logPath(): string {
  if (process.env.YAKA_LOG_PATH) return process.env.YAKA_LOG_PATH;
  const dbPath = process.env.DB_PATH ?? "./data/guardrail.db";
  return path.join(path.dirname(dbPath), "yaka-server.log");
}

export function log(event: string, detail?: unknown): void {
  try {
    const line = `${new Date().toISOString()} ${event}${detail === undefined ? "" : " " + safeStringify(detail)}\n`;
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch {
    // Logging must never be the thing that breaks a payment tool.
  }
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
