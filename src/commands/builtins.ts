import path from "node:path";
import { promises as fs } from "node:fs";
import type { AgentMode, PermissionMode } from "../core/types.js";
import type { ProviderType } from "../config/schema.js";
import { PERMISSION_MODES, PROVIDER_TYPES } from "../config/schema.js";
import type { SessionController } from "../controller.js";
import { PROVIDER_PRESETS } from "../providers/registry.js";
import { removeMcpServer, upsertMcpServer } from "../config/config.js";
import { isProbablyUrl } from "../utils/fs.js";
import { redactValue } from "../security/redact.js";
import { searchMemory } from "../memory/store.js";
import { validateSkillDirectory } from "../skills/validator.js";
import { currentBranch, gitDiff, gitStatusPorcelain, isGitRepository } from "../git/repo.js";
import { formatNumber } from "../utils/strings.js";
import { toError } from "../core/errors.js";
import type { CommandDefinition, CommandInput } from "./types.js";

function fail(message: string): string {
  return `Error: ${message}`;
}

function errorText(error: unknown): string {
  return fail(toError(error).message);
}

function renderTable(rows: string[][], headers: string[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "─".repeat(width))), ...rows.map(line)].join("\n");
}

function presetLabel(type: ProviderType): string {
  return PROVIDER_PRESETS[type]?.label ?? type;
}

