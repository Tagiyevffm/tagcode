import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import { fileTools } from "../src/tools/fs.js";
import { diffLines } from "../src/utils/diff.js";
import { readTextWithMeta } from "../src/utils/textFile.js";
import { makeTempDir, makeToolContext, removeDir } from "./helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  while (temporary.length > 0) await removeDir(temporary.pop()!);
});

async function setup() {
  const workspace = await makeTempDir();
  temporary.push(workspace);
  const registry = new ToolRegistry();
  registry.registerAll(fileTools);
  const { context, checkpoints, permissions } = await makeToolContext({ workspace });
  permissions.setBroker(async () => ({ approved: true, remember: true }));
  return { workspace, registry, context, checkpoints };
}

describe("filesystem tools", () => {
  it("writes, reads, edits and deletes files", async () => {
    const { registry, context } = await setup();

    const write = await registry.execute("write_file", { path: "src/app.ts", content: "hello\nworld\n" }, context);
    expect(write.ok).toBe(true);
    expect(write.output).toContain("src/app.ts");

    const read = await registry.execute("read_file", { path: "src/app.ts" }, context);
    expect(read.ok).toBe(true);
    expect(read.output).toContain("hello");

    const edit = await registry.execute(
      "edit_file",
      { path: "src/app.ts", old_string: "world", new_string: "tagcode" },
      context,
    );
    expect(edit.ok).toBe(true);
    expect(edit.data).toMatchObject({ additions: 1, deletions: 1 });

    const search = await registry.execute("search_content", { query: "tagcode", path: "." }, context);
    expect(search.ok).toBe(true);
    expect(search.output).toContain("src/app.ts");

    const remove = await registry.execute("delete_file", { path: "src/app.ts" }, context);
    expect(remove.ok).toBe(true);
    await expect(fs.stat(path.join(context.workspace, "src/app.ts"))).rejects.toThrow();
  });

  it("rejects edits that are ambiguous or missing", async () => {
    const { registry, context } = await setup();
    await registry.execute("write_file", { path: "a.txt", content: "same same" }, context);
    const ambiguous = await registry.execute(
      "edit_file",
      { path: "a.txt", old_string: "same", new_string: "other" },
      context,
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.output).toContain("occurs 2 times");

    const missing = await registry.execute(
      "edit_file",
      { path: "a.txt", old_string: "absent", new_string: "other" },
      context,
    );
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("not found");
  });

  it("prevents path traversal and absolute escapes", async () => {
    const { registry, context } = await setup();
    const traversal = await registry.execute(
      "write_file",
      { path: "../escaped.txt", content: "no" },
      context,
    );
    expect(traversal.ok).toBe(false);
    expect(traversal.output).toMatch(/outside the workspace/i);

    const absolute = await registry.execute(
      "read_file",
      { path: path.join(context.workspace, "..", "outside.txt") },
      context,
    );
    expect(absolute.ok).toBe(false);
  });

  it("captures a checkpoint before writes", async () => {
    const { registry, context, checkpoints } = await setup();
    await registry.execute("write_file", { path: "note.txt", content: "first" }, context);
    expect(checkpoints.some((entry) => entry.reason === "write_file")).toBe(true);
    expect(checkpoints.at(-1)?.paths[0]).toBe(path.join(context.workspace, "note.txt"));
  });

  it("preserves CRLF line endings and BOM", async () => {
    const { registry, context, workspace } = await setup();
    const target = path.join(workspace, "crlf.txt");
    await fs.writeFile(target, "\uFEFFone\r\ntwo\r\n", "utf8");
    const edit = await registry.execute(
      "edit_file",
      { path: "crlf.txt", old_string: "two", new_string: "three" },
      context,
    );
    expect(edit.ok).toBe(true);
    const loaded = await readTextWithMeta(target);
    expect(loaded.text).toBe("one\r\nthree\r\n");
    expect(loaded.meta.bom).toBe(true);
    expect(loaded.meta.eol).toBe("\r\n");
  });

  it("lists directories and finds files by glob", async () => {
    const { registry, context } = await setup();
    await registry.execute("write_file", { path: "src/a.ts", content: "a" }, context);
    await registry.execute("write_file", { path: "src/b.ts", content: "b" }, context);
    await registry.execute("write_file", { path: "src/c.md", content: "c" }, context);
    const found = await registry.execute("search_files", { pattern: "**/*.ts" }, context);
    expect(found.ok).toBe(true);
    expect(found.output).toContain("src/a.ts");
    expect(found.output).toContain("src/b.ts");
    expect(found.output).not.toContain("src/c.md");
  });
});

describe("diffLines", () => {
  it("returns a unified diff with counts", () => {
    const result = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.text).toContain("-b");
    expect(result.text).toContain("+B");
  });

  it("reports identical input as unchanged", () => {
    expect(diffLines("same\n", "same\n")).toMatchObject({ changed: false, text: "" });
  });
});
