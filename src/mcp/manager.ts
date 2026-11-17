import { z } from "zod";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../config/schema.js";
import { CancelledError } from "../core/errors.js";
import type { JsonSchema, ToolPermission, ToolResult } from "../core/types.js";
import type { AnyTool, ToolContext } from "../tools/types.js";
import { fail, ok } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { logger } from "../utils/logger.js";
import { truncateMiddle } from "../utils/strings.js";

export type McpServerState = "connected" | "connecting" | "disconnected" | "error" | "disabled";

export type McpServerStatus = {
  name: string;
  transport: "stdio" | "http";
  state: McpServerState;
  toolCount: number;
  resourceCount: number;
  templateCount: number;
  promptCount: number;
  error?: string;
  instructions?: string;
  serverName?: string;
  serverVersion?: string;
  checkedAt: string;
};

export type McpManagerOptions = {
  servers: Record<string, McpServerConfig>;
  projectRoot: string;
  registry: ToolRegistry;
  sources?: Record<string, "global" | "project">;
  /** Permission class used when a server does not declare one. */
  defaultPermission?: ToolPermission;
  /** Notified whenever a server status changes (used by the TUI). */
  onStatusChange?: (status: McpServerStatus) => void;
};

type Connection = {
  name: string;
  prefix: string;
  config: McpServerConfig;
  client?: Client;
  transport?: Transport;
  status: McpServerStatus;
  toolNames: string[];
  stderr: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_PAGES = 100;

const permissiveArguments = z.object({}).passthrough();

/** Reduce an arbitrary MCP identifier to a registry-safe tool-name segment. */
function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function compactEnvironment(config: McpServerConfig): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...(config.env ?? {}) })) {
    if (typeof value === "string") merged[key] = value;
  }
  return merged;
}

function approxBytes(base64: string | undefined): number {
  if (!base64) return 0;
  return Math.floor((base64.length * 3) / 4);
}

function formatResource(
  resource: { uri: string; mimeType?: string; text?: string; blob?: string },
): string {
  const meta = resource.mimeType ? ` (${resource.mimeType})` : "";
  if (typeof resource.text === "string") {
    return `Resource ${resource.uri}${meta}:\n${resource.text}`;
  }
  return `[binary resource ${resource.uri}${meta}, ~${approxBytes(resource.blob)} bytes]`;
}

/** Flatten MCP content blocks into text the model can reason about. */
export function formatMcpContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "unknown";
    if (type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (type === "image") {
      parts.push(
        `[image ${String(block.mimeType ?? "unknown")}, ~${approxBytes(
          typeof block.data === "string" ? block.data : undefined,
        )} bytes]`,
      );
      continue;
    }
    if (type === "audio") {
      parts.push(
        `[audio ${String(block.mimeType ?? "unknown")}, ~${approxBytes(
          typeof block.data === "string" ? block.data : undefined,
        )} bytes]`,
      );
      continue;
    }
    if (type === "resource" && block.resource && typeof block.resource === "object") {
      parts.push(formatResource(block.resource as { uri: string }));
      continue;
    }
    if (type === "resource_link") {
      parts.push(
        `[resource ${String(block.name ?? "(unnamed)")}] <${String(block.uri)}>${
          block.description ? ` — ${String(block.description)}` : ""
        }`,
      );
      continue;
    }
    try {
      parts.push(JSON.stringify(raw));
    } catch {
      parts.push(String(raw));
    }
  }
  return parts.join("\n\n");
}

function formatPromptMessages(messages: Array<Record<string, unknown>>): string {
  return messages
    .map((message) => {
      const role = String(message.role ?? "user");
      const content = message.content;
      if (content && typeof content === "object" && !Array.isArray(content)) {
        const block = content as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          return `[${role}]\n${block.text}`;
        }
        if (block.type === "resource" && block.resource && typeof block.resource === "object") {
          return `[${role}]\n${formatResource(block.resource as { uri: string })}`;
        }
        if (block.type === "resource_link") {
          return `[${role}] ${String(block.name ?? "(unnamed)")} <${String(block.uri)}>`;
        }
        return `[${role}]\n${formatMcpContent([block])}`;
      }
      return `[${role}]\n${String(content ?? "")}`;
    })
    .join("\n\n");
}

