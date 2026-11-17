import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ConfigFileSchema,
  McpFileSchema,
  resolveConfig,
  type ConfigFile,
  type McpServerConfig,
  type ProviderConfig,
  type ResolvedConfig,
} from "./schema.js";
import {
  findProjectRoot,
  globalConfigPath,
  globalMcpPath,
  projectConfigPath,
  projectCheckpointsDir,
  projectDir,
  projectMcpPath,
  projectMemoryDir,
  projectSessionsDir,
  projectSkillsDir,
} from "./paths.js";
import { ConfigError, TagCodeError } from "../core/errors.js";
import { readJson, writeJson, pathExists, ensureDir } from "../utils/fs.js";

export type LoadedConfig = {
  workspace: string;
  projectRoot: string;
  globalPath: string;
  projectPath: string;
  global: ConfigFile;
  project: ConfigFile;
  config: ResolvedConfig;
};

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}

export async function readConfigFile(filePath: string): Promise<ConfigFile> {
  const raw = await readJson<unknown>(filePath, {});
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Config file must contain a JSON object: ${filePath}`);
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid TagCode config in ${filePath}:\n${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

export async function loadConfig(
  workspace = process.cwd(),
  options: { projectRoot?: string } = {},
): Promise<LoadedConfig> {
  const resolvedWorkspace = path.resolve(workspace);
  const projectRoot = options.projectRoot ?? (await findProjectRoot(resolvedWorkspace));
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(projectRoot);

  const [global, project] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
  ]);

  return {
    workspace: resolvedWorkspace,
    projectRoot,
    globalPath,
    projectPath,
    global,
    project,
    config: resolveConfig([global, project]),
  };
}

export async function writeConfigFile(filePath: string, file: ConfigFile): Promise<void> {
  const parsed = ConfigFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new ConfigError(`Refusing to write invalid config:\n${formatIssues(parsed.error.issues)}`);
  }
  await writeJson(filePath, parsed.data);
}

export async function updateConfigFile(
  filePath: string,
  updater: (current: ConfigFile) => ConfigFile | Promise<ConfigFile>,
): Promise<ConfigFile> {
  const current = await readConfigFile(filePath);
  const next = await updater(current);
  await writeConfigFile(filePath, next);
  return next;
}

export function scopeConfigPath(scope: "global" | "project", workspace: string): string {
  return scope === "global" ? globalConfigPath() : projectConfigPath(workspace);
}

export async function upsertProvider(
  scope: "global" | "project",
  provider: ProviderConfig,
  workspace: string,
): Promise<string> {
  const filePath = scopeConfigPath(scope, workspace);
  await updateConfigFile(filePath, (current) => {
    const providers = [...(current.providers ?? [])];
    const index = providers.findIndex((entry) => entry.id === provider.id);
    if (index >= 0) providers[index] = { ...providers[index], ...provider };
    else providers.push(provider);
    const next: ConfigFile = { ...current, version: 1, providers };
    if (!current.defaultProvider) next.defaultProvider = provider.id;
    return next;
  });
  return filePath;
}

export async function removeProvider(
  scope: "global" | "project",
  providerId: string,
  workspace: string,
): Promise<boolean> {
  const filePath = scopeConfigPath(scope, workspace);
  let removed = false;
  await updateConfigFile(filePath, (current) => {
    const providers = (current.providers ?? []).filter((entry) => {
      if (entry.id === providerId) {
        removed = true;
        return false;
      }
      return true;
    });
    const next: ConfigFile = { ...current, providers };
    if (current.defaultProvider === providerId) {
      next.defaultProvider = providers[0]?.id;
    }
    return next;
  });
  return removed;
}

export async function setDefaultProvider(
  scope: "global" | "project",
  providerId: string,
  model: string | undefined,
  workspace: string,
): Promise<void> {
  const filePath = scopeConfigPath(scope, workspace);
  await updateConfigFile(filePath, (current) => {
    const next: ConfigFile = { ...current, defaultProvider: providerId };
    if (model) next.defaultModel = model;
    else if (current.defaultProvider !== providerId) delete next.defaultModel;
    return next;
  });
}

export async function setDefaultModel(
  scope: "global" | "project",
  model: string,
  workspace: string,
  providerId?: string,
): Promise<void> {
  const filePath = scopeConfigPath(scope, workspace);
  await updateConfigFile(filePath, (current) => {
    const providers = (current.providers ?? []).map((provider) =>
      providerId && provider.id === providerId ? { ...provider, defaultModel: model } : provider,
    );
    return { ...current, defaultModel: model, ...(providerId ? { providers } : {}) };
  });
}

export function selectProvider(config: ResolvedConfig, providerId?: string): ProviderConfig {
  const enabled = config.providers.filter((provider) => provider.enabled !== false);
  if (enabled.length === 0) {
    throw new ConfigError(
      "No model provider is configured. Run `tgc /connect` inside TagCode, or `tgc connect <provider>`.",
    );
  }
  const targetId = providerId || config.defaultProvider || enabled[0]!.id;
  const provider = enabled.find((entry) => entry.id === targetId);
  if (!provider) {
    throw new ConfigError(
      `Unknown provider "${targetId}". Available: ${enabled.map((entry) => entry.id).join(", ")}`,
    );
  }
  return provider;
}

export function selectModel(
  config: ResolvedConfig,
  provider: ProviderConfig,
  modelOverride?: string,
): string {
  const model = modelOverride || config.defaultModel || provider.defaultModel;
  if (!model) {
    throw new ConfigError(
      `No model selected for provider "${provider.id}". Use /model <name> or set defaultModel in config.json.`,
    );
  }
  return model;
}

export type McpConfigFile = { mcpServers: Record<string, McpServerConfig> } & Record<string, unknown>;

export async function readMcpFile(filePath: string): Promise<McpConfigFile> {
  const raw = await readJson<unknown>(filePath, { mcpServers: {} });
  const parsed = McpFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid MCP config in ${filePath}:\n${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data as McpConfigFile;
}

export type LoadedMcpConfig = {
  servers: Record<string, McpServerConfig>;
  globalPath: string;
  projectPath: string;
  sources: Record<string, "global" | "project">;
};

export async function loadMcpConfig(
  workspace: string,
  projectRoot?: string,
): Promise<LoadedMcpConfig> {
  const root = projectRoot ?? (await findProjectRoot(workspace));
  const globalPath = globalMcpPath();
  const projectPath = projectMcpPath(root);
  const [globalFile, projectFile] = await Promise.all([
    readMcpFile(globalPath),
    readMcpFile(projectPath),
  ]);
  const servers: Record<string, McpServerConfig> = { ...globalFile.mcpServers };
  const sources: Record<string, "global" | "project"> = {};
  for (const key of Object.keys(globalFile.mcpServers)) sources[key] = "global";
  for (const [key, value] of Object.entries(projectFile.mcpServers)) {
    servers[key] = value;
    sources[key] = "project";
  }
  return { servers, globalPath, projectPath, sources };
}

export async function upsertMcpServer(
  scope: "global" | "project",
  name: string,
  server: McpServerConfig,
  workspace: string,
): Promise<string> {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(workspace);
  const current = await readMcpFile(filePath);
  current.mcpServers[name] = server;
  await writeJson(filePath, current);
  return filePath;
}

export async function removeMcpServer(
  scope: "global" | "project",
  name: string,
  workspace: string,
): Promise<boolean> {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(workspace);
  const current = await readMcpFile(filePath);
  if (!(name in current.mcpServers)) return false;
  delete current.mcpServers[name];
  await writeJson(filePath, current);
  return true;
}

const PROJECT_GITIGNORE = `# TagCode local state (keep memory/ if you want to share project knowledge)
sessions/
checkpoints/
cache/
logs/
`;

/**
 * Create the `.tagcode` project structure without overwriting user files.
 * Returns the list of paths that were created.
 */
export async function ensureProjectStructure(workspace: string): Promise<string[]> {
  const root = path.resolve(workspace);
  const created: string[] = [];
  const dirs = [
    projectDir(root),
    projectMemoryDir(root),
    projectSkillsDir(root),
    projectSessionsDir(root),
    projectCheckpointsDir(root),
  ];
  for (const dir of dirs) {
    if (!(await pathExists(dir))) {
      await ensureDir(dir);
      created.push(dir);
    }
  }

  const gitignore = path.join(projectDir(root), ".gitignore");
  if (!(await pathExists(gitignore))) {
    await fs.writeFile(gitignore, PROJECT_GITIGNORE, "utf8");
    created.push(gitignore);
  }

  const configPath = projectConfigPath(root);
  if (!(await pathExists(configPath))) {
    await writeConfigFile(configPath, { version: 1 });
    created.push(configPath);
  }

  const mcpPath = projectMcpPath(root);
  if (!(await pathExists(mcpPath))) {
    await fs.writeFile(mcpPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");
    created.push(mcpPath);
  }

  return created;
}

export function describeConfig(config: ResolvedConfig): string {
  const lines = [
    `Providers: ${config.providers.length} (${config.providers.map((p) => p.id).join(", ") || "none"})`,
    `Default provider: ${config.defaultProvider || "(not set)"}`,
    `Default model: ${config.defaultModel || "(not set)"}`,
    `Permission mode: ${config.permissions.mode}`,
    `Max steps: ${config.context.maxSteps}`,
    `Context budget: ${config.context.maxTokens === 0 ? "auto" : config.context.maxTokens}`,
    `MCP enabled: ${config.mcp.enabled}`,
  ];
  return lines.join("\n");
}

export async function configExists(scope: "global" | "project", workspace: string): Promise<boolean> {
  return pathExists(scopeConfigPath(scope, workspace));
}

export function asTagCodeError(error: unknown): TagCodeError {
  if (error instanceof TagCodeError) return error;
  return new TagCodeError(error instanceof Error ? error.message : String(error));
}
