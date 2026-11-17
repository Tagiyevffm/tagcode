import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Skill, SkillMetadata, SkillSource } from "./types.js";
import { isPathInside } from "../security/paths.js";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_TOTAL_FILES = 2_000;

export type ParsedSkillMarkdown = {
  frontmatter: Record<string, unknown>;
  body: string;
  errors: string[];
  warnings: string[];
};

/**
 * LLM-generated SKILL.md files often contain an unquoted colon in the
 * description. YAML treats that as a nested mapping, which makes the whole
 * frontmatter unusable. Quote such top-level scalar values and parse again.
 */
function repairScalarColons(yamlText: string): { text: string; repaired: string[] } {
  const repaired: string[] = [];
  const lines = yamlText.split("\n").map((line) => {
    const match = /^([A-Za-z0-9_.-]+):[ \t]+(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    const value = match[2]!.trimEnd();
    if (!value || /^["'\[{|>&*!]/.test(value)) return line;
    if (!value.includes(": ") && !value.endsWith(":") && !value.includes(" #")) return line;
    repaired.push(key);
    return `${key}: ${JSON.stringify(value)}`;
  });
  return { text: lines.join("\n"), repaired };
}

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      frontmatter: {},
      body: normalized.trim(),
      errors: ["SKILL.md must start with YAML frontmatter delimited by '---'."],
      warnings,
    };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return {
      frontmatter: {},
      body: "",
      errors: ["SKILL.md frontmatter is missing the closing '---'."],
      warnings,
    };
  }
  const yamlText = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "").trim();
  let frontmatter: Record<string, unknown> = {};
  const parse = (text: string): Record<string, unknown> | undefined => {
    const parsed = YAML.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  };
  try {
    const parsed = parse(yamlText);
    if (parsed) frontmatter = parsed;
    else errors.push("Frontmatter must be a YAML mapping.");
  } catch (error) {
    const repaired = repairScalarColons(yamlText);
    let recovered: Record<string, unknown> | undefined;
    if (repaired.repaired.length > 0) {
      try {
        recovered = parse(repaired.text);
      } catch {
        recovered = undefined;
      }
    }
    if (recovered) {
      frontmatter = recovered;
      warnings.push(
        `Frontmatter used unquoted ':' in ${repaired.repaired.join(", ")}; the value was read as plain text.`,
      );
    } else {
      errors.push(
        `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { frontmatter, body, errors, warnings };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return undefined;
}

export async function validateSkillDirectory(
  directory: string,
  source: SkillSource,
): Promise<{ skill?: Skill; errors: string[]; warnings: string[] }> {
  const root = path.resolve(directory);
  const skillFile = path.join(root, "SKILL.md");
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: string;
  try {
    const stat = await fs.stat(skillFile);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > MAX_SKILL_BYTES) {
      return { errors: [`SKILL.md is larger than ${MAX_SKILL_BYTES} bytes.`], warnings };
    }
    raw = await fs.readFile(skillFile, "utf8");
  } catch {
    return { errors: [`Missing SKILL.md in ${root}`], warnings };
  }

  const parsed = parseSkillMarkdown(raw);
  errors.push(...parsed.errors);
  warnings.push(...parsed.warnings);

  const name = stringValue(parsed.frontmatter.name);
  const description = stringValue(parsed.frontmatter.description);
  if (!name) errors.push("Frontmatter field 'name' is required.");
  else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    errors.push("Skill name must be lowercase kebab-case (a-z, 0-9, '-'), at most 64 characters.");
  }
  if (!description) errors.push("Frontmatter field 'description' is required.");
  else if (description.length > 1024) errors.push("Description must be at most 1024 characters.");
  if (parsed.body.length < 20) errors.push("Skill instructions are empty or too short.");

  if (name && path.basename(root) !== name) {
    warnings.push(`Skill name "${name}" does not match its directory name "${path.basename(root)}".`);
  }

  const metadata: SkillMetadata = {
    name: name ?? path.basename(root),
    description: description ?? "",
    version: stringValue(parsed.frontmatter.version),
    license: stringValue(parsed.frontmatter.license),
    author: stringValue(parsed.frontmatter.author),
    allowedTools: stringArray(parsed.frontmatter["allowed-tools"] ?? parsed.frontmatter.allowedTools),
    tags: stringArray(parsed.frontmatter.tags ?? parsed.frontmatter.keywords),
  };
  if (metadata.version && !/^[0-9A-Za-z.+-]{1,40}$/.test(metadata.version)) {
    warnings.push(`Unusual version string: ${metadata.version}`);
  }

  let entries: Array<{ relative: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }> = [];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    entries = dirents.map((entry) => ({
      relative: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
    if (entries.length > MAX_TOTAL_FILES) {
      errors.push(`Skill directory contains more than ${MAX_TOTAL_FILES} entries.`);
    }
  } catch (error) {
    errors.push(`Cannot read skill directory: ${error instanceof Error ? error.message : String(error)}`);
  }

  const hasScripts = entries.some((entry) => entry.relative === "scripts" && entry.isDirectory);
  const hasReferences = entries.some((entry) => entry.relative === "references" && entry.isDirectory);
  if (hasScripts) {
    warnings.push("This skill includes scripts. TagCode will not execute them automatically.");
  }

  // Validate referenced relative paths stay inside the skill and exist.
  const referencePattern = /\b((?:references|assets|scripts)\/[A-Za-z0-9._\/-]+)/g;
  const seen = new Set<string>();
  for (const match of parsed.body.matchAll(referencePattern)) {
    const reference = match[1]!;
    if (seen.has(reference)) continue;
    seen.add(reference);
    const resolved = path.resolve(root, reference);
    if (!isPathInside(root, resolved)) {
      errors.push(`Referenced path escapes the skill directory: ${reference}`);
      continue;
    }
    try {
      await fs.access(resolved);
    } catch {
      warnings.push(`Referenced file does not exist: ${reference}`);
    }
  }

  if (errors.length > 0) return { errors, warnings };

  return {
    skill: {
      name: metadata.name,
      description: metadata.description,
      instructions: parsed.body,
      directory: root,
      skillFile,
      source,
      metadata,
      hasScripts,
      hasReferences,
      valid: true,
      errors: [],
      warnings,
    },
    errors: [],
    warnings,
  };
}

export function slugifySkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "skill";
}
