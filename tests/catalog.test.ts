import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, removeDir } from "./helpers.js";
import { MCP_CATALOG, getMcpCatalogTemplate, resolveMcpCatalogTemplate } from "../src/mcp/catalog.js";
import { SKILL_CATALOG, getSkillCatalogEntry } from "../src/skills/catalog.js";
import { validateSkillDirectory } from "../src/skills/validator.js";
import { checkForUpdate, compareVersions } from "../src/update/checker.js";

describe("catalog", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()!();
  });

  it("compares semver versions including prereleases", () => {
    expect(compareVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("not-a-version", "1.0.0")).toBe(-1);
  });

  it("checks the npm registry and returns a non-throwing result on failure", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: "9.9.9" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const available = await checkForUpdate({
      currentVersion: "0.1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(available.latestVersion).toBe("9.9.9");
    expect(available.updateAvailable).toBe(true);
    expect(available.installCommand).toContain("tagcode@latest");

    const failing = await checkForUpdate({
      currentVersion: "0.1.0",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    expect(failing.updateAvailable).toBe(false);
    expect(failing.error).toContain("503");
  });

  it("resolves MCP templates with workspace defaults and validates required inputs", () => {
    const workspace = path.resolve("C:/project/example");
    expect(getMcpCatalogTemplate("missing")).toBeUndefined();
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(8);

    const filesystem = getMcpCatalogTemplate("filesystem")!;
    const resolved = resolveMcpCatalogTemplate(filesystem, {}, workspace);
    expect(resolved.name).toBe("filesystem");
    expect(resolved.server.type).toBe("stdio");
    expect(resolved.server.args).toContain(workspace);
    expect(resolved.server.permission).toBe("write");

    const github = getMcpCatalogTemplate("github")!;
    expect(() => resolveMcpCatalogTemplate(github, {}, workspace)).toThrow(/token/i);
    const githubResolved = resolveMcpCatalogTemplate(github, { token: "github_pat_test" }, workspace);
    expect(githubResolved.server.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("github_pat_test");
    expect(githubResolved.server.args).not.toContain("{{token}}");
  });

  it("ships valid built-in skills with unique names", async () => {
    const names = new Set<string>();
    for (const entry of SKILL_CATALOG) {
      expect(entry.name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(names.has(entry.name)).toBe(false);
      names.add(entry.name);
      expect(getSkillCatalogEntry(entry.id)?.name).toBe(entry.name);

      const directory = await makeTempDir("tagcode-catalog-skill-");
      cleanup.push(() => removeDir(directory));
      await fs.writeFile(path.join(directory, "SKILL.md"), entry.markdown, "utf8");
      const validation = await validateSkillDirectory(directory, "configured");
      expect(validation.errors).toEqual([]);
      expect(validation.skill?.description).toBeTruthy();
      expect(validation.skill?.instructions.length).toBeGreaterThan(100);
    }
  });
});
