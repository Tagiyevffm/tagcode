import type { z } from "zod";
import type {
  AgentEvent,
  JsonSchema,
  PlanStep,
  SessionPlan,
  TokenUsage,
  ToolPermission,
  ToolResult,
} from "../core/types.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { SecretStore } from "../config/secrets.js";
import type { PermissionManager } from "../agent/permissions.js";
import type { WorkspacePaths } from "../security/paths.js";

export type ToolDescriptiveInfo = {
  summary: string;
  details?: string;
  command?: string;
  risk?: "low" | "medium" | "high";
  /** Force an approval prompt even in auto/YOLO mode (still subject to allow rules). */
  requiresApproval?: boolean;
};

export type PlanController = {
  get(): SessionPlan | undefined;
  set(plan: SessionPlan | undefined): void;
  updateSteps(steps: PlanStep[]): void;
};

export type ToolCheckpoints = {
  capture(paths: string[], reason: string): Promise<string | undefined>;
};

export type ToolMemory = {
  search(query: string, limit?: number): Promise<string[]>;
  append(section: string, text: string): Promise<void>;
};

export type ToolSkills = {
  getActiveNames(): string[];
  readInstructions(name: string): Promise<string | undefined>;
};

export type ToolContext = {
  workspace: string;
  projectRoot: string;
  paths: WorkspacePaths;
  config: ResolvedConfig;
  permissions: PermissionManager;
  secrets: SecretStore;
  signal: AbortSignal;
  sessionId: string;
  callId: string;
  plan: PlanController;
  emit(event: AgentEvent): void;
  checkpoints?: ToolCheckpoints;
  memory?: ToolMemory;
  skills?: ToolSkills;
  requestUserInput?: (question: string, options?: string[]) => Promise<string>;
  getContextStats?: () => ContextStats;
  model?: { provider: string; model: string };
};

export type ContextStats = {
  messageCount: number;
  estimatedTokens: number;
  budget: number;
  usage: TokenUsage;
};

export interface Tool<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: Schema;
  permission: ToolPermission;
  /**
   * Optional JSON Schema used for provider tool definitions when the Zod
   * schema is intentionally permissive (for example MCP tools whose real input
   * schema lives on the server).
   */
  jsonSchema?: JsonSchema;
  /** Shown in the UI and used for the audit log. */
  describe?(input: z.infer<Schema>): ToolDescriptiveInfo;
  execute(input: z.infer<Schema>, context: ToolContext): Promise<ToolResult>;
}

export type AnyTool = Tool<z.ZodType>;

export function defineTool<Schema extends z.ZodType>(tool: Tool<Schema>): Tool<Schema> {
  return tool;
}

export function ok(output: string, data?: unknown): ToolResult {
  return { ok: true, output, data };
}

export function fail(output: string, data?: unknown): ToolResult {
  return { ok: false, output, data };
}

export function errorResult(error: unknown): ToolResult {
  return {
    ok: false,
    output: error instanceof Error ? error.message : String(error),
  };
}
