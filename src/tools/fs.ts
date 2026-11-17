import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, errorResult, fail, ok, type ToolContext } from "./types.js";
import { countOccurrences, readTextWithMeta, splitFileLines, writeTextPreserving } from "../utils/textFile.js";
import { diffLines, diffStat } from "../utils/diff.js";
import { listDir } from "../utils/fs.js";
import { matchGlob, walkFiles } from "../utils/glob.js";
import { formatBytes, truncate } from "../utils/strings.js";

const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

async function captureBeforeChange(context: ToolContext, paths: string[], reason: string): Promise<string> {
  if (!context.checkpoints) return "";
  try {
    const id = await context.checkpoints.capture(paths, reason);
    return id ? `\nCheckpoint: ${id}` : "";
  } catch (error) {
    return `\nWarning: could not create a checkpoint (${error instanceof Error ? error.message : String(error)})`;
  }
}

function display(context: ToolContext, absolute: string): string {
  return context.paths.relative(absolute) || ".";
}

const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the workspace. Supports 1-based line offsets and line limits. Use this before editing a file.",
  permission: "read",
  parameters: z.object({
    path: z.string().min(1).describe("File path relative to the workspace"),
    offset: z.number().int().min(1).optional().describe("First line to read (1-based)"),
    limit: z.number().int().min(1).max(20_000).optional().describe("Maximum number of lines (default 2000)"),
  }),
  describe: (input) => ({ summary: `Read ${input.path}` }),
  async execute(input, context) {
    const absolute = await context.paths.resolveSafe(input.path);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) return fail(`${input.path} is a directory. Use list_directory instead.`);
    const loaded = await readTextWithMeta(absolute);
    if (loaded.binary) return fail(`${input.path} appears to be a binary file (${formatBytes(loaded.bytes)}).`);
    const lines = splitFileLines(loaded.text);
    const offset = input.offset ?? 1;
    if (offset > Math.max(1, lines.length)) {
      return fail(`Offset ${offset} is beyond the end of the file (${lines.length} lines).`);
    }
    const limit = input.limit ?? 2000;
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const total = lines.length;
    const end = offset + selected.length - 1;
    const header = `File: ${input.path} (${total} lines, ${formatBytes(loaded.bytes)})`;
    const range = offset > 1 || end < total ? `\n[lines ${offset}-${end} of ${total}]` : "";
    const body = selected.join("\n");
    const output = `${header}${range}\n${body}${body.endsWith("\n") ? "" : "\n"}`;
    return ok(output, { path: input.path, lines: selected.length, totalLines: total, offset });
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a text file inside the workspace. Preserves existing line endings and UTF-8 BOM. Prefer edit_file for small changes.",
  permission: "write",
  parameters: z.object({
    path: z.string().min(1).describe("File path relative to the workspace"),
    content: z.string().describe("Complete new file content"),
    create_directories: z.boolean().optional().describe("Create missing parent directories (default true)"),
  }),
  describe: (input) => ({ summary: `Write ${input.path} (${input.content.length} chars)` }),
  async execute(input, context) {
    const absolute = await context.paths.resolveSafe(input.path);
    const directory = path.dirname(absolute);
    if (input.create_directories !== false) await fs.mkdir(directory, { recursive: true });
    else {
      const parentStat = await fs.stat(directory).catch(() => undefined);
      if (!parentStat?.isDirectory()) return fail(`Parent directory does not exist: ${display(context, directory)}`);
    }

    const existing = await fs.stat(absolute).catch(() => undefined);
    if (existing?.isDirectory()) return fail(`${input.path} is a directory.`);

    let diffNote = "";
    let meta;
    if (existing?.isFile()) {
      try {
        const loaded = await readTextWithMeta(absolute);
        if (!loaded.binary) {
          meta = loaded.meta;
          const diff = diffLines(loaded.text, input.content);
          diffNote = diff.changed ? ` (${diffStat(diff)})` : " (unchanged)";
        }
      } catch {
        // Existing file unreadable; overwrite without diff metadata.
      }
    }

    const checkpoint = await captureBeforeChange(context, [absolute], "write_file");
    const { bytes } = await writeTextPreserving(absolute, input.content, meta);
    return ok(
      `Wrote ${formatBytes(bytes)} to ${input.path}${diffNote}${checkpoint}`,
      { path: input.path, bytes, created: !existing },
    );
  },
});

