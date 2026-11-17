import { promises as fs } from "node:fs";
import path from "node:path";
import type { Skill, SkillSource } from "./types.js";
import { validateSkillDirectory } from "./validator.js";
import { globalSkillsDir, projectSkillsDir } from "../config/paths.js";
import { expandHome } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

export type SkillLoaderOptions = {
  workspace: string;
  projectRoot: string;
  extraDirectories?: string[];
  disabled?: string[];
  home?: string;
};

export type DiscoveredSkill = {
  skill: Skill;
  errors: string[];
  warnings: string[];
};

async function isDirectory(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

/**
 * Discover Skills from project, global and configured directories.
 * Project skills win over global skills with the same name.
 */
export class SkillLoader {
  constructor(private readonly options: SkillLoaderOptions) {}

  directories(): Array<{ directory: string; source: SkillSource }> {
    const roots: Array<{ directory: string; source: SkillSource }> = [
      { directory: projectSkillsDir(this.options.projectRoot), source: "project" },
      { directory: globalSkillsDir(), source: "global" },
    ];
    for (const extra of this.options.extraDirectories ?? []) {
      roots.push({ directory: path.resolve(expandHome(extra)), source: "configured" });
    }
    return roots;
  }

  async discover(): Promise<DiscoveredSkill[]> {
    const disabled = new Set(this.options.disabled ?? []);
    const byName = new Map<string, DiscoveredSkill>();
    const seenDirs = new Set<string>();

    for (const root of this.directories()) {
      if (!(await isDirectory(root.directory))) continue;
      let entries;
      try {
        entries = await fs.readdir(root.directory, { withFileTypes: true });
      } catch (error) {
        logger.warn("skills", `Cannot read skills directory ${root.directory}`, error);
        continue;
      }
      const candidates: Array<{ directory: string; source: SkillSource }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        candidates.push({ directory: path.join(root.directory, entry.name), source: root.source });
      }
      // A directory that is itself a skill.
      if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
        candidates.push({ directory: root.directory, source: root.source });
      }

      for (const candidate of candidates) {
        const resolved = path.resolve(candidate.directory);
        if (seenDirs.has(resolved)) continue;
        seenDirs.add(resolved);
        const result = await validateSkillDirectory(resolved, candidate.source);
        if (!result.skill) {
          logger.warn("skills", `Invalid skill at ${resolved}`, result.errors);
          for (const error of result.errors) {
            byName.set(`invalid:${resolved}`, {
              skill: {
                name: path.basename(resolved),
                description: "Invalid skill",
                instructions: "",
                directory: resolved,
                skillFile: path.join(resolved, "SKILL.md"),
                source: candidate.source,
                metadata: { name: path.basename(resolved), description: "Invalid skill" },
                hasScripts: false,
                hasReferences: false,
                valid: false,
                errors: result.errors,
                warnings: result.warnings,
              },
              errors: result.errors,
              warnings: result.warnings,
            });
          }
          continue;
        }
        if (disabled.has(result.skill.name)) continue;
        const existing = byName.get(result.skill.name);
        if (existing && existing.skill.source === "project" && candidate.source !== "project") continue;
        byName.set(result.skill.name, {
          skill: result.skill,
          errors: result.errors,
          warnings: result.warnings,
        });
      }
    }

    return [...byName.values()].sort((a, b) => {
      if (a.skill.valid !== b.skill.valid) return a.skill.valid ? -1 : 1;
      return a.skill.name.localeCompare(b.skill.name);
    });
  }
}
