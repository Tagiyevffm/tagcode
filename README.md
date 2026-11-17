# TagCode

**TagCode** is an extensible autonomous coding agent with a desktop app and a terminal UI. You describe what you want to accomplish; TagCode inspects the project, plans the work, uses tools, edits files, runs commands and tests, and reports what it did — while keeping you in control through a real permission system.

- Repository: https://github.com/Tagiyevffm/tagcode
- CLI command: `tgc` (also `tagcode`)
- Package: `tagcode`
- Version: `0.1.0`
- License: MIT
- Platform: Windows 11 first, Linux/macOS supported
- Node.js: 22 or newer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

TagCode is not a chat wrapper. It has a real tool-calling loop, a workspace-confined filesystem layer, shell and Git tools, MCP client support, Agent Skills, project/global memory, sessions, checkpoints, and a modular provider abstraction (Anthropic, OpenAI, OpenRouter, DeepSeek, Mistral, Groq, Together, Fireworks, Ollama and any OpenAI-compatible endpoint).

## Features

- **Autonomous agent loop** — stream a model turn, execute tool calls, feed results back, repeat until done or the step limit is reached.
- **Three interaction modes** — `/agent` (make changes), `/plan` (investigate and plan, read-only), `/ask` (explain, read-only).
- **Four permission modes** — `ask`, `auto`, `plan`, `yolo`, with allow/deny/requireApproval patterns and a redacted audit log.
- **Provider independent** — native Anthropic Messages API, Ollama, and OpenAI-compatible adapters for hosted and local servers. Capability inference rather than assuming every model supports tools/vision.
- **MCP client** — stdio and Streamable HTTP transports; tools, resources, resource templates and prompts; reconnect, inspect, add/remove from the desktop panel, per-server permissions, and a ready-made catalog with command previews and guided inputs.
- **Skills** — Agent Skills (`SKILL.md`) discovery, validation, installation from local folders or Git, automatic selection, model-assisted creation, a curated catalog with full previews, and a searchable detail panel with install/remove actions.
- **Persistent context** — session save/resume/export, project and global memory, AGENTS.md/CLAUDE.md instruction loading, token budgeting and conversation compaction.
- **Safe file edits** — exact-match edits, conflict detection, encoding/EOL/BOM preservation, diff output, automatic checkpoints, undo/redo.
- **Git integration** — status, diff, log, branch, add, commit, checkout, show; `/diff` and `/changes` in the TUI.
- **Plugins** — tools, slash commands and lifecycle hooks with declared permissions.
- **Desktop app** — a chromeless local window with an animated cat mascot, conversation, expandable tool cards with diff previews, plan view, live Session/MCP/Skills inspector tabs, searchable model picker, approval dialogs and automatic update checks. No Electron dependency.
- **Terminal UI** — Ink/React interface with streaming output, tool activity, plans, approval prompts, history, completion and a status bar.

## Installation

Requires Node.js 22+ and npm.

```bash
git clone https://github.com/Tagiyevffm/tagcode.git
cd tagcode
npm install
npm run build
npm link        # makes `tgc` and `tagcode` available on PATH
```

Or run from source without building:

```bash
npm run dev          # terminal UI from source
npm run app:dev      # desktop app from source
node --import tsx src/cli/index.ts run "explain this project"
```

## Quick start

```bash
cd C:\project\myapp
tgc
```

`tgc` opens the TagCode desktop app in a chromeless Edge/Chrome window. The local server binds to `127.0.0.1` on a random port and requires a per-launch token. Use `tgc tui` for the terminal UI, or `tgc app --no-open` to print the URL without opening a window.

Then connect a provider from the app and pick a model. The choice is saved so the next launch does not ask again.

```text
/connect openai
/model
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Updates

TagCode checks the npm registry for a newer release when the desktop app starts and every six hours. When one is available, an **↑ vX.Y.Z** badge appears in the title bar with the exact upgrade command. The check is read-only; TagCode never installs an update silently. Use **Settings → Check updates** to run it manually.

## MCP

```bash
tgc mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem C:\project\myapp
tgc mcp list
tgc mcp inspect filesystem
```

Or edit `~/.tagcode/mcp.json` / `<project>/.tagcode/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\project\\myapp"],
      "permission": "sensitive"
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

