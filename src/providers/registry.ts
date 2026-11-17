import type { Provider } from "../core/types.js";
import type { ProviderConfig } from "../config/schema.js";
import type { SecretStore } from "../config/secrets.js";
import { ConfigError } from "../core/errors.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai.js";
import { PROVIDER_PRESETS, presetFor } from "./presets.js";

export type CreateProviderOptions = {
  config: ProviderConfig;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export function providerDisplayName(config: ProviderConfig): string {
  return config.name ?? presetFor(config.type).label;
}

export function createProvider(options: CreateProviderOptions): Provider {
  const { config } = options;
  if (config.type === "anthropic") {
    return new AnthropicProvider({
      id: config.id,
      name: providerDisplayName(config),
      baseUrl: config.baseUrl ?? presetFor("anthropic").baseUrl,
      apiKey: options.apiKey,
      headers: config.headers,
      timeoutMs: config.timeoutMs,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      fetchImpl: options.fetchImpl,
    });
  }

  if (config.type === "ollama") {
    return new OllamaProvider({
      id: config.id,
      name: providerDisplayName(config),
      baseUrl: config.baseUrl ?? presetFor("ollama").baseUrl,
      apiKey: options.apiKey,
      headers: config.headers,
      timeoutMs: config.timeoutMs ?? 300_000,
      contextWindow: config.contextWindow,
      fetchImpl: options.fetchImpl,
    });
  }

  const preset = presetFor(config.type);
  return new OpenAICompatibleProvider({
    id: config.id,
    name: providerDisplayName(config),
    baseUrl: config.baseUrl ?? preset.baseUrl,
    apiKey: options.apiKey,
    headers: config.headers,
    timeoutMs: config.timeoutMs,
    providerType: config.type,
    local: preset.local,
    contextWindow: config.contextWindow,
    capabilities: {
      vision: config.type === "openai" || config.type === "openrouter",
      reasoning: config.type === "deepseek",
    },
    fetchImpl: options.fetchImpl,
  });
}

export async function resolveApiKey(
  provider: ProviderConfig,
  secrets: SecretStore,
): Promise<string | undefined> {
  const preset = PROVIDER_PRESETS[provider.type];
  return secrets.get(provider.id, provider.apiKeyEnv ?? preset.envVars[0]);
}

export async function createProviderFromConfig(
  provider: ProviderConfig,
  secrets: SecretStore,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Provider> {
  const preset = PROVIDER_PRESETS[provider.type];
  const apiKey = await resolveApiKey(provider, secrets);
  if (preset.requiresKey && !apiKey) {
    throw new ConfigError(
      `Missing API key for "${provider.id}". Run /connect ${provider.id} to store one, or set ${preset.envVars[0] ?? "the provider's API key environment variable"}.`,
    );
  }
  return createProvider({ config: provider, apiKey, fetchImpl: options.fetchImpl });
}

export { PROVIDER_PRESETS, presetFor } from "./presets.js";
