export type DiffLine = {
  type: "context" | "added" | "removed";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffResult = {
  changed: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Unified diff text, or an empty string when identical. */
  text: string;
};

/**
 * Compute a line diff using an LCS table. Inputs are capped to avoid
 * quadratic blow-ups on huge files; beyond the cap we fall back to a
 * coarse replacement diff which is still truthful about changes.
 */
export function diffLines(
  before: string,
  after: string,
  options: { context?: number; maxLines?: number } = {},
): DiffResult {
  const context = options.context ?? 3;
  const maxLines = options.maxLines ?? 4000;
  const a = splitLines(before);
  const b = splitLines(after);

  if (before === after) {
    return { changed: false, additions: 0, deletions: 0, hunks: [], text: "" };
  }

  let operations: Array<{ type: "context" | "added" | "removed"; text: string }>;
  if (a.length > maxLines || b.length > maxLines) {
    operations = [
      ...a.map((text) => ({ type: "removed" as const, text })),
      ...b.map((text) => ({ type: "added" as const, text })),
    ];
  } else {
    operations = lcsDiff(a, b);
  }

  const additions = operations.filter((op) => op.type === "added").length;
  const deletions = operations.filter((op) => op.type === "removed").length;
  const numbered = numberLines(operations);
  const hunks = buildHunks(numbered, context);
  const text = formatUnified(hunks);
  return { changed: true, additions, deletions, hunks, text };
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function lcsDiff(
  a: string[],
  b: string[],
): Array<{ type: "context" | "added" | "removed"; text: string }> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Array<{ type: "context" | "added" | "removed"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "removed", text: a[i]! });
      i++;
    } else {
      ops.push({ type: "added", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "removed", text: a[i++]! });
  while (j < m) ops.push({ type: "added", text: b[j++]! });
  return ops;
}

function numberLines(
  operations: Array<{ type: "context" | "added" | "removed"; text: string }>,
): DiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((op) => {
    if (op.type === "context") {
      const line: DiffLine = { type: op.type, text: op.text, oldLine, newLine };
      oldLine++;
      newLine++;
      return line;
    }
    if (op.type === "removed") {
      return { type: op.type, text: op.text, oldLine: oldLine++ };
    }
    return { type: op.type, text: op.text, newLine: newLine++ };
  });
}

function buildHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changedIndexes = lines
    .map((line, index) => (line.type === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1);
    const oldLines = slice.filter((line) => line.type !== "added");
    const newLines = slice.filter((line) => line.type !== "removed");
    return {
      oldStart: oldLines[0]?.oldLine ?? 0,
      oldLines: oldLines.length,
      newStart: newLines[0]?.newLine ?? 0,
      newLines: newLines.length,
      lines: slice,
    };
  });
}

function formatUnified(hunks: DiffHunk[]): string {
  const out: string[] = [];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      out.push(`${prefix}${line.text}`);
    }
  }
  return out.join("\n");
}

/** Compact summary such as `+12 -3`. */
export function diffStat(diff: DiffResult): string {
  if (!diff.changed) return "no changes";
  return `+${diff.additions} -${diff.deletions}`;
}
