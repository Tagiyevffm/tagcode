import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, fail, ok, type ToolContext } from "./types.js";
import { classifyCommand } from "../security/commands.js";
import { formatDuration } from "../utils/strings.js";

export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  error?: string;
};

export type ProcessOptions = {
  command?: string;
  file?: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  env?: Record<string, string>;
  maxOutputChars?: number;
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
};

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already gone.
    }
  }
}

/** Run a child process with bounded output, timeout and cancellation. */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const maxOutput = options.maxOutputChars ?? 50_000;
  const started = Date.now();
  const useShell = options.command !== undefined;
  const command = useShell ? options.command! : options.file!;
  const args = useShell ? undefined : options.args ?? [];

  return new Promise<ProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, args as string[], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options.env },
      shell: useShell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length < maxOutput) stdout += text.slice(0, maxOutput - stdout.length);
      } else if (stderr.length < maxOutput) {
        stderr += text.slice(0, maxOutput - stderr.length);
      }
      options.onChunk?.(text, target);
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
    };

    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        error,
      });
    };

    const terminate = (reason: "timeout" | "cancel") => {
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      killTree(child);
      killTimer = setTimeout(() => finish(null, reason === "timeout" ? "Timed out" : "Cancelled"), 3_000);
    };

    const timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = () => terminate("cancel");
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

