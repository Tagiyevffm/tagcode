import { promises as fs } from "node:fs";
import path from "node:path";
import { isPathInside } from "../security/paths.js";
import { newCheckpointId } from "../utils/id.js";
import { ensureDir, readJson, writeJson } from "../utils/fs.js";
import { projectCheckpointsDir } from "../config/paths.js";

export type CheckpointFile = {
  relativePath: string;
  existed: boolean;
  isDirectory?: boolean;
  backup?: string;
  skipped?: boolean;
};

export type CheckpointMeta = {
  id: string;
  createdAt: string;
  reason: string;
  sessionId: string;
  files: CheckpointFile[];
  warnings: string[];
};

export type RestoreResult = {
  checkpoint: CheckpointMeta;
  restored: string[];
  warnings: string[];
};

type Stacks = { undo: string[]; redo: string[] };

const MAX_BACKUP_FILES = 1_000;
const MAX_CHECKPOINTS = 100;

async function countFiles(dir: string, limit: number): Promise<number> {
  let count = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
      else if (entry.isFile()) {
        count++;
        if (count > limit) return count;
      }
    }
  }
  return count;
}

/**
 * File-level snapshots stored inside `.tagcode/checkpoints`.
 * Supports undo/redo through persisted stacks.
 */
export class CheckpointManager {
  readonly directory: string;
  private readonly workspace: string;
  private readonly sessionId: string;

  constructor(options: { workspace: string; projectRoot: string; sessionId: string; directory?: string }) {
    this.workspace = path.resolve(options.workspace);
    this.sessionId = options.sessionId;
    this.directory = options.directory ?? projectCheckpointsDir(options.projectRoot);
  }

  async capture(paths: string[], reason: string): Promise<string | undefined> {
    return this.captureInternal(paths, reason, true);
  }

  private async captureInternal(paths: string[], reason: string, track: boolean): Promise<string | undefined> {
    const unique = [...new Set(paths.map((entry) => path.resolve(entry)))].filter((entry) =>
      isPathInside(this.workspace, entry),
    );
    if (unique.length === 0) return undefined;

    const id = newCheckpointId();
    const checkpointDir = path.join(this.directory, id);
    await ensureDir(path.join(checkpointDir, "files"));
    const files: CheckpointFile[] = [];
    const warnings: string[] = [];

    for (const target of unique) {
      const relativePath = path.relative(this.workspace, target).split(path.sep).join("/");
      const stat = await fs.lstat(target).catch(() => undefined);
      if (!stat) {
        files.push({ relativePath, existed: false });
        continue;
      }
      if (stat.isSymbolicLink()) {
        files.push({ relativePath, existed: true, skipped: true });
        warnings.push(`Skipped symlink ${relativePath}`);
        continue;
      }
      if (stat.isDirectory()) {
        const count = await countFiles(target, MAX_BACKUP_FILES);
        if (count > MAX_BACKUP_FILES) {
          files.push({ relativePath, existed: true, isDirectory: true, skipped: true });
          warnings.push(`Directory ${relativePath} has more than ${MAX_BACKUP_FILES} files and was not backed up`);
          continue;
        }
        const backupRel = `files/${files.length}`;
        await fs.cp(target, path.join(checkpointDir, backupRel), { recursive: true });
        files.push({ relativePath, existed: true, isDirectory: true, backup: backupRel });
        continue;
      }
      if (!stat.isFile()) {
        files.push({ relativePath, existed: true, skipped: true });
        warnings.push(`Skipped unsupported file type: ${relativePath}`);
        continue;
      }
      const backupRel = `files/${files.length}`;
      await fs.copyFile(target, path.join(checkpointDir, backupRel));
      files.push({ relativePath, existed: true, backup: backupRel });
    }

    const meta: CheckpointMeta = {
      id,
      createdAt: new Date().toISOString(),
      reason,
      sessionId: this.sessionId,
      files,
      warnings,
    };
    await writeJson(path.join(checkpointDir, "manifest.json"), meta);

    if (track) {
      const stacks = await this.readStacks();
      stacks.undo.push(id);
      stacks.redo = [];
      await this.writeStacks(stacks);
      await this.prune(stacks);
    }
    return id;
  }

