import type { ModelInfo } from "../core/types.js";
import { joinUrl, requestJson } from "./http.js";
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai.js";
import { inferModelInfo } from "./capabilities.js";

export type OllamaOptions = Omit<OpenAICompatibleOptions, "providerType" | "local"> & {
  baseUrl?: string;
};

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
};

/** Ollama speaks the OpenAI protocol on /v1 and has a richer model list on /api/tags. */
export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly apiRoot: string;

  constructor(options: OllamaOptions) {
    const baseUrl = options.baseUrl ?? "http://localhost:11434/v1";
    super({
      ...options,
      baseUrl,
      providerType: "ollama",
      local: true,
      capabilities: {
        streaming: true,
        toolCalling: true,
        vision: false,
        structuredOutput: false,
        reasoning: false,
        modelListing: true,
        ...options.capabilities,
      },
    });
    this.apiRoot = baseUrl.replace(/\/v1\/?$/, "");
  }

  override async listModels(): Promise<ModelInfo[]> {
    const response = await requestJson<OllamaTagsResponse>(
      joinUrl(this.apiRoot, "/api/tags"),
      { method: "GET" },
      {
        providerId: this.id,
        timeoutMs: 8_000,
        fetchImpl: this.fetchImpl,
        retries: 0,
      },
    );
    const models: ModelInfo[] = [];
    for (const model of response.models ?? []) {
      const id = model.model ?? model.name;
      if (!id) continue;
      const info = inferModelInfo(id, {
        providerType: "ollama",
        local: true,
        contextWindow: this.configuredContextWindow,
      });
      const detail = [model.details?.parameter_size, model.details?.quantization_level]
        .filter(Boolean)
        .join(" · ");
      models.push({
        ...info,
        name: detail ? `${id} (${detail})` : id,
        supportsVision: /llava|vision|vl|minicpm-v/i.test(id) || Boolean(info.supportsVision),
        supportsTools: !/embed|nomic|mxbai/i.test(id),
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Verify that the Ollama server is reachable before chatting. */
  async ping(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }
}
