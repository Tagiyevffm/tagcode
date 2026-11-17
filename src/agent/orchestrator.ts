import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  ImagePart,
  PlanStep,
  Provider,
  SessionPlan,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../core/types.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { SecretStore } from "../config/secrets.js";
import type { WorkspacePaths } from "../security/paths.js";
import type { PermissionManager } from "./permissions.js";
import type { AnyTool, PlanController, ToolCheckpoints, ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ContextManager } from "../context/manager.js";
import type { ContextStats } from "../tools/types.js";
import type { SkillManager } from "../skills/manager.js";
import type { PluginHookName, PluginHookPayloads } from "../plugins/types.js";
import { CancelledError, toError } from "../core/errors.js";
import { logger } from "../utils/logger.js";

export type AgentMemoryAdapter = {
  search(query: string, limit?: number): Promise<string[]>;
  append(section: string, text: string): Promise<void>;
};

export type AgentHooks = {
  runHook<K extends PluginHookName>(
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<PluginHookPayloads[K]>;
};

export type AgentOrchestratorOptions = {
  provider: Provider;
  model: string;
  registry: ToolRegistry;
  config: ResolvedConfig;
  workspace: string;
  projectRoot: string;
  paths: WorkspacePaths;
  permissions: PermissionManager;
  secrets: SecretStore;
  sessionId: string;
  mode: AgentMode;
  context: ContextManager;
  /** Rebuilt before every model request so plan/skill changes are reflected. */
  systemPrompt: () => string | Promise<string>;
  emit: (event: AgentEvent) => void;
  planController?: PlanController;
  hooks?: AgentHooks;
  skills?: SkillManager;
  memory?: AgentMemoryAdapter;
  checkpoints?: ToolCheckpoints;
  requestUserInput?: (question: string, options?: string[]) => Promise<string>;
  maxSteps?: number;
  initialMessages?: ChatMessage[];
  usage?: TokenUsage;
};

const RETRYABLE_ATTEMPTS = 2;
const RETRY_DELAY_MS = 700;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function parseArguments(raw: string): { value: unknown; valid: boolean } {
  try {
    return { value: JSON.parse(raw || "{}"), valid: true };
  } catch {
    return { value: raw, valid: false };
  }
}

type StreamResult = {
  text: string;
  reasoning: string;
  calls: ToolCall[];
  finish: Extract<StreamEvent, { type: "finish" }>["reason"];
  produced: boolean;
};

/**
 * The agent loop: stream one model turn, execute tool calls through the
 * permission-checked registry, append results, and repeat until the model
 * stops or the step limit is reached.
 */
export class AgentOrchestrator {
  private readonly options: AgentOrchestratorOptions;
  private messages: ChatMessage[];
  private usage: TokenUsage;
  private mode: AgentMode;
  private readonly planController: PlanController;
  private abortController?: AbortController;
  private running = false;
  private lastSystem = "";
  private lastTools: ToolDefinition[] = [];

  constructor(options: AgentOrchestratorOptions) {
    this.options = options;
    this.messages = [...(options.initialMessages ?? [])];
    this.usage = { ...(options.usage ?? { inputTokens: 0, outputTokens: 0 }) };
    this.mode = options.mode;
    this.planController =
      options.planController ??
      (() => {
        let plan: SessionPlan | undefined;
        return {
          get: () => plan,
          set: (next: SessionPlan) => {
            plan = next;
          },
          updateSteps: (steps: PlanStep[]) => {
            if (plan) plan = { ...plan, steps };
          },
        };
      })();
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  /** Current context estimate, including system prompt and tool definitions. */
  getContextStats(): ContextStats {
    return this.options.context.stats(this.messages, this.lastSystem, this.lastTools, this.usage);
  }

  getMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
  }

  getPlan(): SessionPlan | undefined {
    return this.planController.get();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Abort the active model turn or tool call. */
  cancel(): void {
    this.abortController?.abort();
  }

  setMessages(messages: ChatMessage[], usage?: TokenUsage): void {
    this.messages = [...messages];
    if (usage) this.usage = { ...usage };
  }

  clear(): void {
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0 };
  }

  /** Force a compaction pass and report before/after message counts. */
  async compactNow(signal?: AbortSignal): Promise<{ before: number; after: number }> {
    const before = this.messages.length;
    const system = await this.options.systemPrompt();
    this.lastSystem = system;
    this.lastTools = this.toolDefinitions();
    this.messages = await this.options.context.compact(this.messages, {
      system,
      tools: this.lastTools,
      signal: signal ?? new AbortController().signal,
      notify: (message) => this.options.emit({ type: "notice", level: "info", text: message }),
    });
    return { before, after: this.messages.length };
  }

  /**
   * Add a user message and run the agent loop until it completes. Throws if a
   * run is already active; errors inside the loop are reported as events.
   */
  async run(userText: string, options: { images?: ImagePart[] } = {}): Promise<void> {
    if (this.running) throw new Error("The agent is already running. Cancel it before sending another message.");
    this.running = true;
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;

    try {
      let text = userText;
      if (this.options.hooks) {
        const hooked = await this.options.hooks.runHook("before_prompt", {
          text,
          sessionId: this.options.sessionId,
        });
        text = hooked.text;
      }

      this.messages.push({
        role: "user",
        content: text,
        ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
      });
      this.options.skills?.selectForTask(text);

      await this.loop(signal);
    } catch (error) {
      if (signal.aborted || error instanceof CancelledError) {
        this.options.emit({ type: "notice", level: "warn", text: "Cancelled." });
        this.options.emit({ type: "done", reason: "cancelled" });
      } else {
        const message = toError(error).message;
        logger.error("agent", "agent loop failed", message);
        this.options.emit({ type: "error", message });
        this.options.emit({ type: "done", reason: "error" });
      }
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
      this.running = false;
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const maxSteps = this.options.maxSteps ?? this.options.config.context.maxSteps;
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw new CancelledError();

      const system = await this.options.systemPrompt();
      this.lastSystem = system;
      const tools = this.toolDefinitions();
      this.lastTools = tools;

      if (this.options.context.needsCompaction(this.messages, system, tools)) {
        this.messages = await this.options.context.compact(this.messages, {
          system,
          tools,
          signal,
          notify: (message) => this.options.emit({ type: "notice", level: "info", text: message }),
        });
      }

      const result = await this.streamWithRetry(
        {
          model: this.options.model,
          system,
          messages: this.messages,
          tools,
          signal,
        },
        signal,
      );

      if (result.finish === "length") {
        this.options.emit({
          type: "notice",
          level: "warn",
          text: "The model hit its output limit. Ask it to continue if the response was incomplete.",
        });
      } else if (result.finish === "content_filter") {
        this.options.emit({
          type: "notice",
          level: "warn",
          text: "The provider filtered part of the response.",
        });
      }

      if (!result.text && result.calls.length === 0) {
        this.options.emit({
          type: "notice",
          level: "warn",
          text: "The model returned an empty response. Try again or check the provider/model.",
        });
        this.options.emit({ type: "done", reason: "completed" });
        return;
      }

      const assistantMessage: Extract<ChatMessage, { role: "assistant" }> = {
        role: "assistant",
        content: result.text,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.calls.length > 0 ? { toolCalls: result.calls } : {}),
      };
      this.messages.push(assistantMessage);
      this.options.emit({ type: "assistant-message", message: assistantMessage });

      if (this.options.hooks) {
        await this.options.hooks.runHook("after_response", {
          text: result.text,
          sessionId: this.options.sessionId,
        });
      }

      if (result.calls.length === 0) {
        this.options.emit({ type: "done", reason: "completed" });
        return;
      }

      for (const call of result.calls) {
        if (signal.aborted) throw new CancelledError();
        const stop = await this.executeToolCall(call, signal);
        if (stop) {
          this.options.emit({ type: "done", reason: "completed" });
          return;
        }
      }
    }

    this.options.emit({
      type: "notice",
      level: "warn",
      text: `Reached the maximum of ${maxSteps} agent steps. Send another message to continue.`,
    });
    this.options.emit({ type: "done", reason: "max-steps" });
  }

  private toolDefinitions(): ToolDefinition[] {
    if (this.mode === "agent") return this.options.registry.definitions();
    // Plan/ask are read-only at the prompt level as well as the permission layer.
    return this.options.registry.definitions((tool) => tool.permission === "read");
  }

  private async streamWithRetry(
    request: {
      model: string;
      system: string;
      messages: ChatMessage[];
      tools: ToolDefinition[];
      signal: AbortSignal;
    },
    signal: AbortSignal,
  ): Promise<StreamResult> {
    let lastError: unknown;
    const progress = { produced: false };
    for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt++) {
      try {
        return await this.streamOnce(request, signal, progress);
      } catch (error) {
        if (signal.aborted) throw new CancelledError();
        lastError = error;
        // Retrying after deltas were already shown would duplicate output.
        if (progress.produced || attempt >= RETRYABLE_ATTEMPTS) break;
        this.options.emit({
          type: "notice",
          level: "warn",
          text: `Provider request failed (${toError(error).message}). Retrying…`,
        });
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async streamOnce(
    request: {
      model: string;
      system: string;
      messages: ChatMessage[];
      tools: ToolDefinition[];
      signal: AbortSignal;
    },
    signal: AbortSignal,
    progress: { produced: boolean },
  ): Promise<StreamResult> {
    let text = "";
    let reasoning = "";
    let produced = false;
    let finish: StreamResult["finish"] = "stop";
    const calls: ToolCall[] = [];

    const markProduced = () => {
      produced = true;
      progress.produced = true;
    };

    const stream = this.options.provider.stream({
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      signal,
      reasoning: this.options.config.ui.showReasoning,
    });

    for await (const event of stream) {
      if (signal.aborted) throw new CancelledError();
      if (event.type === "text-delta") {
        if (event.text) {
          markProduced();
          text += event.text;
          this.options.emit({ type: "assistant-delta", text: event.text });
        }
      } else if (event.type === "reasoning-delta") {
        if (event.text) {
          markProduced();
          reasoning += event.text;
          this.options.emit({ type: "reasoning-delta", text: event.text });
        }
      } else if (event.type === "tool-call") {
        markProduced();
        calls.push(event.call);
      } else if (event.type === "usage") {
        this.usage = addUsage(this.usage, event.usage);
        this.options.emit({ type: "usage", usage: event.usage, cumulative: this.getUsage() });
      } else if (event.type === "finish") {
        finish = event.reason;
      }
    }
    return { text, reasoning, calls, finish, produced };
  }

  private async executeToolCall(call: ToolCall, signal: AbortSignal): Promise<boolean> {
    const tool = this.options.registry.get(call.name);
    const parsed = parseArguments(call.arguments);
    let argumentValue: unknown = parsed.value;

    const summary = this.summarizeTool(tool, parsed.valid, argumentValue);
    this.options.emit({
      type: "tool-start",
      call,
      permission: tool?.permission ?? "sensitive",
      summary,
    });

    if (this.options.hooks) {
      const hooked = await this.options.hooks.runHook("before_tool", {
        toolName: call.name,
        arguments: argumentValue,
        sessionId: this.options.sessionId,
      });
      argumentValue = hooked.arguments;
    }

    const context = this.buildToolContext(call.id, signal);
    const result = await this.options.registry.execute(call.name, argumentValue, context);

    this.options.emit({
      type: "tool-end",
      callId: call.id,
      name: call.name,
      result,
    });

    if (this.options.hooks) {
      await this.options.hooks.runHook("after_tool", {
        toolName: call.name,
        arguments: argumentValue,
        result,
        sessionId: this.options.sessionId,
      });
    }

    this.messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: result.ok ? result.output : `Error: ${result.output}`,
      isError: !result.ok,
    });

    return result.stop === true;
  }

  private summarizeTool(tool: AnyTool | undefined, valid: boolean, value: unknown): string {
    if (!tool) return "Unknown tool";
    if (valid && tool.describe) {
      try {
        const parsed = tool.parameters.safeParse(value);
        if (parsed.success) return tool.describe(parsed.data).summary;
      } catch {
        // Fall through to a generic summary.
      }
    }
    return `Run ${tool.name}`;
  }

  private buildToolContext(callId: string, signal: AbortSignal): ToolContext {
    return {
      workspace: this.options.workspace,
      projectRoot: this.options.projectRoot,
      paths: this.options.paths,
      config: this.options.config,
      permissions: this.options.permissions,
      secrets: this.options.secrets,
      signal,
      sessionId: this.options.sessionId,
      callId,
      plan: this.planController,
      emit: (event: AgentEvent) => this.options.emit(event),
      checkpoints: this.options.checkpoints,
      memory: this.options.memory,
      skills: this.options.skills
        ? {
            getActiveNames: () => this.options.skills!.getActiveNames(),
            readInstructions: (name) => this.options.skills!.readInstructions(name),
          }
        : undefined,
      requestUserInput: this.options.requestUserInput,
      getContextStats: (): ContextStats =>
        this.options.context.stats(this.messages, this.lastSystem, this.lastTools, this.usage),
      model: {
        provider: this.options.provider.id,
        model: this.options.model,
      },
    };
  }
}

export type StreamSummary = StreamResult & { result?: ToolResult };
