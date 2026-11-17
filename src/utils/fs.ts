import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Expand a leading `~` or `~/` using the current user's home directory. */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Heuristic for remote repository URLs. Accepts http(s), ssh (`ssh://`),
 * scp-like (`git@host:path`) and `git://` forms. Local filesystem paths and
 * `file:` URLs are rejected so callers can require a remote source explicitly.
 */
export function isProbablyUrl(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  if (/^(https?|ssh|git):\/\//i.test(value)) return true;
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(value)) return true;
  return false;
}

export type ReadTextOptions = {
  maxBytes?: number;
  encoding?: BufferEncoding;
};

export type ReadTextResult = {
  text: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
};

/** Detect binary content using a NUL byte heuristic on the first 8 KiB. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export async function readTextFile(
  filePath: string,
  options: ReadTextOptions = {},
): Promise<ReadTextResult> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const length = Math.min(stat.size, maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const data = buffer.subarray(0, bytesRead);
    const binary = looksBinary(data);
    return {
      text: binary ? "" : data.toString(options.encoding ?? "utf8"),
      bytes: stat.size,
      truncated: stat.size > bytesRead,
      binary,
    };
  } finally {
    await handle.close();
  }
}

/** Atomically write a file: write to a sibling temp file, then rename. */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode: options.mode ?? 0o644 });
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (options.mode !== undefined) {
    await fs.chmod(filePath, options.mode).catch(() => undefined);
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function writeJson(filePath: string, value: unknown, mode?: number): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : {});
}

export async function removeFile(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function listDir(dir: string): Promise<
  Array<{ name: string; isDirectory: boolean; isFile: boolean; size: number; modifiedMs: number }>
> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    let size = 0;
    let modifiedMs = 0;
    try {
      const stat = await fs.stat(path.join(dir, entry.name));
      size = stat.size;
      modifiedMs = stat.mtimeMs;
    } catch {
      // Broken symlink or race; keep the entry with defaults.
    }
    result.push({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      size,
      modifiedMs,
    });
  }
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

export function uniquePath(base: string, suffix: string): string {
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  return path.join(dir, `${stem}${suffix}${ext}`);
}
