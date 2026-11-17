import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SessionController, type SessionControllerOptions } from "../controller.js";
import { currentBranch } from "../git/repo.js";
import { toError } from "../core/errors.js";
import type { AgentEvent, ApprovalDecision, ApprovalRequest, PermissionMode } from "../core/types.js";
import type { McpServerConfig, ProviderType } from "../config/schema.js";
import { removeMcpServer, upsertMcpServer } from "../config/config.js";
import type { SkillScope } from "../skills/installer.js";
import { SKILL_CATALOG, getSkillCatalogEntry } from "../skills/catalog.js";
import {
  MCP_CATALOG,
  getMcpCatalogTemplate,
  publicMcpCatalog,
  resolveMcpCatalogTemplate,
} from "../mcp/catalog.js";
import { checkForUpdate, type UpdateInfo } from "../update/checker.js";
import { VERSION } from "../version.js";
import { logger } from "../utils/logger.js";

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../desktop");
const MAX_BODY_BYTES = 2 * 1024 * 1024;

type UiRequest =
  | { id: string; kind: "approval"; request: ApprovalRequest }
  | { id: string; kind: "input"; message: string; options?: string[] }
  | { id: string; kind: "secret"; message: string }
  | { id: string; kind: "confirm"; message: string };

type UiInputRequest =
  | { kind: "input"; message: string; options?: string[] }
  | { kind: "secret"; message: string }
  | { kind: "confirm"; message: string };

type PendingUi =
  | { kind: "approval"; resolve: (decision: ApprovalDecision) => void }
  | { kind: "input"; resolve: (value: string | undefined) => void }
  | { kind: "confirm"; resolve: (value: boolean) => void };

export type DesktopServerOptions = {
  controller: SessionController;
  /** 0 disables the idle shutdown timer. */
  idleTimeoutMs?: number;
  /** Inject a fake in tests; defaults to the npm registry checker. */
  updateChecker?: () => Promise<UpdateInfo>;
  onClose?: () => void;
};

export type DesktopServer = {
  url: string;
  token: string;
  controller: SessionController;
  close: () => Promise<void>;
};

type SseClient = {
  response: ServerResponse;
};

