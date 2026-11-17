import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, pathExists, writeFileAtomic } from "../utils/fs.js";
import { redactSecrets } from "../security/redact.js";

const MAX_FILE_BYTES = 256 * 1024;

const SECTIONS: Record<string, string> = {
  project: "Project",
  architecture: "Architecture",
  conventions: "Conventions",
  decisions: "Decisions",
  notes: "Notes",
};

export type MemoryScope = "project" | "global";

function titleFor(section: string): string {
  return SECTIONS[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

/**
 * Markdown-backed memory. Each scope has its own directory; TagCode never
 * writes secrets into memory (the append path rejects them).
 */
export class MemoryStore {
  readonly directory: string;
  readonly scope: MemoryScope;

  constructor(options: { directory: string; scope: MemoryScope }) {
    this.directory = options.directory;
    this.scope = options.scope;
  }

  async listFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  }

  async readSection(section: string): Promise<string> {
    const safe = sanitizeSection(section);
    if (!safe) return "";
    const file = path.join(this.directory, `${safe}.md`);
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) {
        const handle = await fs.open(file, "r");
        try {
          const buffer = Buffer.alloc(MAX_FILE_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0);
          return buffer.subarray(0, bytesRead).toString("utf8") + "\n… (memory truncated)";
        } finally {
          await handle.close();
        }
      }
      return await fs.readFile(file, "utf8");
    } catch {
      return "";
    }
  }

  async readAll(maxChars = 12_000): Promise<string> {
    const files = await this.listFiles();
    const parts: string[] = [];
    let used = 0;
    for (const file of files) {
      const content = await this.readSection(file.replace(/\.md$/, ""));
      if (!content.trim()) continue;
      const block = `## ${file}\n${content.trim()}`;
      if (used + block.length > maxChars) {
        parts.push(block.slice(0, Math.max(0, maxChars - used)) + "\n… (memory truncated)");
        break;
      }
      parts.push(block);
      used += block.length;
    }
    return parts.join("\n\n");
  }

  async search(query: string, limit = 10): Promise<string[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 2)
      .slice(0, 8);
    if (terms.length === 0) return [];
    const files = await this.listFiles();
    const results: Array<{ score: number; text: string }> = [];
    for (const file of files) {
      const content = await this.readSection(file.replace(/\.md$/, ""));
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const lower = line.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (lower.includes(term)) score += term.length;
        }
        if (score > 0) {
          results.push({
            score,
            text: `${file}:${index + 1}: ${line.trim().slice(0, 300)}`,
          });
        }
      }
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.text);
  }

  async append(section: string, text: string): Promise<string> {
    const safe = sanitizeSection(section);
    if (!safe) throw new Error(`Invalid memory section: ${section}`);
    const value = text.trim();
    if (!value) throw new Error("Refusing to store empty memory.");
    if (redactSecrets(value) !== value) {
      throw new Error("Refusing to store a value that looks like a secret in memory.");
    }
    await ensureDir(this.directory);
    const file = path.join(this.directory, `${safe}.md`);
    const exists = await pathExists(file);
    const header = exists ? "" : `# ${titleFor(safe)}\n\n`;
    const current = exists ? await fs.readFile(file, "utf8") : "";
    const next = `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${header}${value}\n`;
    await writeFileAtomic(file, next);
    return file;
  }

  async clear(): Promise<string[]> {
    const files = await this.listFiles();
    await Promise.all(files.map((file) => fs.rm(path.join(this.directory, file), { force: true })));
    return files;
  }

  async export(): Promise<string> {
    const content = await this.readAll(Number.MAX_SAFE_INTEGER);
    return `# TagCode ${this.scope} memory\n\n${content || "(empty)"}\n`;
  }
}

export function sanitizeSection(section: string): string | undefined {
  const value = section.toLowerCase().replace(/\.md$/, "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(value)) return undefined;
  return value;
}

export type MemoryBundle = {
  project: MemoryStore;
  global: MemoryStore;
};

export function createMemoryBundle(options: {
  projectDir: string;
  globalDir: string;
}): MemoryBundle {
  return {
    project: new MemoryStore({ directory: options.projectDir, scope: "project" }),
    global: new MemoryStore({ directory: options.globalDir, scope: "global" }),
  };
}

/** Search both scopes, returning labeled results. */
export async function searchMemory(
  bundle: MemoryBundle,
  query: string,
  limit = 10,
): Promise<string[]> {
  const [project, global] = await Promise.all([
    bundle.project.search(query, limit),
    bundle.global.search(query, limit),
  ]);
  return [
    ...project.map((line) => `[project] ${line}`),
    ...global.map((line) => `[global] ${line}`),
  ].slice(0, limit);
}
