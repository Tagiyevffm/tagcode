import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import type { ProviderType } from "../config/schema.js";
import { ProviderError } from "../core/errors.js";
import { joinUrl, openEventStream, requestJson, type HttpOptions } from "./http.js";
import { parseSSEJson } from "./sse.js";
import { inferModelInfo } from "./capabilities.js";

export type OpenAICompatibleOptions = {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  providerType?: ProviderType;
  local?: boolean;
  contextWindow?: number;
  capabilities?: Partial<ProviderCapabilities>;
  fetchImpl?: typeof fetch;
};

type OpenAIMessage = Record<string, unknown>;

type OpenAIStreamChunk = {
  error?: { message?: string; type?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

/** Adapter for the OpenAI Chat Completions streaming protocol. */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly headers: Record<string, string>;
  protected readonly timeoutMs: number;
  protected readonly providerType: ProviderType;
  protected readonly local: boolean;
  protected readonly fetchImpl?: typeof fetch;
  protected readonly configuredContextWindow?: number;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.providerType = options.providerType ?? "custom";
    this.local = options.local ?? false;
    this.fetchImpl = options.fetchImpl;
    this.configuredContextWindow = options.contextWindow;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: false,
      structuredOutput: false,
      reasoning: false,
      modelListing: true,
      ...options.capabilities,
    };
  }

  protected authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return { ...headers, ...this.headers };
  }

  protected httpOptions(signal?: AbortSignal): HttpOptions {
    return {
      providerId: this.id,
      timeoutMs: this.timeoutMs,
      signal,
      fetchImpl: this.fetchImpl,
    };
  }

  protected buildMessages(request: ChatRequest): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    for (const message of request.messages) {
      messages.push(this.convertMessage(message));
    }
    return messages;
  }

  protected convertMessage(message: ChatMessage): OpenAIMessage {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user": {
        if (message.images && message.images.length > 0) {
          const parts: Array<Record<string, unknown>> = [];
          if (message.content) parts.push({ type: "text", text: message.content });
          for (const image of message.images) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.data}` },
            });
          }
          return { role: "user", content: parts };
        }
        return { role: "user", content: message.content };
      }
      case "assistant": {
        const out: OpenAIMessage = { role: "assistant", content: message.content || null };
        if (message.toolCalls && message.toolCalls.length > 0) {
          out.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" },
          }));
        }
        return out;
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
    }
  }

  protected convertTools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  protected buildBody(request: ChatRequest, includeUsage: boolean): Record<string, unknown> {
    const tools = this.convertTools(request.tools);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: this.buildMessages(request),
      stream: true,
    };
    if (includeUsage) body.stream_options = { include_usage: true };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    return body;
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    let response: Response;
    try {
      response = await this.openStream(request, true);
    } catch (error) {
      // A handful of OpenAI-compatible servers reject `stream_options`.
      if (
        error instanceof ProviderError &&
        error.status === 400 &&
        /stream_options|include_usage/i.test(error.message)
      ) {
        response = await this.openStream(request, false);
      } else {
        throw error;
      }
    }

    const toolCalls = new Map<number, { id?: string; name: string; arguments: string }>();
    let finishReason: string | undefined;
    let emittedUsage = false;
    let sawText = false;

    for await (const chunk of parseSSEJson<OpenAIStreamChunk>(response.body!, request.signal)) {
      if (chunk.error) {
        throw new ProviderError(
          `${this.name}: ${chunk.error.message ?? "stream error"}`,
          { providerId: this.id },
        );
      }
      if (chunk.usage) {
        const inputTokens = chunk.usage.prompt_tokens ?? 0;
        const outputTokens = chunk.usage.completion_tokens ?? 0;
        if (inputTokens > 0 || outputTokens > 0) {
          emittedUsage = true;
          yield { type: "usage", usage: { inputTokens, outputTokens } };
        }
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        sawText = true;
        yield { type: "text-delta", text: delta.content };
      }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        yield { type: "reasoning-delta", text: reasoning };
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const existing = toolCalls.get(index) ?? { name: "", arguments: "" };
        if (fragment.id) existing.id = fragment.id;
        if (fragment.function?.name) {
          existing.name = existing.name
            ? existing.name.length >= fragment.function.name.length
              ? existing.name
              : fragment.function.name
            : fragment.function.name;
        }
        if (fragment.function?.arguments) existing.arguments += fragment.function.arguments;
        toolCalls.set(index, existing);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);
    for (const [index, accumulated] of ordered) {
      if (!accumulated.name) continue;
      const call: ToolCall = {
        id: accumulated.id ?? `call_${randomUUID()}`,
        name: accumulated.name,
        arguments: accumulated.arguments || "{}",
      };
      yield { type: "tool-call", call };
    }

    if (!emittedUsage) {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    }
    const reason: Extract<StreamEvent, { type: "finish" }>["reason"] =
      ordered.length > 0 || finishReason === "tool_calls"
        ? "tool_calls"
        : finishReason === "length"
          ? "length"
          : finishReason === "content_filter"
            ? "content_filter"
            : "stop";
    if (!sawText && reason === "stop" && ordered.length === 0) {
      // Some local servers return an empty stream when the model has nothing to say.
      yield { type: "text-delta", text: "" };
    }
    yield { type: "finish", reason };
  }

  private async openStream(request: ChatRequest, includeUsage: boolean): Promise<Response> {
    const url = joinUrl(this.baseUrl, "/chat/completions");
    return openEventStream(
      url,
      {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(this.buildBody(request, includeUsage)),
      },
      this.httpOptions(request.signal),
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = joinUrl(this.baseUrl, "/models");
    const response = await requestJson<{ data?: Array<{ id: string; owned_by?: string }> }>(
      url,
      { method: "GET", headers: this.authHeaders() },
      { ...this.httpOptions(), timeoutMs: Math.min(this.timeoutMs, 20_000), retries: 1 },
    );
    return (response.data ?? [])
      .filter((model) => typeof model.id === "string" && model.id.length > 0)
      .map((model) => ({
        ...inferModelInfo(model.id, {
          providerType: this.providerType,
          local: this.local,
          contextWindow: this.configuredContextWindow,
        }),
        name: model.id,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
