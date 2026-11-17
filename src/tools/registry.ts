import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../core/types.js";
import { CancelledError, PermissionDeniedError } from "../core/errors.js";
import { truncateMiddle } from "../utils/strings.js";
import { logger } from "../utils/logger.js";
import type { AnyTool, ToolContext } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (!tool.name || !/^[a-zA-Z0-9_-]+$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: AnyTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((tool) => tool.name);
  }

  definitions(filter?: (tool: AnyTool) => boolean): ToolDefinition[] {
    const selected = filter ? this.list().filter(filter) : this.list();
    return selected.map((tool) => {
      const schema = tool.jsonSchema
        ? { ...tool.jsonSchema }
        : (z.toJSONSchema(tool.parameters, { io: "input" }) as Record<string, unknown>);
      delete schema.$schema;
      return {
        name: tool.name,
        description: tool.description,
        parameters: schema,
      };
    });
  }

  /**
   * Validate, authorize, execute and truncate. Tool failures are returned as
   * results (so the model can recover); cancellation propagates.
   */
  async execute(
    name: string,
    rawArguments: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool: ${name}` };
    }
    if (context.signal.aborted) throw new CancelledError();

    const parsed = tool.parameters.safeParse(rawArguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return {
        ok: false,
        output: `Invalid arguments for ${name}: ${issues}`,
      };
    }

    const args = parsed.data;
    const description = tool.describe?.(args);
    const summary = description?.summary ?? name;

    try {
      const decision = await context.permissions.authorize(
        tool.name,
        tool.permission,
        summary,
        {
          details: description?.details,
          command: description?.command,
          risk: description?.risk,
        },
        { forceApproval: description?.requiresApproval === true },
      );
      if (!decision.approved) {
        return { ok: false, output: `Permission denied: ${decision.reason ?? tool.name}` };
      }
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        return { ok: false, output: `Permission denied: ${error.message}` };
      }
      throw error;
    }

    try {
      const result = await tool.execute(args, context);
      return this.truncateResult(result, context);
    } catch (error) {
      if (context.signal.aborted) throw new CancelledError();
      logger.debug("tools", `${name} failed`, error instanceof Error ? error.message : error);
      return {
        ok: false,
        output: truncateMiddle(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          context.config.context.maxToolOutputChars,
        ),
      };
    }
  }

  private truncateResult(result: ToolResult, context: ToolContext): ToolResult {
    const max = context.config.context.maxToolOutputChars;
    const output = typeof result.output === "string" ? result.output : String(result.output ?? "");
    if (output.length <= max) return { ...result, output };
    return {
      ...result,
      output: truncateMiddle(output, max),
      truncated: true,
    };
  }
}

/** Format a tool invocation for display, redacting long/secret-looking args. */
export function previewToolArguments(args: unknown, maxLength = 120): string {
  if (args === null || args === undefined) return "";
  try {
    const text = typeof args === "string" ? args : JSON.stringify(args);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
  } catch {
    return "";
  }
}
