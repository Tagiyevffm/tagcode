import { promises as fs } from "node:fs";
import path from "node:path";
import { globalHistoryPath } from "../config/paths.js";
import { ensureDir } from "../utils/fs.js";

const MAX_ENTRIES = 500;
const MAX_BYTES = 512 * 1024;

type HistoryLine = { text?: unknown; at?: unknown };

function parseLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as HistoryLine | string;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed.text === "string") return parsed.text;
  } catch {
    return trimmed;
  }
  return undefined;
}

/** Load recent prompts, oldest first. Failures are non-fatal. */
export async function loadHistory(): Promise<string[]> {
  try {
    const raw = await fs.readFile(globalHistoryPath(), "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map(parseLine)
      .filter((entry): entry is string => Boolean(entry));
    const deduped: string[] = [];
    for (const entry of entries) {
      if (deduped[deduped.length - 1] === entry) continue;
      deduped.push(entry);
    }
    return deduped.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** Append a prompt to the on-disk history. Slash commands are never stored. */
export async function appendHistory(text: string): Promise<void> {
  const value = text.trim();
  if (!value || value.startsWith("/")) return;
  const file = globalHistoryPath();
  try {
    await ensureDir(path.dirname(file));
    await fs.appendFile(file, `${JSON.stringify({ text: value, at: new Date().toISOString() })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES) {
      const entries = await loadHistory();
      const trimmed = entries.slice(-MAX_ENTRIES);
      await fs.writeFile(
        file,
        `${trimmed.map((entry) => JSON.stringify({ text: entry })).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  } catch {
    // History is a convenience; never interrupt a prompt because of it.
  }
}

export const historyLimits = { MAX_ENTRIES, MAX_BYTES };