const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a text file. The old string must match uniquely unless replace_all is true. Read the file first so the match is exact.",
  permission: "write",
  parameters: z.object({
    path: z.string().min(1).describe("File path relative to the workspace"),
    old_string: z.string().min(1).describe("Exact existing text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring uniqueness"),
  }),
  describe: (input) => ({ summary: `Edit ${input.path}` }),
  async execute(input, context) {
    const absolute = await context.paths.resolveSafe(input.path);
    const loaded = await readTextWithMeta(absolute);
    if (loaded.binary) return fail(`${input.path} is a binary file.`);
    if (input.old_string === input.new_string) return fail("old_string and new_string are identical; nothing to do.");

    const occurrences = countOccurrences(loaded.text, input.old_string);
    if (occurrences === 0) {
      return fail(
        `old_string was not found in ${input.path}. Re-read the file and use an exact snippet (including whitespace).`,
      );
    }
    if (occurrences > 1 && !input.replace_all) {
      return fail(
        `old_string occurs ${occurrences} times in ${input.path}. Provide more surrounding context or set replace_all=true.`,
      );
    }

    const next = input.replace_all
      ? loaded.text.split(input.old_string).join(input.new_string)
      : loaded.text.replace(input.old_string, input.new_string);
    const diff = diffLines(loaded.text, next);
    const checkpoint = await captureBeforeChange(context, [absolute], "edit_file");
    await writeTextPreserving(absolute, next, loaded.meta);
    const diffPreview = truncate(diff.text, 4000, "\n… diff truncated");
    return ok(
      `Edited ${input.path} (${diffStat(diff)}, ${occurrences} replacement${occurrences === 1 ? "" : "s"})${checkpoint}\n${diffPreview}`,
      { path: input.path, additions: diff.additions, deletions: diff.deletions, diff: diff.text },
    );
  },
});

const deleteFileTool = defineTool({
  name: "delete_file",
  description:
    "Delete a file, or a directory with recursive=true. This is destructive and always requires explicit approval unless allowlisted.",
  permission: "sensitive",
  parameters: z.object({
    path: z.string().min(1),
    recursive: z.boolean().optional().describe("Required for directories"),
  }),
  describe: (input) => ({
    summary: `Delete ${input.path}${input.recursive ? " (recursive)" : ""}`,
    requiresApproval: true,
    risk: "high",
  }),
  async execute(input, context) {
    const absolute = await context.paths.resolveSafe(input.path);
    if (absolute === context.paths.root) return fail("Refusing to delete the workspace root.");
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory() && !input.recursive) {
      return fail(`${input.path} is a directory; pass recursive=true to delete it.`);
    }
    const checkpoint = await captureBeforeChange(context, [absolute], "delete_file");
    await fs.rm(absolute, { recursive: input.recursive ?? false, force: false });
    return ok(`Deleted ${input.path}${checkpoint}`, { path: input.path });
  },
});

const createDirectoryTool = defineTool({
  name: "create_directory",
  description: "Create a directory (and any missing parents) inside the workspace.",
  permission: "write",
  parameters: z.object({ path: z.string().min(1) }),
  describe: (input) => ({ summary: `Create directory ${input.path}` }),
  async execute(input, context) {
    const absolute = await context.paths.resolveSafe(input.path);
    const stat = await fs.stat(absolute).catch(() => undefined);
    if (stat?.isDirectory()) return ok(`Directory already exists: ${input.path}`);
    if (stat) return fail(`${input.path} already exists and is not a directory.`);
    await fs.mkdir(absolute, { recursive: true });
    return ok(`Created directory ${input.path}`, { path: input.path });
  },
});

