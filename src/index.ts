/**
 * Public API for embedding TagCode in other Node.js programs.
 *
 * The CLI, desktop app and TUI are thin clients over `SessionController`;
 * anything they can do is available here without depending on terminal or
 * browser internals.
 */

export { SessionController } from "./controller.js";
export type {
  ConnectOptions,
  ControllerUiHooks,
  DoctorReport,
  InitializeReport,
  SessionControllerOptions,
  SkillCreationSource,
} from "./controller.js";

export { AgentOrchestrator } from "./agent/orchestrator.js";
export type {
  AgentHooks,
  AgentMemoryAdapter,
  AgentOrchestratorOptions,
} from "./agent/orchestrator.js";
export { PermissionManager, matchesToolPattern } from "./agent/permissions.js";
export type { ApprovalBroker, PermissionDecision } from "./agent/permissions.js";
export { buildSystemPrompt } from "./agent/systemPrompt.js";

export type {
  AgentEvent,
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ChatRequest,
  ImagePart,
  ModelInfo,
  PermissionMode,
  PlanStep,
  Provider,
  ProviderCapabilities,
  SessionPlan,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolPermission,
  ToolResult,
} from "./core/types.js";
export { CancelledError, ConfigError, PermissionDeniedError, TagCodeError, toError } from "./core/errors.js";

export {
  DEFAULT_CONFIG,
  PERMISSION_MODES,
  PROVIDER_TYPES,
  ProviderConfigSchema,
  ConfigFileSchema,
  McpServerConfigSchema,
} from "./config/schema.js";
export type {
  ConfigFile,
  McpServerConfig,
  ProviderConfig,
  ProviderType,
  ResolvedConfig,
} from "./config/schema.js";
export {
  ensureProjectStructure,
  loadConfig,
  loadMcpConfig,
  readConfigFile,
  readMcpFile,
  selectModel,
  selectProvider,
  updateConfigFile,
  writeConfigFile,
} from "./config/config.js";
export type { LoadedConfig, LoadedMcpConfig } from "./config/config.js";
export { SecretStore } from "./config/secrets.js";
export { tagcodeHome } from "./config/paths.js";

export { PROVIDER_PRESETS, createProvider, createProviderFromConfig, resolveApiKey } from "./providers/registry.js";

export { ToolRegistry } from "./tools/registry.js";
export { registerBuiltinTools } from "./tools/index.js";
export type { AnyTool, ToolContext, ToolCheckpoints, PlanController } from "./tools/types.js";

export { McpManager } from "./mcp/manager.js";
export type { McpServerStatus } from "./mcp/manager.js";
export { PluginHost } from "./plugins/host.js";
export type { PluginApi, PluginModule, PluginStatus } from "./plugins/types.js";
export { SessionStore } from "./sessions/store.js";
export type { SessionSummary, StoredSession } from "./sessions/store.js";
export { createMemoryBundle, searchMemory } from "./memory/store.js";
export type { MemoryBundle } from "./memory/store.js";
export { CheckpointManager } from "./checkpoints/manager.js";
export { SkillLoader } from "./skills/loader.js";
export { SkillManager } from "./skills/manager.js";
export { SkillInstaller } from "./skills/installer.js";
export { validateSkillDirectory } from "./skills/validator.js";
export type { Skill } from "./skills/types.js";

export { WorkspacePaths } from "./security/paths.js";
export { redactSecrets, redactValue } from "./security/redact.js";
export { CommandRegistry, tokenize } from "./commands/types.js";
export type { CommandDefinition, CommandInput, CommandResult } from "./commands/types.js";

export { VERSION, NAME } from "./version.js";

export { launchDesktop, openAppWindow, startDesktopServer } from "./desktop/server.js";
export type {
  DesktopServer,
  DesktopServerOptions,
  LaunchDesktopOptions,
} from "./desktop/server.js";
