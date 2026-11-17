/**
 * Pure text-editing helpers for the terminal input. Kept independent of Ink so
 * they can be unit-tested without a terminal.
 */

export type EditResult = { value: string; cursor: number };

export function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(value.length, cursor));
}

export function insertText(value: string, cursor: number, text: string): EditResult {
  const at = clampCursor(value, cursor);
  const sanitized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  return {
    value: value.slice(0, at) + sanitized + value.slice(at),
    cursor: at + sanitized.length,
  };
}

export function backspace(value: string, cursor: number): EditResult {
  const at = clampCursor(value, cursor);
  if (at === 0) return { value, cursor: at };
  return {
    value: value.slice(0, at - 1) + value.slice(at),
    cursor: at - 1,
  };
}

/** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
export function deleteWordBackward(value: string, cursor: number): EditResult {
  const at = clampCursor(value, cursor);
  if (at === 0) return { value, cursor: at };
  let start = at;
  while (start > 0 && /\s/.test(value[start - 1]!)) start--;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  return { value: value.slice(0, start) + value.slice(at), cursor: start };
}

export function deleteForward(value: string, cursor: number): EditResult {
  const at = clampCursor(value, cursor);
  if (at >= value.length) return { value, cursor: at };
  return { value: value.slice(0, at) + value.slice(at + 1), cursor: at };
}

export function moveLeft(value: string, cursor: number): EditResult {
  return { value, cursor: Math.max(0, clampCursor(value, cursor) - 1) };
}

export function moveRight(value: string, cursor: number): EditResult {
  return { value, cursor: Math.min(value.length, clampCursor(value, cursor) + 1) };
}

function lineStart(value: string, cursor: number): number {
  const at = clampCursor(value, cursor);
  const index = value.lastIndexOf("\n", at - 1);
  return index === -1 ? 0 : index + 1;
}

function lineEnd(value: string, cursor: number): number {
  const at = clampCursor(value, cursor);
  const index = value.indexOf("\n", at);
  return index === -1 ? value.length : index;
}

export function moveLineStart(value: string, cursor: number): EditResult {
  return { value, cursor: lineStart(value, cursor) };
}

export function moveLineEnd(value: string, cursor: number): EditResult {
  return { value, cursor: lineEnd(value, cursor) };
}

export function moveUp(value: string, cursor: number): EditResult {
  const at = clampCursor(value, cursor);
  const start = lineStart(value, at);
  if (start === 0) return { value, cursor: at };
  const column = at - start;
  const previousStart = lineStart(value, start - 1);
  const previousEnd = lineEnd(value, previousStart);
  return { value, cursor: Math.min(previousStart + column, previousEnd) };
}

export function moveDown(value: string, cursor: number): EditResult {
  const at = clampCursor(value, cursor);
  const end = lineEnd(value, at);
  if (end >= value.length) return { value, cursor: at };
  const start = lineStart(value, at);
  const column = at - start;
  const nextStart = end + 1;
  const nextEnd = lineEnd(value, nextStart);
  return { value, cursor: Math.min(nextStart + column, nextEnd) };
}

export function isOnFirstLine(value: string, cursor: number): boolean {
  return lineStart(value, cursor) === 0;
}

export function isOnLastLine(value: string, cursor: number): boolean {
  return lineEnd(value, cursor) === value.length;
}

/**
 * Slice a multi-line value for display. The returned `offset` is the index of
 * the first displayed character so the cursor can be mapped into the slice.
 */
export function visibleLines(
  value: string,
  cursor: number,
  maxLines: number,
): { text: string; offset: number; hidden: number } {
  if (maxLines <= 0) return { text: "", offset: value.length, hidden: 0 };
  const lines = value.split("\n");
  if (lines.length <= maxLines) return { text: value, offset: 0, hidden: 0 };

  const cursorLine = value.slice(0, clampCursor(value, cursor)).split("\n").length - 1;
  let startLine = Math.max(0, lines.length - maxLines);
  if (cursorLine < startLine) startLine = cursorLine;
  if (cursorLine >= startLine + maxLines) startLine = cursorLine - maxLines + 1;
  const preserved = lines.slice(startLine);
  return {
    text: preserved.join("\n"),
    offset: lines.slice(0, startLine).reduce((total, line) => total + line.length + 1, 0),
    hidden: startLine,
  };
}
