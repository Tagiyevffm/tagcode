import { z } from "zod";
import { defineTool, fail, ok, type ToolContext } from "./types.js";
import { formatProcessResult, runProcess, type ProcessResult } from "./terminal.js";

async function git(
  context: ToolContext,
  args: string[],
  timeoutMs = 60_000,
): Promise<ProcessResult> {
  return runProcess({
    file: "git",
    args,
    cwd: context.paths.root,
    timeoutMs,
    signal: context.signal,
    maxOutputChars: context.config.context.maxToolOutputChars,
  });
}

function gitFailure(result: ProcessResult, label: string): string | undefined {
  if (result.error) {
    if (/ENOENT/i.test(result.error)) return "Git is not installed or not on PATH.";
    return `git ${label} failed: ${result.error}`;
  }
  if (result.timedOut) return `git ${label} timed out.`;
  if (result.cancelled) return `git ${label} was cancelled.`;
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
    return `git ${label} failed: ${detail}`;
  }
  return undefined;
}

async function relativePaths(context: ToolContext, paths: string[]): Promise<string[]> {
  const output: string[] = [];
  for (const entry of paths) {
    const absolute = await context.paths.resolveSafe(entry);
    output.push(context.paths.relative(absolute));
  }
  return output;
}

const gitStatusTool = defineTool({
  name: "git_status",
  description: "Show git branch and working-tree status in porcelain format.",
  permission: "read",
  parameters: z.object({}),
  describe: () => ({ summary: "Git status" }),
  async execute(_input, context) {
    const result = await git(context, ["status", "--porcelain=v1", "--branch"]);
    const error = gitFailure(result, "status");
    if (error) return fail(error);
    return ok(result.stdout.trim() || "Working tree clean.", result.stdout);
  },
});

const gitDiffTool = defineTool({
  name: "git_diff",
  description: "Show unstaged or staged changes, optionally for a single path or commit range.",
  permission: "read",
  parameters: z.object({
    staged: z.boolean().optional(),
    path: z.string().optional(),
    base: z.string().optional().describe("Commit/ref to diff against, e.g. HEAD~1"),
    stat_only: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: `Git diff${input.path ? ` ${input.path}` : ""}${input.staged ? " (staged)" : ""}` }),
  async execute(input, context) {
    const args = ["diff"];
    if (input.staged) args.push("--cached");
    if (input.stat_only) args.push("--stat");
    if (input.base) args.push(input.base);
    if (input.path) {
      const [relative] = await relativePaths(context, [input.path]);
      args.push("--", relative!);
    }
    const result = await git(context, args);
    const error = gitFailure(result, "diff");
    if (error) return fail(error);
    return ok(result.stdout.trim() || "No changes.", result.stdout);
  },
});

const gitLogTool = defineTool({
  name: "git_log",
  description: "Show recent commit history.",
  permission: "read",
  parameters: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    path: z.string().optional(),
    oneline: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: `Git log (${input.limit ?? 20})` }),
  async execute(input, context) {
    const limit = input.limit ?? 20;
    const args = ["log", "-n", String(limit)];
    args.push(input.oneline === false ? "--pretty=fuller" : "--pretty=format:%h %ad %an: %s --date=short");
    if (input.path) {
      const [relative] = await relativePaths(context, [input.path]);
      args.push("--", relative!);
    }
    const result = await git(context, args);
    const error = gitFailure(result, "log");
    if (error) return fail(error);
    return ok(result.stdout.trim() || "No commits yet.", result.stdout);
  },
});

const gitBranchTool = defineTool({
  name: "git_branch",
  description: "List branches, or create/switch/delete a branch.",
  permission: "write",
  parameters: z.object({
    action: z.enum(["list", "create", "switch", "delete"]).optional(),
    name: z.string().optional(),
    force: z.boolean().optional(),
  }),
  describe: (input) => ({
    summary: input.action && input.action !== "list" ? `Git branch ${input.action} ${input.name ?? ""}`.trim() : "Git branches",
    requiresApproval: input.action === "delete",
    risk: input.action === "delete" ? "high" : "low",
  }),
  async execute(input, context) {
    const action = input.action ?? "list";
    if (action !== "list" && !input.name) return fail(`Branch name is required for action "${action}".`);
    if (input.name && !/^[A-Za-z0-9._\/-]+$/.test(input.name)) return fail("Invalid branch name.");
    const args =
      action === "list"
        ? ["branch", "-a", "-vv"]
        : action === "create"
          ? ["branch", input.name!]
          : action === "switch"
            ? ["switch", input.name!]
            : ["branch", input.force ? "-D" : "-d", input.name!];
    const result = await git(context, args);
    const error = gitFailure(result, action);
    if (error) return fail(error);
    return ok(result.stdout.trim() || `Branch ${action} completed.`, result.stdout);
  },
});

