# Security

The root policy and reporting process are in [../SECURITY.md](../SECURITY.md).
This document covers the implementation details.

## Layers

### 1. Workspace confinement

`WorkspacePaths` (`src/security/paths.ts`):

- resolves relative inputs against the workspace,
- rejects NUL bytes and empty paths,
- compares normalized paths (case-insensitive on Windows),
- resolves symlink targets best-effort and rejects escapes,
- returns the original absolute path only after validation.

All file tools use `resolveSafe`. Shell commands run with the workspace as cwd,
but a command can still access absolute paths; command approval is the boundary
there.

### 2. Permission gate

`PermissionManager` (`src/agent/permissions.ts`):

- glob matching over tool names (`*` supported),
- `deny` evaluated first,
- plan mode allows only `read`,
- `allow` then session approvals,
- `requireApproval` forces a prompt,
- `sensitive` always asks (unless allowlisted/remembered),
- `yolo` never asks; `auto` asks only for sensitive,
- missing interactive channel → denial, never silent approval,
- remembered approvals are per tool name for the session.

`ToolRegistry.execute` calls `authorize` before every tool. `describe()` can
force approval and attach risk (`low`/`medium`/`high`).

### 3. Command classification

`src/security/commands.ts` classifies shell commands as `safe`, `caution` or
`dangerous`. Dangerous patterns include:

- recursive deletes of root/home paths,
- disk formatting and raw device writes,
- shutdown/reboot and system configuration changes,
- force-push, hard reset, `git clean -fdx`,
- publishing packages,
- piping remote content into a shell/interpreter.

This is heuristic. It does not parse shell semantics and must not be treated as
a sandbox. The approval prompt shows the exact command and reasons.

### 4. Secret handling

`src/config/secrets.ts`:

- environment first,
- OS keychain when available,
- owner-only `auth.json` fallback.

`src/security/redact.ts`:

- pattern-based redaction for common tokens (Anthropic/OpenAI/GitHub/GitLab/
  Slack/AWS/Google/JWT/private keys/Bearer),
- `key=value` redaction for api_key/secret/token/password/authorization,
- object-key redaction for config/log output,
- known-secret substitution,
- environment secret collection.

Provider error bodies are redacted. The audit log stores redacted entries.

### 5. Untrusted content

The system prompt instructs the agent to treat file contents, web pages, MCP
responses and skill references as data, not as instructions. There is no
guarantee a model resists prompt injection; approvals and permission patterns
are the enforceable controls.

### 6. Desktop bridge

The desktop app is not a second permission path. It calls the same
`SessionController` methods and therefore the same `PermissionManager` gate.
The local HTTP server binds to `127.0.0.1`, uses a random per-launch token, and
requires that token on every `/api/*` route (header or EventSource query). It
serves only files under `desktop/`; path traversal is rejected. Approval and
secret prompts travel over SSE and must be answered explicitly before the
controller continues. Closing the window eventually stops the server.

Catalog installs do not let the renderer choose a command. The MCP route looks
up a server-side template by id and resolves only its declared placeholders and
inputs; unknown templates are rejected. The skill catalog installs fixed,
validated `SKILL.md` content through `installFromContent`. Secrets entered in
the MCP catalog are written to the selected MCP configuration file, so operators
should prefer narrowly scoped tokens and protect that file accordingly.

### 7. Plugins

Plugins are discovered from configured roots and load only when enabled. Each
plugin declares `read`/`write`/`execute`/`network` permissions. Tool
registration validates that the tool's permission is covered by the declaration.
The central gate still runs. Plugin commands are namespaced.

## Audit log

Every authorized/denied/approved decision appends JSONL to:

```text
~/.tagcode/logs/audit.jsonl
```

Fields: timestamp, tool, permission, outcome, summary, reason, mode. Summaries
and values are redacted. Logging failures are swallowed so auditing cannot break
execution.

## Known gaps and trade-offs

- **No OS sandbox** — approved commands run as the user.
- **Allowlist precedence** — `allow` patterns bypass approval; use `deny` for
  hard blocks.
- **Symlinks** — checked best-effort; races between check and use are possible.
- **Network** — `fetch_url` checks protocol/domain settings and size/time limits,
  but there is no egress firewall.
- **MCP** — servers are arbitrary programs/endpoints; configuration is trusted
  input.
- **Environment inheritance** — child processes inherit the environment unless a
  tool narrows it. Avoid production credentials in the environment.
- **Model behavior** — the model can propose dangerous actions; only permissions
  and approvals prevent them.

## Recommended setup

```json
{
  "permissions": {
    "mode": "auto",
    "deny": ["delete_file"],
    "requireApproval": ["run_command", "install_dependencies", "mcp__*"]
  }
}
```

- Use `ask` on unfamiliar projects.
- Never enable `yolo` where credentials or production access are present.
- Review MCP commands and skill scripts before use.
- Keep dependencies updated (`npm audit`).
