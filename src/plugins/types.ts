import type { z } from "zod";
import type { PluginManifest } from "../config/schema.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { ToolPermission, ToolResult } from "../core/types.js";
import type { AnyTool, ToolContext } from "../tools/types.js";

export const PLUGIN_API_VERSION = "1" as const;

export type PluginPermission = "read" | "write" | "execute" | "network";

export type PluginSource = "project" | "global" | "configured";

export type PluginDescriptor = {
  name: string;
  version: string;
  description?: string;
  directory: string;
  manifestPath: string;
  entryPath: string;
  source: PluginSource;
  manifest: PluginManifest;
};

export type PluginState = "loaded" | "disabled" | "error" | "pending";

export type PluginStatus = {
  name: string;
  version?: string;
  description?: string;
  directory?: string;
  source?: PluginSource;
  state: PluginState;
  permissions: PluginPermission[];
  tools: string[];
  commands: string[];
  hooks: string[];
  error?: string;
  reason?: string;
};

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginCommandContext = {
  workspace: string;
  projectRoot: string;
  sessionId?: string;
  config: ResolvedConfig;
  signal?: AbortSignal;
};

/**
 * A slash command contributed by a plugin. Commands are addressed as
 * `/plugin:<plugin-name>:<command-name>` so they can never shadow built-ins.
 */
export type PluginCommand = {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[], context: PluginCommandContext) => Promise<string | void> | string | void;
};

export type PluginHookPayloads = {
  session_start: { sessionId: string; workspace: string };
  session_end: { sessionId: string; reason: string };
  before_prompt: { text: string; sessionId: string };
  after_response: { text: string; sessionId: string };
  before_tool: { toolName: string; arguments: unknown; sessionId: string };
  after_tool: {
    toolName: string;
    arguments: unknown;
    result: ToolResult;
    sessionId: string;
  };
};

export type PluginHookName = keyof PluginHookPayloads;

export type PluginHook<K extends PluginHookName = PluginHookName> = (
  payload: PluginHookPayloads[K],
  api: PluginApi,
) => void | Partial<PluginHookPayloads[K]> | Promise<void | Partial<PluginHookPayloads[K]>>;

export type PluginTool = Omit<AnyTool, "name"> & { name: string };

export type PluginApi = {
  /** Plugin identity. */
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  /** Workspace the user launched TagCode in. */
  readonly workspace: string;
  readonly projectRoot: string;
  /** Resolved configuration. Treat as read-only. */
  readonly config: ResolvedConfig;
  /** Declared capabilities from the manifest. */
  readonly permissions: readonly PluginPermission[];
  hasPermission(permission: PluginPermission): boolean;
  log(level: PluginLogLevel, message: string, data?: unknown): void;
  /**
   * Register a model tool. The tool's permission must be covered by the
   * manifest's declared permissions; the standard approval gate still runs on
   * every call.
   */
  registerTool(tool: PluginTool): void;
  registerCommand(command: PluginCommand): void;
  on<K extends PluginHookName>(event: K, handler: PluginHook<K>): void;
};

export type PluginModule = {
  activate(api: PluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
};

export type PluginFactory = (api: PluginApi) => void | Promise<void>;

export type LoadedPlugin = {
  descriptor: PluginDescriptor;
  status: PluginStatus;
  deactivate?: () => void | Promise<void>;
  toolNames: string[];
  commandKeys: string[];
  hookNames: PluginHookName[];
};

export type RegistrableTool = AnyTool & { name: string };

export type HookHandler = {
  plugin: string;
  event: PluginHookName;
  handler: PluginHook;
};

export type RegisteredCommand = {
  plugin: string;
  key: string;
  command: PluginCommand;
};

/** Concrete Zod schemas are not exported from plugins; this alias documents intent. */
export type PluginSchema = z.ZodType;
