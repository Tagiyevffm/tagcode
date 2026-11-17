import { promises as fs } from "node:fs";
import path from "node:path";
import { toPosixPath } from "./fs.js";

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".tagcode",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vscode",
  "target",
  "vendor",
  ".cache",
]);

export type WalkOptions = {
  ignoreDirs?: Set<string>;
  followSymlinks?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  includeHidden?: boolean;
};

export type WalkedFile = { path: string; relativePath: string; size: number; modifiedMs: number };

function escapeRegex(char: string): string {
  return char.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob expression to a RegExp.
 * Supports `**`, `*`, `?`, character classes and `{a,b}` alternation.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  const normalized = toPosixPath(pattern).replace(/^\.\//, "").replace(/^\/+/, "");
  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        const isSlashAfter = normalized[i + 2] === "/";
        if (isSlashAfter) {
          out += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (char === "[") {
      const end = normalized.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        i += 1;
        continue;
      }
      const body = normalized.slice(i + 1, end).replace(/\\/g, "\\\\");
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = end + 1;
      continue;
    }
    if (char === "{") {
      const end = normalized.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        i += 1;
        continue;
      }
      const options = normalized
        .slice(i + 1, end)
        .split(",")
        .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
      out += `(?:${options.join("|")})`;
      i = end + 1;
      continue;
    }
    out += escapeRegex(char);
    i += 1;
  }
  out += "$";
  return new RegExp(out, process.platform === "win32" ? "i" : "");
}

export function matchGlob(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(toPosixPath(relativePath));
}

/**
 * Recursively walk a directory. Deterministic (alphabetical), bounded by depth
 * and file count, and skips common dependency/build directories.
 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORED_DIRECTORIES;
  const maxDepth = options.maxDepth ?? 25;
  const maxFiles = options.maxFiles ?? 20_000;
  const includeHidden = options.includeHidden ?? false;
  const files: WalkedFile[] = [];
  let stopped = false;

  async function visit(dir: string, depth: number): Promise<void> {
    if (stopped || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stopped) return;
      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        // Never skip explicitly requested dot-files at the root, but skip hidden dirs.
        if (entry.isDirectory()) continue;
      }
      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        await visit(fullPath, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink() && !options.followSymlinks) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        path: fullPath,
        relativePath: toPosixPath(path.relative(root, fullPath)),
        size: stat.size,
        modifiedMs: stat.mtimeMs,
      });
      if (files.length >= maxFiles) {
        stopped = true;
        return;
      }
    }
  }

  await visit(root, 0);
  return files;
}

export function formatGlobList(patterns: string[]): string {
  return patterns.join(", ");
}
