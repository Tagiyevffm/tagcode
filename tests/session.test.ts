import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionController } from "../src/controller.js";
import { makeTempDir, removeDir } from "./helpers.js";

let home = "";
let previousHome: string | undefined;
let server: http.Server;
let baseUrl = "";
const cleanup: string[] = [];
const controllers: SessionController[] = [];

beforeAll(async () => {
  previousHome = process.env.TAGCODE_HOME;
  home = await makeTempDir("tagcode-controller-home-");
  process.env.TAGCODE_HOME = home;

  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/chat/completions")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from the mock provider." } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 5 },
          })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server failed to listen");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  while (controllers.length > 0) await controllers.pop()!.dispose().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  while (cleanup.length > 0) await removeDir(cleanup.pop()!);
  await removeDir(home);
  if (previousHome === undefined) delete process.env.TAGCODE_HOME;
  else process.env.TAGCODE_HOME = previousHome;
});

async function setupController(inputAnswer = "answer"): Promise<SessionController> {
  const workspace = await makeTempDir();
  cleanup.push(workspace);
  await fs.mkdir(path.join(workspace, ".tagcode"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".tagcode", "config.json"),
    JSON.stringify({
      version: 1,
      defaultProvider: "mock",
      defaultModel: "test-model",
      providers: [
        {
          id: "mock",
          type: "custom",
          name: "Mock provider",
          baseUrl,
          defaultModel: "test-model",
          contextWindow: 32_000,
        },
      ],
      permissions: { mode: "auto" },
      context: { maxTokens: 16_000, maxSteps: 8 },
      mcp: { enabled: false },
      ui: { showReasoning: false, showToolOutput: false },
    }),
    "utf8",
  );
  const controller = new SessionController({
    workspace,
    connectMcp: false,
    loadPlugins: false,
    ui: { confirm: async () => true, requestInput: async () => inputAnswer },
  });
  controllers.push(controller);
  return controller;
}

describe("SessionController integration", () => {
  it("initializes, streams a response, tracks usage and persists the session", async () => {
    const controller = await setupController();
    const report = await controller.initialize();
    expect(report.workspace).toBe(controller.workspace);
    expect(report.provider).toBe("mock");
    expect(report.model).toBe("test-model");

    const events: string[] = [];
    controller.onEvent((event) => events.push(event.type));
    await controller.run("Say hello");

    expect(events).toContain("assistant-delta");
    expect(events).toContain("done");
    const messages = controller.getMessages();
    expect(messages.some((message) => message.role === "user")).toBe(true);
    expect(messages.some((message) => message.role === "assistant" && message.content.includes("mock provider"))).toBe(
      true,
    );
    expect(controller.getUsage()).toEqual({ inputTokens: 8, outputTokens: 5 });

    const sessions = await controller.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(controller.sessionId);

    const status = await controller.executeCommand("/status");
    expect(status.output).toContain("mock");
    expect(status.output).toContain("test-model");
  });

  it("exposes the new provider and diff commands through the registry", async () => {
    const controller = await setupController();
    await controller.initialize();
    const help = await controller.executeCommand("/help");
    for (const command of ["/models", "/disconnect", "/diff", "/changes", "/checkpoint", "/skills", "/mcp"]) {
      expect(help.output).toContain(command);
    }
    const diff = await controller.executeCommand("/diff");
    expect(diff.output).toMatch(/Not a Git repository/);
    const models = await controller.executeCommand("/models");
    expect(models.output).toContain("test-model");
    const model = await controller.executeCommand("/model");
    expect(model.output).toContain("test-model");
    const skills = await controller.executeCommand("/skills reload");
    expect(skills.output).toMatch(/Reloaded/);
    const mcp = await controller.executeCommand("/mcp status");
    expect(mcp.output).toMatch(/No MCP servers/);
  });

  it("sets a model from the interactive picker", async () => {
    const controller = await setupController("1");
    await controller.initialize();
    const result = await controller.executeCommand("/model");
    expect(result.output).toContain("Model set to test-model");
    expect(controller.getModel()).toBe("test-model");
  });

  it("supports sessions, checkpoints, memory and project init", async () => {
    const controller = await setupController();
    await controller.initialize();
    await controller.run("First task");
    const firstId = controller.sessionId;

    const fresh = await controller.newSession();
    expect(fresh.id).not.toBe(firstId);
    const resumed = await controller.loadSession(firstId);
    expect(resumed.messages.length).toBeGreaterThan(0);

    await fs.writeFile(path.join(controller.workspace, "file.txt"), "before", "utf8");
    const checkpoint = await controller.createCheckpoint(
      [path.join(controller.workspace, "file.txt")],
      "test checkpoint",
    );
    expect(checkpoint).toBeTruthy();
    expect((await controller.listCheckpoints())[0]?.reason).toBe("test checkpoint");
    await fs.writeFile(path.join(controller.workspace, "file.txt"), "after", "utf8");
    const restored = await controller.undo();
    expect(restored?.restored).toContain("file.txt");
    expect(await fs.readFile(path.join(controller.workspace, "file.txt"), "utf8")).toBe("before");

    const memory = await controller.executeCommand('/memory add decisions "Use SQLite for storage."');
    expect(memory.output).toContain("decisions.md");

    const init = await controller.initProject();
    expect(init.created.some((entry) => entry.endsWith("AGENTS.md"))).toBe(true);
    expect(await fs.stat(path.join(controller.workspace, "AGENTS.md"))).toBeTruthy();
    const secondInit = await controller.initProject();
    expect(secondInit.agentSkipped).toBe(true);
  });
});
