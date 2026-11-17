import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  ImagePart,
  PermissionMode,
  Provider,
  SessionPlan,
  TokenUsage,
} from "./core/types.js";
import type { ConfigFile, McpServerConfig, ProviderConfig, ProviderType, ResolvedConfig } from "./config/schema.js";
import {
  ensureProjectStructure,
  loadConfig,
  loadMcpConfig,
  removeProvider as removeProviderConfig,
  setDefaultProvider,
  updateConfigFile,
  upsertProvider,
  scopeConfigPath,
  type LoadedConfig,
} from "./config/config.js";
import { pathExists } from "./utils/fs.js";
import { tagcodeHome, globalMemoryDir, projectMemoryDir } from "./config/paths.js";
import { SecretStore } from "./config/secrets.js";
import { PermissionManager, type ApprovalBroker } from "./agent/permissions.js";
import { WorkspacePaths } from "./security/paths.js";
import { registerBuiltinTools } from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import type { ToolCheckpoints, PlanController } from "./tools/types.js";
import { SessionStore, type StoredSession, type SessionSummary } from "./sessions/store.js";
import { createMemoryBundle, searchMemory, type MemoryBundle } from "./memory/store.js";
import { SkillLoader } from "./skills/loader.js";
import { SkillManager } from "./skills/manager.js";
import { SkillInstaller, type SkillScope } from "./skills/installer.js";
import { generateSkillMarkdown } from "./skills/creator.js";
import { CheckpointManager, type CheckpointMeta, type RestoreResult } from "./checkpoints/manager.js";
import { McpManager, type McpServerStatus } from "./mcp/manager.js";
import { PluginHost } from "./plugins/host.js";
import type { PluginStatus } from "./plugins/types.js";
import {
  PROVIDER_PRESETS,
  createProviderFromConfig,
  presetFor,
  resolveApiKey,
} from "./providers/registry.js";
import { contextWindowFor } from "./providers/capabilities.js";
import { ContextManager } from "./context/manager.js";
import { loadInstructionFiles, formatInstructions } from "./context/instructions.js";
import { detectProject, summarizeProject, type ProjectInfo } from "./project/detect.js";
import { buildSystemPrompt } from "./agent/systemPrompt.js";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import { CommandRegistry, type CommandResult } from "./commands/types.js";
import { createBuiltinCommands } from "./commands/builtins.js";
import { ConfigError, toError } from "./core/errors.js";
import { selectModel, selectProvider, setDefaultModel } from "./config/config.js";
import { logger } from "./utils/logger.js";

export type ControllerUiHooks = {
  requestInput?: (question: string, options?: string[]) => Promise<string | undefined>;
  requestSecret?: (prompt: string) => Promise<string | undefined>;
  confirm?: (prompt: string) => Promise<boolean>;
};

export type SessionControllerOptions = {
  workspace?: string;
  projectRoot?: string;
  sessionId?: string;
  mode?: AgentMode;
  permissionMode?: PermissionMode;
  providerId?: string;
  model?: string;
  connectMcp?: boolean;
  loadPlugins?: boolean;
  ui?: ControllerUiHooks;
  env?: NodeJS.ProcessEnv;
};

export type InitializeReport = {
  workspace: string;
  projectRoot: string;
  provider?: string;
  model?: string;
  warnings: string[];
};

export type DoctorReport = {
  ok: boolean;
  lines: string[];
};

export type ConnectOptions = {
  id?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  scope?: "global" | "project";
};

/** Context used when generating a skill with `/skills create`. */
export type SkillCreationSource = "description" | "project" | "session" | "all";

const CONTEXT_SAFETY_RATIO = 0.92;

/**
 * Owns the lifetime of every subsystem and is shared by the TUI, the headless
 * CLI and slash commands. Nothing else should construct providers, tools or
 * sessions directly.
 */
export class SessionController {
  readonly workspace: string;
  private readonly options: SessionControllerOptions;
  private readonly ui: ControllerUiHooks;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly commandRegistry: CommandRegistry;
  private readonly planController: PlanController;

  private loadedConfig!: LoadedConfig;
  private resolved!: ResolvedConfig;
  private secrets!: SecretStore;
  private permissions!: PermissionManager;
  private paths!: WorkspacePaths;
  private registry!: ToolRegistry;
  private sessionStore!: SessionStore;
  private memoryBundle!: MemoryBundle;
  private skills!: SkillManager;
  private skillInstaller!: SkillInstaller;
  private checkpoints!: CheckpointManager;
  private session!: StoredSession;

  private mcp?: McpManager;
  private plugins?: PluginHost;
  private projectInfo?: ProjectInfo;
  private projectSummary?: string;
  private provider?: Provider;
  private providerConfig?: ProviderConfig;
  private agent?: AgentOrchestrator;
  private initialMessages: ChatMessage[] = [];
  private initialUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private sessionPlan?: SessionPlan;
  private sessionStarted = false;
  private approvalBroker?: ApprovalBroker;
  private mode: AgentMode;
  private providerOverride?: string;
  private modelOverride?: string;
  private basePermissionMode: PermissionMode = "auto";
  private savedPermissionMode?: PermissionMode;
  private initialized = false;
  private disposed = false;

