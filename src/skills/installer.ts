import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { globalSkillsDir, projectSkillsDir } from "../config/paths.js";
import { ensureDir, isProbablyUrl, writeJson } from "../utils/fs.js";
import { runProcess } from "../tools/terminal.js";
import { isPathInside } from "../security/paths.js";
import { validateSkillDirectory } from "./validator.js";
import type { InstallRecord, RegistrySkill, Skill } from "./types.js";

export type SkillScope = "global" | "project";

const RECORD_FILE = ".tagcode-skill.json";

function validateSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

async function copySkillDirectory(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    filter: (file) => {
      const base = path.basename(file);
      return base !== ".git" && base !== "node_modules" && base !== RECORD_FILE;
    },
  });
}

export class SkillInstaller {
  constructor(
    private readonly options: {
      projectRoot: string;
      home?: string;
      registryUrl?: string;
    },
  ) {}

  targetRoot(scope: SkillScope): string {
    return scope === "global" ? globalSkillsDir() : projectSkillsDir(this.options.projectRoot);
  }

  targetDirectory(name: string, scope: SkillScope): string {
    validateSkillName(name);
    const root = this.targetRoot(scope);
    const target = path.join(root, name);
    if (!isPathInside(root, target)) throw new Error("Refusing to install outside the skills directory.");
    return target;
  }

  private async writeRecord(directory: string, record: InstallRecord): Promise<void> {
    await writeJson(path.join(directory, RECORD_FILE), record);
  }

