import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool, fail, ok } from "./types.js";
import { newId } from "../utils/id.js";
import type { PlanStep } from "../core/types.js";
import { VERSION } from "../version.js";
import { formatNumber } from "../utils/strings.js";

const askUserTool = defineTool({
  name: "ask_user",
  description:
    "Ask the user a direct question when a decision is genuinely blocking. Do not use this for routine confirmations; permission prompts handle those.",
  permission: "read",
  parameters: z.object({
    question: z.string().min(1).max(2000),
    options: z.array(z.string()).max(10).optional(),
  }),
  describe: (input) => ({ summary: input.question }),
  async execute(input, context) {
    if (!context.requestUserInput) {
      return fail("No interactive input channel is available in this mode.");
    }
    const answer = await context.requestUserInput(input.question, input.options);
    return ok(`User answered: ${answer}`, { answer });
  },
});

const createPlanTool = defineTool({
  name: "create_plan",
  description:
    "Record a step-by-step implementation plan. Use before multi-step work so the user can follow progress. Does not modify files.",
  permission: "read",
  parameters: z.object({
    goal: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1).max(30),
  }),
  describe: (input) => ({ summary: `Plan: ${input.goal}` }),
  async execute(input, context) {
    const steps: PlanStep[] = input.steps.map((title, index) => ({
      id: `step-${index + 1}`,
      title,
      status: index === 0 ? "in_progress" : "pending",
    }));
    context.plan.set({ goal: input.goal, steps });
    context.emit({ type: "plan", steps });
    return ok(
      `Plan created: ${input.goal}\n${steps.map((step) => `- [${step.status}] ${step.title}`).join("\n")}`,
      { goal: input.goal, steps },
    );
  },
});

const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Update the current plan. Provide `step_id` with a status to update one step, or a full `steps` array to replace the plan.",
  permission: "read",
  parameters: z
    .object({
      step_id: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional(),
      steps: z
        .array(
          z.object({
            id: z.string().optional(),
            title: z.string().min(1),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]),
          }),
        )
        .optional(),
      goal: z.string().optional(),
    })
    .refine((value) => Boolean(value.steps) || Boolean(value.step_id), {
      message: "Provide either steps or step_id",
    }),
  describe: () => ({ summary: "Update plan" }),
  async execute(input, context) {
    const current = context.plan.get();
    if (input.steps) {
      const steps: PlanStep[] = input.steps.map((step, index) => ({
        id: step.id ?? `step-${index + 1}`,
        title: step.title,
        status: step.status,
      }));
      context.plan.set({ goal: input.goal ?? current?.goal ?? "Plan", steps });
      context.emit({ type: "plan", steps });
      return ok(`Plan updated (${steps.filter((step) => step.status === "completed").length}/${steps.length} complete).`, steps);
    }
    if (!current) return fail("There is no plan yet. Use create_plan first.");
    const status = input.status;
    if (!status) return fail("status is required when updating a step.");
    const step = current.steps.find((entry) => entry.id === input.step_id);
    if (!step) return fail(`Unknown step id: ${input.step_id}`);
    step.status = status;
    const steps = [...current.steps];
    context.plan.set({ goal: current.goal, steps });
    context.emit({ type: "plan", steps });
    return ok(
      `Step "${step.title}" is now ${status}.\n${steps.map((entry) => `- [${entry.status}] ${entry.title}`).join("\n")}`,
      steps,
    );
  },
});

const summarizeContextTool = defineTool({
  name: "summarize_context",
  description: "Report conversation size, token budget and usage. Does not call the model.",
  permission: "read",
  parameters: z.object({}),
  describe: () => ({ summary: "Context statistics" }),
  async execute(_input, context) {
    const stats = context.getContextStats?.();
    if (!stats) {
      return ok(
        `Context budget: ${context.config.context.maxTokens === 0 ? "auto (model-derived)" : formatNumber(context.config.context.maxTokens)} tokens\nCompaction threshold: ${Math.round(context.config.context.compactAt * 100)}%`,
      );
    }
    const percent = Math.min(100, Math.round((stats.estimatedTokens / Math.max(1, stats.budget)) * 100));
    return ok(
      [
        `Messages: ${stats.messageCount}`,
        `Estimated context: ${formatNumber(stats.estimatedTokens)} / ${formatNumber(stats.budget)} tokens (${percent}%)`,
        `Session usage: ${formatNumber(stats.usage.inputTokens)} input / ${formatNumber(stats.usage.outputTokens)} output`,
        `Compaction triggers at ${Math.round(context.config.context.compactAt * 100)}%. Use /compact to summarize now.`,
      ].join("\n"),
      stats,
    );
  },
});

const inspectEnvironmentTool = defineTool({
  name: "inspect_environment",
  description:
    "Inspect the runtime environment: OS, Node, shell, git, package managers, configured model and which API-key variables are set (never their values).",
  permission: "read",
  parameters: z.object({}),
  describe: () => ({ summary: "Inspect environment" }),
  async execute(_input, context) {
    const commandVersion = (command: string, args: string[] = ["--version"]): string => {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
      if (result.error) return "not found";
      return (result.stdout || result.stderr || "").trim().split("\n")[0] || "unknown";
    };
    const keyVars = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "MISTRAL_API_KEY",
      "GROQ_API_KEY",
      "TOGETHER_API_KEY",
      "FIREWORKS_API_KEY",
      "BRAVE_API_KEY",
      "TAVILY_API_KEY",
    ];
    const lines = [
      `TagCode: ${VERSION}`,
      `Node: ${process.version}`,
      `Platform: ${process.platform} ${process.arch} (${os.release()})`,
      `Host: ${os.hostname()}`,
      `Workspace: ${context.workspace}`,
      `Project root: ${context.projectRoot}`,
      `Shell: ${process.env.ComSpec ?? process.env.SHELL ?? "unknown"}`,
      `Terminal: ${process.env.WT_SESSION ? "Windows Terminal" : process.env.TERM ?? "unknown"}`,
      `Git: ${commandVersion("git")}`,
      `npm: ${commandVersion("npm")}`,
      `Python: ${commandVersion(process.platform === "win32" ? "python" : "python3")}`,
      `Permission mode: ${context.permissions.getMode()}`,
      `Model: ${context.model ? `${context.model.provider}/${context.model.model}` : "not selected"}`,
      `API keys in environment: ${
        keyVars.filter((key) => Boolean(process.env[key])).join(", ") || "none"
      }`,
    ];
    return ok(lines.join("\n"), {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workspace: context.workspace,
      git: commandVersion("git"),
    });
  },
});

export const miscTools = [askUserTool, createPlanTool, updatePlanTool, summarizeContextTool, inspectEnvironmentTool];

/** Small helper used by tests and the UI to create stable plan ids. */
export function makePlanStep(title: string): PlanStep {
  return { id: newId("step"), title, status: "pending" };
}

export { path };
