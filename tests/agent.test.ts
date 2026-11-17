import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { AgentOrchestrator } from "../src/agent/orchestrator.js";
import { PermissionManager } from "../src/agent/permissions.js";
import { ContextManager } from "../src/context/manager.js";
import { SecretStore } from "../src/config/secrets.js";
import { WorkspacePaths } from "../src/security/paths.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool, fail, ok } from "../src/tools/types.js";
import type {
  AgentEvent,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  StreamEvent,
} from "../src/core/types.js";
import { makeTempDir, removeDir, testConfig } from "./helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  while (temporary.length > 0) await removeDir(temporary.pop()!);
});

type Script = StreamEvent[] | ((request: ChatRequest, call: number) => StreamEvent[]);

class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly name = "Scripted";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: false,
    structuredOutput: false,
    reasoning: true,
    modelListing: false,
  };
  readonly requests: ChatRequest[] = [];
  private call = 0;

  constructor(private readonly script: (request: ChatRequest, call: number) => StreamEvent[]) {}

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request);
    const events = this.script(request, this.call++);
    for (const event of events) {
      if (request.signal?.aborted) throw new Error("aborted");
      yield event;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

function toolCall(name: string, args: unknown): StreamEvent {
  return { type: "tool-call", call: { id: `call_${name}_${Math.random()}`, name, arguments: JSON.stringify(args) } };
}

async function buildAgent(options: {
  workspace: string;
  provider: Provider;
  mode?: "agent" | "plan" | "ask";
  maxSteps?: number;
  registerWrite?: boolean;
  executed?: string[];
  events?: AgentEvent[];
}) {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: "echo",
      description: "Echo text back",
      permission: "read",
      parameters: z.object({ text: z.string() }),
      execute: async (input) => {
        options.executed?.push(`echo:${input.text}`);
        return ok(`echo:${input.text}`);
      },
    }),
  );
  registry.register(
    defineTool({
      name: "write_file",
      description: "Write a file",
      permission: "write",
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: async (input) => {
        options.executed?.push(`write:${input.path}`);
        return ok(`wrote ${input.path}`);
      },
    }),
  );
  if (options.registerWrite === false) registry.unregister("write_file");

  const home = await makeTempDir("tagcode-agent-home-");
  temporary.push(home);
  const config = testConfig();
  config.context.maxSteps = options.maxSteps ?? 6;
  const mode = options.mode ?? "agent";
  const permissions = new PermissionManager(
    { ...config, permissions: { ...config.permissions, mode: mode === "plan" ? "plan" : "auto" } },
    { auditHome: home },
  );
  const context = new ContextManager({
    provider: options.provider,
    model: "test-model",
    budget: 200_000,
    compactAt: 0.92,
    keepRecentMessages: 4,
  });
  const events = options.events ?? [];
  const agent = new AgentOrchestrator({
    provider: options.provider,
    model: "test-model",
    registry,
    config,
    workspace: options.workspace,
    projectRoot: options.workspace,
    paths: await WorkspacePaths.create(options.workspace),
    permissions,
    secrets: new SecretStore({ home, backend: "file" }),
    sessionId: "ses_test",
    mode,
    context,
    systemPrompt: () => "You are TagCode.",
    emit: (event) => events.push(event),
    maxSteps: options.maxSteps,
  });
  return { agent, events, registry };
}

