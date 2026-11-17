import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, fail, ok } from "./types.js";
import { detectProject, summarizeProject } from "../project/detect.js";
import { formatProcessResult, runProcess } from "./terminal.js";
import { walkFiles } from "../utils/glob.js";
import { matchGlob } from "../utils/glob.js";
import { truncate } from "../utils/strings.js";

const inspectProjectTool = defineTool({
  name: "inspect_project",
  description:
    "Analyze the project: languages, frameworks, package managers, manifests, test/build/lint commands and git state. Start here in an unfamiliar repository.",
  permission: "read",
  parameters: z.object({ path: z.string().optional() }),
  describe: (input) => ({ summary: `Inspect project${input.path ? ` ${input.path}` : ""}` }),
  async execute(input, context) {
    const root = input.path ? await context.paths.resolveSafe(input.path) : context.paths.root;
    const info = await detectProject(root);
    return ok(summarizeProject(info), info);
  },
});

const detectLanguageTool = defineTool({
  name: "detect_language",
  description: "Count source files by programming language.",
  permission: "read",
  parameters: z.object({ path: z.string().optional() }),
  describe: () => ({ summary: "Detect project languages" }),
  async execute(input, context) {
    const root = input.path ? await context.paths.resolveSafe(input.path) : context.paths.root;
    const info = await detectProject(root);
    if (info.languages.length === 0) return ok("No recognizable source files found.", []);
    const lines = info.languages.map((language) => `${language.name}: ${language.files} files`);
    return ok(lines.join("\n"), info.languages);
  },
});

const detectFrameworkTool = defineTool({
  name: "detect_framework",
  description: "Detect frameworks and libraries from manifests and framework-specific files.",
  permission: "read",
  parameters: z.object({ path: z.string().optional() }),
  describe: () => ({ summary: "Detect frameworks" }),
  async execute(input, context) {
    const root = input.path ? await context.paths.resolveSafe(input.path) : context.paths.root;
    const info = await detectProject(root);
    if (info.frameworks.length === 0) return ok("No frameworks detected from manifests or config files.", []);
    return ok(
      info.frameworks.map((framework) => `${framework.name} — ${framework.evidence}`).join("\n"),
      info.frameworks,
    );
  },
});

const inspectDependenciesTool = defineTool({
  name: "inspect_dependencies",
  description: "List declared dependencies from package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod and composer.json.",
  permission: "read",
  parameters: z.object({}),
  describe: () => ({ summary: "Inspect dependencies" }),
  async execute(_input, context) {
    const root = context.paths.root;
    const sections: string[] = [];
    const data: Record<string, string[]> = {};

    const packageJsonPath = path.join(root, "package.json");
    try {
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const deps = Object.entries(pkg.dependencies ?? {}).map(([name, version]) => `${name}@${version}`);
      const devDeps = Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => `${name}@${version}`);
      const peerDeps = Object.entries(pkg.peerDependencies ?? {}).map(([name, version]) => `${name}@${version}`);
      if (deps.length > 0) {
        sections.push(`package.json dependencies (${deps.length}):\n${deps.join("\n")}`);
        data.dependencies = deps;
      }
      if (devDeps.length > 0) {
        sections.push(`package.json devDependencies (${devDeps.length}):\n${devDeps.join("\n")}`);
        data.devDependencies = devDeps;
      }
      if (peerDeps.length > 0) {
        sections.push(`package.json peerDependencies (${peerDeps.length}):\n${peerDeps.join("\n")}`);
      }
    } catch {
      // No package.json.
    }

    try {
      const requirements = await fs.readFile(path.join(root, "requirements.txt"), "utf8");
      const lines = requirements
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (lines.length > 0) {
        sections.push(`requirements.txt (${lines.length}):\n${lines.join("\n")}`);
        data.python = lines;
      }
    } catch {
      // No requirements.txt.
    }

    try {
      const cargo = await fs.readFile(path.join(root, "Cargo.toml"), "utf8");
      const depsSection = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? "";
      const deps = depsSection
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (deps.length > 0) {
        sections.push(`Cargo.toml [dependencies] (${deps.length}):\n${deps.join("\n")}`);
        data.cargo = deps;
      }
    } catch {
      // No Cargo.toml.
    }

    try {
      const goMod = await fs.readFile(path.join(root, "go.mod"), "utf8");
      const requires = [...goMod.matchAll(/^\s*require\s+([^\s]+)\s+([^\s]+)/gm)].map(
        (match) => `${match[1]} ${match[2]}`,
      );
      if (requires.length > 0) {
        sections.push(`go.mod require (${requires.length}):\n${requires.join("\n")}`);
        data.go = requires;
      }
    } catch {
      // No go.mod.
    }

    try {
      const composer = JSON.parse(await fs.readFile(path.join(root, "composer.json"), "utf8")) as {
        require?: Record<string, string>;
      };
      const deps = Object.entries(composer.require ?? {}).map(([name, version]) => `${name}: ${version}`);
      if (deps.length > 0) {
        sections.push(`composer.json require (${deps.length}):\n${deps.join("\n")}`);
        data.composer = deps;
      }
    } catch {
      // No composer.json.
    }

    if (sections.length === 0) return ok("No recognized dependency manifests found.");
    return ok(sections.join("\n\n"), data);
  },
});

