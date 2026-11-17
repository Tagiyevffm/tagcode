#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import pc from "picocolors";
import { SessionController, type ControllerUiHooks } from "../controller.js";
import type { AgentEvent, AgentMode, ChatMessage, PermissionMode } from "../core/types.js";
import { PERMISSION_MODES, PROVIDER_TYPES, type McpServerConfig, type ProviderType } from "../config/schema.js";
import { PROVIDER_PRESETS } from "../providers/registry.js";
import { removeMcpServer, upsertMcpServer } from "../config/config.js";
import { SessionStore, type SessionSummary } from "../sessions/store.js";
import { redactValue } from "../security/redact.js";
import { isProbablyUrl } from "../utils/fs.js";
import { toError } from "../core/errors.js";
import { formatNumber } from "../utils/strings.js";
import { VERSION } from "../version.js";

type GlobalOptions = {
  cwd: string;
  provider?: string;
  model?: string;
  mode?: AgentMode;
  permission?: PermissionMode;
  session?: string;
  mcp: boolean;
  plugins: boolean;
};

type CliUiHooks = ControllerUiHooks;

function colorsEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(code: string, text: string): string {
  return colorsEnabled() ? `\u001b[${code}m${text}\u001b[39m` : text;
}

const accent = (text: string) => paint("38;2;245;158;11", text);
const success = (text: string) => paint("38;2;34;197;94", text);
const danger = (text: string) => paint("38;2;239;68;68", text);
const muted = (text: string) => paint("38;2;130;138;150", text);

function stderr(line = ""): void {
  process.stderr.write(`${line}\n`);
}