function contentType(file: string): string {
  switch (path.extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Open a chromeless browser window that looks like a desktop app. */
export async function openAppWindow(url: string, browserOverride?: string): Promise<boolean> {
  const candidates: string[] = [];
  if (browserOverride) candidates.push(browserOverride);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const pf = process.env.ProgramFiles;
    const pf86 = process.env["ProgramFiles(x86)"];
    for (const root of [pf, pf86, local]) {
      if (!root) continue;
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
    candidates.push("msedge.exe", "chrome.exe");
  } else if (process.platform === "darwin") {
    candidates.push("Microsoft Edge", "Google Chrome");
  } else {
    candidates.push("google-chrome", "chromium", "chromium-browser", "microsoft-edge");
  }

  const tryLaunch = (command: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });

  for (const candidate of candidates) {
    if (process.platform === "darwin") {
      const opened = await tryLaunch("open", ["-a", candidate, "--args", `--app=${url}`]);
      if (opened) return true;
      continue;
    }
    if (process.platform === "win32" && candidate.includes(path.sep)) {
      const exists = await fs
        .stat(candidate)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (!exists) continue;
    }
    const opened = await tryLaunch(candidate, [
      `--app=${url}`,
      "--window-size=1440,900",
      "--window-position=80,40",
      "--disable-features=Translate",
    ]);
    if (opened) return true;
  }

  // Last resort: the default browser as a normal tab.
  const fallback =
    process.platform === "win32"
      ? tryLaunch("cmd.exe", ["/c", "start", "", url])
      : process.platform === "darwin"
        ? tryLaunch("open", [url])
        : tryLaunch("xdg-open", [url]);
  return fallback;
}

export async function startDesktopServer(options: DesktopServerOptions): Promise<DesktopServer> {
  const controller = options.controller;
  const token = randomBytes(24).toString("hex");
  const pending = new Map<string, PendingUi>();
  const clients = new Set<SseClient>();
  const idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
  let updateCache: { value: UpdateInfo; at: number } | undefined;
  let connectedOnce = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let server: Server | undefined;

  const broadcast = (payload: unknown): void => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.response.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const ask = (request: UiInputRequest): Promise<unknown> => {
    const id = randomUUID();
    return new Promise((resolve) => {
      if (request.kind === "confirm") {
        pending.set(id, { kind: "confirm", resolve: (value) => resolve(value) });
      } else {
        pending.set(id, { kind: "input", resolve: (value) => resolve(value) });
      }
      broadcast({ type: "ui-request", request: { ...request, id } });
    });
  };

  controller.setApprovalBroker(
    (request) =>
      new Promise<ApprovalDecision>((resolve) => {
        const id = randomUUID();
        pending.set(id, { kind: "approval", resolve });
        broadcast({ type: "ui-request", request: { id, kind: "approval", request } });
      }),
  );

  controller.setUiHooks({
    confirm: (message) =>
      ask({ kind: "confirm", message }).then((value) => Boolean(value)),
    requestSecret: (message) =>
      ask({ kind: "secret", message }).then((value) =>
        typeof value === "string" ? value : undefined,
      ),
    requestInput: (message, inputOptions) =>
      ask({ kind: "input", message, options: inputOptions }).then((value) =>
        typeof value === "string" ? value : undefined,
      ),
  });

  if (options.idleTimeoutMs !== 0) {
    const scheduleIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!connectedOnce || clients.size > 0 || idleTimeoutMs === 0) return;
      idleTimer = setTimeout(() => {
        void close("idle");
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    setInterval(scheduleIdle, 15_000).unref?.();
  }

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const client of clients) {
      try {
        client.response.end();
      } catch {
        // ignore
      }
    }
    clients.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await controller.dispose().catch(() => undefined);
    options.onClose?.();
  };

  const close = async (reason = "requested"): Promise<void> => {
    logger.debug("desktop", `shutting down desktop server (${reason})`);
    await shutdown();
  };

  controller.onEvent((event: AgentEvent) => {
    broadcast({ type: "agent-event", event });
  });

  const state = async () => {
    const session = controller.getSession();
    const stats = controller.getContextStats();
    const mcpManager = controller.getMcpManager();
    const mcp = (mcpManager?.getStatuses() ?? []).map((status) => ({
      ...status,
      tools: mcpManager?.getToolNames(status.name) ?? [],
    }));
    const skills = controller.getSkillManager().list();
    const commands = controller.getCommandRegistry().list();
    let gitBranch: string | undefined;
    try {
      gitBranch = await currentBranch(controller.workspace);
    } catch {
      gitBranch = undefined;
    }
    return {
      workspace: controller.workspace,
      projectRoot: controller.loaded.projectRoot,
      provider: controller.getProviderId(),
      model: controller.getModel(),
      mode: controller.getMode(),
      permission: controller.getPermissionMode(),
      sessionId: controller.sessionId,
      sessionTitle: session?.title ?? "New session",
      createdAt: session?.createdAt,
      messages: controller.getMessages(),
      usage: controller.getUsage(),
      context: stats,
      plan: controller.getPlan(),
      gitBranch,
      mcp,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        valid: skill.valid,
        source: skill.source,
        version: skill.metadata.version,
        author: skill.metadata.author,
        tags: skill.metadata.tags ?? [],
        allowedTools: skill.metadata.allowedTools ?? [],
        errors: skill.errors,
        warnings: skill.warnings,
        hasScripts: skill.hasScripts,
        hasReferences: skill.hasReferences,
        directory: skill.directory,
      })),
      providers: controller.config.providers.map((provider) => ({
        id: provider.id,
        type: provider.type,
        name: provider.name,
        defaultModel: provider.defaultModel,
      })),
      commands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        usage: command.usage,
      })),
      tools: controller.getToolRegistry().names(),
    };
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/")) return false;

    const supplied = request.headers["x-tagcode-token"] ?? url.searchParams.get("token");
    if (supplied !== token) {
      json(response, 401, { error: "Unauthorized" });
      return true;
    }

    try {
      if (pathname === "/api/state" && request.method === "GET") {
        json(response, 200, await state());
        return true;
      }
      if (pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write("retry: 2000\n\n");
        const client: SseClient = { response };
        clients.add(client);
        connectedOnce = true;
        if (idleTimer) clearTimeout(idleTimer);
        response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
        request.on("close", () => {
          clients.delete(client);
        });
        return true;
      }
      if (pathname === "/api/ping" && request.method === "GET") {
        json(response, 200, { ok: true });
        return true;
      }

      const body = request.method === "POST" ? await readJson(request) : {};

      if (pathname === "/api/chat" && request.method === "POST") {
        const text = stringField(body, "text");
        if (!text) {
          json(response, 400, { error: "text is required" });
          return true;
        }
        if (controller.isRunning()) {
          json(response, 409, { error: "The agent is already running" });
          return true;
        }
        void controller.run(text).catch((error) => {
          broadcast({ type: "agent-event", event: { type: "error", message: toError(error).message } });
          broadcast({ type: "agent-event", event: { type: "done", reason: "error" } });
        });
        json(response, 202, { accepted: true });
        return true;
      }
      if (pathname === "/api/cancel" && request.method === "POST") {
        controller.cancel();
        json(response, 200, { ok: true });
        return true;
      }
      if (pathname === "/api/command" && request.method === "POST") {
        const line = stringField(body, "line");
        if (!line) {
          json(response, 400, { error: "line is required" });
          return true;
        }
        const result = await controller.executeCommand(line);
        json(response, 200, result);
        return true;
      }
      if (pathname === "/api/models" && request.method === "GET") {
        json(response, 200, await controller.listModels());
        return true;
      }
      if (pathname === "/api/mcp" && request.method === "GET") {
        const current = await state();
        json(response, 200, { servers: current.mcp });
        return true;
      }
      if (pathname === "/api/mcp/catalog" && request.method === "GET") {
        const current = await state();
        const installed = new Set(current.mcp.map((server) => server.name));
        json(response, 200, {
          templates: MCP_CATALOG.map((template) => ({
            ...publicMcpCatalog(template),
            installed: installed.has(template.id),
          })),
          workspace: controller.workspace,
        });
        return true;
      }
      if (pathname === "/api/mcp/install" && request.method === "POST") {
        const templateId = stringField(body, "template");
        const template = templateId ? getMcpCatalogTemplate(templateId) : undefined;
        if (!template) {
          json(response, 400, { error: "Unknown MCP catalog template" });
          return true;
        }
        const replace = body.replace === true;
        const existing = controller
          .getMcpManager()
          ?.getStatuses()
          .some((server) => server.name === template.id);
        if (existing && !replace) {
          json(response, 409, {
            error: `${template.title} is already configured. Remove it first or reinstall to update its inputs.`,
          });
          return true;
        }
        const rawInputs =
          body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
            ? (body.inputs as Record<string, unknown>)
            : {};
        const resolved = resolveMcpCatalogTemplate(template, rawInputs, controller.workspace);
        const scope = body.scope === "project" ? "project" : "global";
        const file = await upsertMcpServer(
          scope,
          resolved.name,
          resolved.server,
          controller.loaded.projectRoot,
        );
        await controller.reloadMcp();
        json(response, 200, { name: resolved.name, file, state: await state() });
        return true;
      }
      if (pathname === "/api/mcp/action" && request.method === "POST") {
        const action = stringField(body, "action");
        const name = stringField(body, "name");
        const manager = controller.getMcpManager();
        if (!action) {
          json(response, 400, { error: "action is required" });
          return true;
        }
        if (action === "reload") {
          const statuses = await controller.reloadMcp();
          json(response, 200, { servers: statuses, state: await state() });
          return true;
        }
        if (!name || !manager) {
          json(response, 400, { error: "name and an active MCP manager are required" });
          return true;
        }
        if (action === "connect") await manager.connect(name);
        else if (action === "disconnect") await manager.disconnect(name);
        else if (action === "reconnect") await manager.reconnect(name);
        else if (action === "remove") {
          const projectRoot = controller.loaded.projectRoot;
          let removed = await removeMcpServer("project", name, projectRoot);
          if (!removed) removed = await removeMcpServer("global", name, projectRoot);
          await controller.reloadMcp();
          json(response, 200, { removed, state: await state() });
          return true;
        } else {
          json(response, 400, { error: `Unknown MCP action: ${action}` });
          return true;
        }
        json(response, 200, { servers: manager.getStatuses(), state: await state() });
        return true;
      }
      if (pathname === "/api/mcp/add" && request.method === "POST") {
        const name = stringField(body, "name");
        const transport = stringField(body, "transport") === "http" ? "http" : "stdio";
        const command = stringField(body, "command");
        const url = stringField(body, "url");
        if (!name) {
          json(response, 400, { error: "name is required" });
          return true;
        }
        if (transport === "http" && !url) {
          json(response, 400, { error: "url is required for an HTTP MCP server" });
          return true;
        }
        if (transport === "stdio" && !command) {
          json(response, 400, { error: "command is required for a stdio MCP server" });
          return true;
        }
        const permission = ["read", "write", "execute", "network", "sensitive"] as const;
        const requested = stringField(body, "permission");
        const permissionValue = permission.find((entry) => entry === requested);
        const args = Array.isArray(body.args)
          ? body.args.filter((entry): entry is string => typeof entry === "string")
          : undefined;
        const server: McpServerConfig =
          transport === "http"
            ? { type: "http", url: url!, enabled: true, ...(permissionValue ? { permission: permissionValue } : {}) }
            : {
                type: "stdio",
                command: command!,
                args,
                enabled: true,
                ...(permissionValue ? { permission: permissionValue } : {}),
              };
        const scope = body.scope === "project" ? "project" : "global";
        const file = await upsertMcpServer(scope, name, server, controller.loaded.projectRoot);
        await controller.reloadMcp();
        json(response, 200, { file, state: await state() });
        return true;
      }
      if (pathname === "/api/skills" && request.method === "GET") {
        const current = await state();
        json(response, 200, { skills: current.skills });
        return true;
      }
      if (pathname === "/api/skills/catalog" && request.method === "GET") {
        const installed = new Set(controller.getSkillManager().list().map((skill) => skill.name));
        json(response, 200, {
          skills: SKILL_CATALOG.map((entry) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            version: entry.version,
            author: entry.author,
            license: entry.license,
            tags: entry.tags,
            allowedTools: entry.allowedTools,
            instructions: entry.markdown,
            installed: installed.has(entry.name),
          })),
        });
        return true;
      }
      if (pathname === "/api/skills/detail" && request.method === "GET") {
        const name = url.searchParams.get("name");
        if (!name) {
          json(response, 400, { error: "name is required" });
          return true;
        }
        const skill = controller.getSkillManager().list().find((entry) => entry.name === name);
        if (!skill) {
          json(response, 404, { error: `Unknown skill: ${name}` });
          return true;
        }
        const instructions = await controller.getSkillManager().readInstructions(name);
        json(response, 200, {
          skill: {
            name: skill.name,
            description: skill.description,
            source: skill.source,
            valid: skill.valid,
            metadata: skill.metadata,
            errors: skill.errors,
            warnings: skill.warnings,
            hasScripts: skill.hasScripts,
            hasReferences: skill.hasReferences,
          },
          instructions: instructions ?? skill.instructions,
        });
        return true;
      }
      if (pathname === "/api/skills/action" && request.method === "POST") {
        const action = stringField(body, "action");
        const name = stringField(body, "name");
        const scope: SkillScope = body.scope === "global" ? "global" : "project";
        if (action === "reload") {
          await controller.refreshSkills();
          json(response, 200, { state: await state() });
          return true;
        }
        if (action === "remove" && name) {
          const removed = await controller.getSkillInstaller().remove(name, scope);
          const fallback = removed
            ? false
            : await controller.getSkillInstaller().remove(name, scope === "global" ? "project" : "global");
          await controller.refreshSkills();
          json(response, 200, { removed: removed || fallback, state: await state() });
          return true;
        }
        if (action === "install") {
          const installSource = stringField(body, "source") ?? name;
          if (!installSource) {
            json(response, 400, { error: "source is required" });
            return true;
          }
          const sourceType = stringField(body, "sourceType") ?? "git";
          const installed =
            sourceType === "local"
              ? await controller.getSkillInstaller().installFromLocal(installSource, scope)
              : await controller.getSkillInstaller().installFromGit(installSource, scope);
          await controller.refreshSkills();
          json(response, 200, { skill: installed.name, state: await state() });
          return true;
        }
        if (action === "install-catalog") {
          const catalogId = stringField(body, "catalog") ?? name;
          const entry = catalogId ? getSkillCatalogEntry(catalogId) : undefined;
          if (!entry) {
            json(response, 400, { error: "Unknown skill catalog entry" });
            return true;
          }
          const force = body.force === true;
          const existing = controller.getSkillManager().list().some((skill) => skill.name === entry.name);
          if (existing && !force) {
            json(response, 409, {
              error: `Skill "${entry.name}" is already installed. Reinstall it to replace the local copy.`,
            });
            return true;
          }
          const installed = await controller.getSkillInstaller().installFromContent(
            entry.markdown,
            scope,
            { force, source: "TagCode skill catalog" },
          );
          await controller.refreshSkills();
          json(response, 200, { skill: installed.name, state: await state() });
          return true;
        }
        if (action === "create") {
          const description = stringField(body, "description");
          if (!description) {
            json(response, 400, { error: "description is required" });
            return true;
          }
          const source = stringField(body, "source") ?? "all";
          const result = await controller.createSkill(
            description,
            scope,
            source === "description" || source === "project" || source === "session"
              ? source
              : "all",
          );
          json(response, 200, { ...result, state: await state() });
          return true;
        }
        json(response, 400, { error: `Unknown skills action: ${action ?? "(none)"}` });
        return true;
      }
      if (pathname === "/api/model" && request.method === "POST") {
        const model = stringField(body, "model");
        if (!model) {
          json(response, 400, { error: "model is required" });
          return true;
        }
        await controller.setModel(model);
        json(response, 200, { ok: true, model: controller.getModel(), state: await state() });
        return true;
      }
      if (pathname === "/api/provider" && request.method === "POST") {
        const type = stringField(body, "type");
        if (!type) {
          json(response, 400, { error: "type is required" });
          return true;
        }
        const result = await controller.connectProvider(type as ProviderType, {
          id: stringField(body, "id"),
          name: stringField(body, "name"),
          baseUrl: stringField(body, "baseUrl"),
          model: stringField(body, "model"),
          apiKey: stringField(body, "apiKey"),
          scope: body.scope === "project" ? "project" : "global",
        });
        json(response, 200, { ...result, state: await state() });
        return true;
      }
      if (pathname === "/api/provider/remove" && request.method === "POST") {
        const id = stringField(body, "id");
        if (!id) {
          json(response, 400, { error: "id is required" });
          return true;
        }
        const removed = await controller.removeProvider(
          id,
          body.scope === "project" ? "project" : "global",
        );
        json(response, 200, { removed, state: await state() });
        return true;
      }
      if (pathname === "/api/mode" && request.method === "POST") {
        const mode = stringField(body, "mode");
        if (mode !== "agent" && mode !== "plan" && mode !== "ask") {
          json(response, 400, { error: "mode must be agent, plan or ask" });
          return true;
        }
        await controller.setMode(mode);
        json(response, 200, { ok: true, state: await state() });
        return true;
      }
      if (pathname === "/api/permission" && request.method === "POST") {
        const mode = stringField(body, "mode") as PermissionMode | undefined;
        if (!mode || !["ask", "auto", "plan", "yolo"].includes(mode)) {
          json(response, 400, { error: "mode must be ask, auto, plan or yolo" });
          return true;
        }
        controller.setPermissionMode(mode);
        json(response, 200, { ok: true, state: await state() });
        return true;
      }
      if (pathname === "/api/update" && request.method === "GET") {
        const refresh = url.searchParams.get("refresh") === "1";
        if (!refresh && updateCache && Date.now() - updateCache.at < 5 * 60_000) {
          json(response, 200, updateCache.value);
          return true;
        }
        const value = options.updateChecker ? await options.updateChecker() : await checkForUpdate();
        updateCache = { value, at: Date.now() };
        json(response, 200, value);
        return true;
      }
      if (pathname === "/api/sessions" && request.method === "GET") {
        json(response, 200, await controller.listSessions());
        return true;
      }
      if (pathname === "/api/session/new" && request.method === "POST") {
        const session = await controller.newSession();
        json(response, 200, { session, state: await state() });
        return true;
      }
      if (pathname === "/api/session/load" && request.method === "POST") {
        const id = stringField(body, "id");
        if (!id) {
          json(response, 400, { error: "id is required" });
          return true;
        }
        const session = await controller.loadSession(id);
        json(response, 200, { session, state: await state() });
        return true;
      }
      if (pathname === "/api/session/export" && request.method === "POST") {
        const result = await controller.exportSession(stringField(body, "path"));
        json(response, 200, { result });
        return true;
      }
      if (pathname === "/api/approval" && request.method === "POST") {
        const id = stringField(body, "id");
        const entry = id ? pending.get(id) : undefined;
        if (!id || !entry || entry.kind !== "approval") {
          json(response, 404, { error: "Unknown approval request" });
          return true;
        }
        pending.delete(id);
        entry.resolve({
          approved: Boolean(body.approved),
          remember: Boolean(body.remember),
          reason: stringField(body, "reason"),
        });
        json(response, 200, { ok: true });
        return true;
      }
      if (pathname === "/api/respond" && request.method === "POST") {
        const id = stringField(body, "id");
        const entry = id ? pending.get(id) : undefined;
        if (!id || !entry || entry.kind === "approval") {
          json(response, 404, { error: "Unknown UI request" });
          return true;
        }
        pending.delete(id);
        if (body.cancelled) {
          if (entry.kind === "confirm") entry.resolve(false);
          else entry.resolve(undefined);
        } else if (entry.kind === "confirm") {
          entry.resolve(Boolean(body.value));
        } else {
          entry.resolve(stringField(body, "value") ?? "");
        }
        json(response, 200, { ok: true });
        return true;
      }
      if (pathname === "/api/undo" && request.method === "POST") {
        json(response, 200, { result: await controller.undo(), state: await state() });
        return true;
      }
      if (pathname === "/api/redo" && request.method === "POST") {
        json(response, 200, { result: await controller.redo(), state: await state() });
        return true;
      }
      if (pathname === "/api/checkpoints" && request.method === "GET") {
        json(response, 200, await controller.listCheckpoints());
        return true;
      }

      json(response, 404, { error: `Unknown API endpoint: ${pathname}` });
      return true;
    } catch (error) {
      json(response, 500, { error: toError(error).message });
      return true;
    }
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (await handleApi(request, response, url)) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "Method not allowed" });
        return;
      }
      const root = DESKTOP_DIR;
      const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`) && target !== path.join(root, "index.html")) {
        json(response, 403, { error: "Forbidden" });
        return;
      }
      let content: Buffer;
      try {
        content = await fs.readFile(target);
      } catch {
        json(response, 404, { error: "Not found" });
        return;
      }
      if (relative === "index.html") {
        const html = content
          .toString("utf8")
          .replaceAll("__TAGCODE_TOKEN__", token)
          .replaceAll("__TAGCODE_VERSION__", VERSION);
        const body = Buffer.from(html, "utf8");
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": body.length,
        });
        response.end(body);
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType(target),
        "Cache-Control": "no-store",
        "Content-Length": content.length,
      });
      response.end(content);
    } catch (error) {
      logger.warn("desktop", "request failed", toError(error).message);
      if (!response.headersSent) json(response, 500, { error: toError(error).message });
      else response.end();
    }
  };

  server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await shutdown();
    throw new Error("Could not determine desktop server port");
  }
  const url = `http://127.0.0.1:${address.port}/`;

  return {
    url,
    token,
    controller,
    close: () => close("closed"),
  };
}

export type LaunchDesktopOptions = SessionControllerOptions & {
  open?: boolean;
  browser?: string;
  idleTimeoutMs?: number;
};

/**
 * Start the desktop server and open it in a chromeless app window.
 * Returns once the server is running; the Node process stays alive.
 */
export async function launchDesktop(options: LaunchDesktopOptions): Promise<DesktopServer> {
  const { open = true, browser, idleTimeoutMs, ...controllerOptions } = options;
  const controller = new SessionController(controllerOptions);
  await controller.initialize();
  const server = await startDesktopServer({ controller, idleTimeoutMs });
  console.log(`TagCode Desktop: ${server.url}`);
  if (open) {
    const opened = await openAppWindow(server.url, browser);
    if (!opened) {
      console.log("No supported browser found. Open the URL above in Edge or Chrome.");
    }
  }
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}
