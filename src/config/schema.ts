import { z } from "zod";

export const PERMISSION_MODES = ["ask", "auto", "plan", "yolo"] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);

export const PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "openrouter",
  "deepseek",
  "mistral",
  "groq",
  "together",
  "fireworks",
  "ollama",
  "custom",
] as const;
export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ProviderConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Provider ids may contain letters, digits, '-' and '_'"),
  type: ProviderTypeSchema,
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().min(1).max(2048).optional(),
  apiKeyEnv: z.string().min(1).max(120).optional(),
  defaultModel: z.string().min(1).max(300).optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(2_000_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PermissionsConfigSchema = z.object({
  mode: PermissionModeSchema.optional(),
  /** Tool name patterns that never need approval (e.g. `read_file`). */
  allow: z.array(z.string()).optional(),
  /** Tool name patterns that are always denied. */
  deny: z.array(z.string()).optional(),
  /** Tool name patterns that always require approval, even in auto mode. */
  requireApproval: z.array(z.string()).optional(),
});
export type PermissionsConfigFile = z.infer<typeof PermissionsConfigSchema>;

export const ContextConfigSchema = z.object({
  /** 0 or absent = derive from the selected model's context window. */
  maxTokens: z.number().int().min(0).optional(),
  compactAt: z.number().min(0.3).max(0.98).optional(),
  maxToolOutputChars: z.number().int().min(1000).max(2_000_000).optional(),
  maxSteps: z.number().int().min(1).max(500).optional(),
  /** Number of recent messages never compacted away. */
  keepRecentMessages: z.number().int().min(2).max(100).optional(),
});

export const UiConfigSchema = z.object({
  showReasoning: z.boolean().optional(),
  showTokenUsage: z.boolean().optional(),
  showToolOutput: z.boolean().optional(),
  animations: z.boolean().optional(),
});

export const WebConfigSchema = z.object({
  searchProvider: z.enum(["brave", "tavily"]).optional(),
  searchApiKeyEnv: z.string().optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  /** Domains allowed for fetch_url; empty means all public domains. */
  allowedDomains: z.array(z.string()).optional(),
});

export const SkillsConfigSchema = z.object({
  directories: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
  autoSelect: z.boolean().optional(),
  maxActive: z.number().int().min(0).max(20).optional(),
  /** Optional JSON index URL for `/skills search` over a registry. */
  registryUrl: z.string().optional(),
});

export const PluginsConfigSchema = z.object({
  directories: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
  enabled: z.array(z.string()).optional(),
});

export const ConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    providers: z.array(ProviderConfigSchema).optional(),
    permissions: PermissionsConfigSchema.optional(),
    context: ContextConfigSchema.optional(),
    ui: UiConfigSchema.optional(),
    web: WebConfigSchema.optional(),
    skills: SkillsConfigSchema.optional(),
    plugins: PluginsConfigSchema.optional(),
    mcp: z.object({ enabled: z.boolean().optional() }).optional(),
  })
  .passthrough();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export const MCP_TOOL_PERMISSIONS = ["read", "write", "execute", "network", "sensitive"] as const;
export const McpToolPermissionSchema = z.enum(MCP_TOOL_PERMISSIONS);
export type McpToolPermission = z.infer<typeof McpToolPermissionSchema>;

