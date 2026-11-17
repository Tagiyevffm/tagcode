import type { ChatMessage, ToolDefinition } from "../core/types.js";

/**
 * Cheap, dependency-free token estimate.
 *
 * Model tokenizers differ, so TagCode deliberately uses a conservative
 * approximation: ~3.6 ASCII chars per token and ~1.2 chars per token for
 * non-ASCII text. It is only used for budgeting and compaction decisions,
 * never for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 3.6 + nonAscii / 1.2);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = 4;
  total += estimateTokens(message.content ?? "");
  if (message.role === "assistant") {
    if (message.reasoning) total += estimateTokens(message.reasoning);
    for (const call of message.toolCalls ?? []) {
      total += estimateTokens(call.name) + estimateTokens(call.arguments) + 4;
    }
  }
  if (message.role === "tool") total += 4;
  return total;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function estimateToolsTokens(tools: ToolDefinition[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools));
}

export function estimateRequestTokens(
  system: string | undefined,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): number {
  return (
    (system ? estimateTokens(system) + 8 : 0) +
    estimateMessagesTokens(messages) +
    estimateToolsTokens(tools)
  );
}

/** Convert a token budget into a character budget (approximate). */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * 3.6));
}
