import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSkillMarkdown, validateSkillDirectory } from "../src/skills/validator.js";
import { SkillLoader } from "../src/skills/loader.js";
import { SkillManager } from "../src/skills/manager.js";
import { SkillInstaller } from "../src/skills/installer.js";
import { makeTempDir, removeDir } from "./helpers.js";

const temporary: string[] = [];
let previousHome: string | undefined;
let home = "";

beforeAll(async () => {
  previousHome = process.env.TAGCODE_HOME;
  home = await makeTempDir("tagcode-skills-home-");
  process.env.TAGCODE_HOME = home;
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.TAGCODE_HOME;
  else process.env.TAGCODE_HOME = previousHome;
  await removeDir(home);
});

afterEach(async () => {
  while (temporary.length > 0) await removeDir(temporary.pop()!);
});

async function temp(): Promise<string> {
  const dir = await makeTempDir();
  temporary.push(dir);
  return dir;
}

const SKILL_MD = `---
name: react-expert
description: Build React dashboards with hooks and accessible components.
version: 1.2.0
---

# React expert

Use this skill when building React dashboards.

## Procedure

1. Inspect the component tree.
2. Keep state local and colocate hooks.
3. Verify with the project test command.

## Checklist

- TypeScript props are explicit.
- Accessibility labels exist.
`;

async function writeSkill(root: string, name: string, body = SKILL_MD): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body.replace(/^name: .+$/m, `name: ${name}`), "utf8");
  return dir;
}

describe("SKILL.md parsing and validation", () => {
  it("parses YAML frontmatter and body", () => {
    const parsed = parseSkillMarkdown(SKILL_MD);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter.name).toBe("react-expert");
    expect(parsed.body).toContain("Use this skill");
  });

  it("reports malformed frontmatter", () => {
    const missing = parseSkillMarkdown("# No frontmatter");
    expect(missing.errors[0]).toMatch(/must start with YAML frontmatter/i);
    const unterminated = parseSkillMarkdown("---\nname: test\n");
    expect(unterminated.errors[0]).toMatch(/closing/i);
  });

  it("recovers frontmatter with an unquoted colon in a description", async () => {
    const markdown = `---
name: website-generator
description: Generate a complete website: multi-file scaffold, assets and docs.
version: 1.0.0
---

# Website generator

Create a complete multi-file website scaffold with pages, styles, scripts
and a README explaining how to run it.
`;
    const parsed = parseSkillMarkdown(markdown);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter.description).toBe(
      "Generate a complete website: multi-file scaffold, assets and docs.",
    );
    expect(parsed.warnings[0]).toMatch(/unquoted ':'/i);

    const project = await temp();
    const dir = path.join(project, "website-generator");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), markdown, "utf8");
    const result = await validateSkillDirectory(dir, "project");
    expect(result.errors).toEqual([]);
    expect(result.skill?.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("unquoted ':'"))).toBe(true);
  });

  it("validates a valid skill directory", async () => {
    const project = await temp();
    const dir = await writeSkill(path.join(project, ".tagcode", "skills"), "react-expert");
    const result = await validateSkillDirectory(dir, "project");
    expect(result.errors).toEqual([]);
    expect(result.skill).toMatchObject({
      name: "react-expert",
      source: "project",
      valid: true,
      metadata: { version: "1.2.0" },
    });
  });

  it("rejects invalid names, missing descriptions and escaping references", async () => {
    const project = await temp();
    const dir = path.join(project, "Bad_Name");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: Bad_Name\ndescription: x\n---\n\nshort\n\nSee references/../../../etc/passwd\n",
      "utf8",
    );
    const result = await validateSkillDirectory(dir, "project");
    expect(result.skill).toBeUndefined();
    expect(result.errors.join("\n")).toMatch(/kebab-case/);
    expect(result.errors.join("\n")).toMatch(/escapes the skill directory/);
  });
});