type ParsedError = { file?: string; line?: number; column?: number; severity: string; code?: string; message: string };

function parseErrorOutput(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let match = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+)?:?\s*(.+)$/.exec(trimmed);
    if (match) {
      errors.push({
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4]!,
        code: match[5],
        message: match[6]!,
      });
      continue;
    }
    match = /^(.*?):(\d+):(\d+):\s+(error|warning|note|fatal error):\s*(.+)$/.exec(trimmed);
    if (match) {
      errors.push({
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4]!,
        message: match[5]!,
      });
      continue;
    }
    match = /^(error(?:\[[^\]]+\])?):\s*(.+)$/.exec(trimmed);
    if (match) {
      errors.push({ severity: "error", code: match[1], message: match[2]! });
      continue;
    }
    match = /^(.+?):(\d+):\s*(error|warning):\s*(.+)$/.exec(trimmed);
    if (match) {
      errors.push({
        file: match[1],
        line: Number(match[2]),
        severity: match[3]!,
        message: match[4]!,
      });
    }
  }
  return errors;
}

const analyzeErrorsTool = defineTool({
  name: "analyze_errors",
  description:
    "Parse compiler, test or linter output into structured errors with file, line and column. Pass the raw output from a command.",
  permission: "read",
  parameters: z.object({
    output: z.string().min(1),
  }),
  describe: () => ({ summary: "Analyze error output" }),
  async execute(input) {
    const errors = parseErrorOutput(input.output);
    if (errors.length === 0) {
      return ok("No structured errors detected in the provided output.", []);
    }
    const byFile = new Map<string, ParsedError[]>();
    for (const error of errors) {
      const key = error.file ?? "(global)";
      const list = byFile.get(key) ?? [];
      list.push(error);
      byFile.set(key, list);
    }
    const lines: string[] = [`${errors.length} diagnostic(s) in ${byFile.size} location(s):`];
    for (const [file, list] of byFile) {
      lines.push(`\n${file}:`);
      for (const error of list.slice(0, 50)) {
        const position = error.line ? `:${error.line}${error.column ? `:${error.column}` : ""}` : "";
        lines.push(`  [${error.severity}]${position} ${error.code ? `${error.code} ` : ""}${error.message}`);
      }
      if (list.length > 50) lines.push(`  … ${list.length - 50} more`);
    }
    return ok(lines.join("\n"), errors);
  },
});

const findTodosTool = defineTool({
  name: "find_todos",
  description: "Find TODO, FIXME, HACK and XXX comments in the codebase.",
  permission: "read",
  parameters: z.object({
    path: z.string().optional(),
    glob: z.string().optional(),
    max_results: z.number().int().min(1).max(500).optional(),
  }),
  describe: () => ({ summary: "Find TODOs" }),
  async execute(input, context) {
    const root = input.path ? await context.paths.resolveSafe(input.path) : context.paths.root;
    const files = await walkFiles(root, { maxFiles: 20_000 });
    const max = input.max_results ?? 100;
    const pattern = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/i;
    const matches: Array<{ file: string; line: number; kind: string; text: string }> = [];
    for (const file of files) {
      if (matches.length >= max) break;
      if (input.glob && !matchGlob(file.relativePath, input.glob)) continue;
      if (file.size > 1024 * 1024) continue;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|c|cpp|h|hpp|rb|php|swift|dart|sh|ps1|sql|vue|svelte)$/i.test(file.path)) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(file.path, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const match = pattern.exec(lines[index]!);
        if (match) {
          matches.push({
            file: context.paths.relative(file.path),
            line: index + 1,
            kind: match[1]!.toUpperCase(),
            text: truncate(match[2]!.trim(), 200),
          });
          if (matches.length >= max) break;
        }
      }
    }
    if (matches.length === 0) return ok("No TODO/FIXME comments found.", []);
    return ok(
      `${matches.length} item(s):\n${matches
        .map((match) => `${match.file}:${match.line}: ${match.kind} ${match.text}`)
        .join("\n")}`,
      matches,
    );
  },
});

