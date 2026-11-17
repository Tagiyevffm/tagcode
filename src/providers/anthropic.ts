import type {
  ChatMessage,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  ToolCall,
} from "../core/types.js";
import { ProviderError } from "../core/errors.js";
import { joinUrl, openEventStream, requestJson, type HttpOptions } from "./http.js";
import { parseSSEJson } from "./sse.js";
import { inferModelInfo } from "./capabilities.js";

export type AnthropicOptions = {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
};

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicBlock[] };

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
};

const ANTHROPIC_VERSION = "2023-06-01";

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Native adapter for the Anthropic Messages API (streaming). */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    structuredOutput: false,
    reasoning: true,
    modelListing: true,
  };

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly contextWindow?: number;
  private readonly defaultMaxTokens: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.id = options.id;
    this.name = options.name ?? "Anthropic";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.contextWindow = options.contextWindow;
    this.defaultMaxTokens = options.maxOutputTokens ?? 8_192;
    this.fetchImpl = options.fetchImpl;
  }

  private httpOptions(signal?: AbortSignal): HttpOptions {
    return {
      providerId: this.id,
      timeoutMs: this.timeoutMs,
      signal,
      fetchImpl: this.fetchImpl,
    };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return { ...headers, ...this.headers };
  }

  private buildMessages(request: ChatRequest): {
    system: string | undefined;
    messages: AnthropicMessage[];
  } {
    const systemParts: string[] = [];
    if (request.system) systemParts.push(request.system);
    const messages: AnthropicMessage[] = [];
    let lastWasToolResult = false;

    for (const message of request.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
        continue;
      }
      if (message.role === "user") {
        lastWasToolResult = false;
        if (message.images && message.images.length > 0) {
          const blocks: AnthropicBlock[] = message.images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
          }));
          if (message.content) blocks.push({ type: "text", text: message.content });
          messages.push({ role: "user", content: blocks });
        } else {
          messages.push({ role: "user", content: message.content || " " });
        }
        continue;
      }
      if (message.role === "assistant") {
        lastWasToolResult = false;
        const blocks: AnthropicBlock[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: parseToolInput(call.arguments),
          });
        }
        if (blocks.length === 0) continue;
        messages.push({ role: "assistant", content: blocks });
        continue;
      }
      // tool result
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      };
      if (lastWasToolResult) {
        const last = messages[messages.length - 1];
        if (last && Array.isArray(last.content)) {
          last.content.push(block);
          continue;
        }
      }
      messages.push({ role: "user", content: [block] });
      lastWasToolResult = true;
    }

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages,
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { system, messages } = this.buildMessages(request);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const response = await openEventStream(
      joinUrl(this.baseUrl, "/v1/messages"),
      {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      },
      this.httpOptions(request.signal),
    );

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    const emittedTools: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;

    for await (const event of parseSSEJson<AnthropicStreamEvent>(
      response.body!,
      request.signal,
    )) {
      switch (event.type) {
        case "message_start": {
          inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block?.type === "tool_use" && block.id && block.name) {
            toolBlocks.set(event.index ?? 0, { id: block.id, name: block.name, json: "" });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (!delta) break;
          if (delta.type === "text_delta" && delta.text) {
            yield { type: "text-delta", text: delta.text };
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            yield { type: "reasoning-delta", text: delta.thinking };
          } else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
            const block = toolBlocks.get(event.index ?? 0);
            if (block) block.json += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const block = toolBlocks.get(event.index ?? 0);
          if (block) {
            const call: ToolCall = {
              id: block.id,
              name: block.name,
              arguments: block.json || "{}",
            };
            emittedTools.push(call);
            yield { type: "tool-call", call };
            toolBlocks.delete(event.index ?? 0);
          }
          break;
        }
        case "message_delta": {
          stopReason = event.delta?.stop_reason ?? stopReason;
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        }
        case "error": {
          throw new ProviderError(`${this.name}: ${event.error?.message ?? "stream error"}`, {
            providerId: this.id,
          });
        }
        default:
          break;
      }
    }

    yield { type: "usage", usage: { inputTokens, outputTokens } };
    const reason: Extract<StreamEvent, { type: "finish" }>["reason"] =
      emittedTools.length > 0 || stopReason === "tool_use"
        ? "tool_calls"
        : stopReason === "max_tokens"
          ? "length"
          : stopReason === "refusal"
            ? "content_filter"
            : "stop";
    yield { type: "finish", reason };
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await requestJson<{
      data?: Array<{ id: string; display_name?: string; created_at?: string }>;
    }>(
      joinUrl(this.baseUrl, "/v1/models"),
      { method: "GET", headers: this.authHeaders() },
      { ...this.httpOptions(), timeoutMs: Math.min(this.timeoutMs, 20_000), retries: 1 },
    );
    const models = (response.data ?? []).filter((model) => typeof model.id === "string");
    if (models.length === 0) {
      throw new ProviderError("Anthropic returned no models for this API key", {
        providerId: this.id,
      });
    }
    return models
      .map((model) => ({
        ...inferModelInfo(model.id, {
          providerType: "anthropic",
          contextWindow: this.contextWindow,
        }),
        name: model.display_name ?? model.id,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
