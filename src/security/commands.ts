export type CommandRisk = "safe" | "caution" | "dangerous";

export type CommandClassification = {
  risk: CommandRisk;
  reasons: string[];
  requiresApproval: boolean;
};

type Rule = {
  pattern: RegExp;
  risk: CommandRisk;
  reason: string;
};

/**
 * Command risk classification is intentionally conservative and pattern-based.
 * It is a guard-rail, not a sandbox: the real enforcing boundary is the
 * permission gate + user approval.
 */
const RULES: Rule[] = [
  // Destructive filesystem operations
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$HOME|[a-zA-Z]:[\\/]?)(?:\s|$)/i, risk: "dangerous", reason: "Recursive delete of a root/home path" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(?:\*|\.\s*$|\/)/i, risk: "dangerous", reason: "Recursive delete" },
  { pattern: /\b(?:del|erase)\s+\/[sq]/i, risk: "dangerous", reason: "Recursive Windows delete" },
  { pattern: /\bRemove-Item\b[^\n]*-(?:Recurse|Force)/i, risk: "caution", reason: "Recursive PowerShell delete" },
  { pattern: /\b(?:format|mkfs(?:\.\w+)?|diskpart|fdisk)\b/i, risk: "dangerous", reason: "Disk formatting" },
  { pattern: /\bdd\s+if=.*of=\/dev\//i, risk: "dangerous", reason: "Raw device write" },
  { pattern: />\s*\/dev\/(?:sd|hd|nvme)/i, risk: "dangerous", reason: "Raw device write" },
  // System control
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, risk: "dangerous", reason: "System shutdown" },
  { pattern: /\b(?:reg\s+delete|sc\s+delete|bcdedit|vssadmin)\b/i, risk: "dangerous", reason: "System configuration change" },
  // Git history / remote publishing
  { pattern: /\bgit\s+push\b[^\n]*(?:--force|-f)\b/i, risk: "dangerous", reason: "Force-push rewrites remote history" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, risk: "dangerous", reason: "Discards uncommitted work" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/i, risk: "dangerous", reason: "Deletes untracked files" },
  { pattern: /\bgit\s+(?:push|filter-branch|rebase\s+--root)\b/i, risk: "caution", reason: "Remote or history operation" },
  { pattern: /\b(?:npm|yarn|pnpm)\s+publish\b/i, risk: "dangerous", reason: "Publishes a package publicly" },
  { pattern: /\b(?:pip|poetry|cargo|gem|dotnet)\s+(?:publish|twine\s+upload)\b/i, risk: "dangerous", reason: "Publishes a package publicly" },
  // Remote code execution patterns
  { pattern: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:ba|z|k|fi)?sh\b/i, risk: "dangerous", reason: "Pipes remote content into a shell" },
  { pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:node|python|perl|ruby)\b/i, risk: "dangerous", reason: "Pipes remote content into an interpreter" },
  { pattern: /\b(?:eval|iex)\s*\(/i, risk: "caution", reason: "Dynamic code evaluation" },
  // Databases
  { pattern: /\b(?:drop|truncate)\s+(?:database|table|schema)\b/i, risk: "caution", reason: "Destructive database statement" },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*(?:;|$)/i, risk: "caution", reason: "Unfiltered DELETE statement" },
  // Package installs / network
  { pattern: /\b(?:npm|pnpm|yarn)\s+(?:install|add|i)\b/i, risk: "caution", reason: "Installs dependencies" },
  { pattern: /\b(?:pip|pip3|poetry|uv|conda)\s+(?:install|add)\b/i, risk: "caution", reason: "Installs dependencies" },
  { pattern: /\b(?:cargo|go|dotnet|gem)\s+(?:add|get|install)\b/i, risk: "caution", reason: "Installs dependencies" },
  { pattern: /\b(?:sudo|runas)\b/i, risk: "caution", reason: "Elevated privileges" },
  { pattern: /\b(?:ssh|scp|rsync)\b/i, risk: "caution", reason: "Remote system access" },
  { pattern: /\b(?:chmod|chown)\s+-R\b/i, risk: "caution", reason: "Recursive permission change" },
  { pattern: /\b(?:npm|pnpm|yarn)\s+exec\b|\bnpx\s+/i, risk: "caution", reason: "Executes a downloaded package" },
];

export function classifyCommand(command: string): CommandClassification {
  const reasons: string[] = [];
  let risk: CommandRisk = "safe";
  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      reasons.push(rule.reason);
      if (rule.risk === "dangerous") risk = "dangerous";
      else if (rule.risk === "caution" && risk === "safe") risk = "caution";
    }
  }
  return {
    risk,
    reasons: [...new Set(reasons)],
    requiresApproval: risk !== "safe",
  };
}

/** Heuristic for whether a command can modify the filesystem. */
export function isMutatingCommand(command: string): boolean {
  return /\b(?:rm|del|erase|mkdir|rmdir|mv|move|cp|copy|touch|tee|sed\s+-i|perl\s+-pi|truncate|git\s+(?:add|commit|checkout|reset|clean|merge|rebase)|npm\s+(?:install|uninstall)|pip\s+(?:install|uninstall))\b/i.test(
    command,
  );
}