const TEST_SUMMARY =
  /(?:tests?|specs?)[\s:]+(\d+\s+(?:passed|failed|skipped)[^\n]*)|(\d+\s+passed[^\n]*)|(test result:[^\n]+)|(OK \(\d+ tests?\)|FAILED \([^\n]+\))/i;

async function runProjectCommand(
  context: Parameters<typeof inspectProjectTool.execute>[1],
  command: string,
  label: string,
  timeoutMs: number,
): Promise<{ success: boolean; output: string; summary?: string }> {
  const result = await runProcess({
    command,
    cwd: context.paths.root,
    timeoutMs,
    signal: context.signal,
    maxOutputChars: context.config.context.maxToolOutputChars,
    onChunk: (chunk) => context.emit({ type: "tool-output", callId: context.callId, chunk }),
  });
  const success = !result.timedOut && !result.cancelled && result.code === 0 && !result.error;
  const formatted = formatProcessResult(result, label);
  const combined = `${result.stdout}\n${result.stderr}`;
  const summaryMatch = TEST_SUMMARY.exec(combined);
  return { success, output: formatted, summary: summaryMatch?.[0] };
}

async function resolveCommand(
  context: Parameters<typeof inspectProjectTool.execute>[1],
  provided: string | undefined,
  kind: "test" | "lint" | "typecheck",
): Promise<string | undefined> {
  if (provided) return provided;
  const info = await detectProject(context.paths.root);
  return info.commands[kind];
}

const runTestsTool = defineTool({
  name: "run_tests",
  description:
    "Run the project's test suite (auto-detected, or pass a command). Returns output and an extracted summary.",
  permission: "execute",
  parameters: z.object({
    command: z.string().optional(),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: (input) => ({ summary: input.command ?? "Run project tests" }),
  async execute(input, context) {
    const command = await resolveCommand(context, input.command, "test");
    if (!command) return fail("No test command detected. Pass command explicitly.");
    const result = await runProjectCommand(context, command, command, input.timeout_ms ?? 300_000);
    const prefix = result.summary ? `Summary: ${result.summary}\n\n` : "";
    return result.success ? ok(prefix + result.output) : fail(prefix + result.output);
  },
});

const runLinterTool = defineTool({
  name: "run_linter",
  description: "Run the project's linter (auto-detected, or pass a command).",
  permission: "execute",
  parameters: z.object({
    command: z.string().optional(),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: (input) => ({ summary: input.command ?? "Run linter" }),
  async execute(input, context) {
    const command = await resolveCommand(context, input.command, "lint");
    if (!command) return fail("No linter command detected. Pass command explicitly.");
    const result = await runProjectCommand(context, command, command, input.timeout_ms ?? 180_000);
    return result.success ? ok(result.output) : fail(result.output);
  },
});

const checkTypesTool = defineTool({
  name: "check_types",
  description: "Run the project's type checker (tsc, mypy, cargo check, go vet, …), auto-detected or explicit.",
  permission: "execute",
  parameters: z.object({
    command: z.string().optional(),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }),
  describe: (input) => ({ summary: input.command ?? "Check types" }),
  async execute(input, context) {
    const command = await resolveCommand(context, input.command, "typecheck");
    if (!command) return fail("No type-check command detected. Pass command explicitly.");
    const result = await runProjectCommand(context, command, command, input.timeout_ms ?? 300_000);
    return result.success ? ok(result.output) : fail(result.output);
  },
});

export const analysisTools = [
  inspectProjectTool,
  detectLanguageTool,
  detectFrameworkTool,
  inspectDependenciesTool,
  analyzeErrorsTool,
  findTodosTool,
  runTestsTool,
  runLinterTool,
  checkTypesTool,
];
