import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider } from "../core/types.js";
import { ensureDir } from "../utils/fs.js";
import { validateSkillDirectory } from "./validator.js";
import { redactSecrets } from "../security/redact.js";

export type SkillCreationInput = {
  description: string;
  projectSummary?: string;
  conventions?: string;
  sessionTranscript?: string;
};

export type SkillCreationResult = {
  markdown: string;
  name?: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
};

const SYSTEM_PROMPT = `You create reusable Agent Skills for TagCode.

Output ONLY a complete SKILL.md file. It must start with YAML frontmatter:

---
name: kebab-case-name
description: One or two sentences describing what the skill does and when to use it.
---

Then write concise, actionable instructions in Markdown. Include:
- When to use this skill
- A step-by-step procedure
- Project conventions and pitfalls to check
- A verification checklist
- Only reference files under references/, scripts/ or assets/ if you are certain they exist; otherwise do not mention them.

Rules:
- The name must be lowercase kebab-case and at most 64 characters.
- The description must be at most 1024 characters and must say when the skill applies.
- Never include API keys, passwords, tokens or other secrets.
- Do not wrap the SKILL.md in a code fence.
- Do not invent facts about the project that are not in the provided context.
- Keep the file under 400 lines.`;

function extractMarkdown(text: string): string {
  const fenced = /```(?:markdown|md)?\s*\n([\s\S]*?)```/i.exec(text.trim());
  const candidate = (fenced?.[1] ?? text).trim();
  return candidate.replace(/^\uFEFF/, "");
}

async function validateMarkdown(markdown: string): Promise<{
  name?: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const dir = path.join(os.tmpdir(), "tagcode-skills", `validate-${randomUUID()}`);
  await ensureDir(dir);
  try {
    await fs.writeFile(path.join(dir, "SKILL.md"), markdown, "utf8");
    const result = await validateSkillDirectory(dir, "configured");
    return {
      name: result.skill?.name,
      valid: Boolean(result.skill),
      errors: result.errors,
      warnings: result.warnings,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateSkillMarkdown(options: {
  provider: Provider;
  model: string;
  input: SkillCreationInput;
  signal: AbortSignal;
}): Promise<SkillCreationResult> {
  const contextParts: string[] = [];
  if (options.input.projectSummary) {
    contextParts.push(`## Project context\n${options.input.projectSummary.slice(0, 8000)}`);
  }
  if (options.input.conventions) {
    contextParts.push(`## Existing conventions\n${options.input.conventions.slice(0, 8000)}`);
  }
  if (options.input.sessionTranscript) {
    contextParts.push(`## Relevant session history\n${options.input.sessionTranscript.slice(0, 16_000)}`);
  }
  const userPrompt = [
    "Create a Skill based on this description:",
    options.input.description,
    "",
    ...contextParts,
  ].join("\n");

  let markdown = "";
  let validation: { name?: string; valid: boolean; errors: string[]; warnings: string[] } = {
    valid: false,
    errors: [],
    warnings: [],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const failureNote =
      attempt === 0
        ? ""
        : `\n\nYour previous output failed validation with these errors:\n${validation.errors.join("\n")}\nFix them and return the complete corrected SKILL.md.`;
    let output = "";
    for await (const event of options.provider.stream({
      model: options.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt + failureNote }],
      maxTokens: 3000,
      temperature: 0.2,
      signal: options.signal,
    })) {
      if (event.type === "text-delta") output += event.text;
    }
    markdown = extractMarkdown(output);
    if (!markdown.trim()) {
      validation = { valid: false, errors: ["The model returned an empty response."], warnings: [] };
      continue;
    }
    if (redactSecrets(markdown) !== markdown) {
      validation = {
        valid: false,
        errors: ["The generated skill contains something that looks like a secret."],
        warnings: [],
      };
      continue;
    }
    validation = await validateMarkdown(markdown);
    if (validation.valid) break;
  }

  return {
    markdown,
    name: validation.name,
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

export async function validateGeneratedSkill(markdown: string): Promise<{
  name?: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  return validateMarkdown(markdown);
}