  constructor(options: SessionControllerOptions = {}) {
    this.options = options;
    this.ui = options.ui ?? {};
    this.workspace = path.resolve(options.workspace ?? process.cwd());
    this.mode = options.mode ?? "agent";
    this.providerOverride = options.providerId;
    this.modelOverride = options.model;
    this.commandRegistry = new CommandRegistry(createBuiltinCommands());

    let plan: SessionPlan | undefined;
    this.planController = {
      get: () => plan,
      set: (next) => {
        plan = next;
        this.sessionPlan = next;
      },
      updateSteps: (steps) => {
        if (!plan) return;
        plan = { ...plan, steps };
        this.sessionPlan = plan;
      },
    };
  }

  get config(): ResolvedConfig {
    return this.resolved;
  }

  get loaded(): LoadedConfig {
    return this.loadedConfig;
  }

  get sessionId(): string {
    return this.session?.id ?? "";
  }

  getSession(): StoredSession {
    return this.session;
  }

  getMode(): AgentMode {
    return this.mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissions.getMode();
  }

  getProviderId(): string {
    return this.providerConfig?.id ?? this.effectiveProviderId();
  }

  getModel(): string {
    return this.agent ? this.modelInUse() : this.effectiveModel();
  }

  getMessages(): ChatMessage[] {
    return this.agent ? this.agent.getMessages() : [...this.initialMessages];
  }

  getUsage(): TokenUsage {
    return this.agent ? this.agent.getUsage() : { ...this.initialUsage };
  }

  getContextStats(): {
    messageCount: number;
    estimatedTokens: number;
    budget: number;
    usage: TokenUsage;
  } | undefined {
    return this.agent?.getContextStats();
  }

  async confirm(prompt: string): Promise<boolean> {
    if (!this.ui.confirm) return false;
    return this.ui.confirm(prompt);
  }

  /** True when the current frontend can show an in-app input modal. */
  canPrompt(): boolean {
    return Boolean(this.ui.requestInput || this.ui.requestSecret);
  }

  async requestInput(prompt: string, options?: string[]): Promise<string | undefined> {
    return this.ui.requestInput?.(prompt, options);
  }

  async requestSecret(prompt: string): Promise<string | undefined> {
    return this.ui.requestSecret?.(prompt);
  }

  getPlan(): SessionPlan | undefined {
    return this.planController.get();
  }

  getProjectSummary(): string | undefined {
    return this.projectSummary;
  }

  getMcpManager(): McpManager | undefined {
    return this.mcp;
  }

  getPluginHost(): PluginHost | undefined {
    return this.plugins;
  }

  getSkillManager(): SkillManager {
    return this.skills;
  }

  getToolRegistry(): ToolRegistry {
    return this.registry;
  }

  getSkillInstaller(): SkillInstaller {
    return this.skillInstaller;
  }

  getMemory(): MemoryBundle {
    return this.memoryBundle;
  }

  getCheckpoints(): CheckpointManager {
    return this.checkpoints;
  }

  getCommandRegistry(): CommandRegistry {
    return this.commandRegistry;
  }

