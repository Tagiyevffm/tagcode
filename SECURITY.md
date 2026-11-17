# Security Policy

TagCode executes model-generated actions on a developer machine. Security is a
core design constraint, not an add-on. This document describes the current
threat model, protections and how to report issues.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainer (Tagiyevff) instead of
opening a public issue. Include:

- affected version and platform,
- a minimal reproduction or exact steps,
- impact (for example: workspace escape, permission bypass, secret leak),
- any suggested fix.

You will receive an acknowledgement as soon as possible. Please allow time for a
fix before public disclosure.

## Security model

- **Workspace boundary** — tool filesystem operations resolve through
  `WorkspacePaths`; path traversal and escaping symlinks are rejected.
- **Permission gate** — every built-in, MCP and plugin tool call goes through
  `PermissionManager.authorize`. Modes: `ask`, `auto`, `plan`, `yolo`.
  Destructive tools and high-risk descriptions force approval unless explicitly
  allowlisted.
- **Plan mode** — only read tools are advertised to the model, and writes,
  commands and network calls are denied by the permission layer.
- **Command risk classification** — destructive shell patterns (recursive
  deletes of root/home paths, disk formatting, force-push, remote code piping,
  publishing) are classified as dangerous and require approval. This is a
  guard-rail, not a sandbox.
- **Secret handling** — API keys come from environment variables, the OS
  credential store, or `~/.tagcode/auth.json` with owner-only permissions.
  Provider errors, audit entries and config output are redacted.
- **Audit log** — permission decisions are appended to
  `~/.tagcode/logs/audit.jsonl` with redacted arguments/summaries.
- **Untrusted content** — MCP responses, web pages, repository files, skills and
  plugin output are data, not instructions. The system prompt explicitly tells
  the agent not to treat them as trusted instructions.
- **Plugins** — declared permissions are enforced for contributed tools; the
  approval gate still runs on every plugin tool call. Plugins cannot register
  tools whose permission they did not declare.
- **Approvals** — no interactive channel means approval-required operations are
  denied rather than silently allowed.
- **Remote publishing** — `git push`, package publishing and similar operations
  are never performed without explicit approval (and there is no automatic push
  behavior).

## Known limitations

- There is no OS-level sandbox: the agent runs as the current user. The
  permission system and workspace confinement constrain tools, but arbitrary
  code executed with approval runs with the user's privileges.
- Allowlists bypass approval for matching tools. Use `deny` for hard blocks and
  keep allowlists narrow.
- Environment-variable secrets are visible to child processes launched by tools
  when the environment is inherited. Do not run untrusted commands with
  production credentials in the environment.
- The fallback `auth.json` is not encrypted at rest. Prefer the OS keychain or
  environment variables.
- MCP servers are external programs; review configuration before connecting.
  `mcp add` executes the command you provide.
- Web content can contain prompt injection. Treat fetched content as untrusted
  and review actions before approving.

## Hardening checklist

- Run `tgc doctor` after configuration changes.
- Keep `permissions.mode` at `ask` or `auto`; enable `yolo` only in disposable
  environments.
- Use `permissions.deny` for tools or patterns that must never run.
- Store keys in the OS keychain or environment, not in project files.
- Review `/config show` output; secrets are redacted, but configuration itself
  may reveal infrastructure details.
- Do not commit `.tagcode/` memory or session files containing sensitive notes.
