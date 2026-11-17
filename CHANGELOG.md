# Changelog

All notable changes to TagCode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [0.1.0] — 2026-01-01

First public milestone. The focus is a working autonomous agent with a safe
permission model, provider independence, MCP, Skills and persistent context.

### Added

- Desktop app (`tgc` by default): a local token-authenticated HTTP + SSE server,
  a dark conversation UI with an animated SVG cat mascot, live tool cards with
  arguments/duration/diff previews, plan view, Session/MCP/Skills inspector
  tabs, searchable model picker, provider wizard and approval dialogs. It opens
  in a chromeless Edge/Chrome window without Electron. `tgc tui` keeps the
  terminal UI available.
- MCP management in the desktop app: server status, tool lists, connect,
  reconnect, remove, per-server permission and an add-server wizard. The new
  MCP catalog adds ten ready-made servers with command previews, runtime
  requirements, guided inputs and server-side template resolution:
  Filesystem, GitHub, PostgreSQL, SQLite, Playwright, Fetch, Brave Search,
  Memory, Sequential Thinking and Slack.
- Skill management in the desktop app: searchable skill list, SKILL.md preview,
  Git/local/manual installation and model-assisted generation, plus reload and
  remove. The new skill catalog ships eight validated skills — code-review,
  test-writer, bug-hunt, security-audit, docs-writer, windows-powershell,
  release-notes and refactor-planner — with full previews and one-click install.
- Automatic update checks: the desktop app queries the npm registry on launch
  and every six hours, shows an update badge with the exact upgrade command, and
  offers a manual check in Settings. The check is read-only and never installs
  silently.
- Model selections are now persisted to the global or project config, and
  `tgc` reuses the saved model on the next launch.
- Skill loading now recovers from unquoted `: ` in top-level frontmatter values
  (a common generated-SKILL.md error) and surfaces a warning instead of marking
  the whole skill invalid.
- Standalone single-file landing page (`landing/index.html`) with a modern
  responsive design, animated mascot, feature overview, workflow tabs,
  quick-start snippets, mobile navigation, scroll progress and live GitHub
  metadata. Published with GitHub Pages at
  https://tagiyevffm.github.io/tagcode/.
- Interactive Ink terminal UI with streaming output, tool activity, plans,
  approval/confirm/secret/input modals, command completion, history navigation,
  a cat-mascot welcome dashboard with a session sidebar, and a status bar with
  mode, provider/model, Git branch, MCP state, context percentage, tokens and
  session duration.
- Headless CLI (`tgc`): `app`, `tui`, `run`, `init`, `doctor`, `connect`, `disconnect`,
  `models`, `model`, `config`, `mcp`, `skills`, `session`, `plugins`, `tools`,
  `provider`.
- Autonomous multi-step agent loop with tool calling, retries, cancellation and
  a configurable step limit.
- Interaction modes `agent`, `plan` and `ask`; plan mode is read-only at both
  the prompt and permission layers.
- Permission modes `ask`, `auto`, `plan`, `yolo`; allow/deny/requireApproval
  patterns; session approvals; redacted JSONL audit log.
- Workspace-confined filesystem layer with symlink checks and path traversal
  prevention.
- Provider abstraction: Anthropic Messages API, Ollama, and OpenAI-compatible
  adapters (OpenAI, OpenRouter, DeepSeek, Mistral, Groq, Together, Fireworks,
  custom/local endpoints). Capability inference per model.
- Secret storage with environment, OS keychain (`@napi-rs/keyring`, optional)
  and owner-only file fallback; secret redaction.
- Built-in tools: file read/write/edit/delete/move/copy/list/search, command and
  script execution, Python/Node execution, dependency installation, Git
  status/diff/log/branch/add/commit/checkout/show, project inspection, language
  and framework detection, dependency inspection, error analysis, TODO search,
  test/lint/typecheck runners, web search, URL fetch, documentation reader,
  plan/user-input/environment/context tools.
- MCP client with stdio and Streamable HTTP transports, tools/resources/templates/prompts,
  reconnect, inspect, reload and permission integration.
- Agent Skills system: discovery, YAML frontmatter validation, local/Git/content
  installation, duplicate protection, selective automatic activation, and
  model-assisted skill creation (`/skills create` with `from-session`,
  `from-project`, `from-description`).
- Project/global markdown memory with secret rejection and selective search.
- Session persistence with save, resume, rename, delete, Markdown export and
  automatic saving after each run.
- File checkpoints with undo/redo and automatic snapshots before writes.
- Context budgeting, token estimation, model-driven compaction and instruction
  file loading (`AGENTS.md`, `CLAUDE.md`, `.tagcode/AGENTS.md`).
- Plugin host with `plugin.json` manifests, declared permissions, tools, slash
  commands and lifecycle hooks.
- `/diff`, `/changes`, `/models`, `/disconnect` and expanded `/mcp` and
  `/skills` actions.
- `/model` with no arguments fetches the provider model list and opens an
  interactive picker; `/connect custom` is a guided base-URL/model/key flow.
- Vitest suite covering agent loop, providers, MCP integration, filesystem
  tools, permissions/security, skills, configuration, secrets, sessions and an
  end-to-end controller run against a mock provider.
- Documentation set (`README`, installation, configuration, providers, MCP,
  skills, tools, commands, architecture, security) and development status.

### Known limitations

- No GitHub REST API integration (repositories, issues, pull requests, release
  notes). Local Git operations are implemented and remote operations require
  approval.
- No image input UI.
- Web search needs a Brave or Tavily API key.
- No packaging/release automation beyond `npm run build` and
  `npm publish` scripts.
