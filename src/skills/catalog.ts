import { parseSkillMarkdown } from "./validator.js";

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  tags: string[];
  allowedTools: string[];
  markdown: string;
};

type SkillDefinition = {
  markdown: string;
};

const DEFINITIONS: SkillDefinition[] = [
  {
    markdown: `---
name: code-review
description: Review a diff for correctness, security and missing tests before merging.
version: "1.0.0"
author: TagCode
license: MIT
tags: [review, quality, security]
allowed-tools: [read_file, search_files, git_diff, git_status]
---
# Code Review

Use this skill when the user asks for a review, a pre-merge check or a second pair of eyes.

## Workflow

1. Read the full diff and the surrounding files, not just the changed lines.
2. Check correctness first: edge cases, error handling, async ordering, nullability and resource cleanup.
3. Check security next: untrusted input, path traversal, command injection, secret logging and permission bypasses.
4. Check tests: does the change add or update tests for the new behavior and the failure path?
5. Only then comment on style, naming and structure.

## Output

Group findings by severity: **blocker**, **should fix**, **nit**. For every finding include the file path, the smallest relevant line range and a concrete fix. If the change is sound, say so explicitly and list what you verified. Do not rewrite the whole change unless the user asks for it.
`,
  },
  {
    markdown: `---
name: test-writer
description: Add focused tests that match the project's existing framework and conventions.
version: "1.0.0"
author: TagCode
license: MIT
tags: [testing, quality, vitest]
allowed-tools: [read_file, search_files, write_file, edit_file, shell]
---
# Test Writer

Use this skill when new behavior needs coverage or a bug needs a regression test.

## Workflow

1. Find the existing test framework, helpers and naming conventions; mirror them instead of inventing a new style.
2. Read the implementation and identify the public behavior, the failure path and the boundary conditions.
3. Write the smallest test that would fail before the change and pass after it.
4. Use temporary directories and environment overrides for filesystem or network work. Never touch the real user home.
5. Mock external services with injected fakes instead of calling live APIs.
6. Run the focused test file, then the full suite.

## Rules

- Do not weaken or delete existing assertions to make a suite pass.
- Prefer behavior-level assertions over implementation details.
- One regression test per bug is enough; avoid duplicate cases that exercise the same branch.
`,
  },
  {
    markdown: `---
name: bug-hunt
description: Reproduce a bug, isolate the root cause and apply the smallest correct fix.
version: "1.0.0"
author: TagCode
license: MIT
tags: [debugging, investigation, fix]
allowed-tools: [read_file, search_files, shell, write_file, edit_file]
---
# Bug Hunt

Use this skill for a failing test, a stack trace or a reproducible defect.

## Workflow

1. Restate the expected behavior and the observed behavior in one sentence each.
2. Find the smallest command or test that reproduces the failure.
3. Trace the data flow from the entry point to the failure. Read the actual implementation instead of guessing.
4. State a root cause hypothesis and one cheap experiment that would falsify it.
5. Apply the smallest fix that addresses the cause, not the symptom.
6. Re-run the reproduction and the surrounding tests.

## Rules

- Preserve unrelated behavior and avoid broad refactors during a fix.
- If the cause is outside the workspace or needs a credential, stop and explain the blocker.
- Add a regression test when the project has a test suite.
`,
  },
  {
    markdown: `---
name: security-audit
description: Audit code and configuration for injection, secret exposure and permission bypasses.
version: "1.0.0"
author: TagCode
license: MIT
tags: [security, audit, secrets]
allowed-tools: [read_file, search_files, git_diff, shell]
---
# Security Audit

Use this skill when reviewing authentication, input handling, subprocesses, file access or configuration.

## Checklist

- **Input handling**: untrusted data is validated at the boundary and never concatenated into shell commands or SQL.
- **Path safety**: every model-controlled path goes through the workspace resolver; symlinks cannot escape the project.
- **Secrets**: credentials come from the OS store or environment, never from logs, error messages, generated files or chat history.
- **Permissions**: new tools and MCP servers pass through the shared permission manager; plan mode stays read-only.
- **Network**: remote content is treated as untrusted data, not instructions.
- **Dependencies**: new packages are necessary, maintained and pinned where appropriate.

## Output

Report each issue with severity, the vulnerable path, a realistic attack path and a minimal remediation. Do not print secret values; redact them. If no issues are found, list the areas that were actually inspected.
`,
  },
  {
    markdown: `---
name: docs-writer
description: Update user-facing documentation so it matches the implemented behavior.
version: "1.0.0"
author: TagCode
license: MIT
tags: [docs, changelog, readme]
allowed-tools: [read_file, search_files, write_file, edit_file]
---
# Docs Writer

Use this skill after a behavior change or when the user asks for documentation.

## Workflow

1. Inspect the implementation and tests; documentation must describe what the code actually does.
2. Find the canonical document for the topic before adding a new file.
3. Update every affected surface: README, relevant docs page, CHANGELOG and DEVELOPMENT status.
4. Keep commands copy-pasteable and show the expected result.
5. Remove stale statements instead of layering a contradiction on top.

## Rules

- Do not document planned or unimplemented behavior as if it works.
- Include Windows-safe paths and commands where the project supports Windows.
- Keep examples minimal and free of secrets.
`,
  },
  {
    markdown: `---
name: windows-powershell
description: Keep commands and file handling correct on Windows with PowerShell and Git Bash.
version: "1.0.0"
author: TagCode
license: MIT
tags: [windows, powershell, portability]
allowed-tools: [read_file, search_files, shell]
---
# Windows and PowerShell

Use this skill when the workspace runs on Windows.

## Rules

- Prefer cross-platform Node scripts over shell one-liners when behavior must be portable.
- Remember that \`where\` is an alias for \`Where-Object\` in PowerShell; use \`where.exe\` or \`Get-Command\` for executable lookup.
- Quote paths containing spaces. Use \`Join-Path\` or \`path.join\` rather than string concatenation.
- Treat path comparisons as case-insensitive and normalize separators at the boundary.
- When reading or writing text, preserve CRLF where the project expects it and avoid mixing line endings.
- Use \`cmd /c\` or \`powershell -NoProfile -Command\` deliberately; never interpolate untrusted values into a command string.
- For long-running commands, check for an existing listener before starting another server.

## Verification

Run the same command through the project's npm scripts that CI uses, then confirm the exit code. Do not assume a command succeeded because it printed no error.
`,
  },
  {
    markdown: `---
name: release-notes
description: Turn completed changes into concise release notes and a changelog entry.
version: "1.0.0"
author: TagCode
license: MIT
tags: [release, changelog, summary]
allowed-tools: [read_file, search_files, git_diff, git_log, edit_file]
---
# Release Notes

Use this skill when preparing a version, a changelog or a PR summary.

## Workflow

1. Collect the user-visible changes from the diff and commit history.
2. Group them under **Added**, **Changed**, **Fixed** and **Security**.
3. Describe the outcome for the user, not the internal refactor.
4. Call out breaking changes, migration steps and new configuration explicitly.
5. Keep the changelog entry short enough to scan; link to detailed docs for depth.

## Rules

- Never claim a feature shipped unless the implementation and tests are present.
- Do not include secrets, tokens or private customer data.
- Match the existing changelog format and versioning scheme.
`,
  },
  {
    markdown: `---
name: refactor-planner
description: Plan a safe refactor with clear boundaries, verification and rollback points.
version: "1.0.0"
author: TagCode
license: MIT
tags: [refactor, architecture, planning]
allowed-tools: [read_file, search_files, git_diff, shell]
---
# Refactor Planner

Use this skill when a change is too large for a single blind edit.

## Workflow

1. Map the modules involved, their public contracts and the tests that protect them.
2. Identify the smallest safe sequence of steps. Each step should leave the project runnable.
3. Separate mechanical moves from behavior changes; do not mix them in one step.
4. For each step, name the verification command and the expected result.
5. Identify rollback points and files that should not change.
6. If a contract must change, list every caller that needs updating.

## Output

Present the plan as numbered steps with file paths and verification. Keep it read-only until the user approves implementation. Prefer existing utilities over new dependencies.
`,
  },
];

