# Development status

Last updated after the v0.1.0 verification run.

## Current phase

**Phase 8 — Release readiness.** Phases 1–7 are implemented; the remaining work
is external integration and polish (GitHub API, image input, broader platform
testing).

## Completed

- [x] Project scaffold, strict TypeScript, ESM, build/typecheck scripts
- [x] Commander CLI and Ink terminal UI
- [x] Layered JSON configuration with Zod validation
- [x] Provider abstraction and streaming adapters
  (Anthropic, OpenAI-compatible, Ollama, custom/local)
- [x] Secret store (env → OS keychain → owner-only file fallback)
- [x] Agent loop with tool calling, retries, cancellation, step limits
- [x] Interaction modes: agent / plan / ask
- [x] Permission modes: ask / auto / plan / yolo, patterns, session approvals
- [x] Workspace confinement with symlink checks
- [x] Command risk classification and redacted audit log
- [x] Built-in tools: filesystem, terminal, Git, analysis, web, misc
- [x] Diff generation, encoding/EOL/BOM preservation, checkpoints, undo/redo
- [x] MCP client: stdio + Streamable HTTP, tools/resources/templates/prompts,
      reconnect, inspect, permission integration
- [x] Skills: discovery, validation, installation, update/remove, selective
      activation, model-assisted creation, lenient unquoted-colon recovery
- [x] Memory: project/global Markdown stores, search, secret rejection
- [x] Context budgeting, token estimation, model-driven compaction, instruction
      files
- [x] Sessions: save/resume/rename/delete/export, automatic save
- [x] Plugins: manifest, lifecycle hooks, tools, commands, permissions
- [x] Slash commands: `/diff`, `/changes`, `/models`, `/disconnect`, expanded
      `/mcp` and `/skills`
- [x] CLI: `disconnect`, `models`, MCP connect/disconnect/inspect/reload, skills
      inspect/reload
- [x] TUI status bar: Git branch, MCP state, session duration
- [x] Cat-mascot welcome dashboard with session/capabilities sidebar
- [x] Animated SVG mascot with idle/thinking/working/success/error/plan states
- [x] Desktop app: local token-authenticated HTTP + SSE server, chromeless
      Edge/Chrome window, conversation UI, inspector, model/provider dialogs
- [x] Desktop MCP panel: status, tools, connect/reconnect/remove, add wizard
- [x] MCP catalog: ten ready-made servers, command previews, guided inputs,
      server-side template resolver and conflict-safe install/reinstall
- [x] Desktop Skills panel: search, SKILL.md preview, install/create/remove
- [x] Skill catalog: eight validated built-in skills, full preview and
      project/global install/reinstall
- [x] Automatic update check: launch + six-hour interval, update badge,
      Settings manual check and no silent installs
- [x] Expandable tool cards with arguments, duration and diff previews
- [x] `/` command autocomplete, code-copy buttons and toast feedback
- [x] Standalone single-file landing/welcome page (`landing/index.html`)
- [x] Model selections persist to global/project config across launches
- [x] `tgc` opens the desktop app; `tgc tui` keeps the terminal UI
- [x] `/model` auto-fetches provider models and opens an interactive picker
- [x] Guided `/connect custom` flow (base URL, model, optional key)
- [x] Vitest suite (12 files, 88 tests) + MCP stdio fixture + mock provider
- [x] Documentation set, LICENSE, CONTRIBUTING, SECURITY, CHANGELOG
- [x] `DEVELOPMENT.md`, `AGENTS.md`, example plugin and skill

## In progress

- None. The tree is green (typecheck, tests, build).

## Remaining / not implemented

- GitHub REST integration: repository creation, issues, pull requests, release
  notes. Local Git tooling exists; remote publishing always requires approval and
  is not automated.
- Image input from the terminal UI (provider layer already supports images).
- Native installer/MSI or winget packaging for the desktop app. It currently
  requires an installed Edge or Chrome and is launched through the `tgc` CLI.
- Broader Linux/macOS CI and packaging automation.
- Coverage reporting and mutation testing.
- Windows installer/MSI or winget packaging.

## Test results

Command: `npm run check` (`tsc --noEmit` + `vitest run`).

```text
✓ tests/security.test.ts     (17 tests)
✓ tests/providers.test.ts    (8 tests)
✓ tests/agent.test.ts        (6 tests)
✓ tests/config.test.ts       (10 tests)
✓ tests/filesystem.test.ts   (8 tests)
✓ tests/skills.test.ts       (12 tests)
✓ tests/cli.test.ts          (3 tests)
✓ tests/mcp.test.ts          (5 tests)
✓ tests/session.test.ts      (4 tests)
✓ tests/desktop.test.ts      (8 tests)
✓ tests/model-persistence.test.ts (1 test)

Test Files  9 passed (9)
Tests       72 passed (72)
```

Build: `npm run build` emits `dist/` with declarations and source maps.

## Architectural decisions

1. **Controller facade** — one owner for subsystem lifetimes, shared by CLI/TUI.
2. **Canonical core types** — providers adapt at the edge; the engine is neutral.
3. **One permission gate** — built-in, MCP and plugin tools cannot bypass it.
4. **Workspace resolution in the tool context** — no tool receives raw path
   handling responsibility.
5. **Checkpoints before mutation** — undo is file-level and session-scoped.
6. **Plan mode enforced twice** — tool definitions and permission decisions.
7. **JSON/Markdown persistence** — no database dependency; easy to inspect.
8. **Optional keychain dependency** — graceful file fallback with a warning.
9. **No fake tools** — every tool performs real work and reports real errors.
10. **Retry only before output** — avoids duplicate streamed text.

## Known issues

- `README.md` intentionally has no screenshots; terminal previews are textual.
- The working copy may not have a `.git` directory; initialize version control
  before publishing or making the first commit (this environment refused an
  automated `git init`/commit).
- Skill creation and compaction require a working provider; they fail clearly
  when no provider is configured.
- MCP servers can be slow to start; connect timeout defaults to 60 seconds per
  server and startup is sequential.
- The `allow` permission list is evaluated before `requireApproval`; use `deny`
  for hard blocks.
- `npm run dev` requires a TTY for the interactive UI; use `tgc run` otherwise.

## Verification commands

```bash
npm run typecheck
npm test
npm run build
node dist/cli/index.js --version
node dist/cli/index.js doctor --json
```
