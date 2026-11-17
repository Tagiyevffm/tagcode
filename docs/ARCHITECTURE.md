# Architecture

TagCode is a modular TypeScript/Node.js application. The CLI, desktop app and TUI
are thin clients over `SessionController`; the agent engine is independent of
terminal and browser internals.

## Module map

```text
src/
  cli/index.ts           Commander CLI: app, tui, run, init, doctor, connect, mcp, skills, session…
  desktop/server.ts      Local HTTP + SSE bridge and chromeless app-window launcher
  ui/                    Ink/React TUI: App, theme, Markdown, editor, history
  controller.ts          SessionController: owns config, session, provider, tools, subsystems
  index.ts               Public embedding API
  core/
    types.ts             Provider-independent messages, events, tools, permissions
    errors.ts            TagCodeError hierarchy and toError()
  agent/
    orchestrator.ts      Streaming agent loop, tool execution, retries, cancellation
    permissions.ts       Permission gate, patterns, approvals, audit
    systemPrompt.ts      System prompt construction (project summary, instructions, skills)
  providers/             Anthropic, OpenAI-compatible, Ollama, presets, registry, SSE, HTTP, capabilities
  tools/                 Registry plus fs, terminal, git, analysis, web, misc tools
  mcp/manager.ts         MCP client: stdio/HTTP, discovery, registration, reconnect
  mcp/catalog.ts         Curated MCP templates and server-side placeholder resolver
  plugins/host.ts        Plugin discovery/loading, tools, commands, hooks, permissions
  skills/                Loader, manager, validator, installer, creator, types
  skills/catalog.ts      Built-in skill catalog with validated SKILL.md content
  update/checker.ts      Read-only npm release check and semver comparison
  memory/store.ts        Markdown memory (project/global), search, secret rejection
  context/               Token estimation, compaction, instruction files
  sessions/store.ts      JSON session persistence and Markdown export
  checkpoints/manager.ts File snapshots, undo/redo stacks
  config/                Schema (Zod), layered config, paths, secrets
  security/              Workspace paths, command risk, redaction, audit
  git/repo.ts            Small Git process helpers
  project/detect.ts      Language/framework/package-manager/command detection
  commands/              Slash-command registry and built-ins
  utils/                 FS, diff, glob, tokens, ids, logging, strings, text files
desktop/
  index.html             App shell
  styles.css             Dark desktop theme
  app.js                 Renderer: API client, SSE events, modals, markdown
```

## Request flow

```text
CLI/desktop/TUI
  └─ SessionController.run(text)
       ├─ ensureAgent(): select provider/model, build provider, ContextManager, AgentOrchestrator
       └─ AgentOrchestrator.run(text)
            ├─ before_prompt plugin hook
            ├─ loop (maxSteps):
            │    ├─ rebuild system prompt (project summary, instructions, active skills)
            │    ├─ compact history if over budget
            │    ├─ provider.stream(request) → text/reasoning/tool-call/usage events
            │    ├─ append assistant message
            │    └─ for each tool call:
            │         ├─ summarize → tool-start event
            │         ├─ before_tool hook
            │         ├─ ToolRegistry.execute → PermissionManager.authorize → tool.execute
            │         ├─ after_tool hook
            │         └─ append tool result message
            └─ done event
       └─ save session, session_end hook
```

Events are emitted to subscribers (`SessionController.onEvent`). The TUI renders
streaming text, reasoning, active tools, plans, notices and usage; the desktop
server forwards the same events over SSE to the renderer; the headless CLI
renders text and diagnostics.

## Desktop app

`tgc` starts the desktop server on `127.0.0.1` with a random port and a random
token. The renderer authenticates every API call with `X-TagCode-Token` (or the
`token` query parameter for EventSource). The server serves the static files in
`desktop/`, substitutes the token and version into `index.html`, and exposes a
small JSON API plus an SSE event stream. Approval prompts, secret prompts and
model pickers use server-to-client `ui-request` events and the matching
`/api/respond` or `/api/approval` replies.

The window is a normal Edge/Chrome process launched with `--app=<url>`, so there
is no Electron or WebView dependency. If no supported browser is found, TagCode
prints the URL for the default browser. An idle timer shuts the server down after
the window disconnects (configurable with `--idle-timeout`).

## Key decisions

- **Provider independence** — the agent engine only sees `Provider` and canonical
  `ChatMessage`/`StreamEvent` types. Adapters own protocol details.
- **Single permission gate** — built-in, MCP and plugin tools all pass through
  `ToolRegistry.execute` and `PermissionManager.authorize`. This keeps audit and
  approval behavior consistent.
- **Workspace confinement by default** — `WorkspacePaths` resolves and validates
  every filesystem target, including symlink targets. Tools do not call
  `fs` directly with model paths.
- **Real tool loop** — the model may stop only when it returns no tool calls.
  Tool errors are fed back as tool messages so the agent can recover.
- **Read-only planning** — plan mode filters tool definitions and also blocks
  non-read permissions. Defense in depth, not just a prompt instruction.
- **Checkpoint before mutation** — write/edit/delete/move/copy capture the target
  first, enabling undo. Checkpoints are stored under `.tagcode/checkpoints`.
- **Selective skill loading** — skills are indexed; only top-scoring active
  skills are injected, capped by `skills.maxActive`.
- **Context budgeting** — a conservative token estimate and model-driven
  compaction keep long sessions usable. Compaction preserves recent messages.
- **JSON persistence** — sessions, checkpoints, config and memory are plain JSON
  or Markdown under `~/.tagcode` and `.tagcode`. No database dependency.
- **Optional native dependency** — `@napi-rs/keyring` is optional; the file
  fallback keeps the tool usable when it is unavailable.

## Extension points

- **Tools** — `defineTool` + `ToolRegistry.register`.
- **Providers** — implement `Provider`, add a preset and registry case.
- **MCP servers** — configuration only; tools appear at runtime.
- **Skills** — drop a `SKILL.md` directory into a skill root.
- **Plugins** — `plugin.json` + an entry module exporting `activate(api)`.

The plugin API (`src/plugins/types.ts`) provides tools, slash commands, hooks
(`session_start`, `session_end`, `before_prompt`, `after_response`, `before_tool`,
`after_tool`) and declared permissions. Plugin tools are still authorized by the
central gate.

## Error handling

- Provider/network errors use `ProviderError`; failures are retried only before
  any streamed output, preventing duplicate text.
- Tool failures are returned as `{ ok: false, output }`, not thrown, so the agent
  can adapt.
- Cancellation propagates as `CancelledError` and emits `done: cancelled`.
- Permission denials are audited and returned to the model.
- Audit failures never break tool execution.

## Testing architecture

Vitest runs in forked processes. Tests use temporary directories and
`TAGCODE_HOME` overrides; no test touches the real user home. MCP integration is
tested against a small stdio fixture server. Provider tests use mocked `fetch`
streams. The controller test runs against a local HTTP mock provider.
