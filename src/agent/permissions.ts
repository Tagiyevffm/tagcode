import { promises as fs } from "node:fs";
import type { ApprovalDecision, PermissionMode, ToolPermission } from "../core/types.js";
import type { ResolvedConfig } from "../config/schema.js";
import { PermissionDeniedError } from "../core/errors.js";
import { appendAudit } from "../security/audit.js";

export type ApprovalBroker = (request: {
  toolName: string;
  permission: ToolPermission;
  summary: string;
  details?: string;
  command?: string;
  risk?: "low" | "medium" | "high";
}) => Promise<ApprovalDecision>;

export type PermissionDecision = {
  allowed: boolean;
  needsApproval: boolean;
  reason?: string;
};

export type PermissionRule = {
  pattern: string;
  /** "allow", "deny" or "ask" */
  action: "allow" | "deny" | "ask";
};

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

export function matchesToolPattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(name, pattern));
}

const SAFE_TOOL_PERMISSIONS: ToolPermission[] = ["read", "network"];

/**
 * Central permission gate. Every tool call — built-in, MCP or plugin — flows
 * through `authorize()`. Calls are audited with redacted arguments.
 */
export class PermissionManager {
  private mode: PermissionMode;
  private readonly allow: string[];
  private readonly deny: string[];
  private readonly requireApproval: string[];
  private readonly sessionApprovals = new Set<string>();
  private readonly auditHome?: string;
  private broker?: ApprovalBroker;

  constructor(config: ResolvedConfig, options: { auditHome?: string } = {}) {
    this.mode = config.permissions.mode;
    this.allow = [...config.permissions.allow];
    this.deny = [...config.permissions.deny];
    this.requireApproval = [...config.permissions.requireApproval];
    this.auditHome = options.auditHome;
  }

  setBroker(broker: ApprovalBroker | undefined): void {
    this.broker = broker;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  isReadOnly(): boolean {
    return this.mode === "plan";
  }

  /** Decide whether a tool call may run without asking the user. */
  evaluate(toolName: string, permission: ToolPermission): PermissionDecision {
    if (matchesToolPattern(toolName, this.deny)) {
      return { allowed: false, needsApproval: false, reason: `Denied by configuration (${toolName})` };
    }
    if (this.mode === "plan") {
      if (SAFE_TOOL_PERMISSIONS.includes(permission) && permission !== "network") {
        return { allowed: true, needsApproval: false };
      }
      return {
        allowed: false,
        needsApproval: false,
        reason: "Plan mode is read-only. Approve the plan and switch to agent mode to make changes.",
      };
    }
    if (matchesToolPattern(toolName, this.allow)) {
      return { allowed: true, needsApproval: false };
    }
    if (this.sessionApprovals.has(toolName) || this.sessionApprovals.has("*")) {
      return { allowed: true, needsApproval: false };
    }
    if (matchesToolPattern(toolName, this.requireApproval)) {
      return { allowed: true, needsApproval: true, reason: "Configured to always require approval" };
    }
    if (permission === "sensitive") {
      return { allowed: true, needsApproval: true, reason: "Sensitive operation" };
    }
    if (this.mode === "yolo") {
      return { allowed: true, needsApproval: false };
    }
    if (this.mode === "auto") {
      if (permission === "read") return { allowed: true, needsApproval: false };
      if (permission === "write" || permission === "execute" || permission === "network") {
        return { allowed: true, needsApproval: false };
      }
      return { allowed: true, needsApproval: true, reason: "Sensitive operation" };
    }
    // ask mode
    if (permission === "read") return { allowed: true, needsApproval: false };
    return { allowed: true, needsApproval: true, reason: "Ask mode requires approval for changes" };
  }

  async authorize(
    toolName: string,
    permission: ToolPermission,
    summary: string,
    details?: { details?: string; command?: string; risk?: "low" | "medium" | "high" },
    options: { forceApproval?: boolean } = {},
  ): Promise<{ approved: boolean; reason?: string }> {
    const decision = this.evaluate(toolName, permission);
    if (!decision.allowed) {
      await this.audit(toolName, permission, "denied", summary, decision.reason);
      throw new PermissionDeniedError(decision.reason ?? `Tool ${toolName} is not permitted`);
    }
    const explicitlyAllowed =
      matchesToolPattern(toolName, this.allow) ||
      this.sessionApprovals.has(toolName) ||
      this.sessionApprovals.has("*");
    if (options.forceApproval && !explicitlyAllowed) {
      decision.needsApproval = true;
      decision.reason = details?.risk === "high" ? "Destructive operation" : "Explicit approval required";
    }
    if (!decision.needsApproval) {
      await this.audit(toolName, permission, "allowed", summary);
      return { approved: true };
    }
    if (!this.broker) {
      const reason = `Approval required for ${toolName}, but no interactive approval channel is available`;
      await this.audit(toolName, permission, "denied", summary, reason);
      throw new PermissionDeniedError(reason);
    }
    const result = await this.broker({
      toolName,
      permission,
      summary,
      details: details?.details,
      command: details?.command,
      risk: details?.risk,
    });
    if (!result.approved) {
      const reason = result.reason ?? "User declined the operation";
      await this.audit(toolName, permission, "denied", summary, reason);
      throw new PermissionDeniedError(reason);
    }
    if (result.remember) {
      this.sessionApprovals.add(toolName);
    }
    await this.audit(toolName, permission, "approved", summary);
    return { approved: true };
  }

  private async audit(
    toolName: string,
    permission: ToolPermission,
    outcome: string,
    summary: string,
    reason?: string,
  ): Promise<void> {
    try {
      await appendAudit(
        {
          timestamp: new Date().toISOString(),
          tool: toolName,
          permission,
          outcome,
          summary,
          reason,
          mode: this.mode,
        },
        this.auditHome,
      );
    } catch {
      // Audit failures must not break tool execution.
    }
  }
}