async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.nextCursor) return items;
    cursor = result.nextCursor;
  }
  throw new Error(`Pagination exceeded ${MAX_PAGES} pages`);
}

function isJsonObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Owns the lifecycle of every configured MCP server and exposes their tools,
 * resources and prompts through the shared `ToolRegistry`.
 *
 * Individual server failures never abort startup: each one is reported in its
 * status so the UI can show what is broken without hiding working servers.
 */
export class McpManager {
  private readonly registry: ToolRegistry;
  private readonly projectRoot: string;
  private readonly defaultPermission: ToolPermission;
  private readonly onStatusChange?: (status: McpServerStatus) => void;
  private readonly connections = new Map<string, Connection>();

  constructor(options: McpManagerOptions) {
    this.registry = options.registry;
    this.projectRoot = options.projectRoot;
    this.defaultPermission = options.defaultPermission ?? "sensitive";
    this.onStatusChange = options.onStatusChange;

    const usedSegments = new Set<string>();
    for (const [name, config] of Object.entries(options.servers)) {
      let segment = sanitizeSegment(name, "server");
      while (usedSegments.has(segment)) segment = `${segment}_2`;
      usedSegments.add(segment);
      const transportType = config.url ? "http" : "stdio";
      const initial: McpServerStatus = {
        name,
        transport: config.type ?? transportType,
        state: config.enabled === false ? "disabled" : "disconnected",
        toolCount: 0,
        resourceCount: 0,
        templateCount: 0,
        promptCount: 0,
        checkedAt: new Date().toISOString(),
      };
      this.connections.set(name, {
        name,
        prefix: `mcp__${segment}__`,
        config,
        status: initial,
        toolNames: [],
        stderr: "",
      });
    }
  }

  /** Connect every enabled server. Returns after all attempts finish. */
  async connectAll(): Promise<McpServerStatus[]> {
    const names = [...this.connections.keys()];
    for (const name of names) {
      const connection = this.connections.get(name)!;
      if (connection.status.state === "disabled") continue;
      await this.connect(name);
    }
    return this.getStatuses();
  }

  async connect(name: string): Promise<McpServerStatus> {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`Unknown MCP server: ${name}`);
    if (connection.status.state === "disabled") return { ...connection.status };
    if (connection.status.state === "connected" && connection.client) return { ...connection.status };

    await this.disconnect(name, { silent: true });
    this.updateStatus(connection, {
      state: "connecting",
      error: undefined,
      toolCount: 0,
      resourceCount: 0,
      templateCount: 0,
      promptCount: 0,
    });

    const timeoutMs = connection.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let client: Client | undefined;
    let transport: Transport | undefined;
    try {
      transport = this.createTransport(connection);
      client = new Client(
        { name: "tagcode", version: "0.1.0" },
        {
          capabilities: {},
          listChanged: {
            tools: {
              onChanged: (error) => {
                logger.debug(
                  "mcp",
                  `tool list changed for ${name}`,
                  error ? describeError(error) : undefined,
                );
              },
            },
          },
        },
      );
      transport.onerror = (error) => {
        logger.debug("mcp", `transport error for ${name}`, describeError(error));
      };
      await client.connect(transport, { timeout: timeoutMs });

      connection.client = client;
      connection.transport = transport;
      const capabilities = client.getServerCapabilities() ?? {};
      const serverVersion = client.getServerVersion();

      let toolCount = 0;
      let resourceCount = 0;
      let templateCount = 0;
      let promptCount = 0;

      const names = connection.toolNames;
      if (capabilities.tools) {
        const tools = await collectPages(async (cursor) => {
          const page = await client!.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
          return { items: page.tools, nextCursor: page.nextCursor };
        });
        toolCount = tools.length;
        for (const tool of tools) {
          names.push(this.registerTool(connection, client, tool, timeoutMs));
        }
      }

      if (capabilities.resources) {
        const resources = await collectPages(async (cursor) => {
          const page = await client!.listResources(cursor ? { cursor } : undefined, {
            timeout: timeoutMs,
          });
          return { items: page.resources, nextCursor: page.nextCursor };
        });
        resourceCount = resources.length;
        let templates: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }> = [];
        try {
          templates = await collectPages(async (cursor) => {
            const page = await client!.listResourceTemplates(cursor ? { cursor } : undefined, {
              timeout: timeoutMs,
            });
            return { items: page.resourceTemplates, nextCursor: page.nextCursor };
          });
        } catch (error) {
          // Some servers advertise resources but not templates; keep going.
          logger.debug("mcp", `resource templates unavailable for ${name}`, describeError(error));
        }
        templateCount = templates.length;
        names.push(
          ...this.registerResourceTools(connection, client, resources, templates, timeoutMs),
        );
      }

