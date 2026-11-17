import type { ChatMessage, Provider, TokenUsage, ToolDefinition } from "../core/types.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateRequestTokens,
  estimateTokens,
} from "../utils/tokens.js";
import { toError } from "../core/errors.js";
import { logger } from "../utils/logger.js";

export type ContextStats = {
  messageCount: number;
  estimatedTokens: number;
  budget: number;
  usage: TokenUsage;
};

export type ContextManagerOptions = {
  provider: Provider;
  model: string;
  /** Total token budget for the conversation. */
  budget: number;
  compactAt: number;
  keepRecentMessages: number;
};

function formatForSummary(message: ChatMessage): string {
  if (message.role === "user") return `USER: ${message.content.slice(0, 4000)}`;
  if (message.role === "assistant") {
    const calls = (message.toolCalls ?? [])
      .map((call) => `[tool ${call.name} ${call.arguments.slice(0, 400)}]`)
      .join(" ");
    return `ASSISTANT: ${message.content.slice(0, 3000)} ${calls}`.trim();
  }
  if (message.role === "tool") {
    return `TOOL RESULT (${message.name ?? message.toolCallId})${message.isError ? " [error]" : ""}: ${message.content.slice(0, 2000)}`;
  }
  return `SYSTEM: ${message.content.slice(0, 2000)}`;
}

/**
 * Context budgeting and model-driven compaction. The summarizer is called with
 * the same provider, so compaction works for every supported backend.
 */
export class ContextManager {
  readonly budget: number;
  private readonly options: ContextManagerOptions;

  constructor(options: ContextManagerOptions) {
    this.options = options;
    this.budget = Math.max(2048, options.budget);
  }

  stats(
    messages: ChatMessage[],
    system?: string,
    tools?: ToolDefinition[],
    usage: TokenUsage = { inputTokens: 0, outputTokens: 0 },
  ): ContextStats {
    return {
      messageCount: messages.length,
      estimatedTokens: estimateRequestTokens(system, messages, tools),
      budget: this.budget,
      usage,
    };
  }

  needsCompaction(messages: ChatMessage[], system?: string, tools?: ToolDefinition[]): boolean {
    const estimate = estimateRequestTokens(system, messages, tools);
    return estimate > this.budget * this.options.compactAt;
  }

  /** Replace old messages with a model-written summary, keeping recent context. */
  async compact(
    messages: ChatMessage[],
    options: {
      system?: string;
      tools?: ToolDefinition[];
      signal: AbortSignal;
      notify?: (message: string) => void;
    },
  ): Promise<ChatMessage[]> {
    if (messages.length === 0) return messages;
    const recentStart = this.chooseRecentStart(messages);
    if (recentStart <= 0) {
      options.notify?.("Context is large but there is no older history to compact yet.");
      return messages;
    }
    const older = messages.slice(0, recentStart);
    const recent = messages.slice(recentStart);
    const transcript = this.buildTranscript(older);

    options.notify?.(`Compacting ${older.length} older message(s) to stay within the context budget…`);

    let summary = "";
    try {
      const request = {
        model: this.options.model,
        system:
          "You are a context compressor for a coding agent. Summarize the conversation below so another agent can continue the work without the original messages. Preserve: the user's goal, requirements and constraints; decisions made; files created or modified; commands run and their outcomes; errors and fixes; the current plan and pending tasks. Be concise and factual. Output only the summary, in markdown, under 400 words.",
        messages: [{ role: "user" as const, content: transcript }],
        maxTokens: 1200,
        temperature: 0.1,
        signal: options.signal,
      };
      for await (const event of this.options.provider.stream(request)) {
        if (event.type === "text-delta") summary += event.text;
      }
    } catch (error) {
      logger.warn("context", "Compaction summarization failed", toError(error).message);
      options.notify?.(
        `Summarization failed (${toError(error).message}); dropping older messages instead.`,
      );
    }

    const notice: ChatMessage = {
      role: "user",
      content: summary.trim()
        ? `[Summary of earlier conversation]\n\n${summary.trim()}`
        : "[Context note] Earlier messages were omitted because the context budget was exceeded. Continue from the recent messages.",
    };

    let compacted = [notice, ...recent];
    // If the summary plus recent messages still exceeds the budget, trim tool output.
    if (estimateMessagesTokens(compacted) > this.budget * this.options.compactAt && recent.length > 2) {
      compacted = [notice, ...recent.slice(-Math.max(2, Math.floor(recent.length / 2)))];
    }
    return compacted;
  }

  private chooseRecentStart(messages: ChatMessage[]): number {
    const recentBudget = this.budget * 0.45;
    let recentTokens = 0;
    let start = messages.length;
    const maxRecent = Math.max(this.options.keepRecentMessages, Math.min(24, messages.length));
    while (start > 0) {
      const message = messages[start - 1]!;
      const tokens = estimateMessageTokens(message);
      const isLastPossible = start === 1;
      if (!isLastPossible && recentTokens + tokens > recentBudget) break;
      if (!isLastPossible && messages.length - start >= maxRecent) break;
      recentTokens += tokens;
      start--;
    }
    // Never start the recent window with an orphan tool result.
    while (start < messages.length && messages[start]!.role === "tool") start--;
    if (start <= 0) start = Math.max(1, Math.floor(messages.length / 2));
    while (start < messages.length && messages[start]!.role === "tool") start++;
    return start;
  }

  private buildTranscript(messages: ChatMessage[]): string {
    const parts: string[] = [];
    let used = 0;
    const limit = Math.min(80_000, Math.floor(this.budget * 2.5));
    for (let index = messages.length - 1; index >= 0; index--) {
      const part = formatForSummary(messages[index]!);
      if (used + part.length > limit) {
        parts.unshift("… earlier messages omitted from this summary …");
        break;
      }
      parts.unshift(part);
      used += part.length;
    }
    return parts.join("\n\n");
  }
}

/** Rough estimate used for the status bar. */
export function roughContextTokens(system: string, messages: ChatMessage[]): number {
  return estimateTokens(system) + estimateMessagesTokens(messages);
}