/** Show an in-app picker when the frontend supports it. */
async function chooseModel(
  controller: SessionController,
  models: string[],
): Promise<string | undefined> {
  if (!controller.canPrompt() || models.length === 0) return undefined;
  const shown = models.slice(0, 40);
  const prompt =
    models.length > shown.length
      ? `Select a model (showing ${shown.length} of ${models.length}; type an exact model name for others):`
      : "Select a model:";
  const answer = await controller.requestInput(prompt, shown);
  if (!answer?.trim()) return undefined;
  const value = answer.trim();
  const index = Number(value);
  if (Number.isInteger(index) && index >= 1 && index <= shown.length) return shown[index - 1];
  return models.includes(value) ? value : undefined;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        index++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function scopeFrom(flags: Record<string, string | true>): "global" | "project" {
  return flags.project ? "project" : "global";
}

function usageLines(): string {
  return [
    "Usage: tgc [options] [prompt]",
    "",
    "Commands:",
    "  tgc                     Open the desktop app",
    "  tgc app [--no-open]     Start the desktop app server",
    "  tgc tui                 Start the terminal UI",
    "  tgc run <prompt>        Run one prompt non-interactively",
    "  tgc init                Create .tagcode scaffolding and AGENTS.md",
    "  tgc doctor              Check configuration and connectivity",
    "  tgc connect <provider>  Configure a provider",
    "  tgc disconnect [id]     Remove a provider configuration",
    "  tgc models              List models from the active provider",
    "  tgc config <show|get|set> [key] [value]",
    "  tgc mcp <list|add|remove|connect|disconnect|inspect|reload>",
    "  tgc skills <list|install|remove|update|search|create|inspect|reload>",
    "  tgc session <list|show|resume|delete|export>",
    "",
    "Inside the desktop app or TUI, type /help to list slash commands.",
  ].join("\n");
}

const help: CommandDefinition = {
  name: "help",
  aliases: ["?"],
  description: "Show available commands or details for one command",
  usage: "/help [command]",
  handler: async ({ args, controller }) => {
    const registry = controller.getCommandRegistry();
    if (args[0]) {
      const definition = registry.get(args[0].replace(/^\//, "").toLowerCase());
      if (!definition) return `Unknown command: ${args[0]}`;
      return [
        `/${definition.name} — ${definition.description}`,
        definition.usage ? `Usage: ${definition.usage}` : undefined,
        definition.aliases?.length ? `Aliases: ${definition.aliases.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const rows = registry
      .list()
      .map((definition) => [`/${definition.name}`, definition.description]);
    const pluginCommands = controller.getPluginHost()?.getCommands() ?? [];
    if (pluginCommands.length > 0) {
      rows.push(["", ""]);
      rows.push(["Plugin commands", ""]);
      for (const entry of pluginCommands) {
        rows.push([`/plugin:${entry.key}`, entry.command.description]);
      }
    }
    return [
      "TagCode slash commands",
      "",
      renderTable(rows, ["Command", "Description"]),
      "",
      "Anything not starting with / is sent to the agent.",
      usageLines(),
    ].join("\n");
  },
};

const status: CommandDefinition = {
  name: "status",
  description: "Show provider, model, mode, session and usage",
  usage: "/status",
  handler: async ({ controller }) => {
    const session = controller.getSession();
    const usage = controller.getUsage();
    const stats = controller.getContextStats();
    const lines = [
      `Provider: ${controller.getProviderId() || "(not configured)"}`,
      `Model: ${controller.getModel() || "(not selected)"}`,
      `Interaction mode: ${controller.getMode()}`,
      `Permission mode: ${controller.getPermissionMode()}`,
      `Session: ${session.id} (${session.messages.length} saved messages)`,
      `Workspace: ${controller.workspace}`,
      `Project root: ${controller.loaded.projectRoot}`,
      `Session usage: ${formatNumber(usage.inputTokens)} input / ${formatNumber(usage.outputTokens)} output tokens`,
      stats
        ? `Context: ~${formatNumber(stats.estimatedTokens)} / ${formatNumber(stats.budget)} tokens (${Math.round(
            (stats.estimatedTokens / Math.max(1, stats.budget)) * 100,
          )}%)`
        : "Context: not measured yet",
      `Running: ${controller.isRunning() ? "yes" : "no"}`,
    ];
    return lines.join("\n");
  },
};

const mode: CommandDefinition = {
  name: "mode",
  description: "Show or set the interaction mode (agent/plan/ask)",
  usage: "/mode [agent|plan|ask]",
  handler: async ({ args, controller }) => {
    const target = args[0] as AgentMode | undefined;
    if (!target) {
      return [
        `Current mode: ${controller.getMode()}`,
        "  agent — implement changes",
        "  plan  — investigate and plan, read-only",
        "  ask   — answer questions, read-only",
      ].join("\n");
    }
    if (!["agent", "plan", "ask"].includes(target)) {
      return fail("Mode must be agent, plan or ask.");
    }
    await controller.setMode(target);
    return `Interaction mode: ${target}${target === "agent" ? "" : " (read-only)"}.`;
  },
};

function modeCommand(name: AgentMode, description: string): CommandDefinition {
  return {
    name,
    description,
    usage: `/${name} [task]`,
    handler: async ({ raw, controller }) => {
      await controller.setMode(name);
      if (!raw.trim()) {
        return name === "agent"
          ? "Interaction mode: agent. You can now make changes."
          : `Interaction mode: ${name} (read-only).${name === "plan" ? " Describe the task to plan." : " Ask a question."}`;
      }
      await controller.run(raw);
    },
  };
}

const permissions: CommandDefinition = {
  name: "permissions",
  aliases: ["perms"],
  description: "Show or change the permission mode",
  usage: "/permissions [ask|auto|plan|yolo]",
  handler: async ({ args, controller }) => {
    const target = args[0] as PermissionMode | undefined;
    if (!target) {
      return [
        `Permission mode: ${controller.getPermissionMode()}`,
        "",
        "  ask  — approve every non-read operation",
        "  auto — run read/write/execute automatically; sensitive operations still ask",
        "  plan — read-only",
        "  yolo — never prompt; use with care",
        "",
        `Tool allow list: ${controller.config.permissions.allow.join(", ") || "(empty)"}`,
        `Always require approval: ${controller.config.permissions.requireApproval.join(", ") || "(empty)"}`,
        `Denied: ${controller.config.permissions.deny.join(", ") || "(empty)"}`,
      ].join("\n");
    }
    if (!PERMISSION_MODES.includes(target)) {
      return fail(`Permission mode must be one of: ${PERMISSION_MODES.join(", ")}`);
    }
    try {
      controller.setPermissionMode(target);
    } catch (error) {
      return errorText(error);
    }
    const warning =
      target === "yolo"
        ? "\nYOLO mode disables approval prompts. Destructive commands can run without confirmation."
        : "";
    return `Permission mode: ${target}.${warning}`;
  },
};

const model: CommandDefinition = {
  name: "model",
  description: "Show, list or change the active model",
  usage: "/model [list|<name>]",
  handler: async ({ args, controller }) => {
    if (args[0] === "list") {
      const result = await controller.listModels();
      if (result.models.length === 0) {
        return result.error ? fail(result.error) : "No models available.";
      }
      return [
        result.error ? `Warning: could not list remote models (${result.error}). Showing configured models.` : "",
        ...result.models.map((entry) => `${entry === controller.getModel() ? "* " : "  "}${entry}`),
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (args[0]) {
      try {
        await controller.setModel(args.join(" "));
        return `Model set to ${controller.getModel()}.`;
      } catch (error) {
        return errorText(error);
      }
    }
    const current = controller.getModel();
    const result = await controller.listModels();
    if (result.models.length > 0) {
      const picked = await chooseModel(controller, result.models);
      if (picked) {
        try {
          await controller.setModel(picked);
          return `Model set to ${picked}.`;
        } catch (error) {
          return errorText(error);
        }
      }
      const rows = result.models.map((entry) =>
        entry === current ? `* ${entry}` : `  ${entry}`,
      );
      return [
        `Provider: ${controller.getProviderId() || "(not configured)"}`,
        result.error
          ? `Warning: could not fetch the remote model list (${result.error}). Showing configured models.`
          : "Select a model with: /model <name>",
        "",
        ...rows,
        "",
        current ? `Current: ${current}` : "No model selected yet.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    let providerDefault: string | undefined;
    try {
      providerDefault = controller.config.providers.find(
        (provider) => provider.id === controller.getProviderId(),
      )?.defaultModel;
    } catch {
      providerDefault = undefined;
    }
    return [
      `Current model: ${current || "(not selected)"}`,
      `Provider: ${controller.getProviderId() || "(not configured)"}`,
      providerDefault ? `Provider default: ${providerDefault}` : "",
      result.error ? `Could not list models: ${result.error}` : "",
      "",
      "Configure a provider with /connect, then run /model again to fetch the list.",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

const models: CommandDefinition = {
  name: "models",
  description: "List models available from the active provider",
  usage: "/models",
  handler: async ({ controller }) => {
    const result = await controller.listModels();
    if (result.models.length === 0) {
      return result.error ? fail(result.error) : "No models available. Use /connect to configure a provider.";
    }
    return [
      result.error ? `Warning: could not list remote models (${result.error}). Showing configured models.` : "",
      ...result.models.map((entry) => `${entry === controller.getModel() ? "* " : "  "}${entry}`),
    ]
      .filter(Boolean)
      .join("\n");
  },
};

const disconnect: CommandDefinition = {
  name: "disconnect",
  description: "Remove a provider configuration and its stored API key",
  usage: "/disconnect [id] [--project]",
  handler: async ({ args, controller }) => {
    const id = args.find((arg) => !arg.startsWith("--")) ?? controller.getProviderId();
    if (!id) return "No provider is active. Use /provider to list configured providers.";
    const scope = args.includes("--project") ? "project" : "global";
    try {
      const removed = await controller.removeProvider(id, scope);
      return removed
        ? `Disconnected ${id}: removed the ${scope} configuration and any stored API key.`
        : `Provider ${id} was not in the ${scope} config.`;
    } catch (error) {
      return errorText(error);
    }
  },
};

function clipDiff(text: string, limit = 20_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… diff truncated (${text.length - limit} characters hidden)`;
}

const diff: CommandDefinition = {
  name: "diff",
  description: "Show the current Git diff for the workspace",
  usage: "/diff [--staged]",
  handler: async ({ args, controller }) => {
    if (!(await isGitRepository(controller.workspace))) {
      return "Not a Git repository. Initialize one with `git init` or use /checkpoints and /undo for file snapshots.";
    }
    const staged = args.includes("--staged");
    try {
      const text = await gitDiff(controller.workspace, staged);
      if (!text.trim()) {
        return staged
          ? "No staged changes. Use `git add` or the git_add tool first."
          : "No unstaged changes in the working tree.";
      }
      return clipDiff(text.trim());
    } catch (error) {
      return errorText(error);
    }
  },
};

const changes: CommandDefinition = {
  name: "changes",
  description: "List changed files and the current Git branch",
  usage: "/changes",
  handler: async ({ controller }) => {
    if (!(await isGitRepository(controller.workspace))) {
      return "Not a Git repository. Initialize one with `git init` or use /checkpoints to review snapshots.";
    }
    const [branch, status] = await Promise.all([
      currentBranch(controller.workspace),
      gitStatusPorcelain(controller.workspace),
    ]);
    if (!status) return `Working tree clean${branch ? ` on ${branch}` : ""}.`;
    return [`Branch: ${branch ?? "(detached HEAD)"}`, "", status].join("\n");
  },
};

const provider: CommandDefinition = {
  name: "provider",
  description: "List, switch or remove providers",
  usage: "/provider [id|remove <id> [--project]]",
  handler: async ({ args, controller }) => {
    if (args[0] === "remove") {
      const id = args[1];
      if (!id) return "Usage: /provider remove <id> [--project]";
      const scope = args.includes("--project") ? "project" : "global";
      try {
        const removed = await controller.removeProvider(id, scope);
        return removed
          ? `Removed provider ${id} from ${scope} config and deleted its stored API key.`
          : `Provider ${id} was not in the ${scope} config.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (args[0]) {
      try {
        await controller.setProvider(args[0]);
        return `Provider: ${controller.getProviderId()}. Model: ${controller.getModel() || "(not selected)"}.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (controller.config.providers.length === 0) {
      return "No providers configured. Use /connect to add one.";
    }
    const active = controller.getProviderId();
    const rows = controller.config.providers.map((entry) => [
      entry.id === active ? `* ${entry.id}` : `  ${entry.id}`,
      entry.type,
      entry.defaultModel ?? "(no default model)",
      entry.enabled === false ? "disabled" : "enabled",
    ]);
    return renderTable(rows, ["Provider", "Type", "Model", "Status"]);
  },
};

const connect: CommandDefinition = {
  name: "connect",
  description: "Configure a model provider",
  usage: "/connect [type] [--id id] [--model name] [--base-url url] [--api-key key] [--project]",
  handler: async ({ args, controller }) => {
    if (args.length === 0) {
      const rows = PROVIDER_TYPES.map((type) => {
        const preset = PROVIDER_PRESETS[type];
        return [type, preset.label, preset.requiresKey ? "API key" : "no key", preset.suggestedModel || "—"];
      });
      const configured = controller.config.providers.map((entry) => `  ${entry.id} (${entry.type})`);
      return [
        renderTable(rows, ["Type", "Provider", "Auth", "Suggested model"]),
        "",
        configured.length ? `Configured:\n${configured.join("\n")}` : "No providers configured yet.",
        "",
        "Quick start:",
        "  /connect anthropic      Claude models (API key)",
        "  /connect openai         GPT models (API key)",
        "  /connect ollama         local models (no key)",
        "  /connect custom         guided OpenAI-compatible endpoint setup",
        "After connecting, /model opens a picker populated from the provider.",
      ].join("\n");
    }
    const type = args[0] as ProviderType;
    if (!PROVIDER_TYPES.includes(type)) {
      return fail(`Unknown provider type "${type}". Available: ${PROVIDER_TYPES.join(", ")}`);
    }
    const rest = args.slice(1);
    const { flags } = parseFlags(rest);
    let baseUrl = typeof flags["base-url"] === "string" ? flags["base-url"] : undefined;
    let model = typeof flags.model === "string" ? flags.model : undefined;
    let apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;

    if (type === "custom") {
      if (!baseUrl && controller.canPrompt()) {
        const entered = await controller.requestInput(
          "Base URL for the OpenAI-compatible endpoint (e.g. http://localhost:8000/v1):",
        );
        if (!entered?.trim()) {
          return "Custom connection cancelled. Pass --base-url and --model to configure it non-interactively.";
        }
        baseUrl = entered.trim();
      }
      if (!model && controller.canPrompt()) {
        const entered = await controller.requestInput(
          "Model name (optional — run /model afterwards to pick from the provider list):",
        );
        if (entered?.trim()) model = entered.trim();
      }
      if (!apiKey && controller.canPrompt()) {
        const secret = await controller.requestSecret("API key for this endpoint (Enter to skip):");
        if (secret?.trim()) apiKey = secret.trim();
      }
    }

    try {
      const result = await controller.connectProvider(type, {
        id: typeof flags.id === "string" ? flags.id : undefined,
        name: typeof flags.name === "string" ? flags.name : undefined,
        model,
        baseUrl,
        apiKey,
        scope: flags.project ? "project" : "global",
      });
      return [
        `Configured ${presetLabel(type)} as "${result.id}" (${result.scope}).`,
        `Config: ${result.file}`,
        result.backend === "file"
          ? "Warning: the API key was stored in ~/.tagcode/auth.json because the OS keychain is unavailable. The file is mode 0600 but not encrypted at rest."
          : result.backend === "keychain"
            ? "API key stored in the OS credential store."
            : "No API key was stored.",
        await (async () => {
          const available = await controller.listModels();
          const picked = await chooseModel(controller, available.models);
          if (!picked) return "Next: run /model to fetch the provider's models and choose one.";
          await controller.setModel(picked);
          return `Model set to ${picked}.`;
        })(),
      ].join("\n");
    } catch (error) {
      return errorText(error);
    }
  },
};

const context: CommandDefinition = {
  name: "context",
  description: "Show context budget and message statistics",
  usage: "/context",
  handler: async ({ controller }) => {
    const stats = controller.getContextStats();
    const messages = controller.getMessages();
    const lines = [
      `Messages: ${messages.length}`,
      `Session usage: ${formatNumber(controller.getUsage().inputTokens)} input / ${formatNumber(controller.getUsage().outputTokens)} output tokens`,
    ];
    if (stats) {
      const percent = Math.round((stats.estimatedTokens / Math.max(1, stats.budget)) * 100);
      lines.push(
        `Estimated context: ~${formatNumber(stats.estimatedTokens)} / ${formatNumber(stats.budget)} tokens (${percent}%)`,
        `Compaction triggers at ${Math.round(controller.config.context.compactAt * 100)}%.`,
        "Use /compact to summarize now.",
      );
    } else {
      lines.push(
        `Context budget: ${controller.config.context.maxTokens === 0 ? "auto (model-derived)" : formatNumber(controller.config.context.maxTokens)} tokens`,
        "The estimate is available after the first model turn.",
      );
    }
    return lines.join("\n");
  },
};

const cost: CommandDefinition = {
  name: "cost",
  aliases: ["usage"],
  description: "Show token usage for this session",
  usage: "/cost",
  handler: async ({ controller }) => {
    const usage = controller.getUsage();
    return [
      `Input tokens: ${formatNumber(usage.inputTokens)}`,
      `Output tokens: ${formatNumber(usage.outputTokens)}`,
      `Total: ${formatNumber(usage.inputTokens + usage.outputTokens)}`,
      "",
      "Usage is reported by the provider. Local servers may report zero.",
    ].join("\n");
  },
};

const compact: CommandDefinition = {
  name: "compact",
  description: "Summarize older conversation history to free context",
  usage: "/compact",
  handler: async ({ controller }) => {
    try {
      const result = await controller.compact();
      return `Compacted conversation: ${result.before} → ${result.after} messages.`;
    } catch (error) {
      return errorText(error);
    }
  },
};

const clear: CommandDefinition = {
  name: "clear",
  description: "Clear the current conversation (keeps the session file)",
  usage: "/clear",
  handler: async ({ controller }) => {
    try {
      await controller.clearConversation();
      return { output: "Conversation cleared.", resetView: true };
    } catch (error) {
      return errorText(error);
    }
  },
};

const init: CommandDefinition = {
  name: "init",
  description: "Create project scaffolding and an AGENTS.md from detected project facts",
  usage: "/init",
  handler: async ({ controller }) => {
    try {
      const result = await controller.initProject();
      const lines = [
        result.created.length
          ? `Created:\n${result.created.map((entry) => `  ${entry}`).join("\n")}`
          : "Project scaffolding already existed; nothing was created.",
        result.agentSkipped
          ? `AGENTS.md already exists at ${result.agentsFile}; left untouched.`
          : `Wrote ${result.agentsFile}. Review and edit it — it contains only detected facts plus working agreements.`,
      ];
      return lines.join("\n");
    } catch (error) {
      return errorText(error);
    }
  },
};

const memory: CommandDefinition = {
  name: "memory",
  description: "Manage project and global memory",
  usage: "/memory [show|list|search <q>|add <section> <text>|clear|export] [--global]",
  handler: async ({ args, controller }) => {
    const bundle = controller.getMemory();
    const globalFlag = args.includes("--global");
    const positional = args.filter((arg) => arg !== "--global" && arg !== "--force");
    const sub = positional[0] ?? "show";
    const store = globalFlag ? bundle.global : bundle.project;

    if (sub === "list") {
      const [projectFiles, globalFiles] = await Promise.all([
        bundle.project.listFiles(),
        bundle.global.listFiles(),
      ]);
      return [
        `Project (${bundle.project.directory}): ${projectFiles.join(", ") || "(empty)"}`,
        `Global (${bundle.global.directory}): ${globalFiles.join(", ") || "(empty)"}`,
      ].join("\n");
    }
    if (sub === "search") {
      const query = positional.slice(1).join(" ");
      if (!query) return "Usage: /memory search <query>";
      const results = await searchMemory(bundle, query, 20);
      return results.length ? results.join("\n") : `No memory matched "${query}".`;
    }
    if (sub === "add") {
      const section = positional[1];
      const text = positional.slice(2).join(" ");
      if (!section || !text) return "Usage: /memory add [--global] <section> <text>";
      try {
        const file = await store.append(section, text);
        return `Saved to ${file}.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "clear") {
      if (!controller.config.permissions.mode || args.includes("--force")) {
        // fall through to explicit confirmation below
      }
      const confirmed =
        args.includes("--force") ||
        (await controller.confirm(`Clear all ${globalFlag ? "global" : "project"} memory files?`));
      if (!confirmed) return "Memory was not cleared. Add --force to skip the confirmation prompt.";
      try {
        const removed = await store.clear();
        return removed.length ? `Removed ${removed.length} memory file(s).` : "Memory was already empty.";
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "export") {
      return store.export();
    }
    if (sub === "show" || sub === "read") {
      const [projectText, globalText] = await Promise.all([
        bundle.project.readAll(12_000),
        bundle.global.readAll(8_000),
      ]);
      return [
        "## Project memory",
        projectText || "(empty)",
        "",
        "## Global memory",
        globalText || "(empty)",
      ].join("\n");
    }
    return `Unknown memory action "${sub}". ${memory.usage}`;
  },
};

const sessions: CommandDefinition = {
  name: "sessions",
  description: "List saved sessions for this project",
  usage: "/sessions",
  handler: async ({ controller }) => {
    const list = await controller.listSessions();
    if (list.length === 0) return "No saved sessions for this project yet.";
    const rows = list.map((summary) => [
      summary.id === controller.sessionId ? `* ${summary.id}` : `  ${summary.id}`,
      summary.title.slice(0, 40),
      summary.provider || "—",
      summary.model || "—",
      String(summary.messageCount),
      new Date(summary.updatedAt).toLocaleString(),
    ]);
    return renderTable(rows, ["Session", "Title", "Provider", "Model", "Msgs", "Updated"]);
  },
};

const resume: CommandDefinition = {
  name: "resume",
  description: "Resume a saved session",
  usage: "/resume <id|latest>",
  handler: async ({ args, controller }) => {
    if (!args[0]) return "Usage: /resume <id|latest>. Use /sessions to list ids.";
    try {
      const session = await controller.loadSession(args[0]);
      return {
        output: `Resumed ${session.id} with ${session.messages.length} messages.`,
        resetView: true,
      };
    } catch (error) {
      return errorText(error);
    }
  },
};

const session: CommandDefinition = {
  name: "session",
  description: "Inspect or manage the current session",
  usage: "/session [info|new|rename <title>|delete <id>|export [path]]",
  handler: async ({ args, controller }) => {
    const sub = args[0] ?? "info";
    if (sub === "new") {
      try {
        const created = await controller.newSession();
        return { output: `Started ${created.id}.`, resetView: true };
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "rename") {
      const title = args.slice(1).join(" ");
      if (!title) return "Usage: /session rename <title>";
      await controller.renameSession(title);
      return `Session renamed to "${title}".`;
    }
    if (sub === "delete") {
      const id = args[1];
      if (!id) return "Usage: /session delete <id>";
      if (!(await controller.confirm(`Delete session ${id}? This cannot be undone.`))) {
        return "Session was not deleted.";
      }
      try {
        await controller.deleteSession(id);
        return `Deleted ${id}.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "export") {
      const destination = args[1]
        ? path.resolve(controller.workspace, args[1])
        : undefined;
      try {
        const result = await controller.exportSession(destination);
        return destination ? `Exported session to ${result}.` : result;
      } catch (error) {
        return errorText(error);
      }
    }
    const current = controller.getSession();
    return [
      `Session: ${current.id}`,
      `Title: ${current.title}`,
      `Created: ${current.createdAt}`,
      `Updated: ${current.updatedAt}`,
      `Messages: ${controller.getMessages().length}`,
      `Provider/model: ${current.provider}/${current.model || "(not set)"}`,
      `Permission mode: ${current.permissionMode}`,
      `Working directory: ${current.cwd}`,
      `Project root: ${current.projectRoot}`,
      "",
      "Use /session export <path> to write Markdown.",
    ].join("\n");
  },
};

const save: CommandDefinition = {
  name: "save",
  description: "Save the current session to disk",
  usage: "/save",
  handler: async ({ controller }) => {
    try {
      return `Session saved to ${await controller.saveSession()}.`;
    } catch (error) {
      return errorText(error);
    }
  },
};

const exportCommand: CommandDefinition = {
  name: "export",
  description: "Export the current session as Markdown",
  usage: "/export [path]",
  handler: async ({ args, controller }) => {
    const destination = args[0] ? path.resolve(controller.workspace, args[0]) : undefined;
    try {
      const result = await controller.exportSession(destination);
      return destination ? `Exported to ${result}.` : result;
    } catch (error) {
      return errorText(error);
    }
  },
};

function describeRestore(
  action: string,
  result: Awaited<ReturnType<SessionController["undo"]>>,
): string {
  if (!result) return `Nothing to ${action}.`;
  const warnings = result.warnings.length
    ? `\nWarnings:\n${result.warnings.map((warning) => `  - ${warning}`).join("\n")}`
    : "";
  return `${action === "undo" ? "Undid" : "Redid"} checkpoint ${result.checkpoint.id} (${result.checkpoint.reason}). Restored ${result.restored.length} path(s): ${result.restored.join(", ") || "(none)"}.${warnings}`;
}

const undo: CommandDefinition = {
  name: "undo",
  description: "Restore files from the most recent checkpoint",
  usage: "/undo",
  handler: async ({ controller }) => {
    try {
      return describeRestore("undo", await controller.undo());
    } catch (error) {
      return errorText(error);
    }
  },
};

const redo: CommandDefinition = {
  name: "redo",
  description: "Reapply the last undone checkpoint",
  usage: "/redo",
  handler: async ({ controller }) => {
    try {
      return describeRestore("redo", await controller.redo());
    } catch (error) {
      return errorText(error);
    }
  },
};

const checkpoints: CommandDefinition = {
  name: "checkpoints",
  aliases: ["checkpoint"],
  description: "List checkpoints or capture specific paths",
  usage: "/checkpoints | /checkpoint <path...> [--reason text]",
  handler: async ({ args, controller }) => {
    const { positional, flags } = parseFlags(args);
    if (positional.length > 0) {
      const reason = typeof flags.reason === "string" ? flags.reason : "manual checkpoint";
      const paths = positional.map((entry) => path.resolve(controller.workspace, entry));
      try {
        const id = await controller.createCheckpoint(paths, reason);
        return id ? `Created checkpoint ${id}.` : "No valid workspace paths were provided.";
      } catch (error) {
        return errorText(error);
      }
    }
    const list = await controller.listCheckpoints();
    if (list.length === 0) return "No checkpoints yet. Writes through TagCode create them automatically.";
    const rows = list.map((meta) => [
      meta.id,
      new Date(meta.createdAt).toLocaleString(),
      String(meta.files.length),
      meta.reason.slice(0, 50),
    ]);
    return renderTable(rows, ["Checkpoint", "Created", "Files", "Reason"]);
  },
};

const skills: CommandDefinition = {
  name: "skills",
  description: "List, activate, install and create skills",
  usage: "/skills [list|active|index|use <name>|off <name>|install <path|url>|remove <name>|update <name>|search <q>|create <description>|validate <path>]",
  handler: async ({ args, controller }) => {
    const manager = controller.getSkillManager();
    const installer = controller.getSkillInstaller();
    const { positional, flags } = parseFlags(args);
    const sub = positional[0] ?? "list";
    const scope = flags.global ? "global" : "project";

    if (sub === "list") {
      const discovered = manager.list();
      if (discovered.length === 0) {
        return "No skills installed. Use /skills install <path|git-url> or /skills create <description>.";
      }
      const active = new Set(manager.getActiveNames());
      const rows = discovered.map((skill) => [
        active.has(skill.name) ? `* ${skill.name}` : `  ${skill.name}`,
        skill.source,
        skill.valid ? "valid" : "INVALID",
        skill.description.replace(/\s+/g, " ").slice(0, 70),
      ]);
      return renderTable(rows, ["Skill", "Source", "State", "Description"]);
    }
    if (sub === "active") {
      const active = manager.activeSkills();
      return active.length
        ? active.map((skill) => `${skill.name}: ${skill.description}`).join("\n")
        : "No skills are active. Use /skills use <name>.";
    }
    if (sub === "index") return manager.buildIndex();
    if (sub === "use") {
      const name = positional[1];
      if (!name) return "Usage: /skills use <name>";
      const skill = manager.activate(name);
      return skill ? `Activated ${skill.name}.` : `Skill not found or invalid: ${name}`;
    }
    if (sub === "off") {
      const name = positional[1];
      if (!name) return "Usage: /skills off <name>";
      manager.deactivate(name);
      return `Deactivated ${name}.`;
    }
    if (sub === "install") {
      const source = positional[1];
      if (!source) return "Usage: /skills install <directory|git-url> [--global]";
      try {
        const skill = isProbablyUrl(source)
          ? await installer.installFromGit(source, scope)
          : await installer.installFromLocal(path.resolve(controller.workspace, source), scope);
        await controller.refreshSkills();
        return `Installed ${skill.name} (${scope}) from ${source}.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "remove") {
      const name = positional[1];
      if (!name) return "Usage: /skills remove <name> [--global]";
      if (!(await controller.confirm(`Remove skill "${name}" (${scope})?`))) {
        return "Skill was not removed. Re-run and confirm, or delete the directory manually.";
      }
      try {
        const removed = await installer.remove(name, scope);
        await controller.refreshSkills();
        return removed ? `Removed ${name} (${scope}).` : `Skill not found: ${name} (${scope}).`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "update") {
      const name = positional[1];
      if (!name) return "Usage: /skills update <name> [--global]";
      try {
        const skill = await installer.update(name, scope);
        await controller.refreshSkills();
        return `Updated ${skill.name} (${scope}).`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "search") {
      const query = positional.slice(1).join(" ");
      if (!query) return "Usage: /skills search <query>";
      try {
        const result = await installer.searchRegistry(query);
        if (!result.configured) return "No skills registry configured. Set skills.registryUrl in config.json.";
        if (result.results.length === 0) return `No registry skills matched "${query}".`;
        return renderTable(
          result.results.map((entry) => [entry.name, entry.version ?? "—", entry.url, entry.description.slice(0, 60)]),
          ["Skill", "Version", "URL", "Description"],
        );
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "inspect") {
      const name = positional[1];
      if (!name) return "Usage: /skills inspect <name>";
      const skill = manager.get(name);
      if (!skill) return `Skill not found: ${name}`;
      return [
        `Skill: ${skill.name}`,
        `Description: ${skill.description}`,
        `Source: ${skill.source}`,
        `Directory: ${skill.directory}`,
        `Version: ${skill.metadata.version ?? "—"}`,
        `State: ${skill.valid ? "valid" : "INVALID"}`,
        skill.errors.length ? `Errors:\n${skill.errors.map((error) => `  ✘ ${error}`).join("\n")}` : "",
        skill.warnings.length ? `Warnings:\n${skill.warnings.map((warning) => `  ! ${warning}`).join("\n")}` : "",
        "",
        (await manager.readInstructions(name)) ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (sub === "reload") {
      await controller.refreshSkills();
      return `Reloaded ${manager.list().length} skill(s); ${manager.getActiveNames().length} active.`;
    }
    if (sub === "create") {
      const selectors = new Set(["from-session", "from-project", "from-description"]);
      let rest = positional.slice(1);
      let source: "description" | "project" | "session" | "all" = "all";
      if (rest[0] && selectors.has(rest[0])) {
        const selector = rest[0];
        source =
          selector === "from-session"
            ? "session"
            : selector === "from-project"
              ? "project"
              : "description";
        rest = rest.slice(1);
      }
      const description =
        rest.join(" ").trim() ||
        (source === "session" ? "Reusable workflow based on the current session." : "");
      if (!description) return "Usage: /skills create [from-session|from-project|from-description] <description>";
      controller.emit({ type: "notice", level: "info", text: "Generating a SKILL.md with the active model…" });
      try {
        const result = await controller.createSkill(description, scope, source);
        if (result.installed) return `Created and installed ${result.installed}.`;
        return [
          "Generated skill failed validation:",
          ...result.errors.map((error) => `  - ${error}`),
          "",
          "Generated content:",
          result.markdown,
        ].join("\n");
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "validate") {
      const target = positional[1];
      if (!target) return "Usage: /skills validate <directory>";
      try {
        const result = await validateSkillDirectory(path.resolve(controller.workspace, target), "configured");
        return [
          result.skill ? `Valid skill: ${result.skill.name}` : "Invalid skill",
          ...result.errors.map((error) => `  ✘ ${error}`),
          ...result.warnings.map((warning) => `  ! ${warning}`),
        ].join("\n");
      } catch (error) {
        return errorText(error);
      }
    }
    return `Unknown skills action "${sub}". ${skills.usage}`;
  },
};

const mcp: CommandDefinition = {
  name: "mcp",
  description: "Manage MCP servers and inspect their tools",
  usage: "/mcp [status|tools|add <name> -- <command...>|add <name> --url <url>|remove <name>|reconnect <name>|refresh]",
  handler: async ({ args, controller }) => {
    const manager = controller.getMcpManager();
    const { positional, flags } = parseFlags(args);
    const sub = positional[0] ?? "status";

    if (sub === "status" || sub === "list") {
      const statuses = manager?.getStatuses() ?? [];
      if (statuses.length === 0) return "No MCP servers configured. Add one with /mcp add <name> -- <command...>.";
      const rows = statuses.map((entry) => [
        entry.name,
        entry.transport,
        entry.state,
        `${entry.toolCount} tools`,
        `${entry.resourceCount} res`,
        `${entry.promptCount} prompts`,
        entry.error ? entry.error.replace(/\s+/g, " ").slice(0, 60) : "",
      ]);
      return renderTable(rows, ["Server", "Transport", "State", "Tools", "Resources", "Prompts", "Error"]);
    }
    if (sub === "tools") {
      const tools = controller
        .getToolRegistry()
        .list()
        .filter((tool) => tool.name.startsWith("mcp__"));
      if (tools.length === 0) return "No MCP tools are registered.";
      return renderTable(
        tools.map((tool) => [tool.name, tool.permission, tool.description.slice(0, 70)]),
        ["Tool", "Permission", "Description"],
      );
    }
    if (sub === "add") {
      const name = positional[1];
      if (!name) return "Usage: /mcp add <name> -- <command...> OR /mcp add <name> --url <url>";
      const scope = scopeFrom(flags);
      const dashIndex = args.indexOf("--");
      let server;
      if (typeof flags.url === "string") {
        server = { type: "http" as const, url: flags.url, enabled: true };
      } else if (dashIndex >= 0 && dashIndex < args.length - 1) {
        const command = args.slice(dashIndex + 1);
        server = {
          type: "stdio" as const,
          command: command[0]!,
          args: command.slice(1),
          enabled: true,
        };
      } else {
        return "Usage: /mcp add <name> -- <command...> OR /mcp add <name> --url <url>";
      }
      try {
        const file = await upsertMcpServer(scope, name, server, controller.loaded.projectRoot);
        await controller.reloadMcp();
        return `Added MCP server "${name}" to ${file} and reconnected.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "remove") {
      const name = positional[1];
      if (!name) return "Usage: /mcp remove <name> [--project]";
      const scope = scopeFrom(flags);
      try {
        let removed = await removeMcpServer(scope, name, controller.loaded.projectRoot);
        if (!removed) {
          removed = await removeMcpServer(scope === "global" ? "project" : "global", name, controller.loaded.projectRoot);
        }
        await controller.reloadMcp();
        return removed ? `Removed MCP server "${name}".` : `MCP server not found: ${name}`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "reconnect") {
      const name = positional[1];
      try {
        if (!name || name === "--all") {
          const statuses = await controller.reloadMcp();
          return `Reconnected ${statuses.filter((entry) => entry.state === "connected").length}/${statuses.length} MCP servers.`;
        }
        if (!manager) return "No MCP manager is active.";
        const status = await manager.reconnect(name);
        return status.state === "connected"
          ? `Reconnected ${name}: ${status.toolCount} tools, ${status.resourceCount} resources, ${status.promptCount} prompts.`
          : `Reconnect failed for ${name}: ${status.error ?? status.state}`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "refresh" || sub === "reload") {
      const statuses = await controller.reloadMcp();
      return `Refreshed MCP: ${statuses.filter((entry) => entry.state === "connected").length}/${statuses.length} connected.`;
    }
    if (sub === "connect") {
      if (!manager) return "No MCP manager is active.";
      const name = positional[1];
      try {
        if (!name) {
          const statuses = await manager.connectAll();
          return `Connected ${statuses.filter((entry) => entry.state === "connected").length}/${statuses.length} MCP servers.`;
        }
        const status = await manager.connect(name);
        return status.state === "connected"
          ? `Connected ${name}: ${status.toolCount} tools, ${status.resourceCount} resources, ${status.promptCount} prompts.`
          : `Could not connect ${name}: ${status.error ?? status.state}`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "disconnect") {
      if (!manager) return "No MCP manager is active.";
      const name = positional[1];
      if (!name) return "Usage: /mcp disconnect <name>";
      try {
        await manager.disconnect(name);
        return `Disconnected MCP server "${name}". Its tools were unregistered.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "inspect") {
      const name = positional[1];
      if (!name) return "Usage: /mcp inspect <name>";
      const status = manager?.getStatus(name);
      if (!status) return `Unknown MCP server: ${name}`;
      const toolNames = manager?.getToolNames(name) ?? [];
      return [
        `Server: ${status.name}${status.serverName ? ` (${status.serverName} ${status.serverVersion ?? ""})` : ""}`,
        `Transport: ${status.transport}`,
        `State: ${status.state}`,
        `Tools: ${status.toolCount} · Resources: ${status.resourceCount} · Templates: ${status.templateCount} · Prompts: ${status.promptCount}`,
        status.error ? `Error: ${status.error}` : "",
        status.instructions ? `\nInstructions:\n${status.instructions}` : "",
        toolNames.length ? `\nRegistered tools:\n${toolNames.map((tool) => `  ${tool}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    return `Unknown MCP action "${sub}". ${mcp.usage}`;
  },
};

const plugins: CommandDefinition = {
  name: "plugins",
  description: "List, enable or disable plugins",
  usage: "/plugins [list|enable <name>|disable <name>|reload] [--project]",
  handler: async ({ args, controller }) => {
    const host = controller.getPluginHost();
    const { positional, flags } = parseFlags(args);
    const sub = positional[0] ?? "list";
    if (sub === "enable" || sub === "disable") {
      const name = positional[1];
      if (!name) return `Usage: /plugins ${sub} <name> [--project]`;
      try {
        await controller.setPluginEnabled(name, sub === "enable", scopeFrom(flags));
        return `${sub === "enable" ? "Enabled" : "Disabled"} plugin "${name}" (${scopeFrom(flags)}).`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "reload") {
      const statuses = await controller.reloadPlugins();
      return `Reloaded plugins: ${statuses.filter((entry) => entry.state === "loaded").length}/${statuses.length} loaded.`;
    }
    const statuses = host?.getStatuses() ?? [];
    if (statuses.length === 0) {
      return [
        "No plugins discovered.",
        "Add a plugin directory containing plugin.json under .tagcode/plugins, ~/.tagcode/plugins, or plugins.directories.",
        "Plugins load only when listed in plugins.enabled.",
      ].join("\n");
    }
    const rows = statuses.map((entry) => [
      entry.state === "loaded" ? `* ${entry.name}` : `  ${entry.name}`,
      entry.version ?? "—",
      entry.source ?? "—",
      entry.state,
      `${entry.tools.length} tools, ${entry.commands.length} cmds`,
      entry.error ?? entry.reason ?? "",
    ]);
    const commands = host?.getCommands() ?? [];
    return [
      renderTable(rows, ["Plugin", "Version", "Source", "State", "Contributions", "Detail"]),
      commands.length
        ? `\nPlugin commands:\n${commands.map((entry) => `  /plugin:${entry.key} — ${entry.command.description}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

const tools: CommandDefinition = {
  name: "tools",
  description: "List registered tools",
  usage: "/tools [filter]",
  handler: async ({ args, controller }) => {
    const filter = args.join(" ").toLowerCase();
    const list = controller
      .getToolRegistry()
      .list()
      .filter(
        (tool) =>
          !filter ||
          tool.name.toLowerCase().includes(filter) ||
          tool.description.toLowerCase().includes(filter),
      );
    if (list.length === 0) return filter ? `No tools matched "${filter}".` : "No tools registered.";
    return renderTable(
      list.map((tool) => [tool.name, tool.permission, tool.description.replace(/\s+/g, " ").slice(0, 80)]),
      ["Tool", "Permission", "Description"],
    );
  },
};

const configCommand: CommandDefinition = {
  name: "config",
  description: "Show or change configuration values",
  usage: "/config [show|path|get <key>|set <key> <value>] [--project]",
  handler: async ({ args, controller }) => {
    const { positional, flags } = parseFlags(args);
    const sub = positional[0] ?? "show";
    const scope = scopeFrom(flags);
    if (sub === "path") {
      return [
        `Global: ${controller.loaded.globalPath}`,
        `Project: ${controller.loaded.projectPath}`,
      ].join("\n");
    }
    if (sub === "get") {
      const key = positional[1];
      if (!key) return "Usage: /config get <key>";
      const value = controller.getConfigValue(key);
      return value === undefined
        ? `No value for ${key}.`
        : `${key} = ${JSON.stringify(redactValue(value), null, 2)}`;
    }
    if (sub === "set") {
      const key = positional[1];
      const value = positional.slice(2).join(" ");
      if (!key || !value) return "Usage: /config set <key> <value> [--project]";
      try {
        await controller.setConfigValue(key, value, scope);
        if (key === "permissions.mode") {
          controller.setPermissionMode(value as PermissionMode);
        }
        return `Set ${key} in ${scope} config and reloaded.`;
      } catch (error) {
        return errorText(error);
      }
    }
    if (sub === "reload") {
      await controller.reloadConfig();
      return "Configuration reloaded.";
    }
    return JSON.stringify(redactValue(controller.config), null, 2);
  },
};

const doctor: CommandDefinition = {
  name: "doctor",
  description: "Diagnose configuration, providers, secrets, git, MCP and plugins",
  usage: "/doctor",
  handler: async ({ controller }) => {
    const report = await controller.doctor();
    return [...report.lines, "", report.ok ? "Doctor: OK" : "Doctor: problems found"].join("\n");
  },
};

const quit: CommandDefinition = {
  name: "quit",
  aliases: ["exit", "q"],
  description: "Exit TagCode",
  usage: "/quit",
  handler: async () => ({ output: "Goodbye.", exit: true }),
};

const version: CommandDefinition = {
  name: "version",
  description: "Show the TagCode version",
  usage: "/version",
  handler: async () => {
    const { VERSION } = await import("../version.js");
    return `TagCode ${VERSION}`;
  },
};

const newSessionCommand: CommandDefinition = {
  name: "new",
  description: "Start a new session",
  usage: "/new",
  handler: async ({ controller }) => {
    try {
      const created = await controller.newSession();
      return { output: `Started ${created.id}.`, resetView: true };
    } catch (error) {
      return errorText(error);
    }
  },
};

export function createBuiltinCommands(): CommandDefinition[] {
  return [
    help,
    status,
    mode,
    modeCommand("agent", "Switch to agent mode (may modify files)"),
    modeCommand("plan", "Switch to plan mode (read-only) and optionally plan a task"),
    modeCommand("ask", "Switch to ask mode (read-only) and optionally ask a question"),
    permissions,
    model,
    models,
    provider,
    connect,
    disconnect,
    diff,
    changes,
    context,
    cost,
    compact,
    clear,
    init,
    memory,
    sessions,
    resume,
    session,
    newSessionCommand,
    save,
    exportCommand,
    undo,
    redo,
    checkpoints,
    skills,
    mcp,
    plugins,
    tools,
    configCommand,
    doctor,
    version,
    quit,
  ];
}