  async readRecord(name: string, scope: SkillScope): Promise<InstallRecord | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.targetDirectory(name, scope), RECORD_FILE), "utf8");
      return JSON.parse(raw) as InstallRecord;
    } catch {
      return undefined;
    }
  }

  async installFromLocal(
    sourceDirectory: string,
    scope: SkillScope,
    options: { force?: boolean } = {},
  ): Promise<Skill> {
    const source = path.resolve(sourceDirectory);
    const validation = await validateSkillDirectory(source, "configured");
    if (!validation.skill) {
      throw new Error(`Invalid skill at ${source}:\n${validation.errors.join("\n")}`);
    }
    const target = this.targetDirectory(validation.skill.name, scope);
    if ((await fs.stat(target).catch(() => undefined)) && !options.force) {
      throw new Error(
        `Skill "${validation.skill.name}" is already installed at ${target}. Use update or force to replace it.`,
      );
    }
    await ensureDir(path.dirname(target));
    if (options.force) await fs.rm(target, { recursive: true, force: true });
    await copySkillDirectory(source, target);
    await this.writeRecord(target, {
      source,
      sourceType: "local",
      installedAt: new Date().toISOString(),
      version: validation.skill.metadata.version,
    });
    const installed = await validateSkillDirectory(target, scope === "global" ? "global" : "project");
    if (!installed.skill) {
      await fs.rm(target, { recursive: true, force: true });
      throw new Error(`Installed skill failed validation:\n${installed.errors.join("\n")}`);
    }
    return installed.skill;
  }

  async installFromGit(
    url: string,
    scope: SkillScope,
    options: { force?: boolean; ref?: string } = {},
  ): Promise<Skill> {
    if (!isProbablyUrl(url) || url.startsWith("file:")) {
      throw new Error("Skill URL must be an https, ssh or git URL.");
    }
    const tempRoot = path.join(os.tmpdir(), "tagcode-skills", randomUUID());
    await ensureDir(tempRoot);
    const cloneDir = path.join(tempRoot, "repo");
    try {
      const args = ["clone", "--depth", "1"];
      if (options.ref) args.push("--branch", options.ref);
      args.push("--", url, cloneDir);
      const result = await runProcess({
        file: "git",
        args,
        cwd: tempRoot,
        timeoutMs: 120_000,
        signal: AbortSignal.timeout(120_000),
        maxOutputChars: 20_000,
      });
      if (result.code !== 0 || result.error) {
        throw new Error(`git clone failed: ${result.error ?? result.stderr.trim() ?? `exit ${result.code}`}`);
      }
      const skillRoot = await findSkillRoot(cloneDir);
      if (!skillRoot) throw new Error("No SKILL.md found in the repository root or a single subdirectory.");
      return await this.installFromLocal(skillRoot, scope, options);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async installFromContent(
    markdown: string,
    scope: SkillScope,
    options: { force?: boolean; source?: string } = {},
  ): Promise<Skill> {
    const tempDir = path.join(os.tmpdir(), "tagcode-skills", `content-${randomUUID()}`);
    await ensureDir(tempDir);
    try {
      await fs.writeFile(path.join(tempDir, "SKILL.md"), markdown, "utf8");
      const validation = await validateSkillDirectory(tempDir, "configured");
      if (!validation.skill) {
        throw new Error(`Generated skill is invalid:\n${validation.errors.join("\n")}`);
      }
      const name = validation.skill.name;
      const target = this.targetDirectory(name, scope);
      if ((await fs.stat(target).catch(() => undefined)) && !options.force) {
        throw new Error(`Skill "${name}" is already installed.`);
      }
      await ensureDir(path.dirname(target));
      if (options.force) await fs.rm(target, { recursive: true, force: true });
      await ensureDir(target);
      await fs.writeFile(path.join(target, "SKILL.md"), markdown, "utf8");
      await this.writeRecord(target, {
        source: options.source ?? "generated by TagCode",
        sourceType: "content",
        installedAt: new Date().toISOString(),
        version: validation.skill.metadata.version,
      });
      const installed = await validateSkillDirectory(target, scope === "global" ? "global" : "project");
      if (!installed.skill) {
        await fs.rm(target, { recursive: true, force: true });
        throw new Error(`Installed skill failed validation:\n${installed.errors.join("\n")}`);
      }
      return installed.skill;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(name: string, scope: SkillScope): Promise<boolean> {
    const target = this.targetDirectory(name, scope);
    if (!(await fs.stat(target).catch(() => undefined))) return false;
    await fs.rm(target, { recursive: true, force: true });
    return true;
  }

  async update(name: string, scope: SkillScope): Promise<Skill> {
    const record = await this.readRecord(name, scope);
    if (!record) throw new Error(`No installation record for "${name}"; cannot update automatically.`);
    if (record.sourceType === "git") {
      return this.installFromGit(record.source, scope, { force: true });
    }
    if (record.sourceType === "local") {
      return this.installFromLocal(record.source, scope, { force: true });
    }
    throw new Error(`Skill "${name}" was generated locally and has no upstream source to update from.`);
  }

  async searchRegistry(query: string): Promise<{ configured: boolean; results: RegistrySkill[] }> {
    if (!this.options.registryUrl) return { configured: false, results: [] };
    let url: URL;
    try {
      url = new URL(this.options.registryUrl);
    } catch {
      throw new Error("skills.registryUrl is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("skills.registryUrl must use http(s).");
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json", "User-Agent": "TagCode/0.1" },
    });
    if (!response.ok) throw new Error(`Skill registry returned HTTP ${response.status}`);
    const data = (await response.json()) as { skills?: unknown };
    if (!Array.isArray(data.skills)) throw new Error("Skill registry JSON must contain a 'skills' array.");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: RegistrySkill[] = [];
    for (const item of data.skills) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.name !== "string" || typeof entry.url !== "string") continue;
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
      const description = typeof entry.description === "string" ? entry.description : "";
      const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
      const haystack = `${entry.name} ${description} ${tags.join(" ")}`.toLowerCase();
      if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) continue;
      results.push({
        name: entry.name,
        description,
        url: entry.url,
        version: typeof entry.version === "string" ? entry.version : undefined,
        tags,
      });
    }
    return { configured: true, results: results.slice(0, 30) };
  }
}

async function findSkillRoot(repoRoot: string): Promise<string | undefined> {
  try {
    await fs.access(path.join(repoRoot, "SKILL.md"));
    return repoRoot;
  } catch {
    // Look one level down.
  }
  const entries = await fs.readdir(repoRoot, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(repoRoot, entry.name);
    try {
      await fs.access(path.join(candidate, "SKILL.md"));
      candidates.push(candidate);
    } catch {
      // Not a skill directory.
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
