import type { ProviderType } from "../config/schema.js";
import type { ModelInfo } from "../core/types.js";

const PROVIDER_DEFAULT_CONTEXT: Record<ProviderType, number> = {
  anthropic: 200_000,
  openai: 128_000,
  openrouter: 128_000,
  deepseek: 64_000,
  mistral: 128_000,
  groq: 128_000,
  together: 128_000,
  fireworks: 128_000,
  ollama: 16_384,
  custom: 32_768,
};

export function defaultContextWindow(type: ProviderType): number {
  return PROVIDER_DEFAULT_CONTEXT[type] ?? 32_768;
}

type ModelHints = {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
};

const HINTS: Array<{ pattern: RegExp; hints: ModelHints }> = [
  { pattern: /^claude/i, hints: { contextWindow: 200_000, maxOutputTokens: 8_192, supportsVision: true, supportsTools: true, supportsReasoning: true } },
  { pattern: /^gpt-4\.1/i, hints: { contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsVision: true, supportsTools: true } },
  { pattern: /^gpt-4o|^gpt-4-turbo/i, hints: { contextWindow: 128_000, supportsVision: true, supportsTools: true } },
  { pattern: /^o[13](-|$)/i, hints: { contextWindow: 200_000, supportsTools: true, supportsReasoning: true } },
  { pattern: /deepseek-reasoner/i, hints: { contextWindow: 64_000, supportsTools: true, supportsReasoning: true } },
  { pattern: /deepseek/i, hints: { contextWindow: 64_000, supportsTools: true } },
  { pattern: /qwen.*coder/i, hints: { contextWindow: 32_768, supportsTools: true } },
  { pattern: /qwen/i, hints: { contextWindow: 128_000, supportsTools: true } },
  { pattern: /llama-?3\.[123]/i, hints: { contextWindow: 128_000, supportsTools: true } },
  { pattern: /llama-?4/i, hints: { contextWindow: 128_000, supportsTools: true } },
  { pattern: /mistral-large|mistral-small|magistral/i, hints: { contextWindow: 128_000, supportsTools: true } },
  { pattern: /codestral/i, hints: { contextWindow: 128_000, supportsTools: true } },
  { pattern: /gemini/i, hints: { contextWindow: 1_000_000, supportsVision: true, supportsTools: true } },
  { pattern: /grok/i, hints: { contextWindow: 131_072, supportsTools: true } },
  { pattern: /llava|vision|vl\b/i, hints: { supportsVision: true } },
];

/** Best-effort capability inference from the model id. Never authoritative. */
export function inferModelInfo(
  modelId: string,
  options: { providerType: ProviderType; local?: boolean; contextWindow?: number },
): ModelInfo {
  const hint = HINTS.find((entry) => entry.pattern.test(modelId))?.hints ?? {};
  return {
    id: modelId,
    name: modelId,
    contextWindow: options.contextWindow ?? hint.contextWindow ?? defaultContextWindow(options.providerType),
    maxOutputTokens: hint.maxOutputTokens,
    supportsTools: hint.supportsTools ?? true,
    supportsVision: hint.supportsVision ?? false,
    supportsReasoning: hint.supportsReasoning ?? false,
    local: options.local,
  };
}

export function contextWindowFor(
  modelId: string,
  providerType: ProviderType,
  explicit?: number,
): number {
  if (explicit && explicit > 0) return explicit;
  return inferModelInfo(modelId, { providerType }).contextWindow ?? defaultContextWindow(providerType);
}
