import { promises as fs } from "node:fs";
import path from "node:path";
import { tagcodeHome } from "../config/paths.js";
import { pathExists } from "../utils/fs.js";

export type InstructionFile = {
  path: string;
  scope: "global" | "project";
  content: string;
};

const MAX_PER_FILE = 24_000;
const MAX_TOTAL = 64_000;

async function readCapped(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_PER_FILE) {
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_PER_FILE);
        const { bytesRead } = await handle.read(buffer, 0, MAX_PER_FILE, 0);
        return `${buffer.subarray(0, bytesRead).toString("utf8")}\n… (instruction file truncated)`;
      } finally {
        await handle.close();
      }
    }
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function directoriesBetween(projectRoot: string, workspace: string): string[] {
  const root = path.resolve(projectRoot);
  const target = path.resolve(workspace);
  if (!target.startsWith(root)) return [target];
  const relative = path.relative(root, target);
  const chain = [root];
  if (relative) {
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      chain.push(current);
    }
  }
  return chain;
}

/**
 * Load AGENTS.md / CLAUDE.md instructions with directory scope. Global
 * instructions come first, then project root, then nested directories.
 */
export async function loadInstructionFiles(options: {
  workspace: string;
  projectRoot: string;
  home?: string;
}): Promise<InstructionFile[]> {
  const files: InstructionFile[] = [];
  const seen = new Set<string>();
  const push = async (filePath: string, scope: "global" | "project") => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    const content = await readCapped(resolved);
    if (content === undefined || !content.trim()) return;
    seen.add(resolved);
    files.push({ path: resolved, scope, content });
  };

  const homeDir = options.home ?? tagcodeHome();
  await push(path.join(homeDir, "AGENTS.md"), "global");

  const chain = directoriesBetween(options.projectRoot, options.workspace);
  for (const directory of chain) {
    await push(path.join(directory, "AGENTS.md"), "project");
    await push(path.join(directory, "CLAUDE.md"), "project");
    if (directory === path.resolve(options.projectRoot)) {
      await push(path.join(directory, ".tagcode", "AGENTS.md"), "project");
    }
  }
  return files;
}

export function formatInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  const blocks: string[] = [];
  let used = 0;
  for (const file of files) {
    const header = `### ${file.path}\n`;
    const remaining = MAX_TOTAL - used;
    if (remaining <= header.length + 100) break;
    const content = file.content.slice(0, Math.max(0, remaining - header.length));
    blocks.push(`${header}${content.trim()}`);
    used += header.length + content.length;
  }
  return blocks.join("\n\n");
}

export async function hasInstructionFiles(workspace: string): Promise<boolean> {
  for (const candidate of ["AGENTS.md", "CLAUDE.md", path.join(".tagcode", "AGENTS.md")]) {
    if (await pathExists(path.join(workspace, candidate))) return true;
  }
  return false;
}
