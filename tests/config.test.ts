import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, readConfigFile, updateConfigFile, writeConfigFile } from "../src/config/config.js";
import { resolveConfig, ConfigFileSchema } from "../src/config/schema.js";
import { SecretStore } from "../src/config/secrets.js";
import { SessionStore } from "../src/sessions/store.js";
import { createMemoryBundle } from "../src/memory/store.js";
import { makeTempDir, removeDir } from "./helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  while (temporary.length > 0) await removeDir(temporary.pop()!);
});

async function temp(): Promise<string> {
  const dir = await makeTempDir();
  temporary.push(dir);
  return dir;
}

describe("configuration layering", () => {
  it("merges global and project config with project precedence", () => {
    const resolved = resolveConfig([
      {
        version: 1,
        defaultProvider: "global-provider",
        providers: [
          { id: "shared", type: "openai", defaultModel: "global-model" },
          { id: "global-provider", type: "openai" },
        ],
        permissions: { mode: "ask", allow: ["read_file"], deny: ["rm_*"] },
        context: { maxSteps: 10 },
      },
      {
        version: 1,
        defaultProvider: "project-provider",
        defaultModel: "project-model",
        providers: [
          { id: "shared", type: "openrouter", defaultModel: "project-model" },
          { id: "project-provider", type: "ollama" },
        ],
        permissions: { mode: "auto", allow: ["write_*"] },
        context: { maxSteps: 20 },
      },
    ]);
    expect(resolved.defaultProvider).toBe("project-provider");
    expect(resolved.defaultModel).toBe("project-model");
    expect(resolved.providers.find((provider) => provider.id === "shared")).toMatchObject({
      type: "openrouter",
      defaultModel: "project-model",
    });
    expect(resolved.permissions.mode).toBe("auto");
    expect(resolved.permissions.allow).toEqual(["read_file", "write_*"]);
    expect(resolved.permissions.deny).toEqual(["rm_*"]);
    expect(resolved.context.maxSteps).toBe(20);
  });

  it("rejects invalid configuration files", async () => {
    const dir = await temp();
    const file = path.join(dir, "config.json");
    await fs.writeFile(file, JSON.stringify({ providers: [{ id: "bad id!", type: "nope" }] }), "utf8");
    await expect(readConfigFile(file)).rejects.toThrow(/Invalid TagCode config/);
  });

  it("writes and updates config atomically", async () => {
    const dir = await temp();
    const file = path.join(dir, "config.json");
    await writeConfigFile(file, { version: 1, defaultModel: "a" });
    await updateConfigFile(file, (current) => ({ ...current, defaultModel: "b" }));
    const parsed = ConfigFileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    expect(parsed.defaultModel).toBe("b");
  });

  it("loads global and project files from disk", async () => {
    const home = await temp();
    const workspace = await temp();
    const previousHome = process.env.TAGCODE_HOME;
    process.env.TAGCODE_HOME = home;
    try {
      await fs.mkdir(path.join(workspace, ".tagcode"), { recursive: true });
      await fs.writeFile(
        path.join(home, "config.json"),
        JSON.stringify({ version: 1, defaultModel: "global", permissions: { mode: "ask" } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspace, ".tagcode", "config.json"),
        JSON.stringify({ version: 1, defaultModel: "project" }),
        "utf8",
      );
      const loaded = await loadConfig(workspace);
      expect(loaded.projectRoot).toBe(workspace);
      expect(loaded.config.defaultModel).toBe("project");
      expect(loaded.config.permissions.mode).toBe("ask");
    } finally {
      if (previousHome === undefined) delete process.env.TAGCODE_HOME;
      else process.env.TAGCODE_HOME = previousHome;
    }
  });
});

describe("SecretStore", () => {
  it("stores secrets in the fallback file and removes them", async () => {
    const home = await temp();
    const store = new SecretStore({ home, backend: "file", env: {} });
    expect(await store.get("openai")).toBeUndefined();
    expect(await store.set("openai", "sk-secret-value-123")).toBe("file");
    expect(await store.get("openai")).toBe("sk-secret-value-123");
    expect(await store.storedProviders()).toEqual(["openai"]);

    const raw = await fs.readFile(path.join(home, "auth.json"), "utf8");
    expect(raw).toContain("sk-secret-value-123");

    await store.remove("openai");
    expect(await store.get("openai")).toBeUndefined();
  });

  it("prefers environment variables over stored values", async () => {
    const home = await temp();
    const store = new SecretStore({
      home,
      backend: "file",
      env: { OPENAI_API_KEY: "from-env", TAGCODE_OPENAI_API_KEY: "generic-env" },
    });
    await store.set("openai", "stored");
    expect(await store.get("openai", "OPENAI_API_KEY")).toBe("from-env");
    expect(await store.get("openai")).toBe("generic-env");
  });

  it("describes the active backend", async () => {
    const home = await temp();
    const store = new SecretStore({ home, backend: "file", env: {} });
    const description = await store.describe();
    expect(description.backend).toBe("file");
    expect(description.filePath).toBe(path.join(home, "auth.json"));
  });
});

describe("SessionStore", () => {
  it("creates, saves, lists, renames, exports and deletes sessions", async () => {
    const dir = await temp();
    const store = new SessionStore(dir);
    const session = store.create({
      cwd: process.cwd(),
      projectRoot: "/project/app",
      provider: "mock",
      model: "test-model",
      permissionMode: "auto",
    });
    session.messages.push({ role: "user", content: "Build a feature" });
    session.messages.push({ role: "assistant", content: "Done." });
    await store.save(session);

    expect(await store.exists(session.id)).toBe(true);
    const loaded = await store.load(session.id);
    expect(loaded.title).toBe("Build a feature");

    const list = await store.list({ projectRoot: "/project/app" });
    expect(list).toHaveLength(1);
    expect(list[0]?.messageCount).toBe(2);

    await store.rename(session.id, "Renamed session");
    expect((await store.load(session.id)).title).toBe("Renamed session");

    const markdown = await store.export(session.id);
    expect(markdown).toContain("# Renamed session");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("## Assistant");

    await store.delete(session.id);
    expect(await store.exists(session.id)).toBe(false);
    await expect(store.load(session.id)).rejects.toThrow(/not found/i);
  });

  it("rejects path traversal in session ids", async () => {
    const dir = await temp();
    const store = new SessionStore(dir);
    await expect(store.load("../config")).rejects.toThrow(/Invalid session id/);
  });
});

describe("memory store", () => {
  it("appends, searches, redacts secrets and clears project memory", async () => {
    const projectDir = await temp();
    const globalDir = await temp();
    const bundle = createMemoryBundle({ projectDir, globalDir });
    const file = await bundle.project.append("architecture", "The API uses Fastify and SQLite.");
    expect(file).toContain("architecture.md");
    await expect(
      bundle.project.append("conventions", "Use tabs. token=supersecret12345"),
    ).rejects.toThrow(/secret/i);
    await bundle.project.append("conventions", "Use tabs and explicit types.");
    const results = await bundle.project.search("Fastify", 5);
    expect(results.join("\n")).toContain("Fastify");
    const all = await bundle.project.readAll();
    expect(all).not.toContain("supersecret12345");
    const removed = await bundle.project.clear();
    expect(removed.length).toBeGreaterThan(0);
    expect(await bundle.project.readAll()).toBe("");
  });
});
