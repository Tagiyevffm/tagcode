import type { McpServerConfig, McpToolPermission } from "../config/schema.js";

export type McpCatalogInput = {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  secret?: boolean;
  default?: string;
};

export type McpCatalogTemplate = {
  id: string;
  title: string;
  description: string;
  category: "files" | "git" | "data" | "browser" | "web" | "productivity";
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  permission: McpToolPermission;
  requires?: string[];
  docsUrl?: string;
  notes?: string;
  inputs?: McpCatalogInput[];
};

export type ResolvedMcpTemplate = {
  name: string;
  server: McpServerConfig;
  inputs: Record<string, string>;
};

/**
 * Curated MCP servers that can be configured without hand-writing JSON.
 * Placeholders are resolved on the server from the user's inputs; the renderer
 * never supplies a command or URL for a catalog template.
 */
export const MCP_CATALOG: McpCatalogTemplate[] = [
  {
    id: "filesystem",
    title: "Filesystem",
    description: "Give the agent scoped file access to a folder on this machine.",
    category: "files",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{{path}}"],
    permission: "write",
    requires: ["Node.js", "npx"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    inputs: [
      {
        key: "path",
        label: "Allowed folder",
        placeholder: "{{workspace}}",
        default: "{{workspace}}",
        required: true,
        help: "Filesystem tools cannot leave this folder.",
      },
    ],
  },
  {
    id: "github",
    title: "GitHub",
    description: "Read repositories, issues and pull requests, and create review comments.",
    category: "git",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{token}}" },
    permission: "network",
    requires: ["Node.js", "npx", "GitHub token"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    notes: "Use a fine-grained token limited to the repositories the agent should see.",
    inputs: [
      {
        key: "token",
        label: "GitHub personal access token",
        placeholder: "github_pat_…",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "postgres",
    title: "PostgreSQL",
    description: "Inspect schemas and run read/write SQL against a PostgreSQL database.",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{{databaseUrl}}"],
    permission: "sensitive",
    requires: ["Node.js", "npx", "Database URL"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    notes: "Prefer a read-only role unless you explicitly want the agent to mutate data.",
    inputs: [
      {
        key: "databaseUrl",
        label: "Database URL",
        placeholder: "postgresql://user:password@localhost:5432/app",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "sqlite",
    title: "SQLite",
    description: "Query and modify a local SQLite database file.",
    category: "data",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "{{path}}"],
    permission: "sensitive",
    requires: ["uv / uvx", "Database file"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    inputs: [
      {
        key: "path",
        label: "Database file",
        placeholder: "{{workspace}}/data.db",
        default: "{{workspace}}/data.db",
        required: true,
      },
    ],
  },
  {
    id: "playwright",
    title: "Playwright",
    description: "Drive a real browser: navigate pages, inspect the DOM, click and take screenshots.",
    category: "browser",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    permission: "execute",
    requires: ["Node.js", "npx"],
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    notes: "The first run downloads browser binaries, which can take a few minutes.",
  },
  {
    id: "fetch",
    title: "Fetch",
    description: "Fetch a URL and convert HTML to readable Markdown for the model.",
    category: "web",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    permission: "network",
    requires: ["uv / uvx"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "brave-search",
    title: "Brave Search",
    description: "Search the web through the Brave Search API.",
    category: "web",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "{{apiKey}}" },
    permission: "network",
    requires: ["Node.js", "npx", "Brave API key"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    inputs: [
      {
        key: "apiKey",
        label: "Brave Search API key",
        placeholder: "BSA…",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    description: "Persist entities and relations in a local knowledge graph across sessions.",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: { MEMORY_FILE_PATH: "{{path}}" },
    permission: "write",
    requires: ["Node.js", "npx"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    inputs: [
      {
        key: "path",
        label: "Memory file",
        placeholder: "{{workspace}}/.tagcode/mcp-memory.json",
        default: "{{workspace}}/.tagcode/mcp-memory.json",
        required: true,
      },
    ],
  },
  {
    id: "sequential-thinking",
    title: "Sequential Thinking",
    description: "Give the agent a structured scratchpad for multi-step reasoning.",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    permission: "read",
    requires: ["Node.js", "npx"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "slack",
    title: "Slack",
    description: "Read channels and post updates through a Slack bot.",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "{{botToken}}", SLACK_TEAM_ID: "{{teamId}}" },
    permission: "network",
    requires: ["Node.js", "npx", "Slack bot token"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    inputs: [
      {
        key: "botToken",
        label: "Slack bot token",
        placeholder: "xoxb-…",
        required: true,
        secret: true,
      },
      { key: "teamId", label: "Slack team ID", placeholder: "T01234567", required: true },
    ],
  },
];

export function getMcpCatalogTemplate(id: string): McpCatalogTemplate | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

function replacePlaceholders(value: string, inputs: Record<string, string>, workspace: string): string {
  return value.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, key: string) => {
    if (key === "workspace") return workspace;
    return inputs[key] ?? "";
  });
}

/**
 * Expand a catalog template with user inputs. Unknown input keys are ignored;
 * required fields and the resulting transport are validated here rather than in
 * the renderer.
 */
export function resolveMcpCatalogTemplate(
  template: McpCatalogTemplate,
  rawInputs: Record<string, unknown>,
  workspace: string,
): ResolvedMcpTemplate {
  const inputs: Record<string, string> = {};
  for (const field of template.inputs ?? []) {
    const raw = rawInputs[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) inputs[field.key] = value;
    else if (field.default) inputs[field.key] = replacePlaceholders(field.default, {}, workspace);
    else if (field.required) throw new Error(`${field.label} is required.`);
  }

  const args = (template.args ?? [])
    .map((arg) => replacePlaceholders(arg, inputs, workspace))
    .filter((arg) => arg.length > 0);
  const url = template.url ? replacePlaceholders(template.url, inputs, workspace) : undefined;
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(template.env ?? {})) {
    const value = replacePlaceholders(raw, inputs, workspace);
    if (value) env[key] = value;
  }

  const server: McpServerConfig =
    template.transport === "http"
      ? {
          type: "http",
          url: url!,
          enabled: true,
          permission: template.permission,
        }
      : {
          type: "stdio",
          command: template.command!,
          args,
          ...(Object.keys(env).length ? { env } : {}),
          enabled: true,
          permission: template.permission,
        };

  return { name: template.id, server, inputs };
}

/** Metadata safe to send to the renderer: no env values or resolved secrets. */
export function publicMcpCatalog(template: McpCatalogTemplate): McpCatalogTemplate {
  return {
    ...template,
    inputs: (template.inputs ?? []).map((field) => ({ ...field })),
  };
}
