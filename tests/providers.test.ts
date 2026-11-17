import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { ProviderError } from "../src/core/errors.js";
import { inferModelInfo, contextWindowFor } from "../src/providers/capabilities.js";
import { joinUrl } from "../src/providers/http.js";
import type { ChatRequest, StreamEvent } from "../src/core/types.js";
import { jsonResponse, sseResponse } from "./helpers.js";

const encoder = new TextEncoder();

function sse(chunks: unknown[]): string[] {
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"];
}

async function collect(generator: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const baseRequest: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
};

describe("OpenAI-compatible provider", () => {
  it("streams text, reasoning, usage and a finish event", async () => {
    const fetchImpl = (async () =>
      sseResponse(
        sse([
          { choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
          { usage: { prompt_tokens: 12, completion_tokens: 3 } },
        ]),
      )) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "test",
      baseUrl: "https://example.test/v1",
      apiKey: "secret-key",
      fetchImpl,
    });
    const events = await collect(provider.stream(baseRequest));
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text).join("")).toBe(
      "Hello",
    );
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("assembles streamed tool calls and reports tool_calls", async () => {
    const fetchImpl = (async () =>
      sseResponse(
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      )) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "test",
      baseUrl: "https://example.test/v1",
      fetchImpl,
    });
    const events = await collect(provider.stream(baseRequest));
    const call = events.find((event) => event.type === "tool-call");
    expect(call).toEqual({
      type: "tool-call",
      call: { id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });

  it("sends auth headers, system prompt and tool definitions", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return sseResponse(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "test",
      baseUrl: "https://example.test/v1/",
      apiKey: "secret-key",
      fetchImpl,
    });
    await collect(
      provider.stream({
        ...baseRequest,
        system: "You are TagCode.",
        tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
      }),
    );
    expect(captured?.url).toBe("https://example.test/v1/chat/completions");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(String(captured?.init.body)) as {
      messages: Array<{ role: string }>;
      tools: Array<{ function: { name: string } }>;
      stream: boolean;
    };
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.tools[0]?.function.name).toBe("read_file");
  });

  it("surfaces provider errors with redacted secrets", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key sk-abcdefghijklmnopqrstuvwx" } }), {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "test",
      baseUrl: "https://example.test/v1",
      fetchImpl,
    });
    await expect(collect(provider.stream(baseRequest))).rejects.toBeInstanceOf(ProviderError);
    await expect(collect(provider.stream(baseRequest))).rejects.toThrow(/sk-\[REDACTED\]/);
  });

  it("lists models from the provider", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ id: "qwen2.5-coder:7b" }, { id: "gpt-4.1" }] })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      id: "test",
      baseUrl: "https://example.test/v1",
      providerType: "openai",
      fetchImpl,
    });
    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(["gpt-4.1", "qwen2.5-coder:7b"]);
    expect(models.find((model) => model.id === "gpt-4.1")?.supportsVision).toBe(true);
  });
});

describe("Anthropic provider", () => {
  it("streams content blocks and tool use", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        ...sse([
          {
            type: "message_start",
            message: { usage: { input_tokens: 9, output_tokens: 0 } },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hi" },
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
          },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
        ]),
      ])) as unknown as typeof fetch;
    const provider = new AnthropicProvider({
      id: "anthropic",
      baseUrl: "https://api.anthropic.test",
      apiKey: "sk-ant-test",
      fetchImpl,
    });
    const events = await collect(provider.stream(baseRequest));
    expect(events.filter((event) => event.type === "text-delta")).toContainEqual({
      type: "text-delta",
      text: "Hi",
    });
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      type: "tool-call",
      call: { name: "read_file", arguments: '{"path":"a.txt"}' },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });
});

describe("provider helpers", () => {
  it("joins base URLs without duplicating /v1", () => {
    expect(joinUrl("https://api.test/v1", "/chat/completions")).toBe(
      "https://api.test/v1/chat/completions",
    );
    expect(joinUrl("https://api.test", "/v1/chat/completions")).toBe(
      "https://api.test/v1/chat/completions",
    );
  });

  it("infers model capabilities and context windows", () => {
    expect(inferModelInfo("claude-sonnet-4-5", { providerType: "anthropic" }).supportsVision).toBe(true);
    expect(inferModelInfo("deepseek-reasoner", { providerType: "deepseek" }).supportsReasoning).toBe(true);
    expect(contextWindowFor("qwen2.5-coder:7b", "ollama")).toBeGreaterThan(0);
    expect(contextWindowFor("anything", "custom", 999)).toBe(999);
  });
});