  async list(limit = 20): Promise<CheckpointMeta[]> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    const metas: CheckpointMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readJson<CheckpointMeta | undefined>(
        path.join(this.directory, entry.name, "manifest.json"),
        undefined,
      );
      if (meta?.id) metas.push(meta);
    }
    return metas
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async get(id: string): Promise<CheckpointMeta | undefined> {
    if (!/^cp_[a-z0-9]+$/.test(id)) return undefined;
    return readJson<CheckpointMeta | undefined>(
      path.join(this.directory, id, "manifest.json"),
      undefined,
    );
  }

  async restore(id: string): Promise<RestoreResult> {
    const meta = await this.get(id);
    if (!meta) throw new Error(`Checkpoint not found: ${id}`);
    const restored: string[] = [];
    const warnings = [...meta.warnings];

    for (const file of meta.files) {
      const absolute = path.resolve(this.workspace, file.relativePath);
      if (!isPathInside(this.workspace, absolute)) {
        warnings.push(`Refused to restore outside the workspace: ${file.relativePath}`);
        continue;
      }
      if (file.skipped) {
        warnings.push(`Skipped restoration of ${file.relativePath} (not backed up)`);
        continue;
      }
      if (!file.existed) {
        await fs.rm(absolute, { recursive: true, force: true });
        restored.push(file.relativePath);
        continue;
      }
      if (!file.backup) continue;
      const backup = path.join(this.directory, id, file.backup);
      await fs.rm(absolute, { recursive: true, force: true });
      await ensureDir(path.dirname(absolute));
      if (file.isDirectory) await fs.cp(backup, absolute, { recursive: true });
      else await fs.copyFile(backup, absolute);
      restored.push(file.relativePath);
    }
    return { checkpoint: meta, restored, warnings };
  }

  async undo(): Promise<RestoreResult | undefined> {
    const stacks = await this.readStacks();
    const id = stacks.undo.pop();
    if (!id) return undefined;
    const meta = await this.get(id);
    if (!meta) {
      await this.writeStacks(stacks);
      return undefined;
    }
    const safeId = await this.captureInternal(
      meta.files.map((file) => path.resolve(this.workspace, file.relativePath)),
      `before undo ${id}`,
      false,
    );
    if (safeId) stacks.redo.push(safeId);
    await this.writeStacks(stacks);
    return this.restore(id);
  }

  async redo(): Promise<RestoreResult | undefined> {
    const stacks = await this.readStacks();
    const id = stacks.redo.pop();
    if (!id) return undefined;
    const meta = await this.get(id);
    if (!meta) {
      await this.writeStacks(stacks);
      return undefined;
    }
    const safeId = await this.captureInternal(
      meta.files.map((file) => path.resolve(this.workspace, file.relativePath)),
      `before redo ${id}`,
      false,
    );
    if (safeId) stacks.undo.push(safeId);
    await this.writeStacks(stacks);
    return this.restore(id);
  }

  private stacksPath(): string {
    return path.join(this.directory, "stacks.json");
  }

  private async readStacks(): Promise<Stacks> {
    const stacks = await readJson<Stacks>(this.stacksPath(), { undo: [], redo: [] });
    return { undo: stacks.undo ?? [], redo: stacks.redo ?? [] };
  }

  private async writeStacks(stacks: Stacks): Promise<void> {
    await writeJson(this.stacksPath(), stacks);
  }

  private async prune(stacks: Stacks): Promise<void> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    const ids = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("cp_"))
      .map((entry) => entry.name)
      .sort();
    if (ids.length <= MAX_CHECKPOINTS) return;
    const protectedIds = new Set([...stacks.undo, ...stacks.redo]);
    const excess = ids.slice(0, ids.length - MAX_CHECKPOINTS);
    for (const id of excess) {
      if (protectedIds.has(id)) continue;
      await fs.rm(path.join(this.directory, id), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