export function formatProcessResult(result: ProcessResult, commandLabel: string): string {
  const parts: string[] = [];
  const duration = formatDuration(result.durationMs);
  if (result.cancelled) parts.push(`$ ${commandLabel}\n[cancelled after ${duration}]`);
  else if (result.timedOut) parts.push(`$ ${commandLabel}\n[timed out after ${duration}]`);
  else parts.push(`$ ${commandLabel}\n[exit code ${result.code ?? "unknown"}, ${duration}]`);
  if (result.error) parts.push(`error: ${result.error}`);
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

function quoteArg(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function riskFor(command: string): { risk: "low" | "medium" | "high"; requiresApproval: boolean; reasons: string[] } {
  const classification = classifyCommand(command);
  const risk = classification.risk === "dangerous" ? "high" : classification.risk === "caution" ? "medium" : "low";
  return {
    risk,
    requiresApproval: classification.risk === "dangerous",
    reasons: classification.reasons,
  };
}

async function resolveCwd(context: ToolContext, input?: string): Promise<string> {
  if (!input) return context.paths.root;
  const absolute = await context.paths.resolveSafe(input);
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${input}`);
  return absolute;
}

const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a shell command in the workspace and return stdout, stderr and the exit code. Use for builds, tests and inspection. Destructive commands require explicit approval.",
  permission: "execute",
  parameters: z.object({
    command: z.string().min(1).describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory relative to the workspace"),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
  }),
  describe: (input) => {
    const { risk, requiresApproval, reasons } = riskFor(input.command);
    return {
      summary: input.command,
      command: input.command,
      risk,
      requiresApproval,
      details: reasons.length > 0 ? `Risk: ${reasons.join("; ")}` : undefined,
    };
  },
  async execute(input, context) {
    let cwd: string;
    try {
      cwd = await resolveCwd(context, input.cwd);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const result = await runProcess({
      command: input.command,
      cwd,
      timeoutMs: input.timeout_ms ?? 120_000,
      signal: context.signal,
      env: input.env,
      maxOutputChars: context.config.context.maxToolOutputChars,
      onChunk: (chunk) => context.emit({ type: "tool-output", callId: context.callId, chunk }),
    });
    const formatted = formatProcessResult(result, input.command);
    const success = !result.timedOut && !result.cancelled && result.code === 0 && !result.error;
    return success ? ok(formatted, result) : fail(formatted, result);
  },
});

const INTERPRETERS: Record<string, { file: string; prefix: string[] }> = {
  ".js": { file: process.execPath, prefix: [] },
  ".mjs": { file: process.execPath, prefix: [] },
  ".cjs": { file: process.execPath, prefix: [] },
  ".ts": { file: process.execPath, prefix: [] },
  ".mts": { file: process.execPath, prefix: [] },
  ".py": { file: process.platform === "win32" ? "python" : "python3", prefix: [] },
  ".ps1": { file: "powershell", prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"] },
  ".sh": { file: process.platform === "win32" ? "bash" : "bash", prefix: [] },
  ".bat": { file: "cmd", prefix: ["/d", "/s", "/c"] },
  ".cmd": { file: "cmd", prefix: ["/d", "/s", "/c"] },
};

const runScriptTool = defineTool({
  name: "run_script",
  description:
    "Execute a script file inside the workspace using an interpreter chosen by its extension (.js/.ts/.py/.ps1/.sh/.bat). Arguments can be passed explicitly.",
  permission: "execute",
  parameters: z.object({
    path: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: (input) => {
    const { risk, requiresApproval, reasons } = riskFor(`${input.path} ${(input.args ?? []).join(" ")}`);
    return {
      summary: `Run script ${input.path}`,
      risk,
      requiresApproval,
      details: reasons.join("; ") || undefined,
    };
  },
  async execute(input, context) {
    const script = await context.paths.resolveSafe(input.path);
    const stat = await fs.stat(script);
    if (!stat.isFile()) return fail(`${input.path} is not a file.`);
    const extension = path.extname(script).toLowerCase();
    const interpreter = INTERPRETERS[extension];
    if (!interpreter) {
      return fail(`Unsupported script type "${extension}". Use run_command instead.`);
    }
    let cwd: string;
    try {
      cwd = await resolveCwd(context, input.cwd ?? path.dirname(context.paths.relative(script)));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const scriptArgs =
      interpreter.prefix.length > 0 && interpreter.prefix[0] === "-File"
        ? [...interpreter.prefix, script, ...(input.args ?? [])]
        : [...interpreter.prefix, script, ...(input.args ?? [])];
    const result = await runProcess({
      file: interpreter.file,
      args: scriptArgs,
      cwd,
      timeoutMs: input.timeout_ms ?? 120_000,
      signal: context.signal,
      maxOutputChars: context.config.context.maxToolOutputChars,
      onChunk: (chunk) => context.emit({ type: "tool-output", callId: context.callId, chunk }),
    });
    const label = `${interpreter.file} ${input.path} ${(input.args ?? []).join(" ")}`.trim();
    const formatted = formatProcessResult(result, label);
    const success = !result.timedOut && !result.cancelled && result.code === 0 && !result.error;
    return success ? ok(formatted, result) : fail(formatted, result);
  },
});

async function runInlineScript(
  context: ToolContext,
  language: "python" | "node",
  code: string,
  timeoutMs: number,
  label: string,
): Promise<{ success: boolean; output: string }> {
  const extension = language === "python" ? ".py" : ".mjs";
  const dir = path.join(os.tmpdir(), "tagcode");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `inline-${randomUUID()}${extension}`);
  await fs.writeFile(file, code, "utf8");
  try {
    const executable =
      language === "python"
        ? process.env.TAGCODE_PYTHON || (process.platform === "win32" ? "python" : "python3")
        : process.execPath;
    const result = await runProcess({
      file: executable,
      args: [file],
      cwd: context.paths.root,
      timeoutMs,
      signal: context.signal,
      maxOutputChars: context.config.context.maxToolOutputChars,
      onChunk: (chunk) => context.emit({ type: "tool-output", callId: context.callId, chunk }),
    });
    const success = !result.timedOut && !result.cancelled && result.code === 0 && !result.error;
    return { success, output: formatProcessResult(result, label) };
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

const executePythonTool = defineTool({
  name: "execute_python",
  description:
    "Run a Python snippet in a temporary file. Use for calculations, data processing and quick checks. Set TAGCODE_PYTHON to choose the interpreter.",
  permission: "execute",
  parameters: z.object({
    code: z.string().min(1),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: () => ({ summary: "Execute Python snippet", risk: "medium" }),
  async execute(input, context) {
    const result = await runInlineScript(
      context,
      "python",
      input.code,
      input.timeout_ms ?? 60_000,
      "python (inline)",
    );
    return result.success ? ok(result.output) : fail(result.output);
  },
});

const executeNodeTool = defineTool({
  name: "execute_node",
  description: "Run a JavaScript/TypeScript snippet with Node.js in a temporary file.",
  permission: "execute",
  parameters: z.object({
    code: z.string().min(1),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: () => ({ summary: "Execute Node snippet", risk: "medium" }),
  async execute(input, context) {
    const result = await runInlineScript(
      context,
      "node",
      input.code,
      input.timeout_ms ?? 60_000,
      "node (inline)",
    );
    return result.success ? ok(result.output) : fail(result.output);
  },
});

async function detectInstallCommand(workspace: string): Promise<{ command: string; manager: string } | null> {
  const exists = async (file: string) =>
    fs.stat(path.join(workspace, file)).then(() => true).catch(() => false);

  if (await exists("pnpm-lock.yaml")) return { command: "pnpm install", manager: "pnpm" };
  if (await exists("yarn.lock")) return { command: "yarn install", manager: "yarn" };
  if (await exists("bun.lockb") || await exists("bun.lock")) return { command: "bun install", manager: "bun" };
  if (await exists("package-lock.json") || (await exists("package.json")))
    return { command: "npm install", manager: "npm" };
  if (await exists("poetry.lock")) return { command: "poetry install", manager: "poetry" };
  if (await exists("uv.lock")) return { command: "uv sync", manager: "uv" };
  if (await exists("pyproject.toml")) return { command: "python -m pip install -e .", manager: "pip" };
  if (await exists("requirements.txt"))
    return { command: "python -m pip install -r requirements.txt", manager: "pip" };
  if (await exists("Cargo.toml")) return { command: "cargo fetch", manager: "cargo" };
  if (await exists("go.mod")) return { command: "go mod download", manager: "go" };
  if (await exists("composer.json")) return { command: "composer install", manager: "composer" };
  if (await exists("Gemfile")) return { command: "bundle install", manager: "bundler" };
  return null;
}

const installDependenciesTool = defineTool({
  name: "install_dependencies",
  description:
    "Install project dependencies using the package manager detected from lockfiles (npm, pnpm, yarn, bun, pip, poetry, uv, cargo, go, composer, bundler). Always requires approval.",
  permission: "sensitive",
  parameters: z.object({
    command: z.string().optional().describe("Override the detected install command"),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: (input) => ({
    summary: input.command ? `Install: ${input.command}` : "Install project dependencies",
    requiresApproval: true,
    risk: "medium",
    details: "Dependency installation executes third-party code and modifies the environment.",
  }),
  async execute(input, context) {
    const detected = await detectInstallCommand(context.paths.root);
    if (!detected && !input.command) {
      return fail(
        "Could not detect a package manager in this workspace (looked for package.json, lockfiles, pyproject.toml, requirements.txt, Cargo.toml, go.mod, composer.json, Gemfile).",
      );
    }
    const command = input.command ?? detected!.command;
    const result = await runProcess({
      command,
      cwd: context.paths.root,
      timeoutMs: input.timeout_ms ?? 300_000,
      signal: context.signal,
      maxOutputChars: context.config.context.maxToolOutputChars,
      onChunk: (chunk) => context.emit({ type: "tool-output", callId: context.callId, chunk }),
    });
    const formatted = formatProcessResult(result, command);
    const success = !result.timedOut && !result.cancelled && result.code === 0 && !result.error;
    return success ? ok(formatted, result) : fail(formatted, result);
  },
});

export const terminalTools = [
  runCommandTool,
  runScriptTool,
  executePythonTool,
  executeNodeTool,
  installDependenciesTool,
];

export { quoteArg };