      if (capabilities.prompts) {
        const prompts = await collectPages(async (cursor) => {
          const page = await client!.listPrompts(cursor ? { cursor } : undefined, {
            timeout: timeoutMs,
          });
          return { items: page.prompts, nextCursor: page.nextCursor };
        });
        promptCount = prompts.length;
        names.push(...this.registerPromptTools(connection, client, prompts, timeoutMs));
      }

      connection.toolNames = names;
      this.updateStatus(connection, {        state: "connected",
        toolCount,
        resourceCount,
        templateCount,
        promptCount,
        instructions: client.getInstructions(),
        serverName: serverVersion?.name,
        serverVersion: serverVersion?.version,
        error: undefined,
      });
      logger.debug("mcp", `connected ${name}`, {
        tools: toolCount,
        resources: resourceCount,
        prompts: promptCount,
      });
    } catch (error) {
      const stderr = connection.stderr.trim();
      const message = stderr
        ? `${describeError(error)}\n${truncateMiddle(stderr, 1_500)}`
        : describeError(error);
      logger.warn("mcp", `failed to connect ${name}`, message);
      await this.safeClose(client, transport);
      connection.client = undefined;
      connection.transport = undefined;
      this.unregisterAll(connection);
      this.updateStatus(connection, { state: "error", error: message });
    }
    return { ...connection.status };
  }

  /** Drop a connection and every tool it contributed. */
  async disconnect(name: string, options: { silent?: boolean } = {}): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.unregisterAll(connection);
    const client = connection.client;
    const transport = connection.transport;
    connection.client = undefined;
    connection.transport = undefined;
    await this.safeClose(client, transport);
    if (!options.silent && connection.status.state !== "disabled") {
      this.updateStatus(connection, {
        state: "disconnected",
        toolCount: 0,
        resourceCount: 0,
        templateCount: 0,
        promptCount: 0,
      });
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.connections.keys()) {
      await this.disconnect(name, { silent: true });
    }
  }

  /** Re-establish one server, which also refreshes its tool list. */
  async reconnect(name: string): Promise<McpServerStatus> {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`Unknown MCP server: ${name}`);
    if (connection.status.state === "disabled") return { ...connection.status };
    await this.disconnect(name, { silent: true });
    return this.connect(name);
  }

  async reconnectAll(): Promise<McpServerStatus[]> {
    const names = [...this.connections.keys()];
    for (const name of names) {
      const connection = this.connections.get(name)!;
      if (connection.status.state === "disabled") continue;
      await this.connect(name);
    }
    return this.getStatuses();
  }

  getStatuses(): McpServerStatus[] {
    return [...this.connections.values()]
      .map((connection) => ({ ...connection.status }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getStatus(name: string): McpServerStatus | undefined {
    const connection = this.connections.get(name);
    return connection ? { ...connection.status } : undefined;
  }

  isConnected(name: string): boolean {
    return this.connections.get(name)?.status.state === "connected";
  }

  /** Names of registry tools contributed by one server, with the MCP prefix. */
  getToolNames(name: string): string[] {
    const connection = this.connections.get(name);
    if (!connection) return [];
    return connection.toolNames.filter((toolName) => this.registry.has(toolName));
  }

  private createTransport(connection: Connection): Transport {
    const config = connection.config;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (config.url) {
      let url: URL;
      try {
        url = new URL(config.url);
      } catch {
        throw new Error(`Invalid MCP server URL: ${config.url}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`MCP server URL must use http or https: ${config.url}`);
      }
      return new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        reconnectionOptions: {
          initialReconnectionDelay: 500,
          maxReconnectionDelay: 10_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      });
    }

    if (!config.command) {
      throw new Error(`MCP server ${connection.name} has neither 'command' nor 'url'`);
    }
    const resolvedCwd = config.cwd
      ? path.resolve(this.projectRoot, config.cwd)
      : this.projectRoot;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: compactEnvironment(config),
      cwd: resolvedCwd,
      stderr: "pipe",
      maxBufferSize: 20 * 1024 * 1024,
    });
    const stderrStream = transport.stderr;
    if (stderrStream && "on" in stderrStream) {
      stderrStream.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        connection.stderr = `${connection.stderr}${text}`.slice(-MAX_STDERR_CHARS);
      });
    }
    logger.debug("mcp", `starting ${connection.name}`, {
      command: config.command,
      args: config.args,
      timeoutMs,
    });
    return transport;
  }

  private registerTool(
    connection: Connection,
    client: Client,
    tool: {
      name: string;
      description?: string;
      inputSchema: JsonSchema;
    },
    timeoutMs: number,
  ): string {
    const originalName = tool.name;
    const registeredName = this.uniqueToolName(
      connection,
      `${connection.prefix}${sanitizeSegment(originalName, "tool")}`,
    );
    const permission = connection.config.permission ?? this.defaultPermission;
    const description =
      tool.description?.trim() || `MCP tool "${originalName}" from server "${connection.name}"`;

    const wrapper: AnyTool = {
      name: registeredName,
      description,
      parameters: permissiveArguments,
      jsonSchema: isJsonObject(tool.inputSchema) ? tool.inputSchema : { type: "object" },
      permission,
      describe: (input) => ({
        summary: `MCP ${connection.name}: ${originalName}`,
        details:
          Object.keys(input as Record<string, unknown>).length > 0
            ? `Arguments: ${truncateMiddle(JSON.stringify(input), 800)}`
            : description,
        risk: permission === "sensitive" ? "medium" : undefined,
      }),
      execute: async (input, context: ToolContext) =>
        this.callTool(client, originalName, input as Record<string, unknown>, timeoutMs, context),
    };
    this.registry.register(wrapper);
    return registeredName;
  }

  private registerResourceTools(
    connection: Connection,
    client: Client,
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>,
    templates: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }>,
    timeoutMs: number,
  ): string[] {
    const names: string[] = [];
    const permission = connection.config.permission ?? this.defaultPermission;

    names.push(
      this.registerHelperTool(connection, {
        toolName: "list_resources",
        description: `List resources and resource templates exposed by MCP server "${connection.name}".`,
        parameters: z.object({}),
        permission: "read",
        summarize: () => `MCP ${connection.name}: list resources`,
        execute: async () => {
          const resourceLines = resources.map(
            (resource) =>
              `- ${resource.uri}${resource.name ? ` — ${resource.name}` : ""}${
                resource.mimeType ? ` [${resource.mimeType}]` : ""
              }${resource.description ? `\n  ${resource.description}` : ""}`,
          );
          const templateLines = templates.map(
            (template) =>
              `- ${template.uriTemplate}${template.name ? ` — ${template.name}` : ""}${
                template.description ? `\n  ${template.description}` : ""
              }`,
          );
          const text = [
            `Resources (${resources.length}):`,
            ...(resourceLines.length ? resourceLines : ["(none)"]),
            "",
            `Templates (${templates.length}):`,
            ...(templateLines.length ? templateLines : ["(none)"]),
          ].join("\n");
          return ok(text, { resources, templates });
        },
      }),
    );

    names.push(
      this.registerHelperTool(connection, {
        toolName: "read_resource",
        description: `Read a resource by URI from MCP server "${connection.name}".`,
        parameters: z.object({ uri: z.string().min(1) }),
        permission,
        summarize: (input) => `MCP ${connection.name}: read ${input.uri}`,
        execute: async (input, context) => {
          const result = await client.readResource({ uri: input.uri }, {
            timeout: timeoutMs,
            signal: context.signal,
          });
          return ok(formatMcpContent(result.contents), result.contents);
        },
      }),
    );
    return names;
  }

  private registerPromptTools(
    connection: Connection,
    client: Client,
    prompts: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>,
    timeoutMs: number,
  ): string[] {
    const names: string[] = [];
    const permission = connection.config.permission ?? this.defaultPermission;

    names.push(
      this.registerHelperTool(connection, {
        toolName: "list_prompts",
        description: `List prompts exposed by MCP server "${connection.name}".`,
        parameters: z.object({}),
        permission: "read",
        summarize: () => `MCP ${connection.name}: list prompts`,
        execute: async () => {
          const lines = prompts.map((prompt) => {
            const args = (prompt.arguments ?? [])
              .map((arg) => `${arg.name}${arg.required ? " (required)" : ""}`)
              .join(", ");
            return `- ${prompt.name}${args ? ` (${args})` : ""}${
              prompt.description ? `\n  ${prompt.description}` : ""
            }`;
          });
          return ok(
            [`Prompts (${prompts.length}):`, ...(lines.length ? lines : ["(none)"])].join("\n"),
            prompts,
          );
        },
      }),
    );

    names.push(
      this.registerHelperTool(connection, {
        toolName: "get_prompt",
        description: `Fetch a prompt from MCP server "${connection.name}" and return its messages.`,
        parameters: z.object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.string()).optional(),
        }),
        permission,
        summarize: (input) => `MCP ${connection.name}: prompt ${input.name}`,
        execute: async (input, context) => {
          const result = await client.getPrompt(
            { name: input.name, arguments: input.arguments },
            { timeout: timeoutMs, signal: context.signal },
          );
          return ok(
            formatPromptMessages(result.messages as Array<Record<string, unknown>>),
            result,
          );
        },
      }),
    );
    return names;
  }

  private registerHelperTool<Schema extends z.ZodType>(
    connection: Connection,
    options: {
      toolName: string;
      description: string;
      parameters: Schema;
      permission: ToolPermission;
      summarize: (input: z.infer<Schema>) => string;
      execute: (input: z.infer<Schema>, context: ToolContext) => Promise<ToolResult>;
    },
  ): string {
    const name = this.uniqueToolName(connection, `${connection.prefix}${options.toolName}`);
    const wrapper: AnyTool = {
      name,
      description: options.description,
      parameters: options.parameters,
      permission: options.permission,
      describe: (input) => ({
        summary: options.summarize(input as z.infer<Schema>),
        risk: options.permission === "sensitive" ? "medium" : undefined,
      }),
      execute: (input, context) =>
        options.execute(input as z.infer<Schema>, context),
    };
    this.registry.register(wrapper);
    return name;
  }

  private async callTool(
    client: Client,
    originalName: string,
    input: Record<string, unknown>,
    timeoutMs: number,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (context.signal.aborted) throw new CancelledError();
    try {
      const result = await client.callTool(
        { name: originalName, arguments: input },
        undefined,
        { timeout: timeoutMs, signal: context.signal },
      );
      if ("toolResult" in result) {
        return ok(JSON.stringify(result.toolResult, null, 2), result.toolResult);
      }
      const text = formatMcpContent(result.content);
      const structured = result.structuredContent
        ? `\n\nStructured content:\n${JSON.stringify(result.structuredContent, null, 2)}`
        : "";
      const output = `${text || "(no textual content)"}${structured}`;
      return result.isError
        ? fail(output, { content: result.content, structuredContent: result.structuredContent })
        : ok(output, { content: result.content, structuredContent: result.structuredContent });
    } catch (error) {
      if (context.signal.aborted) throw new CancelledError();
      return fail(`MCP tool ${originalName} failed: ${describeError(error)}`);
    }
  }

  private uniqueToolName(connection: Connection, base: string): string {
    let candidate = base;
    let index = 2;
    while (this.registry.has(candidate)) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    return candidate;
  }

  private unregisterAll(connection: Connection): void {
    for (const name of connection.toolNames) this.registry.unregister(name);
    connection.toolNames = [];
  }

  private async safeClose(client?: Client, transport?: Transport): Promise<void> {
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch (error) {
      logger.debug("mcp", "error while closing MCP connection", describeError(error));
    }
  }

  private updateStatus(connection: Connection, patch: Partial<McpServerStatus>): void {
    connection.status = { ...connection.status, ...patch, checkedAt: new Date().toISOString() };
    this.onStatusChange?.({ ...connection.status });
  }
}