export const McpServerConfigSchema = z
  .object({
    type: z.enum(["stdio", "http"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    description: z.string().optional(),
    /** Permission class applied to every tool exposed by this server. */
    permission: McpToolPermissionSchema.optional(),
  })
  .refine((value) => Boolean(value.command) !== Boolean(value.url), {
    message: "An MCP server needs exactly one of 'command' (stdio) or 'url' (HTTP)",
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpFileSchema = z
  .object({
    mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
  })
  .passthrough();

export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
  description: z.string().max(1000).optional(),
  main: z.string().min(1),
  tagcode: z.object({
    apiVersion: z.literal("1"),
    permissions: z.array(z.enum(["read", "write", "execute", "network"])).optional(),
  }),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type ResolvedConfig = {
  version: 1;
  defaultProvider: string;
  defaultModel: string;
  providers: ProviderConfig[];
  permissions: {
    mode: (typeof PERMISSION_MODES)[number];
    allow: string[];
    deny: string[];
    requireApproval: string[];
  };
  context: {
    maxTokens: number;
    compactAt: number;
    maxToolOutputChars: number;
    maxSteps: number;
    keepRecentMessages: number;
  };
  ui: {
    showReasoning: boolean;
    showTokenUsage: boolean;
    showToolOutput: boolean;
    animations: boolean;
  };
  web: {
    searchProvider?: "brave" | "tavily";
    searchApiKeyEnv?: string;
    maxResults: number;
    timeoutMs: number;
    allowedDomains: string[];
  };
  skills: {
    directories: string[];
    disabled: string[];
    autoSelect: boolean;
    maxActive: number;
    registryUrl?: string;
  };
  plugins: {
    directories: string[];
    disabled: string[];
    enabled: string[];
  };
  mcp: { enabled: boolean };
};

export const DEFAULT_CONFIG: ResolvedConfig = {
  version: 1,
  defaultProvider: "",
  defaultModel: "",
  providers: [],
  permissions: { mode: "auto", allow: [], deny: [], requireApproval: [] },
  context: {
    maxTokens: 0,
    compactAt: 0.82,
    maxToolOutputChars: 20_000,
    maxSteps: 40,
    keepRecentMessages: 8,
  },
  ui: {
    showReasoning: true,
    showTokenUsage: true,
    showToolOutput: false,
    animations: true,
  },
  web: { maxResults: 5, timeoutMs: 20_000, allowedDomains: [] },
  skills: { directories: [], disabled: [], autoSelect: true, maxActive: 3 },
  plugins: { directories: [], disabled: [], enabled: [] },
  mcp: { enabled: true },
};

function union(...lists: Array<string[] | undefined>): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) out.add(item);
  }
  return [...out];
}

function mergeProviders(files: ConfigFile[]): ProviderConfig[] {
  const byId = new Map<string, ProviderConfig>();
  for (const file of files) {
    for (const provider of file.providers ?? []) {
      const existing = byId.get(provider.id);
      byId.set(provider.id, existing ? { ...existing, ...provider } : { ...provider });
    }
  }
  return [...byId.values()];
}

/** Deep-merge global and project config files into a fully resolved config. */
export function resolveConfig(files: ConfigFile[]): ResolvedConfig {
  const providers = mergeProviders(files);
  const last = <T>(pick: (file: ConfigFile) => T | undefined): T | undefined => {
    for (let i = files.length - 1; i >= 0; i--) {
      const value = pick(files[i]!);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const skillsDirs = [...DEFAULT_CONFIG.skills.directories, ...union(...files.map((f) => f.skills?.directories))];
  const pluginDirs = [...DEFAULT_CONFIG.plugins.directories, ...union(...files.map((f) => f.plugins?.directories))];

  return {
    version: 1,
    defaultProvider:
      last((f) => f.defaultProvider) ?? providers.find((p) => p.enabled !== false)?.id ?? "",
    defaultModel:
      last((f) => f.defaultModel) ??
      providers.find((p) => p.id === (last((f) => f.defaultProvider) ?? ""))?.defaultModel ??
      "",
    providers,
    permissions: {
      mode: last((f) => f.permissions?.mode) ?? DEFAULT_CONFIG.permissions.mode,
      allow: union(...files.map((f) => f.permissions?.allow)),
      deny: union(...files.map((f) => f.permissions?.deny)),
      requireApproval: union(...files.map((f) => f.permissions?.requireApproval)),
    },
    context: {
      maxTokens: last((f) => f.context?.maxTokens) ?? DEFAULT_CONFIG.context.maxTokens,
      compactAt: last((f) => f.context?.compactAt) ?? DEFAULT_CONFIG.context.compactAt,
      maxToolOutputChars:
        last((f) => f.context?.maxToolOutputChars) ?? DEFAULT_CONFIG.context.maxToolOutputChars,
      maxSteps: last((f) => f.context?.maxSteps) ?? DEFAULT_CONFIG.context.maxSteps,
      keepRecentMessages:
        last((f) => f.context?.keepRecentMessages) ?? DEFAULT_CONFIG.context.keepRecentMessages,
    },
    ui: {
      showReasoning: last((f) => f.ui?.showReasoning) ?? DEFAULT_CONFIG.ui.showReasoning,
      showTokenUsage: last((f) => f.ui?.showTokenUsage) ?? DEFAULT_CONFIG.ui.showTokenUsage,
      showToolOutput: last((f) => f.ui?.showToolOutput) ?? DEFAULT_CONFIG.ui.showToolOutput,
      animations: last((f) => f.ui?.animations) ?? DEFAULT_CONFIG.ui.animations,
    },
    web: {
      searchProvider: last((f) => f.web?.searchProvider),
      searchApiKeyEnv: last((f) => f.web?.searchApiKeyEnv),
      maxResults: last((f) => f.web?.maxResults) ?? DEFAULT_CONFIG.web.maxResults,
      timeoutMs: last((f) => f.web?.timeoutMs) ?? DEFAULT_CONFIG.web.timeoutMs,
      allowedDomains: union(...files.map((f) => f.web?.allowedDomains)),
    },
    skills: {
      directories: skillsDirs,
      disabled: union(...files.map((f) => f.skills?.disabled)),
      autoSelect: last((f) => f.skills?.autoSelect) ?? DEFAULT_CONFIG.skills.autoSelect,
      maxActive: last((f) => f.skills?.maxActive) ?? DEFAULT_CONFIG.skills.maxActive,
      registryUrl: last((f) => f.skills?.registryUrl),
    },
    plugins: {
      directories: pluginDirs,
      disabled: union(...files.map((f) => f.plugins?.disabled)),
      enabled: union(...files.map((f) => f.plugins?.enabled)),
    },
    mcp: {
      enabled: last((f) => f.mcp?.enabled) ?? DEFAULT_CONFIG.mcp.enabled,
    },
  };
}
