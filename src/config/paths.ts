import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

/**
 * Global TagCode home. `TAGCODE_HOME` makes the entire tool self-contained,
 * which is what the test-suite uses.
 */
export function tagcodeHome(): string {
  const override = process.env.TAGCODE_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".tagcode");
}

export function globalConfigPath(): string {
  return path.join(tagcodeHome(), "config.json");
}

export function globalMcpPath(): string {
  return path.join(tagcodeHome(), "mcp.json");
}

export function globalAuthPath(): string {
  return path.join(tagcodeHome(), "auth.json");
}

export function globalSkillsDir(): string {
  return path.join(tagcodeHome(), "skills");
}

export function globalPluginsDir(): string {
  return path.join(tagcodeHome(), "plugins");
}

export function globalSessionsDir(): string {
  return path.join(tagcodeHome(), "sessions");
}

export function globalMemoryDir(): string {
  return path.join(tagcodeHome(), "memory");
}

export function globalHistoryPath(): string {
  return path.join(tagcodeHome(), "history.jsonl");
}

export function projectDir(workspace: string): string {
  return path.join(workspace, ".tagcode");
}

export function projectConfigPath(workspace: string): string {
  return path.join(projectDir(workspace), "config.json");
}

export function projectMcpPath(workspace: string): string {
  return path.join(projectDir(workspace), "mcp.json");
}

export function projectSkillsDir(workspace: string): string {
  return path.join(projectDir(workspace), "skills");
}

export function projectMemoryDir(workspace: string): string {
  return path.join(projectDir(workspace), "memory");
}

export function projectCheckpointsDir(workspace: string): string {
  return path.join(projectDir(workspace), "checkpoints");
}

export function projectSessionsDir(workspace: string): string {
  return path.join(projectDir(workspace), "sessions");
}

/**
 * Find the project root: the nearest ancestor containing `.tagcode` or `.git`.
 * Falls back to the starting directory.
 *
 * `~/.tagcode` is the global TagCode home, not a project marker, so the walk
 * stops before the OS home directory and before a custom `TAGCODE_HOME`.
 * Without that guard every project under the user's home would resolve to the
 * home directory itself.
 */
export async function findProjectRoot(start: string): Promise<string> {
  const resolvedStart = path.resolve(start);
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const boundaries = new Set([normalize(os.homedir()), normalize(tagcodeHome())]);
  let current = resolvedStart;
  const root = path.parse(current).root;
  while (true) {
    if (boundaries.has(normalize(current))) return resolvedStart;
    try {
      const entries = await fs.readdir(current);
      if (entries.includes(".tagcode") || entries.includes(".git")) return current;
    } catch {
      // Unreadable directory; keep walking up.
    }
    if (current === root) return resolvedStart;
    const parent = path.dirname(current);
    if (parent === current) return resolvedStart;
    current = parent;
  }
}

export async function ensureTagcodeHome(): Promise<string> {
  const home = tagcodeHome();
  await fs.mkdir(home, { recursive: true });
  return home;
}
