import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tagcodeHome } from "../config/paths.js";
import { redactValue } from "./redact.js";

export type AuditEntry = {
  timestamp: string;
  tool: string;
  permission: string;
  outcome: string;
  summary?: string;
  reason?: string;
  mode?: string;
  [key: string]: unknown;
};

/**
 * Append a redacted JSONL record to the permission audit log.
 * The log lives in the global TagCode home, not in the user's project.
 */
export async function appendAudit(entry: AuditEntry, home = tagcodeHome()): Promise<void> {
  const dir = path.join(home, "logs");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "audit.jsonl");
  const safe = redactValue(entry);
  await appendFile(file, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
}