const listDirectoryTool = defineTool({
  name: "list_directory",
  description: "List the immediate contents of a directory with sizes and modification times.",
  permission: "read",
  parameters: z.object({
    path: z.string().optional().describe("Directory path (default: workspace root)"),
    include_hidden: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: `List ${input.path ?? "."}` }),
  async execute(input, context) {
    const absolute = input.path ? await context.paths.resolveSafe(input.path) : context.paths.root;
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) return fail(`${input.path} is not a directory.`);
    const entries = await listDir(absolute);
    const filtered = input.include_hidden ? entries : entries.filter((entry) => !entry.name.startsWith("."));
    if (filtered.length === 0) return ok(`Directory ${input.path ?? "."} is empty.`, []);
    const lines = filtered.map((entry) =>
      entry.isDirectory
        ? `[dir]  ${entry.name}/`
        : `[file] ${entry.name}\t${formatBytes(entry.size)}`,
    );
    return ok(
      `Directory: ${input.path ?? "."} (${filtered.length} entries)\n${lines.join("\n")}`,
      filtered,
    );
  },
});

const searchFilesTool = defineTool({
  name: "search_files",
  description:
    "Find files by glob pattern (supports *, **, ?, {a,b}). Examples: 'src/**/*.ts', '*.json'. Skips node_modules and build output.",
  permission: "read",
  parameters: z.object({
    pattern: z.string().min(1),
    path: z.string().optional().describe("Directory to search (default: workspace root)"),
    max_results: z.number().int().min(1).max(2000).optional(),
    include_hidden: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: `Find files matching ${input.pattern}` }),
  async execute(input, context) {
    const base = input.path ? await context.paths.resolveSafe(input.path) : context.paths.root;
    const files = await walkFiles(base, { maxFiles: 20_000, includeHidden: input.include_hidden ?? false });
    const max = input.max_results ?? 200;
    const matches = files
      .filter((file) =>
        matchGlob(file.relativePath, input.pattern) ||
        (!input.pattern.includes("/") && matchGlob(path.basename(file.relativePath), input.pattern)),
      )
      .slice(0, max);
    if (matches.length === 0) return ok(`No files matched "${input.pattern}" under ${input.path ?? "."}.`, []);
    return ok(
      `${matches.length} file(s) matched "${input.pattern}":\n${matches
        .map((file) => `${file.relativePath}\t${formatBytes(file.size)}`)
        .join("\n")}`,
      matches.map((file) => file.relativePath),
    );
  },
});

function buildSearchRegex(query: string, options: { isRegex?: boolean; caseSensitive?: boolean; word?: boolean }): RegExp {
  const source = options.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wrapped = options.word ? `\\b${source}\\b` : source;
  return new RegExp(wrapped, options.caseSensitive ? "" : "i");
}