function stdout(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function errorLine(error: unknown): string {
  return danger(`Error: ${toError(error).message}`);
}

function renderTable(rows: string[][], headers: string[]): string {
  if (rows.length === 0) return headers.join("  ");
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

function buildController(program: Command, ui: CliUiHooks = {}): SessionController {
  const options = program.opts<GlobalOptions>();
  return new SessionController({
    workspace: path.resolve(options.cwd || process.cwd()),
    providerId: options.provider,
    model: options.model,
    mode: options.mode,
    permissionMode: options.permission,
    sessionId: options.session,
    connectMcp: options.mcp !== false,
    loadPlugins: options.plugins !== false,
    ui,
  });
}

async function withController<T>(
  program: Command,
  action: (controller: SessionController) => Promise<T>,
  ui: CliUiHooks = {},
): Promise<T> {
  const controller = buildController(program, ui);
  try {
    await controller.initialize();
    return await action(controller);
  } finally {
    await controller.dispose();
  }
}

function readLines(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

async function readStdinIfAvailable(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  try {
    return await readLines(process.stdin);
  } catch {
    return undefined;
  }
}

/** Read a secret without echoing it. Falls back to a visible prompt on non-TTY input. */
async function promptSecret(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    stderr(`${label} (stdin is not a TTY; input is visible)`);
    const line = await readLines(process.stdin);
    return line.trim() || undefined;
  }
  process.stderr.write(`${label} `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = (result?: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      resolve(result);
    };
    const onData = (input: Buffer | string) => {
      const text = input.toString();
      for (const char of text) {
        if (char === "\u0003") {
          finish(undefined);
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(value || undefined);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        if (char >= " " || char === "\t") {
          value += char;
          process.stderr.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function summarizeSessions(list: SessionSummary[]): string {
  return renderTable(
    list.map((entry) => [
      entry.id,
      entry.title.slice(0, 44),
      entry.provider || "—",
      entry.model || "—",
      String(entry.messageCount),
      new Date(entry.updatedAt).toLocaleString(),
    ]),
    ["Session", "Title", "Provider", "Model", "Msgs", "Updated"],
  );
}

function sessionTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      lines.push(accent("You"), message.content, "");
    } else if (message.role === "assistant") {
      if (message.content) lines.push(accent("Assistant"), message.content, "");
      for (const call of message.toolCalls ?? []) {
        lines.push(muted(`  → ${call.name} ${call.arguments.slice(0, 300)}`));
      }
      if (message.toolCalls?.length) lines.push("");
    } else if (message.role === "tool") {
      lines.push(
        muted(`  ← ${message.name ?? "tool"}${message.isError ? " (error)" : ""}: ${message.content.slice(0, 600)}`),
        "",
      );
    }
  }
  return lines.join("\n").trim();
}

type HeadlessOptions = {
  json?: boolean;
  yes?: boolean;
  quiet?: boolean;
  showReasoning?: boolean;
  prompt?: string;
};

function runHeadless(controller: SessionController, options: HeadlessOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    let reason: string = "completed";
    let failed = false;
    let finalMessage = "";
    const tools: Array<{ name: string; ok: boolean; summary: string }> = [];
    const notices: Array<{ level: string; text: string }> = [];
    const json = Boolean(options.json);
    const quiet = Boolean(options.quiet);

    const diagnostics = (line: string): void => {
      if (!quiet) stderr(line);
    };

    const unsubscribe = controller.onEvent((event) => {
      switch (event.type) {
        case "assistant-delta":
          if (!json) process.stdout.write(event.text);
          break;
        case "reasoning-delta":
          if (!json && (options.showReasoning || controller.config.ui.showReasoning)) {
            process.stderr.write(muted(event.text));
          }
          break;
        case "assistant-message":
          finalMessage = event.message.content;
          break;
        case "tool-start":
          diagnostics(muted(`⚙ ${event.call.name} — ${event.summary}`));
          break;
        case "tool-end": {
          const summary = event.result.output.replace(/\s+/g, " ").slice(0, 240);
          tools.push({ name: event.name, ok: event.result.ok, summary });
          if (!event.result.ok) diagnostics(danger(`✘ ${event.name}: ${summary}`));
          else diagnostics(success(`✔ ${event.name}`));
          if (!json && controller.config.ui.showToolOutput && event.result.output) {
            diagnostics(muted(event.result.output.slice(0, 4000)));
          }
          break;
        }
        case "notice":
          notices.push({ level: event.level, text: event.text });
          if (!json || event.level === "warn" || event.level === "error") {
            const color =
              event.level === "error" ? danger : event.level === "warn" ? accent : muted;
            diagnostics(color(`• ${event.text}`));
          }
          break;
        case "error":
          failed = true;
          reason = "error";
          diagnostics(errorLine(event.message));
          break;
        case "done":
          reason = event.reason;
          break;
        default:
          break;
      }
    });

    void (async () => {
      try {
        const prompt = options.prompt ?? "";
        if (!prompt.trim()) {
          diagnostics(errorLine("No prompt was provided."));
          resolve(2);
          return;
        }
        if (prompt.trim().startsWith("/")) {
          const result = await controller.executeCommand(prompt.trim());
          if (result.output) stdout(result.output);
          resolve(result.exit ? 0 : 0);
          return;
        }
        await controller.run(prompt);
        if (!json && process.stdout.isTTY) stdout();
        const usage = controller.getUsage();
        if (json) {
          stdout(
            JSON.stringify(
              {
                ok: !failed && reason !== "error",
                reason,
                sessionId: controller.sessionId,
                provider: controller.getProviderId(),
                model: controller.getModel(),
                text: finalMessage,
                usage,
                tools,
                notices,
                messages: controller.getMessages(),
              },
              null,
              2,
            ),
          );
        }
        if (reason === "cancelled") resolve(130);
        else resolve(failed || reason === "error" ? 1 : 0);
      } catch (error) {
        stderr(errorLine(error));
        resolve(1);
      } finally {
        unsubscribe();
      }
    })();
  });
}

function addGlobalOptions(program: Command): void {
  program
    .name("tgc")
    .description("TagCode — an extensible, terminal-first autonomous coding agent")
    .version(VERSION, "-v, --version", "Print the TagCode version")
    .option("-C, --cwd <dir>", "working directory", process.cwd())
    .option("-p, --provider <id>", "provider id to use for this run")
    .option("-m, --model <name>", "model to use for this run")
    .addOption(new Option("--mode <mode>", "interaction mode").choices(["agent", "plan", "ask"]))
    .addOption(
      new Option("--permission <mode>", "permission mode").choices([...PERMISSION_MODES]),
    )
    .option("--session <id>", "resume a session by id")
    .option("--no-mcp", "do not connect MCP servers")
    .option("--no-plugins", "do not load plugins");
}

export function buildProgram(): Command {
  const program = new Command();
  addGlobalOptions(program);

  program.action(async () => {
    const options = program.opts<GlobalOptions>();
    try {
      const { launchDesktop } = await import("../desktop/server.js");
      await launchDesktop({
        workspace: path.resolve(options.cwd || process.cwd()),
        providerId: options.provider,
        model: options.model,
        mode: options.mode,
        permissionMode: options.permission,
        sessionId: options.session,
        connectMcp: options.mcp !== false,
        loadPlugins: options.plugins !== false,
      });
    } catch (error) {
      stderr(errorLine(error));
      process.exitCode = 1;
    }
  });

  program
    .command("app")
    .description("Launch the TagCode desktop app")
    .option("--no-open", "start the local app server without opening a window")
    .option("--browser <path>", "browser or app executable to use")
    .option("--idle-timeout <ms>", "shut down after the window closes (0 disables)", "180000")
    .action(async (options: { open?: boolean; browser?: string; idleTimeout?: string }) => {
      const opts = program.opts<GlobalOptions>();
      try {
        const { launchDesktop } = await import("../desktop/server.js");
        const idle = Number.parseInt(options.idleTimeout ?? "180000", 10);
        await launchDesktop({
          workspace: path.resolve(opts.cwd || process.cwd()),
          providerId: opts.provider,
          model: opts.model,
          mode: opts.mode,
          permissionMode: opts.permission,
          sessionId: opts.session,
          connectMcp: opts.mcp !== false,
          loadPlugins: opts.plugins !== false,
          open: options.open !== false,
          browser: options.browser,
          idleTimeoutMs: Number.isFinite(idle) && idle >= 0 ? idle : 180_000,
        });
      } catch (error) {
        stderr(errorLine(error));
        process.exitCode = 1;
      }
    });

  program
    .command("tui")
    .description("Start the terminal UI")
    .action(async () => {
      const controller = buildController(program);
      const { runTui } = await import("../ui/tui.js");
      process.exitCode = await runTui({ controller });
    });

  program
    .command("run")
    .description("Run one prompt non-interactively")
    .argument("[prompt...]", "prompt text; reads stdin when omitted and piped")
    .option("--json", "print a JSON result instead of streaming text")
    .option("--yes", "approve permission prompts automatically (use with care)")
    .option("--quiet", "suppress tool and status diagnostics")
    .option("--show-reasoning", "stream model reasoning to stderr")
    .action(async (parts: string[], options: HeadlessOptions) => {
      const controller = buildController(program, {
        confirm: async (prompt) => {
          if (options.yes) {
            stderr(accent(`Auto-approved: ${prompt}`));
            return true;
          }
          return false;
        },
      });
      controller.setApprovalBroker(async (request) => {
        if (options.yes) {
          stderr(accent(`Auto-approved ${request.toolName}: ${request.summary}`));
          return { approved: true };
        }
        return {
          approved: false,
          reason: `Non-interactive run needs approval for ${request.toolName} (${request.summary}). Re-run with --yes or use the interactive UI.`,
        };
      });
      try {
        await controller.initialize();
        let prompt = parts.join(" ").trim();
        if (!prompt) {
          prompt = (await readStdinIfAvailable())?.trim() ?? "";
        }
        process.exitCode = await runHeadless(controller, { ...options, prompt });
      } catch (error) {
        stderr(errorLine(error));
        process.exitCode = 1;
      } finally {
        await controller.dispose();
      }
    });

  program
    .command("init")
    .description("Create .tagcode scaffolding and a factual AGENTS.md")
    .action(async () => {
      await withController(program, async (controller) => {
        const result = await controller.initProject();
        if (result.created.length === 0) stdout("Project scaffolding already exists.");
        else {
          stdout("Created:");
          for (const entry of result.created) stdout(`  ${entry}`);
        }
        if (result.agentSkipped) stdout(muted(`AGENTS.md already exists at ${result.agentsFile}; left untouched.`));
        else stdout(`Wrote ${result.agentsFile}. Review and adjust it to match the project.`);
      });
    });

  program
    .command("doctor")
    .description("Check configuration, providers, secrets, git, MCP and plugins")
    .option("--json", "print the report as JSON")
    .action(async (options: { json?: boolean }) => {
      await withController(program, async (controller) => {
        const report = await controller.doctor();
        if (options.json) {
          stdout(JSON.stringify({ ok: report.ok, lines: report.lines }, null, 2));
        } else {
          for (const line of report.lines) {
            const colored = line.startsWith("✔")
              ? success(line)
              : line.startsWith("✘")
                ? danger(line)
                : line;
            stdout(colored);
          }
          stdout("");
          stdout(report.ok ? success("Doctor: OK") : danger("Doctor: problems found"));
        }
        process.exitCode = report.ok ? 0 : 1;
      });
    });

  const connect = program
    .command("connect")
    .description("Configure a model provider")
    .argument("[type]", `provider type (${PROVIDER_TYPES.join(", ")})`)
    .option("--id <id>", "provider id (defaults to the type)")
    .option("--name <name>", "display name")
    .option("--base-url <url>", "custom OpenAI-compatible base URL")
    .option("--model <name>", "default model")
    .option("--api-key <key>", "API key (prefer --api-key-stdin or the interactive UI)")
    .option("--api-key-stdin", "read the API key from stdin")
    .option("--project", "write to the project config instead of the global config");

  connect.action(async (type: string | undefined, options: Record<string, string | boolean | undefined>) => {
    if (!type) {
      const rows = PROVIDER_TYPES.map((entry) => {
        const preset = PROVIDER_PRESETS[entry];
        return [
          entry,
          preset.label,
          preset.requiresKey ? "API key" : "no key",
          preset.baseUrl ?? "—",
          preset.suggestedModel || "—",
        ];
      });
      stdout(renderTable(rows, ["Type", "Provider", "Auth", "Base URL", "Suggested model"]));
      stdout("");
      stdout("Example: tgc connect anthropic --model claude-sonnet-4-5");
      return;
    }
    if (!PROVIDER_TYPES.includes(type as ProviderType)) {
      throw new Error(`Unknown provider type "${type}". Available: ${PROVIDER_TYPES.join(", ")}`);
    }
    let apiKey = typeof options.apiKey === "string" ? options.apiKey : undefined;
    if (options.apiKeyStdin) {
      const fromStdin = await readStdinIfAvailable();
      apiKey = fromStdin?.split(/\r?\n/)[0]?.trim() || apiKey;
    }
    const preset = PROVIDER_PRESETS[type as ProviderType];
    if (!apiKey && preset.requiresKey && process.stdin.isTTY) {
      apiKey = await promptSecret(`API key for ${preset.label} (input hidden):`);
    }
    const modelOption =
      typeof options.model === "string"
        ? options.model
        : program.opts<GlobalOptions>().model;
    await withController(
      program,
      async (controller) => {
        const result = await controller.connectProvider(type as ProviderType, {
          id: typeof options.id === "string" ? options.id : undefined,
          name: typeof options.name === "string" ? options.name : undefined,
          baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
          model: modelOption,
          apiKey,
          scope: options.project ? "project" : "global",
        });
        stdout(success(`Configured ${preset.label} as "${result.id}" (${result.scope}).`));
        stdout(`Config: ${result.file}`);
        if (result.backend === "file") {
          stdout(
            accent(
              "Warning: the API key is stored in ~/.tagcode/auth.json (mode 0600) because the OS keychain is unavailable. The fallback file is not encrypted at rest.",
            ),
          );
        } else if (result.backend === "keychain") {
          stdout(`API key stored in the OS credential store.`);
        } else {
          stdout("No API key was stored.");
        }
      },
      {
        requestSecret: async (label) => promptSecret(label),
      },
    );
  });

  const model = program
    .command("model")
    .description("Show, list or change the active model")
    .argument("[name...]", "model name to use")
    .option("--json", "print machine-readable output")
    .action(async (parts: string[], options: { json?: boolean }) => {
      await withController(program, async (controller) => {
        const name = parts.join(" ").trim();
        if (name) {
          await controller.setModel(name);
          stdout(success(`Model set to ${controller.getModel()}.`));
          return;
        }
        const result = await controller.listModels();
        const current = controller.getModel();
        if (options.json) {
          stdout(JSON.stringify({ current, provider: controller.getProviderId(), ...result }, null, 2));
          return;
        }
        if (result.error) {
          stdout(accent(`Warning: could not list models from the provider (${result.error}).`));
        }
        if (result.models.length === 0) {
          stdout("No models available. Configure a provider with: tgc connect <type> --model <name>");
          return;
        }
        stdout(`Provider: ${controller.getProviderId() || "(none)"}`);
        for (const entry of result.models) {
          stdout(`${entry === current ? "* " : "  "}${entry}`);
        }
      });
    });

  const models = program
    .command("models")
    .description("List models available from the active provider")
    .option("--json", "print machine-readable output")
    .action(async (options: { json?: boolean }) => {
      await withController(program, async (controller) => {
        const result = await controller.listModels();
        const current = controller.getModel();
        if (options.json) {
          stdout(JSON.stringify({ current, provider: controller.getProviderId(), ...result }, null, 2));
          return;
        }
        if (result.error) {
          stdout(accent(`Warning: could not list models from the provider (${result.error}).`));
        }
        if (result.models.length === 0) {
          stdout("No models available. Configure a provider with: tgc connect <type> --model <name>");
          return;
        }
        for (const entry of result.models) {
          stdout(`${entry === current ? "* " : "  "}${entry}`);
        }
      });
    });

  const disconnect = program
    .command("disconnect")
    .description("Remove a provider configuration and its stored API key")
    .argument("[id]", "provider id (defaults to the active provider)")
    .option("--project", "remove from the project config instead of the global config")
    .option("--json", "print machine-readable output")
    .action(async (id: string | undefined, options: { project?: boolean; json?: boolean }) => {
      await withController(program, async (controller) => {
        const target = id ?? controller.getProviderId();
        if (!target) throw new Error("No provider is active. Pass an id or configure one with tgc connect.");
        const scope = options.project ? "project" : "global";
        const removed = await controller.removeProvider(target, scope);
        if (options.json) {
          stdout(JSON.stringify({ id: target, scope, removed }, null, 2));
          return;
        }
        stdout(
          removed
            ? success(`Disconnected ${target}: removed the ${scope} configuration and any stored API key.`)
            : accent(`Provider ${target} was not in the ${scope} config.`),
        );
      });
    });

  const config = program
    .command("config")
    .description("Show or change configuration values")
    .argument("[action]", "show, path, get, set or reload", "show")
    .argument("[key]", "dot-separated configuration key")
    .argument("[value...]", "value to set")
    .option("--project", "write to the project config instead of the global config")
    .option("--json", "print values as JSON");

  config.action(
    async (action: string, key: string | undefined, valueParts: string[], options: Record<string, boolean>) => {
      await withController(program, async (controller) => {
        const scope = options.project ? "project" : "global";
        if (action === "path") {
          stdout(`Global: ${controller.loaded.globalPath}`);
          stdout(`Project: ${controller.loaded.projectPath}`);
          return;
        }
        if (action === "get") {
          if (!key) throw new Error("Usage: tgc config get <key>");
          const value = controller.getConfigValue(key);
          if (value === undefined) {
            stdout(`No value for ${key}.`);
            return;
          }
          stdout(
            options.json
              ? JSON.stringify(redactValue(value), null, 2)
              : `${key} = ${JSON.stringify(redactValue(value), null, 2)}`,
          );
          return;
        }
        if (action === "set") {
          const value = valueParts.join(" ");
          if (!key || !value) throw new Error("Usage: tgc config set <key> <value> [--project]");
          await controller.setConfigValue(key, value, scope);
          if (key === "permissions.mode") controller.setPermissionMode(value as PermissionMode);
          stdout(success(`Set ${key} in ${scope} config and reloaded.`));
          return;
        }
        if (action === "reload") {
          await controller.reloadConfig();
          stdout("Configuration reloaded.");
          return;
        }
        stdout(JSON.stringify(redactValue(controller.config), null, 2));
      });
    },
  );

  const mcp = program
    .command("mcp")
    .description("Manage MCP servers")
    .argument("[action]", "list, tools, add, remove, connect, disconnect, inspect, reconnect or reload", "list")
    .argument("[args...]", "action arguments")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--url <url>", "HTTP MCP endpoint (for add)")
    .option("--project", "use the project MCP configuration")
    .option("--json", "print machine-readable output");

  mcp.action(
    async (
      action: string,
      args: string[],
      options: Record<string, string | boolean | undefined>,
    ) => {
      await withController(program, async (controller) => {
        const scope = options.project ? "project" : "global";
        const manager = controller.getMcpManager();
        if (action === "list" || action === "status") {
          const statuses = manager?.getStatuses() ?? [];
          if (options.json) {
            stdout(JSON.stringify(statuses, null, 2));
            return;
          }
          if (statuses.length === 0) {
            stdout("No MCP servers configured. Add one with: tgc mcp add <name> -- <command...>");
            return;
          }
          stdout(
            renderTable(
              statuses.map((entry) => [
                entry.name,
                entry.transport,
                entry.state,
                String(entry.toolCount),
                String(entry.resourceCount),
                String(entry.promptCount),
                entry.error?.replace(/\s+/g, " ").slice(0, 60) ?? "",
              ]),
              ["Server", "Transport", "State", "Tools", "Resources", "Prompts", "Error"],
            ),
          );
          return;
        }
        if (action === "tools") {
          const tools = controller
            .getToolRegistry()
            .list()
            .filter((tool) => tool.name.startsWith("mcp__"));
          if (tools.length === 0) {
            stdout("No MCP tools are registered.");
            return;
          }
          stdout(
            renderTable(
              tools.map((tool) => [tool.name, tool.permission, tool.description.slice(0, 90)]),
              ["Tool", "Permission", "Description"],
            ),
          );
          return;
        }
        if (action === "inspect") {
          const name = args[0];
          if (!name) throw new Error("Usage: tgc mcp inspect <name>");
          const status = manager?.getStatus(name);
          if (!status) throw new Error(`Unknown MCP server: ${name}`);
          if (options.json) {
            stdout(JSON.stringify({ ...status, tools: manager?.getToolNames(name) ?? [] }, null, 2));
            return;
          }
          stdout(`${status.name} (${status.transport}) — ${status.state}`);
          stdout(
            `${status.toolCount} tools · ${status.resourceCount} resources · ${status.templateCount} templates · ${status.promptCount} prompts`,
          );
          if (status.serverName) stdout(`Server: ${status.serverName} ${status.serverVersion ?? ""}`);
          if (status.error) stdout(danger(`Error: ${status.error}`));
          if (status.instructions) stdout(`\n${status.instructions}`);
          const tools = manager?.getToolNames(name) ?? [];
          if (tools.length > 0) stdout(`\nTools:\n${tools.map((tool) => `  ${tool}`).join("\n")}`);
          return;
        }
        if (action === "connect" || action === "disconnect") {
          if (!manager) throw new Error("No MCP manager is active.");
          const name = args[0];
          if (action === "connect") {
            const statuses = name ? [await manager.connect(name)] : await manager.connectAll();
            stdout(
              `Connected ${statuses.filter((entry) => entry.state === "connected").length}/${statuses.length} MCP servers.`,
            );
            return;
          }
          if (!name) throw new Error("Usage: tgc mcp disconnect <name>");
          await manager.disconnect(name);
          stdout(success(`Disconnected MCP server "${name}".`));
          return;
        }
        if (action === "reload") {
          const statuses = await controller.reloadMcp();
          stdout(
            `Reloaded MCP: ${statuses.filter((entry) => entry.state === "connected").length}/${statuses.length} connected.`,
          );
          return;
        }
        if (action === "add") {
          const name = args[0];
          if (!name) throw new Error("Usage: tgc mcp add <name> -- <command...> | --url <url>");
          let server: McpServerConfig;
          if (typeof options.url === "string") {
            server = { type: "http", url: options.url, enabled: true };
          } else {
            const commandArgs = args.slice(1);
            if (commandArgs.length === 0) {
              throw new Error("Usage: tgc mcp add <name> -- <command...> | --url <url>");
            }
            server = {
              type: "stdio",
              command: commandArgs[0]!,
              args: commandArgs.slice(1),
              enabled: true,
            };
          }
          const file = await upsertMcpServer(scope, name, server, controller.loaded.projectRoot);
          const statuses = await controller.reloadMcp();
          const status = statuses.find((entry) => entry.name === name);
          stdout(success(`Added MCP server "${name}" to ${file}.`));
          if (status) {
            stdout(
              status.state === "connected"
                ? `Connected: ${status.toolCount} tools, ${status.resourceCount} resources, ${status.promptCount} prompts.`
                : accent(`State: ${status.state}${status.error ? ` (${status.error})` : ""}`),
            );
          }
          return;
        }
        if (action === "remove") {
          const name = args[0];
          if (!name) throw new Error("Usage: tgc mcp remove <name> [--project]");
          let removed = await removeMcpServer(scope, name, controller.loaded.projectRoot);
          if (!removed) {
            removed = await removeMcpServer(
              scope === "global" ? "project" : "global",
              name,
              controller.loaded.projectRoot,
            );
          }
          await controller.reloadMcp();
          stdout(removed ? success(`Removed MCP server "${name}".`) : `MCP server not found: ${name}`);
          return;
        }
        if (action === "reconnect") {
          const name = args[0];
          if (name && manager) {
            const status = await manager.reconnect(name);
            stdout(
              status.state === "connected"
                ? success(`Reconnected ${name}: ${status.toolCount} tools, ${status.resourceCount} resources.`)
                : danger(`Reconnect failed for ${name}: ${status.error ?? status.state}`),
            );
            return;
          }
          const statuses = await controller.reloadMcp();
          stdout(
            `Reconnected ${statuses.filter((entry) => entry.state === "connected").length}/${statuses.length} MCP servers.`,
          );
          return;
        }
        throw new Error(`Unknown MCP action "${action}". Try list, tools, add, remove or reconnect.`);
      });
    },
  );

  const skills = program
    .command("skills")
    .description("List, install, update and create skills")
    .argument("[action]", "list, install, remove, update, search, create, inspect, reload or validate", "list")
    .argument("[args...]", "action arguments")
    .option("--global", "use the global skills directory")
    .option("--force", "replace an existing skill on install")
    .option("--yes", "skip the removal confirmation")
    .allowUnknownOption(true);

  skills.action(
    async (
      action: string,
      args: string[],
      options: Record<string, boolean>,
    ) => {
      await withController(program, async (controller) => {
        const manager = controller.getSkillManager();
        const installer = controller.getSkillInstaller();
        const scope = options.global ? "global" : "project";

        if (action === "list") {
          const list = manager.list();
          if (list.length === 0) {
            stdout("No skills installed. Use tgc skills install <path|git-url> or /skills create <description>.");
            return;
          }
          const active = new Set(manager.getActiveNames());
          stdout(
            renderTable(
              list.map((skill) => [
                active.has(skill.name) ? `* ${skill.name}` : `  ${skill.name}`,
                skill.source,
                skill.valid ? "valid" : "INVALID",
                skill.description.replace(/\s+/g, " ").slice(0, 80),
              ]),
              ["Skill", "Source", "State", "Description"],
            ),
          );
          return;
        }
        if (action === "active") {
          const active = manager.activeSkills();
          stdout(active.length ? active.map((skill) => `${skill.name}: ${skill.description}`).join("\n") : "No active skills.");
          return;
        }
        if (action === "index") {
          stdout(manager.buildIndex());
          return;
        }
        if (action === "inspect") {
          const name = args[0];
          if (!name) throw new Error("Usage: tgc skills inspect <name>");
          const skill = manager.get(name);
          if (!skill) throw new Error(`Skill not found: ${name}`);
          stdout(`${skill.name} — ${skill.description}`);
          stdout(`Source: ${skill.source} · Directory: ${skill.directory}`);
          stdout(`Version: ${skill.metadata.version ?? "—"} · State: ${skill.valid ? "valid" : "INVALID"}`);
          for (const error of skill.errors) stdout(danger(`  ✘ ${error}`));
          for (const warning of skill.warnings) stdout(accent(`  ! ${warning}`));
          stdout("");
          stdout((await manager.readInstructions(name)) ?? "");
          return;
        }
        if (action === "reload") {
          await controller.refreshSkills();
          stdout(
            success(`Reloaded ${manager.list().length} skill(s); ${manager.getActiveNames().length} active.`),
          );
          return;
        }
        if (action === "use" || action === "off") {
          const name = args[0];
          if (!name) throw new Error(`Usage: tgc skills ${action} <name>`);
          if (action === "use") {
            const skill = manager.activate(name);
            stdout(skill ? success(`Activated ${skill.name}.`) : `Skill not found or invalid: ${name}`);
          } else {
            manager.deactivate(name);
            stdout(`Deactivated ${name}.`);
          }
          return;
        }
        if (action === "install") {
          const source = args[0];
          if (!source) throw new Error("Usage: tgc skills install <directory|git-url> [--global] [--force]");
          const skill = isProbablyUrl(source)
            ? await installer.installFromGit(source, scope)
            : await installer.installFromLocal(path.resolve(controller.workspace, source), scope, {
                force: options.force,
              });
          await controller.refreshSkills();
          stdout(success(`Installed ${skill.name} (${scope}).`));
          return;
        }
        if (action === "remove") {
          const name = args[0];
          if (!name) throw new Error("Usage: tgc skills remove <name> [--global] --yes");
          if (!options.yes) {
            throw new Error("Removing a skill is destructive. Re-run with --yes to confirm.");
          }
          const removed = await installer.remove(name, scope);
          await controller.refreshSkills();
          stdout(removed ? success(`Removed ${name} (${scope}).`) : `Skill not found: ${name} (${scope}).`);
          return;
        }
        if (action === "update") {
          const name = args[0];
          if (!name) throw new Error("Usage: tgc skills update <name> [--global]");
          const skill = await installer.update(name, scope);
          await controller.refreshSkills();
          stdout(success(`Updated ${skill.name} (${scope}).`));
          return;
        }
        if (action === "search") {
          const query = args.join(" ");
          if (!query) throw new Error("Usage: tgc skills search <query>");
          const result = await installer.searchRegistry(query);
          if (!result.configured) {
            stdout("No skills registry configured. Set skills.registryUrl in config.json.");
            return;
          }
          if (result.results.length === 0) {
            stdout(`No registry skills matched "${query}".`);
            return;
          }
          stdout(
            renderTable(
              result.results.map((entry) => [
                entry.name,
                entry.version ?? "—",
                entry.url,
                entry.description.slice(0, 70),
              ]),
              ["Skill", "Version", "URL", "Description"],
            ),
          );
          return;
        }
        if (action === "create") {
          const description = args.join(" ");
          if (!description) throw new Error("Usage: tgc skills create <description>");
          stderr(muted("Generating a SKILL.md with the active model…"));
          const result = await controller.createSkill(description, scope);
          if (result.installed) {
            stdout(success(`Created and installed ${result.installed}.`));
            return;
          }
          stdout(danger("Generated skill failed validation:"));
          for (const error of result.errors) stdout(`  - ${error}`);
          stdout("");
          stdout(result.markdown);
          process.exitCode = 1;
          return;
        }
        if (action === "validate") {
          const target = args[0];
          if (!target) throw new Error("Usage: tgc skills validate <directory>");
          const { validateSkillDirectory } = await import("../skills/validator.js");
          const result = await validateSkillDirectory(path.resolve(controller.workspace, target), "configured");
          stdout(result.skill ? success(`Valid skill: ${result.skill.name}`) : danger("Invalid skill"));
          for (const error of result.errors) stdout(`  ✘ ${error}`);
          for (const warning of result.warnings) stdout(`  ! ${warning}`);
          if (!result.skill) process.exitCode = 1;
          return;
        }
        throw new Error(`Unknown skills action "${action}".`);
      });
    },
  );

  const session = program
    .command("session")
    .description("Inspect and manage sessions")
    .argument("[action]", "list, show, resume, delete or export", "list")
    .argument("[args...]", "action arguments")
    .option("--yes", "skip destructive confirmations")
    .option("--json", "print machine-readable output");

  session.action(async (action: string, args: string[], options: Record<string, boolean>) => {
    if (action === "resume") {
      const id = args[0];
      if (!id) throw new Error("Usage: tgc session resume <id|latest>");
      const controller = new SessionController({
        workspace: path.resolve(program.opts<GlobalOptions>().cwd || process.cwd()),
        sessionId: id === "latest" ? undefined : id,
      });
      const { runTui } = await import("../ui/tui.js");
      process.exitCode = await runTui({ controller, resumeLatest: id === "latest" });
      return;
    }
    await withController(program, async (controller) => {
      if (action === "list") {
        const list = await controller.listSessions();
        if (options.json) {
          stdout(JSON.stringify(list, null, 2));
          return;
        }
        stdout(list.length ? summarizeSessions(list) : "No saved sessions for this project yet.");
        return;
      }
      if (action === "show") {
        const id = args[0];
        const messages = id ? (await controller.loadSession(id)).messages : controller.getMessages();
        if (options.json) {
          stdout(JSON.stringify(messages, null, 2));
          return;
        }
        stdout(sessionTranscript(messages) || muted("(empty session)"));
        return;
      }
      if (action === "export") {
        const destination = args[0] ? path.resolve(controller.workspace, args[0]) : undefined;
        stdout(`Exported to ${await controller.exportSession(destination)}.`);
        return;
      }
      if (action === "delete") {
        const id = args[0];
        if (!id) throw new Error("Usage: tgc session delete <id> --yes");
        if (!options.yes) {
          throw new Error("Deleting a session cannot be undone. Re-run with --yes to confirm.");
        }
        await controller.deleteSession(id);
        stdout(success(`Deleted ${id}.`));
        return;
      }
      throw new Error(`Unknown session action "${action}".`);
    });
  });

  program
    .command("plugins")
    .description("List, reload, enable or disable plugins")
    .argument("[action]", "list, reload, enable or disable", "list")
    .argument("[name]", "plugin name")
    .option("--project", "write to the project config")
    .action(async (action: string, name: string | undefined, options: Record<string, boolean>) => {
      await withController(program, async (controller) => {
        const host = controller.getPluginHost();
        if (action === "reload") {
          const statuses = await controller.reloadPlugins();
          stdout(
            `Reloaded plugins: ${statuses.filter((entry) => entry.state === "loaded").length}/${statuses.length} loaded.`,
          );
          return;
        }
        if (action === "enable" || action === "disable") {
          if (!name) throw new Error(`Usage: tgc plugins ${action} <name>`);
          await controller.setPluginEnabled(name, action === "enable", options.project ? "project" : "global");
          stdout(`${action === "enable" ? "Enabled" : "Disabled"} plugin "${name}".`);
          return;
        }
        const statuses = host?.getStatuses() ?? [];
        if (statuses.length === 0) {
          stdout(
            [
              "No plugins discovered.",
              "Add a plugin directory containing plugin.json under .tagcode/plugins or ~/.tagcode/plugins.",
              "Plugins load only when listed in plugins.enabled.",
            ].join("\n"),
          );
          return;
        }
        stdout(
          renderTable(
            statuses.map((entry) => [
              entry.name,
              entry.version ?? "—",
              entry.source ?? "—",
              entry.state,
              `${entry.tools.length} tools, ${entry.commands.length} cmds`,
              entry.error ?? entry.reason ?? "",
            ]),
            ["Plugin", "Version", "Source", "State", "Contributions", "Detail"],
          ),
        );
      });
    });

  program
    .command("tools")
    .description("List registered tools")
    .argument("[filter]", "filter by name or description")
    .action(async (filter: string | undefined) => {
      await withController(program, async (controller) => {
        const query = (filter ?? "").toLowerCase();
        const list = controller
          .getToolRegistry()
          .list()
          .filter(
            (tool) =>
              !query ||
              tool.name.toLowerCase().includes(query) ||
              tool.description.toLowerCase().includes(query),
          );
        if (list.length === 0) {
          stdout(query ? `No tools matched "${filter}".` : "No tools registered.");
          return;
        }
        stdout(
          renderTable(
            list.map((tool) => [tool.name, tool.permission, tool.description.replace(/\s+/g, " ").slice(0, 90)]),
            ["Tool", "Permission", "Description"],
          ),
        );
      });
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    stderr(errorLine(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
