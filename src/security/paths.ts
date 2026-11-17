import { promises as fs } from "node:fs";
import path from "node:path";
import { PathOutsideWorkspaceError } from "../core/errors.js";

/**
 * Normalize a path for comparison. Windows filesystems are case-insensitive
 * and may receive either separator.
 */
export function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parent: string, child: string): boolean {
  const parentNorm = normalizeForComparison(parent);
  const childNorm = normalizeForComparison(child);
  if (parentNorm === childNorm) return true;
  const withSeparator = parentNorm.endsWith(path.sep) ? parentNorm : parentNorm + path.sep;
  return childNorm.startsWith(withSeparator);
}

async function realpathBestEffort(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await fs.realpath(resolved);
  } catch {
    // Path does not exist yet: resolve the nearest existing ancestor, then
    // re-append the remaining segments so symlinked parents are still checked.
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    const realParent = await realpathBestEffort(parent);
    return path.join(realParent, path.basename(resolved));
  }
}

/**
 * Confines every tool filesystem operation to the workspace.
 * Resolves symlinks to prevent escaping through a link.
 */
export class WorkspacePaths {
  readonly workspace: string;
  private readonly realWorkspace: string;

  private constructor(workspace: string, realWorkspace: string) {
    this.workspace = workspace;
    this.realWorkspace = realWorkspace;
  }

  static async create(workspace: string): Promise<WorkspacePaths> {
    const resolved = path.resolve(workspace);
    const real = await realpathBestEffort(resolved);
    return new WorkspacePaths(resolved, real);
  }

  /** Resolve `input` relative to the workspace and reject escapes. */
  resolve(input: string): string {
    if (typeof input !== "string" || input.length === 0) {
      throw new PathOutsideWorkspaceError(String(input));
    }
    if (input.includes("\0")) {
      throw new PathOutsideWorkspaceError(input);
    }
    const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.workspace, input);
    if (!isPathInside(this.workspace, absolute) && !isPathInside(this.realWorkspace, absolute)) {
      throw new PathOutsideWorkspaceError(input);
    }
    return absolute;
  }

  /** Async resolution that also validates symlink targets. */
  async resolveSafe(input: string): Promise<string> {
    const absolute = this.resolve(input);
    const real = await realpathBestEffort(absolute);
    if (!isPathInside(this.realWorkspace, real)) {
      throw new PathOutsideWorkspaceError(input);
    }
    return absolute;
  }

  relative(absolute: string): string {
    return path.relative(this.workspace, absolute).split(path.sep).join("/");
  }

  get root(): string {
    return this.workspace;
  }
}

/** Validate that an absolute path stays inside `workspace` (sync helper). */
export function assertInsideWorkspace(workspace: string, target: string): string {
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  if (!isPathInside(workspace, absolute)) {
    throw new PathOutsideWorkspaceError(target);
  }
  return absolute;
}