async function searchContent(
  context: ToolContext,
  options: {
    query: string;
    path?: string;
    glob?: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    word?: boolean;
    maxResults: number;
  },
): Promise<{ matches: Array<{ file: string; line: number; text: string }>; filesSearched: number; truncated: boolean }> {
  const base = options.path ? await context.paths.resolveSafe(options.path) : context.paths.root;
  const stat = await fs.stat(base);
  const regex = buildSearchRegex(options.query, options);
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let filesSearched = 0;
  let truncated = false;

  const files = stat.isDirectory()
    ? await walkFiles(base, { maxFiles: 20_000 })
    : [{ path: base, relativePath: context.paths.relative(base), size: stat.size, modifiedMs: stat.mtimeMs }];

  for (const file of files) {
    if (matches.length >= options.maxResults) {
      truncated = true;
      break;
    }
    if (file.size > MAX_SEARCH_FILE_BYTES) continue;
    if (options.glob && !matchGlob(context.paths.relative(file.path), options.glob)) continue;
    let content: string;
    try {
      content = await fs.readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;
    filesSearched++;
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (regex.test(line)) {
        matches.push({
          file: context.paths.relative(file.path),
          line: index + 1,
          text: truncate(line.trim(), 300),
        });
        if (matches.length >= options.maxResults) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { matches, filesSearched, truncated };
}

const searchContentTool = defineTool({
  name: "search_content",
  description:
    "Search file contents with a plain-text or regular-expression query. Returns file, line number and matching line. Skips binary and very large files.",
  permission: "read",
  parameters: z.object({
    query: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional().describe("Only search files matching this glob"),
    is_regex: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    max_results: z.number().int().min(1).max(1000).optional(),
  }),
  describe: (input) => ({ summary: `Search content for "${truncate(input.query, 60)}"` }),
  async execute(input, context) {
    let result;
    try {
      result = await searchContent(context, {
        query: input.query,
        path: input.path,
        glob: input.glob,
        isRegex: input.is_regex,
        caseSensitive: input.case_sensitive,
        maxResults: input.max_results ?? 200,
      });
    } catch (error) {
      return errorResult(error);
    }
    if (result.matches.length === 0) {
      return ok(`No matches for "${input.query}" (searched ${result.filesSearched} files).`, []);
    }
    const lines = result.matches.map((match) => `${match.file}:${match.line}: ${match.text}`);
    const suffix = result.truncated ? "\n(results truncated)" : "";
    return ok(
      `${result.matches.length} match(es) in ${result.filesSearched} file(s):\n${lines.join("\n")}${suffix}`,
      result.matches,
    );
  },
});

const findReferencesTool = defineTool({
  name: "find_references",
  description: "Find word-boundary references to a symbol across workspace source files.",
  permission: "read",
  parameters: z.object({
    symbol: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    max_results: z.number().int().min(1).max(1000).optional(),
  }),
  describe: (input) => ({ summary: `Find references to ${input.symbol}` }),
  async execute(input, context) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$.:-]*$/.test(input.symbol)) {
      return fail("Symbol must be a valid identifier (letters, digits, _, $, :, ., -).");
    }
    let result;
    try {
      result = await searchContent(context, {
        query: input.symbol,
        path: input.path,
        glob: input.glob,
        word: true,
        caseSensitive: true,
        maxResults: input.max_results ?? 200,
      });
    } catch (error) {
      return errorResult(error);
    }
    if (result.matches.length === 0) return ok(`No references to "${input.symbol}" found.`, []);
    return ok(
      `${result.matches.length} reference(s) to "${input.symbol}":\n${result.matches
        .map((match) => `${match.file}:${match.line}: ${match.text}`)
        .join("\n")}`,
      result.matches,
    );
  },
});

const moveFileTool = defineTool({
  name: "move_file",
  description: "Move or rename a file or directory inside the workspace.",
  permission: "write",
  parameters: z.object({
    source: z.string().min(1),
    destination: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: `Move ${input.source} → ${input.destination}` }),
  async execute(input, context) {
    const source = await context.paths.resolveSafe(input.source);
    const destination = await context.paths.resolveSafe(input.destination);
    const sourceStat = await fs.stat(source);
    const destStat = await fs.stat(destination).catch(() => undefined);
    if (destStat && !input.overwrite) {
      return fail(`Destination already exists: ${input.destination}. Pass overwrite=true to replace it.`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const checkpoint = await captureBeforeChange(
      context,
      destStat ? [source, destination] : [source],
      "move_file",
    );
    try {
      if (destStat) await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") throw error;
      await fs.cp(source, destination, { recursive: true, force: true });
      await fs.rm(source, { recursive: true, force: true });
    }
    return ok(`Moved ${input.source} → ${input.destination}${checkpoint}`, {
      source: input.source,
      destination: input.destination,
      directory: sourceStat.isDirectory(),
    });
  },
});

const copyFileTool = defineTool({
  name: "copy_file",
  description: "Copy a file or directory inside the workspace.",
  permission: "write",
  parameters: z.object({
    source: z.string().min(1),
    destination: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  describe: (input) => ({ summary: `Copy ${input.source} → ${input.destination}` }),
  async execute(input, context) {
    const source = await context.paths.resolveSafe(input.source);
    const destination = await context.paths.resolveSafe(input.destination);
    const destStat = await fs.stat(destination).catch(() => undefined);
    if (destStat && !input.overwrite) {
      return fail(`Destination already exists: ${input.destination}. Pass overwrite=true to replace it.`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const checkpoint = await captureBeforeChange(context, [destination], "copy_file");
    await fs.cp(source, destination, {
      recursive: true,
      force: input.overwrite ?? false,
      errorOnExist: !input.overwrite,
    });
    return ok(`Copied ${input.source} → ${input.destination}${checkpoint}`);
  },
});

export const fileTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  createDirectoryTool,
  listDirectoryTool,
  searchFilesTool,
  searchContentTool,
  findReferencesTool,
  moveFileTool,
  copyFileTool,
];