describe("AgentOrchestrator", () => {
  it("executes tool calls and continues the loop until the model stops", async () => {
    const workspace = await makeTempDir();
    temporary.push(workspace);
    const executed: string[] = [];
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider((_request, call) => {
      if (call === 0) {
        return [toolCall("echo", { text: "hi" }), { type: "finish", reason: "tool_calls" }];
      }
      return [
        { type: "text-delta", text: "All done." },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
        { type: "finish", reason: "stop" },
      ];
    });
    const { agent, events: captured } = await buildAgent({ workspace, provider, executed, events });

    await agent.run("say hi");

    expect(executed).toEqual(["echo:hi"]);
    const messages = agent.getMessages();
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "echo" }] });
    expect(messages[2]).toMatchObject({ role: "tool", content: "echo:hi", isError: false });
    expect(messages[3]).toMatchObject({ role: "assistant", content: "All done." });
    expect(captured).toContainEqual({ type: "done", reason: "completed" });
    expect(captured).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 2 }, cumulative: { inputTokens: 10, outputTokens: 2 } });
  });

  it("feeds tool errors back to the model and recovers", async () => {
    const workspace = await makeTempDir();
    temporary.push(workspace);
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider((_request, call) => {
      if (call === 0) {
        return [
          { type: "tool-call", call: { id: "bad", name: "missing_tool", arguments: "{}" } },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text-delta", text: "Recovered." },
        { type: "finish", reason: "stop" },
      ];
    });
    const { agent, events: captured } = await buildAgent({ workspace, provider, events });

    await agent.run("try something");

    const toolMessage = agent.getMessages().find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({ role: "tool", isError: true });
    expect(toolMessage?.content).toContain("Unknown tool");
    expect(captured).toContainEqual({ type: "done", reason: "completed" });
  });

  it("stops at the maximum step count", async () => {
    const workspace = await makeTempDir();
    temporary.push(workspace);
    const provider = new ScriptedProvider(() => [
      toolCall("echo", { text: "again" }),
      { type: "finish", reason: "tool_calls" },
    ]);
    const { agent, events } = await buildAgent({ workspace, provider, maxSteps: 2 });

    await agent.run("loop forever");

    expect(events).toContainEqual({ type: "done", reason: "max-steps" });
    expect(events.some((event) => event.type === "notice" && /maximum of 2 agent steps/.test(event.text))).toBe(
      true,
    );
  });

  it("cancels an in-flight run", async () => {
    const workspace = await makeTempDir();
    temporary.push(workspace);
    const events: AgentEvent[] = [];
    const provider: Provider = {
      id: "hanging",
      name: "Hanging",
      capabilities: {
        streaming: true,
        toolCalling: false,
        vision: false,
        structuredOutput: false,
        reasoning: false,
        modelListing: false,
      },
      async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "working" };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "stop" };
      },
      async listModels() {
        return [];
      },
    };
    const { agent } = await buildAgent({ workspace, provider, events });

    const run = agent.run("long task");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(agent.isRunning()).toBe(true);
    agent.cancel();
    await run;

    expect(events).toContainEqual({ type: "notice", level: "warn", text: "Cancelled." });
    expect(events).toContainEqual({ type: "done", reason: "cancelled" });
  });

  it("only exposes read tools in plan mode", async () => {
    const workspace = await makeTempDir();
    temporary.push(workspace);
    const provider = new ScriptedProvider(() => [
      { type: "text-delta", text: "Plan ready." },
      { type: "finish", reason: "stop" },
    ]);
    const { agent } = await buildAgent({ workspace, provider, mode: "plan" });

    await agent.run("plan the work");

    const names = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("echo");
    expect(names).not.toContain("write_file");
  });

  it("denies write tools that need approval without a broker", async () => {
    const workspace = await makeTempDir();
    temporary.push(workspace);
    const executed: string[] = [];
    const provider = new ScriptedProvider((_request, call) => {
      if (call === 0) {
        return [toolCall("write_file", { path: "a.txt", content: "x" }), { type: "finish", reason: "tool_calls" }];
      }
      return [
        { type: "text-delta", text: "Could not write." },
        { type: "finish", reason: "stop" },
      ];
    });
    const { agent } = await buildAgent({ workspace, provider, executed });
    // Switch the real permission manager to ask mode for this run.
    const manager = (agent as unknown as { options: { permissions: PermissionManager } }).options.permissions;
    manager.setMode("ask");

    await agent.run("write a file");

    expect(executed).toEqual([]);
    const toolMessage = agent.getMessages().find((message) => message.role === "tool");
    expect(toolMessage?.content).toMatch(/Permission denied/i);
  });
});
