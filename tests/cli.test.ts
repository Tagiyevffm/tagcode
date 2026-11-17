import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/index.js";

describe("CLI surface", () => {
  it("registers the documented commands", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    for (const expected of [
      "app",
      "tui",
      "run",
      "init",
      "doctor",
      "connect",
      "disconnect",
      "model",
      "models",
      "config",
      "mcp",
      "skills",
      "session",
      "plugins",
      "tools",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("defines global options and a version", () => {
    const program = buildProgram();
    const flags = program.options.map((option) => option.long);
    expect(flags).toContain("--version");
    expect(flags).toContain("--cwd");
    expect(flags).toContain("--provider");
    expect(flags).toContain("--model");
    expect(flags).toContain("--mode");
    expect(flags).toContain("--permission");
    expect(flags).toContain("--no-mcp");
    expect(flags).toContain("--no-plugins");
  });

  it("advertises options for run and mcp", () => {
    const program = buildProgram();
    const run = program.commands.find((command) => command.name() === "run");
    const runFlags = run?.options.map((option) => option.long) ?? [];
    expect(runFlags).toEqual(
      expect.arrayContaining(["--json", "--yes", "--quiet", "--show-reasoning"]),
    );

    const mcp = program.commands.find((command) => command.name() === "mcp");
    expect(mcp?.usage()).toContain("action");
  });
});