describe("skill discovery and selection", () => {
  it("discovers project and global skills, preferring project on conflict", async () => {
    const project = await temp();
    await writeSkill(path.join(home, "skills"), "global-only", SKILL_MD);
    await writeSkill(path.join(home, "skills"), "shared", SKILL_MD);
    await writeSkill(path.join(project, ".tagcode", "skills"), "project-only", SKILL_MD);
    await writeSkill(path.join(project, ".tagcode", "skills"), "shared", SKILL_MD);
    const loader = new SkillLoader({ workspace: project, projectRoot: project, home });
    const discovered = await loader.discover();
    const byName = new Map(discovered.map((entry) => [entry.skill.name, entry.skill]));
    expect(byName.get("project-only")?.source).toBe("project");
    expect(byName.get("global-only")?.source).toBe("global");
    expect(byName.get("shared")?.source).toBe("project");
  });

  it("selects relevant skills for a task and enforces the active limit", async () => {
    const project = await temp();
    // Isolate selection from skills left behind by earlier tests.
    await fs.rm(path.join(home, "skills"), { recursive: true, force: true });
    await writeSkill(path.join(project, ".tagcode", "skills"), "react-expert");
    await writeSkill(path.join(project, ".tagcode", "skills"), "python-expert", SKILL_MD.replace("React dashboards", "Python services"));
    const loader = new SkillLoader({ workspace: project, projectRoot: project, home });
    const manager = new SkillManager(loader, { maxActive: 1, autoSelect: true });
    await manager.reload();
    expect(manager.list()).toHaveLength(2);

    const selected = manager.selectForTask("Build a React dashboard with hooks");
    expect(selected.map((skill) => skill.name)).toEqual(["react-expert"]);
    expect(manager.getActiveNames()).toEqual(["react-expert"]);

    manager.deactivate("react-expert");
    expect(manager.getActiveNames()).toEqual([]);
  });

  it("does not activate invalid skills", async () => {
    const project = await temp();
    const dir = await writeSkill(path.join(project, ".tagcode", "skills"), "broken", SKILL_MD);
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: broken\n---\ntoo short\n", "utf8");
    const loader = new SkillLoader({ workspace: project, projectRoot: project, home });
    const manager = new SkillManager(loader, { maxActive: 3, autoSelect: true });
    await manager.reload();
    const skill = manager.get("broken");
    expect(skill?.valid).toBe(false);
    expect(manager.activate("broken")).toBeUndefined();
  });
});

describe("skill installation", () => {
  it("installs a generated skill, rejects duplicates and supports force replacement", async () => {
    const project = await temp();
    const installer = new SkillInstaller({ projectRoot: project, home });
    const installed = await installer.installFromContent(SKILL_MD, "project", { source: "test" });
    expect(installed.name).toBe("react-expert");
    expect(await fs.stat(path.join(project, ".tagcode", "skills", "react-expert", "SKILL.md"))).toBeTruthy();

    await expect(installer.installFromContent(SKILL_MD, "project")).rejects.toThrow(/already installed/);
    const forced = await installer.installFromContent(
      SKILL_MD.replace("1.2.0", "2.0.0"),
      "project",
      { force: true },
    );
    expect(forced.metadata.version).toBe("2.0.0");

    const record = await installer.readRecord("react-expert", "project");
    expect(record?.sourceType).toBe("content");

    expect(await installer.remove("react-expert", "project")).toBe(true);
    expect(await installer.remove("react-expert", "project")).toBe(false);
  });

  it("refuses to install invalid content", async () => {
    const project = await temp();
    const installer = new SkillInstaller({ projectRoot: project, home });
    await expect(installer.installFromContent("no frontmatter", "project")).rejects.toThrow(
      /Invalid|frontmatter/i,
    );
  });

  it("installs from a local directory", async () => {
    const project = await temp();
    const source = await writeSkill(await temp(), "local-skill");
    const installer = new SkillInstaller({ projectRoot: project, home });
    const installed = await installer.installFromLocal(source, "project");
    expect(installed.name).toBe("local-skill");
    expect((await installer.readRecord("local-skill", "project"))?.sourceType).toBe("local");
  });
});

describe("temp path", () => {
  it("uses the OS temp directory", () => {
    expect(os.tmpdir().length).toBeGreaterThan(0);
  });
});
