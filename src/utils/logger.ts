import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { redactSecrets } from "../security/redact.js";

const LOG_DIR = path.join(os.homedir(), ".tagcode", "logs");
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type LogLevel = "debug" | "info" | "warn" | "error";

let debugEnabled =
  process.env.TAGCODE_DEBUG === "1" || process.env.TAGCODE_DEBUG === "true";

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

function formatValue(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return `${data.message}${data.stack ? `\n${data.stack}` : ""}`;
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/**
 * Debug logging is opt-in. All messages pass through secret redaction and are
 * written to stderr plus `~/.tagcode/logs/tagcode.log`.
 */
export function log(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (!debugEnabled && level === "debug") return;
  const line = redactSecrets(
    `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${message}${
      data === undefined ? "" : ` ${formatValue(data)}`
    }`,
  );
  if (debugEnabled) {
    process.stderr.write(`${line}\n`);
  }
  void persist(line);
}

async function persist(line: string): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_DIR, line + "\n", { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    if (line.length > MAX_LOG_BYTES) return;
  } catch {
    // Logging must never take the application down.
  }
}

export const logger = {
  debug: (scope: string, message: string, data?: unknown) => log("debug", scope, message, data),
  info: (scope: string, message: string, data?: unknown) => log("info", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => log("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => log("error", scope, message, data),
};
