import type { ToolRegistry } from "./registry.js";
import { fileTools } from "./fs.js";
import { terminalTools } from "./terminal.js";
import { gitTools } from "./git.js";
import { analysisTools } from "./analysis.js";
import { webTools } from "./web.js";
import { miscTools } from "./misc.js";

/** Register every built-in tool. MCP and plugin tools are added separately. */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.registerAll([
    ...fileTools,
    ...terminalTools,
    ...gitTools,
    ...analysisTools,
    ...webTools,
    ...miscTools,
  ]);
}

export { ToolRegistry } from "./registry.js";
export * from "./types.js";