const gitAddTool = defineTool({
  name: "git_add",
  description: "Stage files for commit.",
  permission: "write",
  parameters: z.object({
    paths: z.array(z.string()).optional(),
    all: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: input.all ? "Git add all" : `Git add ${(input.paths ?? []).join(", ")}` }),
  async execute(input, context) {
    if (!input.all && (!input.paths || input.paths.length === 0)) {
      return fail("Provide paths to stage or set all=true.");
    }
    const args = ["add", ...(input.all ? ["-A"] : ["--", ...(await relativePaths(context, input.paths!))])];
    const result = await git(context, args);
    const error = gitFailure(result, "add");
    if (error) return fail(error);
    return ok(result.stdout.trim() || `Staged ${input.all ? "all changes" : input.paths!.join(", ")}.`);
  },
});

const gitCommitTool = defineTool({
  name: "git_commit",
  description:
    "Create a git commit with the given message. Modifies repository history and therefore requires approval unless allowlisted.",
  permission: "sensitive",
  parameters: z.object({
    message: z.string().min(1),
    add_all: z.boolean().optional(),
    amend: z.boolean().optional(),
  }),
  describe: (input) => ({
    summary: `Commit: ${input.message.split("\n")[0]}`,
    requiresApproval: true,
    risk: "high",
    details: input.amend ? "Amending rewrites the previous commit." : undefined,
  }),
  async execute(input, context) {
    if (input.add_all) {
      const add = await git(context, ["add", "-A"]);
      const addError = gitFailure(add, "add");
      if (addError) return fail(addError);
    }
    const args = ["commit", "-m", input.message];
    if (input.amend) args.push("--amend");
    const result = await git(context, args);
    const error = gitFailure(result, "commit");
    if (error) return fail(error);
    return ok(result.stdout.trim() || "Commit created.", result.stdout);
  },
});

const gitCheckoutTool = defineTool({
  name: "git_checkout",
  description: "Switch to a branch or commit, optionally creating a new branch. Can discard uncommitted changes.",
  permission: "sensitive",
  parameters: z.object({
    target: z.string().min(1),
    create: z.boolean().optional(),
    force: z.boolean().optional(),
  }),
  describe: (input) => ({
    summary: `Git checkout ${input.target}${input.create ? " (new branch)" : ""}`,
    requiresApproval: true,
    risk: "high",
    details: input.force ? "Force checkout discards local changes." : undefined,
  }),
  async execute(input, context) {
    if (!/^[A-Za-z0-9._\/~^-]+$/.test(input.target)) return fail("Invalid git ref.");
    const args = input.create ? ["checkout", "-b", input.target] : ["checkout", input.target];
    if (input.force) args.splice(1, 0, "--force");
    const result = await git(context, args);
    const error = gitFailure(result, "checkout");
    if (error) return fail(error);
    return ok(result.stdout.trim() || `Checked out ${input.target}.`);
  },
});

const gitShowTool = defineTool({
  name: "git_show",
  description: "Show a commit, or the content of a file at a specific revision.",
  permission: "read",
  parameters: z.object({
    ref: z.string().optional().describe("Revision (default HEAD)"),
    path: z.string().optional().describe("Show this file at the revision"),
  }),
  describe: (input) => ({ summary: `Git show ${input.ref ?? "HEAD"}${input.path ? `:${input.path}` : ""}` }),
  async execute(input, context) {
    const ref = input.ref ?? "HEAD";
    if (!/^[A-Za-z0-9._\/~^-]+$/.test(ref)) return fail("Invalid git ref.");
    const args = input.path ? ["show", `${ref}:${input.path}`] : ["show", ref];
    const result = await git(context, args);
    const error = gitFailure(result, "show");
    if (error) return fail(error);
    return ok(result.stdout.trim() || "(no output)", result.stdout);
  },
});

export const gitTools = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
  gitAddTool,
  gitCommitTool,
  gitCheckoutTool,
  gitShowTool,
];

export { git };
export function formatGitResult(result: ProcessResult, label: string): string {
  return formatProcessResult(result, label);
}
