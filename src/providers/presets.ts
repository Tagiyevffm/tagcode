import type { ProviderType } from "../config/schema.js";

export type ProviderPreset = {
  type: ProviderType;
  label: string;
  description: string;
  /** Base URL including the API version segment where applicable. */
  baseUrl: string;
  envVars: string[];
  suggestedModel: string;
  contextWindow: number;
  docsUrl: string;
  requiresKey: boolean;
  local?: boolean;
};

export const PROVIDER_PRESETS = {
  anthropic: {
    type: "anthropic",
    label: "Anthropic",
    description: "Claude models via the native Messages API.",
    baseUrl: "https://api.anthropic.com",
    envVars: ["ANTHROPIC_API_KEY"],
    suggestedModel: "claude-sonnet-4-5",
    contextWindow: 200_000,
    docsUrl: "https://docs.anthropic.com",
    requiresKey: true,
  },
  openai: {
    type: "openai",
    label: "OpenAI",
    description: "GPT models via the OpenAI API.",
    baseUrl: "https://api.openai.com/v1",
    envVars: ["OPENAI_API_KEY"],
    suggestedModel: "gpt-4.1",
    contextWindow: 128_000,
    docsUrl: "https://platform.openai.com/docs",
    requiresKey: true,
  },
  openrouter: {
    type: "openrouter",
    label: "OpenRouter",
    description: "One API for many hosted models.",
    baseUrl: "https://openrouter.ai/api/v1",
    envVars: ["OPENROUTER_API_KEY"],
    suggestedModel: "openai/gpt-4.1",
    contextWindow: 128_000,
    docsUrl: "https://openrouter.ai/docs",
    requiresKey: true,
  },
  deepseek: {
    type: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek chat and reasoning models.",
    baseUrl: "https://api.deepseek.com/v1",
    envVars: ["DEEPSEEK_API_KEY"],
    suggestedModel: "deepseek-chat",
    contextWindow: 64_000,
    docsUrl: "https://api-docs.deepseek.com",
    requiresKey: true,
  },
  mistral: {
    type: "mistral",
    label: "Mistral AI",
    description: "Mistral and Codestral models.",
    baseUrl: "https://api.mistral.ai/v1",
    envVars: ["MISTRAL_API_KEY"],
    suggestedModel: "mistral-large-latest",
    contextWindow: 128_000,
    docsUrl: "https://docs.mistral.ai",
    requiresKey: true,
  },
  groq: {
    type: "groq",
    label: "Groq",
    description: "Fast hosted inference on Groq hardware.",
    baseUrl: "https://api.groq.com/openai/v1",
    envVars: ["GROQ_API_KEY"],
    suggestedModel: "llama-3.3-70b-versatile",
    contextWindow: 128_000,
    docsUrl: "https://console.groq.com/docs",
    requiresKey: true,
  },
  together: {
    type: "together",
    label: "Together AI",
    description: "Open models hosted by Together.",
    baseUrl: "https://api.together.xyz/v1",
    envVars: ["TOGETHER_API_KEY"],
    suggestedModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    contextWindow: 128_000,
    docsUrl: "https://docs.together.ai",
    requiresKey: true,
  },
  fireworks: {
    type: "fireworks",
    label: "Fireworks AI",
    description: "Fast open-model inference.",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envVars: ["FIREWORKS_API_KEY"],
    suggestedModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    contextWindow: 128_000,
    docsUrl: "https://docs.fireworks.ai",
    requiresKey: true,
  },
  ollama: {
    type: "ollama",
    label: "Ollama (local)",
    description: "Run models locally with Ollama. No API key, no cloud.",
    baseUrl: "http://localhost:11434/v1",
    envVars: ["OLLAMA_HOST"],
    suggestedModel: "qwen2.5-coder:7b",
    contextWindow: 16_384,
    docsUrl: "https://ollama.com",
    requiresKey: false,
    local: true,
  },
  custom: {
    type: "custom",
    label: "Custom OpenAI-compatible endpoint",
    description: "Any server implementing /chat/completions (vLLM, LM Studio, llama.cpp, …).",
    baseUrl: "http://localhost:8000/v1",
    envVars: [],
    suggestedModel: "",
    contextWindow: 32_768,
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    requiresKey: false,
  },
} satisfies Record<ProviderType, ProviderPreset>;

export function presetFor(type: ProviderType): ProviderPreset {
  return PROVIDER_PRESETS[type];
}

export function presetId(type: ProviderType): string {
  return type;
}