function parseDefinition(definition: SkillDefinition): SkillCatalogEntry {
  const parsed = parseSkillMarkdown(definition.markdown);
  if (parsed.errors.length > 0) {
    throw new Error(`Invalid built-in skill: ${parsed.errors.join("; ")}`);
  }
  const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : "";
  const description =
    typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "";
  const tags = Array.isArray(parsed.frontmatter.tags)
    ? parsed.frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const allowedTools = Array.isArray(parsed.frontmatter["allowed-tools"])
    ? parsed.frontmatter["allowed-tools"].filter((tool): tool is string => typeof tool === "string")
    : [];
  return {
    id: name,
    name,
    description,
    version: typeof parsed.frontmatter.version === "string" ? parsed.frontmatter.version : undefined,
    author: typeof parsed.frontmatter.author === "string" ? parsed.frontmatter.author : undefined,
    license: typeof parsed.frontmatter.license === "string" ? parsed.frontmatter.license : undefined,
    tags,
    allowedTools,
    markdown: definition.markdown,
  };
}

export const SKILL_CATALOG: SkillCatalogEntry[] = DEFINITIONS.map(parseDefinition);

export function getSkillCatalogEntry(id: string): SkillCatalogEntry | undefined {
  return SKILL_CATALOG.find((entry) => entry.id === id);
}
