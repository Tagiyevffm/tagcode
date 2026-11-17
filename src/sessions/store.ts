import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage, PermissionMode, SessionPlan, TokenUsage } from "../core/types.js";
import { newSessionId } from "../utils/id.js";
import { ensureDir, readJson, writeJson, pathExists } from "../utils/fs.js";
import { tagcodeHome } from "../config/paths.js";

export type StoredSession = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  projectRoot: string;
  provider: string;
  model: string;
  permissionMode: PermissionMode;
  messages: ChatMessage[];
  plan?: SessionPlan;
  usage: TokenUsage;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  messageCount: number;
};

function now(): string {
  return new Date().toISOString();
}

function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return "New session";
  const text = firstUser.content.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || "New session";
}

export class SessionStore {
  readonly directory: string;

  constructor(directory = path.join(tagcodeHome(), "sessions")) {
    this.directory = directory;
  }

  private filePath(id: string): string {
    if (!/^ses_[a-z0-9]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  create(options: {
    cwd: string;
    projectRoot: string;
    provider: string;
    model: string;
    permissionMode: PermissionMode;
  }): StoredSession {
    const timestamp = now();
    return {
      version: 1,
      id: newSessionId(),
      title: "New session",
      createdAt: timestamp,
      updatedAt: timestamp,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      provider: options.provider,
      model: options.model,
      permissionMode: options.permissionMode,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async save(session: StoredSession): Promise<void> {
    await ensureDir(this.directory);
    session.updatedAt = now();
    if (session.title === "New session") session.title = titleFromMessages(session.messages);
    await writeJson(this.filePath(session.id), session, 0o600);
  }

  async load(id: string): Promise<StoredSession> {
    const session = await readJson<StoredSession | undefined>(this.filePath(id), undefined);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (!Array.isArray(session.messages)) throw new Error(`Session is corrupted: ${id}`);
    return session;
  }

  async exists(id: string): Promise<boolean> {
    try {
      return await pathExists(this.filePath(id));
    } catch {
      return false;
    }
  }

  async list(filter: { projectRoot?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.replace(/\.json$/, "");
      if (!/^ses_[a-z0-9]+$/.test(id)) continue;
      try {
        const raw = await readJson<StoredSession>(path.join(this.directory, entry.name), {} as StoredSession);
        if (!raw.id) continue;
        if (filter.projectRoot && raw.projectRoot !== filter.projectRoot) continue;
        summaries.push({
          id: raw.id,
          title: raw.title,
          updatedAt: raw.updatedAt,
          cwd: raw.cwd,
          provider: raw.provider,
          model: raw.model,
          messageCount: raw.messages?.length ?? 0,
        });
      } catch {
        // Ignore corrupt session files rather than failing the listing.
      }
    }
    return summaries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, filter.limit ?? 50);
  }

  async latest(projectRoot: string): Promise<StoredSession | undefined> {
    const summaries = await this.list({ projectRoot, limit: 1 });
    if (summaries.length === 0) return undefined;
    return this.load(summaries[0]!.id);
  }

  async rename(id: string, title: string): Promise<void> {
    const session = await this.load(id);
    session.title = title.trim().slice(0, 120) || session.title;
    await this.save(session);
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.filePath(id), { force: true });
  }

  toMarkdown(session: StoredSession): string {
    const lines: string[] = [
      `# ${session.title}`,
      "",
      `- Session: ${session.id}`,
      `- Created: ${session.createdAt}`,
      `- Updated: ${session.updatedAt}`,
      `- Model: ${session.provider}/${session.model}`,
      `- Directory: ${session.cwd}`,
      `- Tokens: ${session.usage.inputTokens} input / ${session.usage.outputTokens} output`,
      "",
    ];
    for (const message of session.messages) {
      if (message.role === "user") {
        lines.push("## User", "", message.content, "");
      } else if (message.role === "assistant") {
        lines.push("## Assistant", "", message.content || "(no text)", "");
        for (const call of message.toolCalls ?? []) {
          lines.push(`> Tool call: \`${call.name}\` \`${call.arguments}\``, "");
        }
      } else if (message.role === "tool") {
        lines.push(
          `### Tool result: ${message.name ?? message.toolCallId}`,
          "",
          "```",
          message.content.slice(0, 8000),
          "```",
          "",
        );
      } else if (message.role === "system") {
        lines.push("## System", "", message.content, "");
      }
    }
    return lines.join("\n");
  }

  async export(id: string, destination?: string): Promise<string> {
    const session = await this.load(id);
    const markdown = this.toMarkdown(session);
    if (!destination) return markdown;
    await ensureDir(path.dirname(destination));
    await fs.writeFile(destination, markdown, "utf8");
    return destination;
  }
}
