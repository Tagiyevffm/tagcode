import { runProcess, type ProcessResult } from "../tools/terminal.js";

export async function runGit(
  workspace: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return runProcess({
    file: "git",
    args,
    cwd: workspace,
    timeoutMs,
    signal: AbortSignal.timeout(timeoutMs + 1_000),
    maxOutputChars: 50_000,
  });
}

export async function isGitRepository(workspace: string): Promise<boolean> {
  const result = await runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function currentBranch(workspace: string): Promise<string | undefined> {
  const result = await runGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.code !== 0) return undefined;
  const branch = result.stdout.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

export async function gitStatusPorcelain(workspace: string): Promise<string> {
  const result = await runGit(workspace, ["status", "--porcelain=v1", "--branch"]);
  return result.code === 0 ? result.stdout.trim() : result.stderr.trim();
}

export async function gitDiff(workspace: string, staged = false): Promise<string> {
  const args = ["diff"];
  if (staged) args.push("--cached");
  const result = await runGit(workspace, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  return result.stdout;
}

export async function gitDiffStat(workspace: string): Promise<string> {
  const result = await runGit(workspace, ["diff", "--stat"]);
  return result.code === 0 ? result.stdout.trim() : "";
}