MCP tools are registered as `mcp__<server>__<tool>` and go through the same permission gate as built-in tools. External MCP responses are treated as untrusted data.

In the desktop app, open the **MCP** tab and choose **▦** to browse the catalog. Each entry shows its command preview, required runtime, permission class and the fields TagCode needs; the server-side template resolver writes the configuration so the renderer cannot inject an arbitrary command. Available entries include Filesystem, GitHub, PostgreSQL, SQLite, Playwright, Fetch, Brave Search, Memory, Sequential Thinking and Slack.

See [docs/MCP.md](docs/MCP.md).

## Skills

```bash
tgc skills install ./my-skill
tgc skills install https://github.com/user/repo
tgc skills list
tgc skills inspect my-skill
```

A skill is a directory with a `SKILL.md` file:

```markdown
---
name: react-expert
description: Build React dashboards with hooks and accessible components.
version: 1.0.0
---

# React expert

Use this skill when building React dashboards.
...
```

Project skills live in `.tagcode/skills/`, global skills in `~/.tagcode/skills/`. The agent selects relevant skills per task instead of loading everything into context. `/skills create from-project` asks the active model to generate a skill from project conventions; the generated content is validated before installation.

In the desktop app, open the **Skills** tab and choose **▦** to browse the skill catalog. Each entry has a full rendered preview and a project/global install button. The catalog includes code review, test writing, bug hunting, security audit, docs, Windows/PowerShell, release notes and refactor planning skills.

See [docs/SKILLS.md](docs/SKILLS.md).

## Memory and sessions

```text
/memory show
/memory search authentication
/memory add decisions "Use SQLite for local persistence."
/session list
/session resume latest
/session export notes/session.md
```

Project memory lives in `.tagcode/memory/` (`project.md`, `architecture.md`, `conventions.md`, `decisions.md`, `notes.md`); global memory lives in `~/.tagcode/memory/`. The append path refuses content that looks like a secret.

Sessions are stored as JSON under `.tagcode/sessions/` and can be listed, resumed, renamed or exported as Markdown. The desktop **Session** inspector shows the current session, working directory, Git branch, context usage and token totals.

## Permissions

| Mode | Reads | Writes / commands | Sensitive |
| --- | --- | --- | --- |
| `ask` | allow | ask | ask |
| `auto` | allow | allow | ask |
| `plan` | allow | deny | deny |
| `yolo` | allow | allow | allow |

`deny` patterns are evaluated first, then plan mode, then `allow` and remembered session approvals, then `requireApproval`, then the mode rules. This order is intentional; use `deny` for hard blocks. Every decision is appended (redacted) to `~/.tagcode/logs/audit.jsonl`.

## Development

```bash
npm run typecheck   # strict TypeScript
npm test            # Vitest suite
npm run build       # emit dist/
npm run check       # typecheck + tests
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the current status, test results and architectural decisions, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map.

## Live site

The landing page is published with GitHub Pages at **https://tagiyevffm.github.io/tagcode/**.

A standalone, dependency-free copy lives at [landing/index.html](landing/index.html). Open it directly in a browser or serve the folder:

```bash
npx serve landing
```

It includes the animated mascot, feature overview, workflow tabs and quick-start snippets in one HTML file.

## Limitations

- GitHub API integration (creating repositories/issues/PRs) is not implemented; Git operations are local and pushing/creating publications always requires approval. See [DEVELOPMENT.md](DEVELOPMENT.md).
- Web search requires a Brave or Tavily API key (`web.searchProvider` + `web.searchApiKeyEnv`). `fetch_url` works without a search key.
- Images are supported by the provider layer and OpenAI-compatible adapters, but the TUI does not yet offer an image picker.
- The terminal UI requires a TTY. Use `tgc run` for automation; the desktop app does not need a TTY.
- Update checks use the public npm registry. Until a release is published there, the desktop app reports no newer version.

## License

MIT © 2026 Tagiyevff. See [LICENSE](LICENSE).
