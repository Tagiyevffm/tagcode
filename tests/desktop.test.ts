import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SessionController } from "../src/controller.js";
import { startDesktopServer, type DesktopServer } from "../src/desktop/server.js";
import type { UpdateInfo } from "../src/update/checker.js";
import { makeTempDir, removeDir } from "./helpers.js";

describe("desktop server", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()!();
  });

  async function start(options: { updateChecker?: () => Promise<UpdateInfo> } = {}): Promise<{
    server: DesktopServer;
    controller: SessionController;
    workspace: string;
    home: string;
  }> {
    const workspace = await makeTempDir("tagcode-desktop-ws-");
    const home = await makeTempDir("tagcode-desktop-home-");
    const controller = new SessionController({
      workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    await controller.initialize();
    const server = await startDesktopServer({
      controller,
      idleTimeoutMs: 0,
      ...(options.updateChecker ? { updateChecker: options.updateChecker } : {}),
    });
    cleanup.push(async () => {
      await server.close();
      await removeDir(workspace);
      await removeDir(home);
    });
    return { server, controller, workspace, home };
  }

  it("serves the app shell with an injected token and version", async () => {
    const { server } = await start();
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("TagCode");
    expect(html).toContain(`content="${server.token}"`);
    expect(html).not.toContain("__TAGCODE_TOKEN__");
    expect(html).not.toContain("__TAGCODE_VERSION__");
  });

  it("requires the token for API calls", async () => {
    const { server } = await start();
    const denied = await fetch(new URL("/api/state", server.url));
    expect(denied.status).toBe(401);

    const allowed = await fetch(new URL("/api/state", server.url), {
      headers: { "x-tagcode-token": server.token },
    });
    expect(allowed.status).toBe(200);
    const state = (await allowed.json()) as {
      workspace: string;
      messages: unknown[];
      mode: string;
    };
    expect(state.workspace).toBe(server.controller.workspace);
    expect(Array.isArray(state.messages)).toBe(true);
    expect(state.mode).toBe("agent");
  });

  it("serves static assets and rejects unknown files", async () => {
    const { server } = await start();
    const script = await fetch(new URL("/app.js", server.url));
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("EventSource");

    const missing = await fetch(new URL("/missing-file.js", server.url));
    expect(missing.status).toBe(404);
  });

  it("executes slash commands through the API", async () => {
    const { server } = await start();
    const response = await fetch(new URL("/api/command", server.url), {
      method: "POST",
      headers: { "x-tagcode-token": server.token, "Content-Type": "application/json" },
      body: JSON.stringify({ line: "/help" }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { output?: string };
    expect(result.output).toContain("/help");
  });

  it("streams SSE events to the renderer", async () => {
    const { server } = await start();
    const first = await new Promise<string>((resolve, reject) => {
      const request = http.get(
        new URL(`/api/events?token=${encodeURIComponent(server.token)}`, server.url),
        (response) => {
          let buffer = "";
          response.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("connected")) {
              request.destroy();
              resolve(buffer);
            }
          });
        },
      );
      request.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      setTimeout(() => {
        request.destroy();
        reject(new Error("timed out waiting for SSE"));
      }, 5000).unref();
    });
    expect(first).toContain("connected");
  });

  it("resets the conversation for a new session", async () => {
    const { server } = await start();
    const response = await fetch(new URL("/api/session/new", server.url), {
      method: "POST",
      headers: { "x-tagcode-token": server.token, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { state: { messages: unknown[] } };
    expect(body.state.messages).toEqual([]);
    const sessions = await fs.readdir(path.join(server.controller.workspace, ".tagcode", "sessions")).catch(() => []);
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("exposes MCP and skill inspection endpoints", async () => {
    const { server } = await start();
    const headers = { "x-tagcode-token": server.token };

    const mcp = await fetch(new URL("/api/mcp", server.url), { headers });
    expect(mcp.status).toBe(200);
    expect((await mcp.json()) as { servers: unknown[] }).toEqual({ servers: [] });

    const skills = await fetch(new URL("/api/skills", server.url), { headers });
    expect(skills.status).toBe(200);
    expect(Array.isArray(((await skills.json()) as { skills: unknown[] }).skills)).toBe(true);

    const missing = await fetch(new URL("/api/skills/detail?name=missing", server.url), { headers });
    expect(missing.status).toBe(404);

    const invalid = await fetch(new URL("/api/mcp/add", server.url), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "broken", transport: "stdio" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("serves MCP and skill catalogs and installs a catalog skill", async () => {
    const { server } = await start();
    const headers = { "x-tagcode-token": server.token };

    const mcpCatalog = await fetch(new URL("/api/mcp/catalog", server.url), { headers });
    expect(mcpCatalog.status).toBe(200);
    const mcpBody = (await mcpCatalog.json()) as {
      templates: Array<{ id: string; command?: string; installed: boolean }>;
      workspace: string;
    };
    expect(mcpBody.templates.some((template) => template.id === "filesystem")).toBe(true);
    expect(mcpBody.templates.every((template) => template.installed === false)).toBe(true);
    expect(mcpBody.workspace).toBe(server.controller.workspace);

    const skillCatalog = await fetch(new URL("/api/skills/catalog", server.url), { headers });
    expect(skillCatalog.status).toBe(200);
    const skillBody = (await skillCatalog.json()) as {
      skills: Array<{ id: string; instructions: string; installed: boolean }>;
    };
    const review = skillBody.skills.find((entry) => entry.id === "code-review");
    expect(review?.installed).toBe(false);
    expect(review?.instructions).toContain("# Code Review");

    const unknownTemplate = await fetch(new URL("/api/mcp/install", server.url), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ template: "not-real", inputs: {} }),
    });
    expect(unknownTemplate.status).toBe(400);

    const installed = await fetch(new URL("/api/skills/action", server.url), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "install-catalog", catalog: "code-review", scope: "project" }),
    });
    expect(installed.status).toBe(200);
    const installedBody = (await installed.json()) as {
      skill: string;
      state: { skills: Array<{ name: string; valid: boolean }> };
    };
    expect(installedBody.skill).toBe("code-review");
    expect(installedBody.state.skills.some((skill) => skill.name === "code-review" && skill.valid)).toBe(true);

    const duplicate = await fetch(new URL("/api/skills/action", server.url), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "install-catalog", catalog: "code-review", scope: "project" }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("reports update status without hitting the network in tests", async () => {
    const checkedAt = new Date().toISOString();
    const { server } = await start({
      updateChecker: async () => ({
        currentVersion: "0.1.0",
        latestVersion: "9.9.9",
        updateAvailable: true,
        checkedAt,
        packageUrl: "https://www.npmjs.com/package/tagcode",
        installCommand: "npm install -g tagcode@latest",
      }),
    });
    const response = await fetch(new URL("/api/update", server.url), {
      headers: { "x-tagcode-token": server.token },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { latestVersion: string; updateAvailable: boolean };
    expect(body.latestVersion).toBe("9.9.9");
    expect(body.updateAvailable).toBe(true);

    const denied = await fetch(new URL("/api/update", server.url));
    expect(denied.status).toBe(401);
  });

  it("installs a local skill and returns its instructions", async () => {
    const { server } = await start();
    const source = path.join(server.controller.workspace, "source-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      [
        "---",
        "name: local-review",
        "description: Review local changes for correctness.",
        "---",
        "",
        "# Local Review",
        "",
        "Inspect the diff before making changes.",
      ].join("\n"),
      "utf8",
    );

    const response = await fetch(new URL("/api/skills/action", server.url), {
      method: "POST",
      headers: { "x-tagcode-token": server.token, "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "install",
        sourceType: "local",
        source,
        scope: "project",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skill: string; state: { skills: Array<{ name: string }> } };
    expect(body.skill).toBe("local-review");
    expect(body.state.skills.some((skill) => skill.name === "local-review")).toBe(true);

    const detail = await fetch(new URL("/api/skills/detail?name=local-review", server.url), {
      headers: { "x-tagcode-token": server.token },
    });
    expect(detail.status).toBe(200);
    const instructions = (await detail.json()) as { instructions: string };
    expect(instructions.instructions).toContain("Inspect the diff");
  });
});
