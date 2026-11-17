import type { AgentMode, PermissionMode, ToolPermission } from "../core/types.js";

/**
 * TagCode visual identity: near-black surfaces, warm amber accent, restrained
 * status colors and a single hairline border tone.
 */
export const palette = {
  background: "#0B0C0E",
  surface: "#111318",
  surfaceRaised: "#171A20",
  accent: "#F59E0B",
  success: "#22C55E",
  error: "#EF4444",
  border: "#292D34",
  borderStrong: "#3A404A",
  text: "#E6E8EB",
  muted: "#8A919E",
  faint: "#5B6270",
  info: "#60A5FA",
} as const;

export function modeColor(mode: AgentMode): string {
  if (mode === "plan") return palette.info;
  if (mode === "ask") return palette.success;
  return palette.accent;
}

export function modeLabel(mode: AgentMode): string {
  return mode.toUpperCase();
}

export function permissionColor(mode: PermissionMode): string {
  switch (mode) {
    case "yolo":
      return palette.error;
    case "ask":
      return palette.accent;
    case "plan":
      return palette.info;
    default:
      return palette.success;
  }
}

export function permissionWarning(mode: PermissionMode): string | undefined {
  if (mode === "yolo") {
    return "YOLO: approval prompts are disabled. Destructive commands can run without confirmation.";
  }
  if (mode === "plan") return "Read-only: writes and commands are blocked.";
  return undefined;
}

export function toolColor(permission: ToolPermission | undefined): string {
  switch (permission) {
    case "read":
      return palette.info;
    case "write":
      return palette.accent;
    case "execute":
      return palette.accent;
    case "network":
      return palette.info;
    case "sensitive":
      return palette.error;
    default:
      return palette.muted;
  }
}

export function riskColor(risk: "low" | "medium" | "high" | undefined): string {
  if (risk === "high") return palette.error;
  if (risk === "medium") return palette.accent;
  return palette.success;
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 3) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Keep only the newest `maxLines` lines while noting what was hidden. */
export function tailLines(text: string, maxLines: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, hidden: 0 };
  const hidden = lines.length - maxLines;
  return { text: lines.slice(lines.length - maxLines).join("\n"), hidden };
}
