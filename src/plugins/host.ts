import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PluginManifestSchema,
  type PluginManifest,
  type ResolvedConfig,
} from "../config/schema.js";
import { globalPluginsDir, projectDir } from "../config/paths.js";
import { expandHome } from "../utils/fs.js";
import { isPathInside } from "../security/paths.js";
import { logger } from "../utils/logger.js";
import type { ToolPermission, ToolResult } from "../core/types.js";
import type { AnyTool, ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  PLUGIN_API_VERSION,
  type HookHandler,
  type LoadedPlugin,
  type PluginApi,
  type PluginCommand,
  type PluginCommandContext,
  type PluginDescriptor,
  type PluginFactory,
  type PluginHook,
  type PluginHookName,
  type PluginHookPayloads,
  type PluginLogLevel,
  type PluginModule,
  type PluginPermission,
  type PluginSource,
  type PluginState,
  type PluginStatus,
  type PluginTool,
  type RegisteredCommand,
} from "./types.js";

export type PluginHostOptions = {
  registry: ToolRegistry;
  config: ResolvedConfig;
  workspace: string;
  projectRoot: string;
  /** Extra search roots, useful for tests. */
  extraDirectories?: string[];
};

const MANIFEST_FILE = "plugin.json";
const VALID_PERMISSIONS: readonly PluginPermission[] = ["read", "write", "execute", "network"];

function sanitizeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "plugin"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFile(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

function isDirectory(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

type ScannedManifest = { descriptor: PluginDescriptor } | { error: PluginStatus };

/**
 * Discovers and loads TagCode plugins.
 *
 * Plugin code runs in the same Node.js process, so the manifest permission
 * list is an enforced capability contract for tool registration, not an OS
 * sandbox. Only enable plugins you trust. Every tool a plugin registers still
 * passes through the central approval gate.
 */
export class PluginHost {
  private readonly registry: ToolRegistry;
  private readonly config: ResolvedConfig;
  private readonly workspace: string;
  private readonly projectRoot: string;
  private readonly extraDirectories: string[];
  private readonly descriptors = new Map<string, PluginDescriptor>();
  private readonly statuses = new Map<string, PluginStatus>();
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly apis = new Map<string, PluginApi>();
  private readonly commands = new Map<string, RegisteredCommand>();
  private hooks: HookHandler[] = [];
  private discovered = false;

  constructor(options: PluginHostOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.workspace = options.workspace;
    this.projectRoot = options.projectRoot;
    this.extraDirectories = options.extraDirectories ?? [];
  }

  /** Discover manifests without activating any plugin. */
  async discover(): Promise<PluginStatus[]> {
    this.descriptors.clear();
    this.statuses.clear();
    const roots: Array<{ directory: string; source: PluginSource }> = [
      { directory: globalPluginsDir(), source: "global" },
      ...this.extraDirectories.map((directory) => ({
        directory: path.resolve(this.projectRoot, expandHome(directory)),
        source: "configured" as const,
      })),
      ...this.config.plugins.directories.map((directory) => ({
        directory: path.resolve(this.projectRoot, expandHome(directory)),
        source: "configured" as const,
      })),
      { directory: path.join(projectDir(this.projectRoot), "plugins"), source: "project" },
    ];

    const seen = new Set<string>();
    for (const root of roots) {
      if (seen.has(root.directory)) continue;
      seen.add(root.directory);
      for (const scanned of await this.scanDirectory(root.directory, root.source)) {
        if ("descriptor" in scanned) {
          // Later roots win, so a project plugin overrides a global one.
          this.descriptors.set(scanned.descriptor.name, scanned.descriptor);
        } else {
          this.statuses.set(scanned.error.name, scanned.error);
        }
      }
    }

    for (const descriptor of this.descriptors.values()) {
      if (this.statuses.has(descriptor.name)) continue;
      this.statuses.set(descriptor.name, {
        name: descriptor.name,
        version: descriptor.version,
        description: descriptor.description,
        directory: descriptor.directory,
        source: descriptor.source,
        state: this.isEnabled(descriptor.name) ? "pending" : "disabled",
        permissions: [...(descriptor.manifest.tagcode.permissions ?? [])],
        tools: [],
        commands: [],
        hooks: [],
        reason: this.isEnabled(descriptor.name)
          ? undefined
          : this.disabledReason(descriptor.name),
      });
    }

    this.discovered = true;
    return this.getStatuses();
  }

  /** Discover (if needed) and activate every enabled plugin. */
  async load(): Promise<PluginStatus[]> {
    if (!this.discovered) await this.discover();
    for (const descriptor of this.descriptors.values()) {
      const status = this.statuses.get(descriptor.name);
      if (!status || status.state === "loaded") continue;
      if (!this.isEnabled(descriptor.name)) {
        status.state = "disabled";
        status.reason = this.disabledReason(descriptor.name);
        continue;
      }
      await this.loadOne(descriptor, status);
    }
    return this.getStatuses();
  }

  getStatuses(): PluginStatus[] {
    return [...this.statuses.values()]
      .map((status) => ({
        ...status,
        tools: [...status.tools],
        commands: [...status.commands],
        hooks: [...status.hooks],
        permissions: [...status.permissions],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getStatus(name: string): PluginStatus | undefined {
    const status = this.statuses.get(name);
    return status ? { ...status, tools: [...status.tools] } : undefined;
  }

  getCommands(): Array<{ key: string; plugin: string; command: PluginCommand }> {
    return [...this.commands.values()]
      .map((entry) => ({ key: entry.key, plugin: entry.plugin, command: entry.command }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Run a plugin slash command. The key is `<plugin>:<command>`. */
  async executeCommand(
    key: string,
    args: string[],
    context: PluginCommandContext,
  ): Promise<string | void> {
    const entry = this.commands.get(key);
    if (!entry) throw new Error(`Unknown plugin command: ${key}`);
    return entry.command.handler(args, context);
  }

  /**
   * Run every hook for an event in plugin load order. Hook return values are
   * shallow-merged into the payload; a failing hook is logged and skipped.
   */
  async runHook<K extends PluginHookName>(
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<PluginHookPayloads[K]> {
    let current = payload;
    for (const entry of this.hooks) {
      if (entry.event !== event) continue;
      const api = this.apis.get(entry.plugin);
      if (!api) continue;
      try {
        const result = await entry.handler(current, api);
        if (result && typeof result === "object" && !Array.isArray(result)) {
          current = { ...current, ...result };
        }
      } catch (error) {
        logger.warn(
          "plugins",
          `hook ${event} from ${entry.plugin} failed`,
          describeError(error),
        );
      }
    }
    return current;
  }

  /** Deactivate a plugin and remove everything it contributed. */
  async unload(name: string): Promise<boolean> {
    const entry = this.loaded.get(name);
    if (!entry) return false;
    try {
      await entry.deactivate?.();
    } catch (error) {
      logger.warn("plugins", `deactivate failed for ${name}`, describeError(error));
    }
    for (const toolName of entry.toolNames) this.registry.unregister(toolName);
    for (const commandKey of entry.commandKeys) this.commands.delete(commandKey);
    this.hooks = this.hooks.filter((hook) => hook.plugin !== name);
    this.loaded.delete(name);
    this.apis.delete(name);
    const status = this.statuses.get(name);
    if (status) {
      status.state = this.isEnabled(name) ? "pending" : "disabled";
      status.tools = [];
      status.commands = [];
      status.hooks = [];
      status.error = undefined;
      status.reason = this.disabledReason(name);
    }
    return true;
  }

  async unloadAll(): Promise<void> {
    for (const name of [...this.loaded.keys()].reverse()) await this.unload(name);
  }

  /** Unload everything, re-scan the filesystem and load enabled plugins again. */
  async reloadAll(): Promise<PluginStatus[]> {
    await this.unloadAll();
    this.descriptors.clear();
    this.statuses.clear();
    this.commands.clear();
    this.hooks = [];
    this.discovered = false;
    await this.discover();
    return this.load();
  }

  async reload(name: string): Promise<PluginStatus | undefined> {
    if (!this.discovered) await this.discover();
    await this.unload(name);
    const descriptor = this.descriptors.get(name);
    const status = this.statuses.get(name);
    if (!descriptor || !status) return undefined;
    if (!this.isEnabled(name)) {
      status.state = "disabled";
      status.reason = this.disabledReason(name);
      return { ...status };
    }
    await this.loadOne(descriptor, status);
    return { ...status, tools: [...status.tools] };
  }

  /** Deactivate all plugins. Call this before the process exits. */
  async dispose(): Promise<void> {
    await this.unloadAll();
  }

  private async loadOne(descriptor: PluginDescriptor, status: PluginStatus): Promise<void> {
    status.state = "pending";
    status.error = undefined;
    status.reason = undefined;

    const toolNames: string[] = [];
    const commandKeys: string[] = [];
    const hookNames: PluginHookName[] = [];
    const api = this.createApi(descriptor, status, toolNames, commandKeys, hookNames);
    this.apis.set(descriptor.name, api);

    let deactivate: (() => void | Promise<void>) | undefined;
    try {
      const moduleUrl = `${pathToFileURL(descriptor.entryPath).href}?tagcode=${Date.now()}`;
      const imported = (await import(moduleUrl)) as Record<string, unknown>;
      const candidate = imported.default ?? imported;
      let activate: PluginFactory | undefined;

      if (typeof candidate === "function") {
        activate = candidate as PluginFactory;
      } else if (candidate && typeof candidate === "object") {
        const module = candidate as PluginModule;
        if (typeof module.activate === "function") {
          activate = module.activate.bind(module);
          if (typeof module.deactivate === "function") {
            deactivate = module.deactivate.bind(module);
          }
        }
      }
      if (!activate && typeof imported.activate === "function") {
        activate = imported.activate as PluginFactory;
        if (typeof imported.deactivate === "function") {
          deactivate = imported.deactivate as () => void | Promise<void>;
        }
      }
      if (!activate) {
        throw new Error(
          `Plugin entry must export an object with activate(), a default function, or a named activate() export`,
        );
      }

      await activate(api);
      status.state = "loaded";
      this.loaded.set(descriptor.name, {
        descriptor,
        status,
        deactivate,
        toolNames,
        commandKeys,
        hookNames,
      });
      logger.debug("plugins", `loaded ${descriptor.name}`, {
        tools: toolNames.length,
        commands: commandKeys.length,
        hooks: hookNames.length,
      });
    } catch (error) {
      // Roll back anything the plugin managed to register before failing.
      for (const toolName of toolNames) this.registry.unregister(toolName);
      for (const key of commandKeys) this.commands.delete(key);
      this.hooks = this.hooks.filter((hook) => hook.plugin !== descriptor.name);
      this.apis.delete(descriptor.name);
      status.state = "error";
      status.error = describeError(error);
      status.tools = [];
      status.commands = [];
      status.hooks = [];
      logger.warn("plugins", `failed to load ${descriptor.name}`, describeError(error));
    }
  }

  private createApi(
    descriptor: PluginDescriptor,
    status: PluginStatus,
    toolNames: string[],
    commandKeys: string[],
    hookNames: PluginHookName[],
  ): PluginApi {
    const declared = new Set<PluginPermission>(descriptor.manifest.tagcode.permissions ?? []);
    const prefix = `plugin__${sanitizeSegment(descriptor.name)}__`;
    const pluginName = descriptor.name;

    return {
      name: pluginName,
      version: descriptor.version,
      directory: descriptor.directory,
      workspace: this.workspace,
      projectRoot: this.projectRoot,
      config: this.config,
      permissions: [...declared],
      hasPermission: (permission) => declared.has(permission),
      log: (level: PluginLogLevel, message: string, data?: unknown) => {
        logger[level](`plugin:${pluginName}`, message, data);
      },
      registerTool: (tool: PluginTool) => {
        this.assertToolPermission(pluginName, declared, tool.permission);
        const base = `${prefix}${sanitizeSegment(tool.name)}`;
        let name = base;
        let index = 2;
        while (this.registry.has(name)) name = `${base}_${index++}`;
        this.registry.register({ ...tool, name } as AnyTool);
        toolNames.push(name);
        status.tools.push(name);
      },
      registerCommand: (command: PluginCommand) => {
        if (!command.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(command.name)) {
          throw new Error(`Invalid plugin command name: ${command.name}`);
        }
        const key = `${pluginName}:${command.name}`;
        if (this.commands.has(key)) {
          throw new Error(`Plugin command already registered: ${key}`);
        }
        this.commands.set(key, { plugin: pluginName, key, command });
        commandKeys.push(key);
        status.commands.push(key);
      },
      on: <K extends PluginHookName>(event: K, handler: PluginHook<K>) => {
        if (!handler || typeof handler !== "function") {
          throw new Error(`Hook handler for ${String(event)} must be a function`);
        }
        this.hooks.push({
          plugin: pluginName,
          event,
          handler: handler as PluginHook,
        });
        hookNames.push(event);
        status.hooks.push(event);
      },
    };
  }

  private assertToolPermission(
    pluginName: string,
    declared: Set<PluginPermission>,
    permission: ToolPermission,
  ): void {
    if (permission === "sensitive") {
      if (!declared.has("write") && !declared.has("execute")) {
        throw new Error(
          `Plugin "${pluginName}" registers a sensitive tool but declares neither "write" nor "execute" permission`,
        );
      }
      return;
    }
    if (!VALID_PERMISSIONS.includes(permission)) {
      throw new Error(`Unsupported plugin tool permission: ${permission}`);
    }
    if (!declared.has(permission)) {
      throw new Error(
        `Plugin "${pluginName}" registers a "${permission}" tool without declaring that permission in plugin.json`,
      );
    }
  }

  private async scanDirectory(
    root: string,
    source: PluginSource,
  ): Promise<ScannedManifest[]> {
    const results: ScannedManifest[] = [];
    if (!(await isDirectory(root))) return results;

    const directManifest = path.join(root, MANIFEST_FILE);
    if (await isFile(directManifest)) {
      results.push(await this.readManifest(root, source, directManifest));
      return results;
    }

    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = (await fs.readdir(root, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch (error) {
      logger.warn("plugins", `cannot read plugin directory ${root}`, describeError(error));
      return results;
    }

    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const directory = path.join(root, entry.name);
      const manifestPath = path.join(directory, MANIFEST_FILE);
      if (await isFile(manifestPath)) {
        results.push(await this.readManifest(directory, source, manifestPath));
      }
    }
    return results;
  }

  private async readManifest(
    directory: string,
    source: PluginSource,
    manifestPath: string,
  ): Promise<ScannedManifest> {
    const folderName = path.basename(directory);
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (error) {
        throw new Error(`invalid JSON: ${describeError(error)}`);
      }
      const parsed = PluginManifestSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new Error(`invalid manifest: ${issues}`);
      }
      const manifest = parsed.data;
      if (manifest.tagcode.apiVersion !== PLUGIN_API_VERSION) {
        throw new Error(
          `unsupported API version "${manifest.tagcode.apiVersion}" (expected "${PLUGIN_API_VERSION}")`,
        );
      }
      const entryPath = path.resolve(directory, manifest.main);
      if (!isPathInside(directory, entryPath)) {
        throw new Error(`"main" must stay inside the plugin directory`);
      }
      if (!(await isFile(entryPath))) {
        throw new Error(`entry file not found: ${manifest.main}`);
      }
      return {
        descriptor: {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          directory,
          manifestPath,
          entryPath,
          source,
          manifest,
        },
      };
    } catch (error) {
      return {
        error: {
          name: folderName,
          directory,
          source,
          state: "error" as PluginState,
          permissions: [],
          tools: [],
          commands: [],
          hooks: [],
          error: describeError(error),
        },
      };
    }
  }

  private isEnabled(name: string): boolean {
    if (this.config.plugins.disabled.includes(name)) return false;
    const enabled = this.config.plugins.enabled;
    if (enabled.length === 0) return false;
    return enabled.includes("*") || enabled.includes(name);
  }

  private disabledReason(name: string): string | undefined {
    if (this.config.plugins.disabled.includes(name)) {
      return "Disabled in plugins.disabled";
    }
    if (this.config.plugins.enabled.length === 0) {
      return "Not enabled. Add the plugin name to plugins.enabled in config.json (use \"*\" to enable all).";
    }
    return `Not listed in plugins.enabled`;
  }
}
