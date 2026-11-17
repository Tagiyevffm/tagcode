import { promises as fs } from "node:fs";
import { looksBinary } from "./fs.js";

export type TextMeta = {
  bom: boolean;
  eol: "\n" | "\r\n";
  encoding: "utf8";
};

export const UTF8_BOM = "\uFEFF";

export function detectMeta(buffer: Buffer): TextMeta {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = buffer.toString("utf8");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return { bom, eol: crlf > lf ? "\r\n" : "\n", encoding: "utf8" };
}

export function normalizeEol(text: string, eol: "\n" | "\r\n"): string {
  const unified = text.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? unified.replace(/\n/g, "\r\n") : unified;
}

export type ReadTextMetaResult = {
  text: string;
  meta: TextMeta;
  bytes: number;
  lineCount: number;
  binary: boolean;
  truncated: boolean;
};

export async function readTextWithMeta(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<ReadTextMetaResult> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  if (stat.size > maxBytes) {
    throw new Error(
      `File is too large to read (${stat.size} bytes, limit ${maxBytes}). Use search_content or offset-based tooling.`,
    );
  }
  const buffer = await fs.readFile(filePath);
  if (looksBinary(buffer)) {
    return {
      text: "",
      meta: { bom: false, eol: "\n", encoding: "utf8" },
      bytes: stat.size,
      lineCount: 0,
      binary: true,
      truncated: false,
    };
  }
  const meta = detectMeta(buffer);
  let text = buffer.toString("utf8");
  if (meta.bom) text = text.replace(/^\uFEFF/, "");
  const lineCount = text.length === 0 ? 0 : text.replace(/\r\n/g, "\n").split("\n").length;
  return { text, meta, bytes: stat.size, lineCount, binary: false, truncated: false };
}

export async function writeTextPreserving(
  filePath: string,
  content: string,
  existing?: TextMeta,
): Promise<{ bytes: number }> {
  const eol = existing?.eol ?? "\n";
  const normalized = normalizeEol(content, eol);
  const output = existing?.bom ? UTF8_BOM + normalized : normalized;
  await fs.writeFile(filePath, output, "utf8");
  return { bytes: Buffer.byteLength(output, "utf8") };
}

/** Split text into lines without losing the information about a trailing newline. */
export function splitFileLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