  isRunning(): boolean {
    return this.agent?.isRunning() ?? false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit = (event: AgentEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // UI listeners must never break the agent loop.
      }
    }
  };

  async initialize(): Promise<InitializeReport> {
    if (this.initialized) {
      return {
        workspace: this.workspace,
        projectRoot: this.loadedConfig.projectRoot,
        provider: this.getProviderId() || undefined,
        model: this.getModel() || undefined,
        warnings: [],
      };
    }
    const warnings: string[] = [];
    this.loadedConfig = await loadConfig(this.workspace, { projectRoot: this.options.projectRoot });
    this.resolved = this.loadedConfig.config;
    this.basePermissionMode = this.options.permissionMode ?? this.resolved.permissions.mode;
    this.resolved.permissions.mode = this.basePermissionMode;

    this.paths = await WorkspacePaths.create(this.workspace);
    this.secrets = new SecretStore({ home: tagcodeHome(), env: this.options.env });
    this.permissions = new PermissionManager(this.resolved, { auditHome: tagcodeHome() });
    this.permissions.setMode(this.basePermissionMode);
    if (this.approvalBroker) this.permissions.setBroker(this.approvalBroker);

    this.sessionStore = new SessionStore();
    this.session = await this.loadOrCreateSession();

    this.memoryBundle = createMemoryBundle({
      projectDir: projectMemoryDir(this.loadedConfig.projectRoot),
      globalDir: globalMemoryDir(),
    });

    const skillLoader = new SkillLoader({
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      extraDirectories: this.resolved.skills.directories,
      disabled: this.resolved.skills.disabled,
    });
    this.skills = new SkillManager(skillLoader, {
      maxActive: this.resolved.skills.maxActive,
      autoSelect: this.resolved.skills.autoSelect,
    });
    await this.skills.reload();
    this.skillInstaller = new SkillInstaller({
      projectRoot: this.loadedConfig.projectRoot,
      registryUrl: this.resolved.skills.registryUrl,
    });

    this.checkpoints = new CheckpointManager({
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      sessionId: this.session.id,
    });

    this.registry = new ToolRegistry();
    registerBuiltinTools(this.registry);

    if (this.options.loadPlugins !== false) {
      const pluginResult = await this.loadPlugins();
      warnings.push(...pluginResult);
    }

    if (this.options.connectMcp !== false && this.resolved.mcp.enabled) {
      const mcpWarnings = await this.loadMcp();
      warnings.push(...mcpWarnings);
    }

    await this.refreshProjectInfo();

    try {
      this.providerConfig = selectProvider(this.resolved, this.providerOverride);
      this.basePermissionMode = this.options.permissionMode ?? this.session.permissionMode ?? this.basePermissionMode;
      const model = this.effectiveModel();
      if (model) this.session.model = model;
      this.session.provider = this.providerConfig.id;
      this.session.permissionMode = this.permissions.getMode();
    } catch (error) {
      warnings.push(toError(error).message);
    }

    this.initialized = true;
    for (const warning of warnings) {
      this.emit({ type: "notice", level: "warn", text: warning });
    }
    return {
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      provider: this.getProviderId() || undefined,
      model: this.getModel() || undefined,
      warnings,
    };
  }

  async run(text: string, options: { images?: ImagePart[] } = {}): Promise<void> {
    if (!text.trim() && !(options.images && options.images.length > 0)) return;
    const agent = await this.ensureAgent();
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      await this.plugins?.runHook("session_start", {
        sessionId: this.session.id,
        workspace: this.workspace,
      });
    }
    try {
      await agent.run(text, options);
    } finally {
      try {
        await this.saveSession();
      } catch (error) {
        this.emit({
          type: "notice",
          level: "warn",
          text: `Could not save the session: ${toError(error).message}`,
        });
      }
      await this.plugins?.runHook("session_end", {
        sessionId: this.session.id,
        reason: agent.isRunning() ? "interrupted" : "completed",
      });
    }
  }

  cancel(): void {
    this.agent?.cancel();
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.mode = mode;
    if (mode === "agent") {
      const restore = this.savedPermissionMode ?? this.basePermissionMode;
      this.permissions.setMode(restore);
      this.savedPermissionMode = undefined;
    } else {
      const current = this.permissions.getMode();
      if (current !== "plan") this.savedPermissionMode = current;
      this.permissions.setMode("plan");
    }
    this.agent?.setMode(mode);
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.mode !== "agent" && mode !== "plan") {
      throw new Error("Plan and ask modes are read-only. Switch to /agent before changing permissions.");
    }
    this.basePermissionMode = mode;
    this.resolved.permissions.mode = mode;
    this.permissions.setMode(mode);
    if (this.mode === "agent") this.savedPermissionMode = undefined;
  }

  setApprovalBroker(broker: ApprovalBroker | undefined): void {
    this.approvalBroker = broker;
    this.permissions?.setBroker(broker);
  }

  /** Install or replace interactive UI hooks after construction. */
  setUiHooks(hooks: ControllerUiHooks): void {
    Object.assign(this.ui, hooks);
  }

  async setModel(model: string): Promise<void> {
    const value = model.trim();
    if (!value) throw new Error("Model name cannot be empty.");
    if (this.isRunning()) throw new Error("Cancel the active run before changing models.");
    const providerId = this.effectiveProviderId();
    if (providerId) {
      const project = this.loadedConfig.project;
      const inProject =
        (project.providers ?? []).some((provider) => provider.id === providerId) ||
        project.defaultProvider === providerId;
      await setDefaultModel(inProject ? "project" : "global", value, this.workspace, providerId);
    }
    this.modelOverride = value;
    this.resolved.defaultModel = value;
    const configured = this.resolved.providers.find((provider) => provider.id === providerId);
    if (configured) configured.defaultModel = value;
    this.session.model = value;
    this.agent = undefined;
  }

  async setProvider(providerId: string): Promise<void> {
    if (this.isRunning()) throw new Error("Cancel the active run before changing providers.");
    const provider = selectProvider(this.resolved, providerId);
    this.providerOverride = provider.id;
    this.resolved.defaultProvider = provider.id;
    this.session.provider = provider.id;
    this.modelOverride = provider.defaultModel ?? this.modelOverride;
    this.resolved.defaultModel = provider.defaultModel ?? this.resolved.defaultModel;
    this.agent = undefined;
    this.provider = undefined;
    this.providerConfig = provider;
  }

  async resolveProviderContext(): Promise<{
    provider: Provider;
    providerConfig: ProviderConfig;
    model: string;
  }> {
    const providerConfig = selectProvider(
      this.resolved,
      (this.providerOverride ?? this.session.provider) || this.resolved.defaultProvider,
    );
    const model = selectModel(this.resolved, providerConfig, this.modelOverride ?? this.session.model);
    const provider = await createProviderFromConfig(providerConfig, this.secrets);
    return { provider, providerConfig, model };
  }

  async listModels(): Promise<{ models: string[]; error?: string }> {
    let providerConfig: ProviderConfig;
    try {
      providerConfig = selectProvider(this.resolved, this.effectiveProviderId());
    } catch (error) {
      return { models: [], error: toError(error).message };
    }
    const configured = [
      ...new Set(
        [providerConfig.defaultModel, ...(providerConfig.models ?? [])].filter(
          (entry): entry is string => Boolean(entry),
        ),
      ),
    ];
    try {
      const provider = await createProviderFromConfig(providerConfig, this.secrets);
      const models = await provider.listModels();
      return { models: models.map((model) => model.id) };
    } catch (error) {
      const suggested = presetFor(providerConfig.type).suggestedModel;
      const fallback = [...new Set([...configured, suggested].filter(Boolean))];
      return { models: fallback, error: toError(error).message };
    }
  }

  async connectProvider(type: ProviderType, options: ConnectOptions = {}): Promise<{
    id: string;
    scope: "global" | "project";
    backend?: "keychain" | "file";
    file: string;
  }> {
    const preset = PROVIDER_PRESETS[type];
    if (!preset) throw new Error(`Unknown provider type: ${type}`);
    const scope = options.scope ?? "global";
    const id = (options.id ?? type).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
      throw new Error("Provider id may contain letters, digits, '-' and '_'.");
    }
    const baseUrl = options.baseUrl ?? preset.baseUrl;
    if (baseUrl) {
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new Error(`Invalid base URL: ${baseUrl}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Provider base URL must use http or https.");
      }
    }
    const model = options.model ?? (preset.suggestedModel || undefined);

    let apiKey = options.apiKey;
    const existing = await this.secrets.get(id, preset.envVars[0]);
    if (!apiKey && preset.requiresKey && !existing) {
      if (!this.ui.requestSecret) {
        throw new ConfigError(
          `Provider "${type}" needs an API key. Set ${preset.envVars[0] ?? "the provider's API key env var"} or run /connect in the interactive UI.`,
        );
      }
      const entered = await this.ui.requestSecret(`API key for ${preset.label}:`);
      if (!entered?.trim()) throw new Error("No API key provided; provider was not configured.");
      apiKey = entered.trim();
    }

    let backend: "keychain" | "file" | undefined;
    if (apiKey) backend = await this.secrets.set(id, apiKey);

    const providerConfig: ProviderConfig = {
      id,
      type,
      name: options.name ?? preset.label,
      baseUrl,
      defaultModel: model,
      contextWindow: preset.contextWindow,
      ...(preset.envVars[0] ? { apiKeyEnv: preset.envVars[0] } : {}),
    };
    const file = await upsertProvider(scope, providerConfig, this.workspace);
    await setDefaultProvider(scope, id, model, this.workspace);
    await this.reloadConfig();
    this.providerOverride = id;
    this.modelOverride = model;
    this.agent = undefined;
    this.provider = undefined;
    return { id, scope, backend, file };
  }

  async removeProvider(providerId: string, scope: "global" | "project" = "global"): Promise<boolean> {
    const removed = await removeProviderConfig(scope, providerId, this.workspace);
    await this.secrets.remove(providerId);
    await this.reloadConfig();
    if (this.providerOverride === providerId) this.providerOverride = undefined;
    this.agent = undefined;
    return removed;
  }

  async reloadConfig(): Promise<void> {
    const activeMode = this.permissions?.getMode() ?? this.basePermissionMode;
    const activeBroker = this.approvalBroker;
    this.loadedConfig = await loadConfig(this.workspace, { projectRoot: this.loadedConfig?.projectRoot });
    this.resolved = this.loadedConfig.config;
    this.permissions = new PermissionManager(this.resolved, { auditHome: tagcodeHome() });
    this.permissions.setMode(activeMode);
    if (activeBroker) this.permissions.setBroker(activeBroker);
    this.basePermissionMode = this.savedPermissionMode ?? activeMode;
  }

  async saveSession(): Promise<string> {
    const messages = this.getMessages();
    const usage = this.getUsage();
    this.session.messages = messages;
    this.session.usage = usage;
    this.session.plan = this.planController.get();
    this.session.provider = this.getProviderId();
    this.session.model = this.modelInUse();
    this.session.permissionMode = this.permissions.getMode();
    this.session.cwd = this.workspace;
    this.session.projectRoot = this.loadedConfig.projectRoot;
    await this.sessionStore.save(this.session);
    return path.join(this.sessionStore.directory, `${this.session.id}.json`);
  }

  async newSession(): Promise<StoredSession> {
    if (this.isRunning()) throw new Error("Cancel the active run before starting a new session.");
    if (this.session.messages.length > 0) await this.saveSession();
    this.agent = undefined;
    this.initialMessages = [];
    this.initialUsage = { inputTokens: 0, outputTokens: 0 };
    this.planController.set(undefined);
    this.sessionPlan = undefined;
    this.sessionStarted = false;
    this.session = this.sessionStore.create({
      cwd: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      provider: this.getProviderId(),
      model: this.modelInUse(),
      permissionMode: this.permissions.getMode(),
    });
    this.checkpoints = new CheckpointManager({
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      sessionId: this.session.id,
    });
    this.emit({ type: "notice", level: "success", text: `Started session ${this.session.id}.` });
    return this.session;
  }

  async loadSession(id: string): Promise<StoredSession> {
    if (this.isRunning()) throw new Error("Cancel the active run before switching sessions.");
    const targetId = id === "latest" ? (await this.sessionStore.list({ limit: 1 }))[0]?.id : id;
    if (!targetId) throw new Error("There are no saved sessions for this project.");
    if (this.session && this.session.id !== targetId && this.session.messages.length > 0) {
      await this.saveSession();
    }
    const loaded = await this.sessionStore.load(targetId);
    this.session = loaded;
    this.agent = undefined;
    this.initialMessages = loaded.messages;
    this.initialUsage = loaded.usage;
    this.sessionPlan = loaded.plan;
    this.planController.set(loaded.plan as SessionPlan);
    this.sessionStarted = false;
    this.providerOverride = loaded.provider || this.providerOverride;
    this.modelOverride = loaded.model || this.modelOverride;
    this.checkpoints = new CheckpointManager({
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      sessionId: loaded.id,
    });
    this.basePermissionMode = loaded.permissionMode;
    if (this.mode === "agent") this.permissions.setMode(loaded.permissionMode);
    this.emit({
      type: "notice",
      level: "info",
      text: `Resumed ${loaded.id} (${loaded.messages.length} messages, ${loaded.provider}/${loaded.model || "no model"}).`,
    });
    return loaded;
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.sessionStore.list({ projectRoot: this.loadedConfig.projectRoot, limit: 100 });
  }

  async renameSession(title: string): Promise<void> {
    await this.sessionStore.rename(this.session.id, title);
    this.session.title = title;
  }

  async deleteSession(id: string): Promise<void> {
    if (id === this.session.id) {
      throw new Error("Cannot delete the active session. Start a new session first.");
    }
    await this.sessionStore.delete(id);
  }

  async exportSession(destination?: string): Promise<string> {
    return this.sessionStore.export(this.session.id, destination);
  }

  async compact(): Promise<{ before: number; after: number }> {
    if (this.isRunning()) throw new Error("Cannot compact while the agent is running.");
    const agent = await this.ensureAgent();
    const result = await agent.compactNow();
    await this.saveSession();
    return result;
  }

  async clearConversation(): Promise<void> {
    if (this.isRunning()) throw new Error("Cancel the active run before clearing the conversation.");
    this.agent?.clear();
    this.initialMessages = [];
    this.initialUsage = { inputTokens: 0, outputTokens: 0 };
    this.planController.set(undefined);
    this.sessionPlan = undefined;
    this.session.messages = [];
    this.session.usage = { inputTokens: 0, outputTokens: 0 };
    this.session.plan = undefined;
    await this.saveSession();
  }

  async undo(): Promise<RestoreResult | undefined> {
    return this.checkpoints.undo();
  }

  async redo(): Promise<RestoreResult | undefined> {
    return this.checkpoints.redo();
  }

  listCheckpoints(limit = 20): Promise<CheckpointMeta[]> {
    return this.checkpoints.list(limit);
  }

  async createCheckpoint(paths: string[], reason: string): Promise<string | undefined> {
    return this.checkpoints.capture(paths, reason);
  }

  async refreshSkills(): Promise<void> {
    await this.skills.reload();
  }

  async createSkill(description: string, scope: SkillScope = "project", source: SkillCreationSource = "all"): Promise<{
    markdown: string;
    installed?: string;
    errors: string[];
    warnings: string[];
  }> {
    const { provider, model } = await this.resolveProviderContext();
    const result = await generateSkillMarkdown({
      provider,
      model,
      input: {
        description,
        projectSummary: source === "description" ? undefined : this.projectSummary,
        conventions:
          source === "project" || source === "all" ? await this.readInstructions() : undefined,
        sessionTranscript:
          source === "session" || source === "all"
            ? this.getMessages()
                .slice(-20)
                .map((message) => `${message.role}: ${message.content.slice(0, 1500)}`)
                .join("\n\n")
            : undefined,
      },
      signal: AbortSignal.timeout(180_000),
    });
    if (!result.valid) {
      return { markdown: result.markdown, errors: result.errors, warnings: result.warnings };
    }
    const skill = await this.skillInstaller.installFromContent(result.markdown, scope, {
      force: false,
      source: `generated by TagCode: ${description}`,
    });
    await this.refreshSkills();
    return {
      markdown: result.markdown,
      installed: `${skill.name} (${scope})`,
      errors: [],
      warnings: result.warnings,
    };
  }

  async reloadPlugins(): Promise<PluginStatus[]> {
    await this.plugins?.dispose();
    this.plugins = undefined;
    const warnings = await this.loadPlugins();
    for (const warning of warnings) {
      this.emit({ type: "notice", level: "warn", text: warning });
    }
    const host = this.plugins as PluginHost | undefined;
    return host ? host.getStatuses() : [];
  }

  async setPluginEnabled(
    name: string,
    enabled: boolean,
    scope: "global" | "project" = "global",
  ): Promise<void> {
    const filePath = scopeConfigPath(scope, this.workspace);
    await updateConfigFile(filePath, (current) => {
      const plugins = { ...(current.plugins ?? {}) };
      const enabledList = new Set(plugins.enabled ?? []);
      const disabledList = new Set(plugins.disabled ?? []);
      if (enabled) {
        enabledList.add(name);
        disabledList.delete(name);
      } else {
        enabledList.delete(name);
        disabledList.add(name);
      }
      plugins.enabled = [...enabledList];
      plugins.disabled = [...disabledList];
      return { ...current, plugins };
    });
    await this.reloadConfig();
    await this.reloadPlugins();
  }

  async reloadMcp(): Promise<McpServerStatus[]> {
    await this.mcp?.disconnectAll();
    this.mcp = undefined;
    if (!this.resolved.mcp.enabled) return [];
    await this.loadMcp();
    const manager = this.mcp as McpManager | undefined;
    return manager ? manager.getStatuses() : [];
  }

  async refreshProjectInfo(): Promise<ProjectInfo | undefined> {
    try {
      this.projectInfo = await detectProject(this.loadedConfig.projectRoot);
      this.projectSummary = summarizeProject(this.projectInfo);
    } catch (error) {
      this.projectInfo = undefined;
      this.projectSummary = undefined;
      logger.debug("controller", "project detection failed", toError(error).message);
    }
    return this.projectInfo;
  }

  /**
   * Create `.tagcode` scaffolding and a factual AGENTS.md if the project does
   * not have one. Never overwrites existing instructions.
   */
  async initProject(): Promise<{ created: string[]; agentsFile?: string; agentSkipped?: boolean }> {
    const created = await ensureProjectStructure(this.loadedConfig.projectRoot);
    const agentsPath = path.join(this.loadedConfig.projectRoot, "AGENTS.md");
    let agentSkipped = false;
    if (await pathExists(agentsPath)) {
      agentSkipped = true;
    } else {
      const info = await this.refreshProjectInfo();
      const lines = [
        "# Project instructions",
        "",
        `Generated by TagCode /init on ${new Date().toISOString().slice(0, 10)}. Edit freely.`,
        "",
      ];
      if (info) {
        lines.push("## Detected project", "", summarizeProject(info), "");
      }
      lines.push(
        "## Working agreements",
        "",
        "- Inspect the relevant code before changing it.",
        "- Keep changes focused and match the existing style.",
        "- Run the project's checks before reporting success.",
        "- Document any behavior change that affects users or configuration.",
        "",
      );
      await fs.writeFile(agentsPath, lines.join("\n"), { encoding: "utf8", flag: "wx" });
      created.push(agentsPath);
    }
    await this.refreshProjectInfo();
    return { created, agentsFile: agentsPath, agentSkipped };
  }

  async executeCommand(line: string): Promise<CommandResult> {
    const trimmed = line.trim();
    if (trimmed.startsWith("/plugin:")) {
      const body = trimmed.slice("/plugin:".length).trim();
      const [key, ...args] = body.split(/\s+/);
      if (!key || !key.includes(":")) {
        return {
          handled: true,
          output: "Usage: /plugin:<plugin-name>:<command> [args]. Run /plugins to list plugin commands.",
        };
      }
      try {
        const result = await this.plugins?.executeCommand(key, args, {
          workspace: this.workspace,
          projectRoot: this.loadedConfig.projectRoot,
          sessionId: this.session.id,
          config: this.resolved,
        });
        return { handled: true, output: result || `/${trimmed.slice(1)} completed.` };
      } catch (error) {
        return { handled: true, output: toError(error).message };
      }
    }
    return this.commandRegistry.execute(trimmed, this);
  }

  getConfigValue(dotted: string): unknown {
    const parts = dotted.split(".").filter(Boolean);
    let current: unknown = this.resolved;
    for (const part of parts) {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  async setConfigValue(
    dotted: string,
    rawValue: string,
    scope: "global" | "project" = "global",
  ): Promise<void> {
    const parts = dotted.split(".").filter(Boolean);
    if (parts.length === 0) throw new Error("Configuration key is required.");
    if (parts[0] === "providers") {
      throw new Error("Use /connect to change providers; /config cannot edit the providers array.");
    }
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    if (typeof value === "string") {
      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (value === "null") value = null;
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    }
    const filePath = scopeConfigPath(scope, this.workspace);
    await updateConfigFile(filePath, (current) => {
      const next = { ...current } as ConfigFile;
      let target: Record<string, unknown> = next as unknown as Record<string, unknown>;
      for (let index = 0; index < parts.length - 1; index++) {
        const part = parts[index]!;
        const existing = target[part];
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
          target[part] = {};
        }
        target = target[part] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]!] = value;
      return next;
    });
    await this.reloadConfig();
  }

  async doctor(): Promise<DoctorReport> {
    const lines: string[] = [];
    let ok = true;
    const check = (condition: boolean, label: string, detail: string): void => {
      if (!condition) ok = false;
      lines.push(`${condition ? "✔" : "✘"} ${label}: ${detail}`);
    };

    const major = Number(process.versions.node.split(".")[0]);
    check(major >= 22, "Node.js", `${process.version} (requires >=22)`);
    lines.push(`• Platform: ${process.platform} ${process.arch}`);
    lines.push(`• Workspace: ${this.workspace}`);
    lines.push(`• Project root: ${this.loadedConfig.projectRoot}`);
    check(await pathExists(globalConfigPathSafe()), "Global config", globalConfigPathSafe());
    check(
      await pathExists(path.join(this.loadedConfig.projectRoot, ".tagcode")),
      "Project scaffolding",
      path.join(this.loadedConfig.projectRoot, ".tagcode"),
    );

    if (this.resolved.providers.length === 0) {
      ok = false;
      lines.push("✘ Providers: none configured. Run `tgc connect <provider>` or /connect.");
    } else {
      for (const provider of this.resolved.providers) {
        const key = await resolveApiKey(provider, this.secrets);
        const preset = presetFor(provider.type);
        const keyStatus = preset.requiresKey ? (key ? "API key present" : "API key MISSING") : "no key required";
        if (preset.requiresKey && !key) ok = false;
        lines.push(
          `• Provider ${provider.id} (${provider.type}): ${keyStatus}, model ${provider.defaultModel ?? "(unset)"}`,
        );
      }
    }

    try {
      const secretInfo = await this.secrets.describe();
      lines.push(
        `• Secret backend: ${secretInfo.backend}${secretInfo.backend === "file" ? " (plaintext file — OS keychain unavailable)" : ""}`,
      );
      if (secretInfo.backend === "file" && secretInfo.fileExists) {
        lines.push("  The fallback auth file is readable by your OS user only (mode 0600).");
      }
    } catch (error) {
      lines.push(`• Secret backend: unavailable (${toError(error).message})`);
    }

    try {
      const git = await import("./git/repo.js");
      if (await git.isGitRepository(this.workspace)) {
        const branch = await git.currentBranch(this.workspace);
        const status = await git.gitStatusPorcelain(this.workspace);
        lines.push(`• Git: repository on ${branch ?? "detached HEAD"}; ${status.split("\n").length - 1} changed path(s)`);
      } else {
        lines.push("• Git: not a repository");
      }
    } catch (error) {
      lines.push(`• Git: unavailable (${toError(error).message})`);
    }

    const skills = this.skills?.list() ?? [];
    const invalidSkills = skills.filter((skill) => !skill.valid);
    if (invalidSkills.length > 0) ok = false;
    lines.push(`• Skills: ${skills.length} discovered, ${invalidSkills.length} invalid`);

    const mcpStatuses = this.mcp?.getStatuses() ?? [];
    const failedMcp = mcpStatuses.filter((status) => status.state === "error");
    if (failedMcp.length > 0) ok = false;
    lines.push(
      `• MCP: ${mcpStatuses.filter((status) => status.state === "connected").length} connected, ${failedMcp.length} failed, ${mcpStatuses.length} configured`,
    );

    const pluginStatuses = this.plugins?.getStatuses() ?? [];
    const failedPlugins = pluginStatuses.filter((status) => status.state === "error");
    if (failedPlugins.length > 0) ok = false;
    lines.push(
      `• Plugins: ${pluginStatuses.filter((status) => status.state === "loaded").length} loaded, ${failedPlugins.length} failed, ${pluginStatuses.length} discovered`,
    );

    lines.push(`• Permission mode: ${this.permissions.getMode()} (interaction: ${this.mode})`);
    lines.push(
      `• Context: ${this.resolved.context.maxTokens === 0 ? "auto" : this.resolved.context.maxTokens} budget, compact at ${Math.round(this.resolved.context.compactAt * 100)}%`,
    );
    return { ok, lines };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    try {
      if (this.session) await this.saveSession();
    } catch {
      // Best effort on shutdown.
    }
    await this.plugins?.dispose().catch(() => undefined);
    await this.mcp?.disconnectAll().catch(() => undefined);
  }

  private async ensureAgent(): Promise<AgentOrchestrator> {
    if (!this.initialized) await this.initialize();
    const providerConfig = selectProvider(
      this.resolved,
      (this.providerOverride ?? this.session.provider) || this.resolved.defaultProvider,
    );
    const model = selectModel(this.resolved, providerConfig, this.modelOverride ?? this.session.model);
    if (
      this.agent &&
      this.providerConfig?.id === providerConfig.id &&
      this.modelInUse() === model
    ) {
      return this.agent;
    }
    if (this.agent?.isRunning()) throw new Error("The agent is already running.");

    const messages = this.agent ? this.agent.getMessages() : this.initialMessages;
    const usage = this.agent ? this.agent.getUsage() : this.initialUsage;
    if (this.agent) this.sessionPlan = this.agent.getPlan();
    this.agent = undefined;

    const provider = await createProviderFromConfig(providerConfig, this.secrets);
    const configuredBudget = this.resolved.context.maxTokens;
    const window = contextWindowFor(model, providerConfig.type, providerConfig.contextWindow);
    const budget = configuredBudget > 0
      ? Math.max(4096, configuredBudget)
      : Math.max(4096, Math.floor(window * CONTEXT_SAFETY_RATIO));
    const context = new ContextManager({
      provider,
      model,
      budget,
      compactAt: this.resolved.context.compactAt,
      keepRecentMessages: this.resolved.context.keepRecentMessages,
    });

    const agent = new AgentOrchestrator({
      provider,
      model,
      registry: this.registry,
      config: this.resolved,
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      paths: this.paths,
      permissions: this.permissions,
      secrets: this.secrets,
      sessionId: this.session.id,
      mode: this.mode,
      context,
      systemPrompt: () => this.buildSystemPrompt(),
      emit: this.emit,
      planController: this.planController,
      hooks: this.plugins,
      skills: this.skills,
      memory: {
        search: (query, limit) => searchMemory(this.memoryBundle, query, limit),
        append: async (section, text) => {
          await this.memoryBundle.project.append(section, text);
        },
      },
      checkpoints: {
        capture: (paths: string[], reason: string) => this.checkpoints.capture(paths, reason),
      } satisfies ToolCheckpoints,
      requestUserInput: this.ui.requestInput
        ? async (question, options) => (await this.ui.requestInput!(question, options)) ?? ""
        : undefined,
      maxSteps: this.resolved.context.maxSteps,
      initialMessages: messages,
      usage,
    });

    this.provider = provider;
    this.providerConfig = providerConfig;
    this.agent = agent;
    this.session.provider = providerConfig.id;
    this.session.model = model;
    return agent;
  }

  private modelInUse(): string {
    return this.providerConfig && this.agent
      ? selectModel(this.resolved, this.providerConfig, this.modelOverride ?? this.session.model)
      : this.effectiveModel();
  }

  private effectiveProviderId(): string {
    return (
      this.providerOverride ||
      this.session?.provider ||
      this.resolved.defaultProvider ||
      this.resolved.providers.find((provider) => provider.enabled !== false)?.id ||
      ""
    );
  }

  private effectiveModel(): string {
    if (this.modelOverride) return this.modelOverride;
    if (this.session?.model) return this.session.model;
    return this.resolved.defaultModel;
  }

  private async loadOrCreateSession(): Promise<StoredSession> {
    if (this.options.sessionId) {
      const loaded = await this.sessionStore.load(this.options.sessionId);
      this.initialMessages = loaded.messages;
      this.initialUsage = loaded.usage;
      this.sessionPlan = loaded.plan;
      this.planController.set(loaded.plan as SessionPlan);
      this.providerOverride = this.options.providerId ?? loaded.provider ?? undefined;
      this.modelOverride = this.options.model ?? loaded.model ?? undefined;
      this.basePermissionMode =
        this.options.permissionMode ?? loaded.permissionMode ?? this.basePermissionMode;
      return loaded;
    }
    const session = this.sessionStore.create({
      cwd: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      provider: this.effectiveProviderId(),
      model: this.effectiveModel(),
      permissionMode: this.basePermissionMode,
    });
    return session;
  }

  private async loadPlugins(): Promise<string[]> {
    const warnings: string[] = [];
    try {
      this.plugins = new PluginHost({
        registry: this.registry,
        config: this.resolved,
        workspace: this.workspace,
        projectRoot: this.loadedConfig.projectRoot,
      });
      const statuses = await this.plugins.load();
      for (const status of statuses) {
        if (status.state === "error") {
          warnings.push(`Plugin ${status.name} failed: ${status.error ?? "unknown error"}`);
        }
      }
    } catch (error) {
      warnings.push(`Plugin system unavailable: ${toError(error).message}`);
    }
    return warnings;
  }

  private async loadMcp(): Promise<string[]> {
    const warnings: string[] = [];
    try {
      const mcpConfig = await loadMcpConfig(this.workspace, this.loadedConfig.projectRoot);
      const servers = Object.fromEntries(
        Object.entries(mcpConfig.servers).filter(([, config]) => config.enabled !== false),
      ) as Record<string, McpServerConfig>;
      this.mcp = new McpManager({
        servers,
        projectRoot: this.loadedConfig.projectRoot,
        registry: this.registry,
        sources: mcpConfig.sources,
      });
      const statuses = await this.mcp.connectAll();
      for (const status of statuses) {
        if (status.state === "error") {
          warnings.push(`MCP server ${status.name} failed: ${status.error ?? "connection error"}`);
        }
      }
    } catch (error) {
      warnings.push(`MCP configuration error: ${toError(error).message}`);
    }
    return warnings;
  }

  private async readInstructions(): Promise<string> {
    try {
      const files = await loadInstructionFiles({
        workspace: this.workspace,
        projectRoot: this.loadedConfig.projectRoot,
      });
      return formatInstructions(files);
    } catch (error) {
      logger.debug("controller", "instruction loading failed", toError(error).message);
      return "";
    }
  }

  private async buildSystemPrompt(): Promise<string> {
    const [instructions, projectMemory, globalMemory] = await Promise.all([
      this.readInstructions(),
      this.memoryBundle.project.readAll(6000),
      this.memoryBundle.global.readAll(3000),
    ]);
    const memory = [projectMemory, globalMemory].filter((entry) => entry.trim()).join("\n\n");
    const providerName = this.providerConfig ? presetFor(this.providerConfig.type).label : "not configured";
    return buildSystemPrompt({
      mode: this.mode,
      config: this.resolved,
      workspace: this.workspace,
      projectRoot: this.loadedConfig.projectRoot,
      projectSummary: this.projectSummary,
      instructions: instructions || undefined,
      memory: memory || undefined,
      skillsIndex: this.skills.buildIndex(),
      activeSkills: this.skills.formatActiveInstructions(),
      plan: this.planController.get(),
      toolNames: this.registry.names(),
      provider: this.providerConfig
        ? { id: this.providerConfig.id, name: providerName, model: this.modelInUse() }
        : undefined,
      sessionId: this.session.id,
    });
  }
}

function globalConfigPathSafe(): string {
  return path.join(tagcodeHome(), "config.json");
}
